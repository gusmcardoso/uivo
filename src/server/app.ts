import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import {
  decodeSession,
  encodeSession,
  hashPassword,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  verifyPassword,
} from './auth.ts';
import { getSite } from './db.ts';
import { DAY, HOUR } from './util.ts';

export interface AppOptions {
  db: DatabaseSync;
  authSecret: string;
  runNow: (siteId: number) => Promise<void>;
  webDir?: string;
  logger?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    userId: number | null;
  }
}

const RANGES: Record<string, number> = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };
/** Pontos máximos por gráfico: períodos longos são agregados em faixas de tempo. */
const MAX_POINTS = 300;

const siteBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    url: { type: 'string', pattern: '^https?://[^\\s/$.?#][^\\s]*$', maxLength: 2048 },
    interval_sec: { type: 'integer', minimum: 30, maximum: 3600 },
    keyword: { type: ['string', 'null'], maxLength: 200 },
    enabled: { type: 'boolean' },
    check_domain: { type: 'boolean' },
  },
} as const;

const credentials = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email', maxLength: 200 },
    password: { type: 'string', minLength: 8, maxLength: 200 },
  },
} as const;

interface SiteInput {
  name?: string;
  url?: string;
  interval_sec?: number;
  keyword?: string | null;
  enabled?: boolean;
  check_domain?: boolean;
}

export async function buildApp(options: AppOptions) {
  const { db } = options;
  const app = Fastify({ logger: options.logger ?? false, trustProxy: true });

  await app.register(cookie, { secret: options.authSecret });
  await app.register(rateLimit, { global: false });

  app.decorateRequest('userId', null);
  app.addHook('onRequest', async (req) => {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return;
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return;
    const id = decodeSession(unsigned.value);
    if (id && db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) req.userId = id;
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('x-frame-options', 'DENY');
    reply.header(
      'content-security-policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
  });

  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.userId) return reply.code(401).send({ error: 'Faça login para continuar.' });
  };

  const startSession = (reply: FastifyReply, userId: number) => {
    reply.setCookie(SESSION_COOKIE, encodeSession(userId), {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });
  };

  const userCount = () => (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;

  // ─── Saúde ────────────────────────────────────────────────────────────────
  app.get('/healthz', async () => {
    db.prepare('SELECT 1').get();
    return { ok: true };
  });

  // ─── Sessão ───────────────────────────────────────────────────────────────
  app.get('/api/session', async (req) => ({
    authenticated: Boolean(req.userId),
    needsSetup: userCount() === 0,
  }));

  app.post<{ Body: { email: string; password: string } }>(
    '/api/setup',
    { schema: { body: credentials }, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (userCount() > 0) return reply.code(409).send({ error: 'A conta de administrador já existe.' });
      const result = db
        .prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)')
        .run(req.body.email.toLowerCase(), hashPassword(req.body.password), Date.now());
      startSession(reply, Number(result.lastInsertRowid));
      return { ok: true };
    },
  );

  app.post<{ Body: { email: string; password: string } }>(
    '/api/login',
    { schema: { body: credentials }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const user = db
        .prepare('SELECT id, password_hash FROM users WHERE email = ?')
        .get(req.body.email.toLowerCase()) as { id: number; password_hash: string } | undefined;
      if (!user || !verifyPassword(req.body.password, user.password_hash)) {
        return reply.code(401).send({ error: 'E-mail ou senha incorretos.' });
      }
      startSession(reply, user.id);
      return { ok: true };
    },
  );

  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ─── Sites ────────────────────────────────────────────────────────────────
  app.get('/api/sites', { preHandler: requireAuth }, async () => {
    const now = Date.now();
    return db
      .prepare(
        `SELECT s.*,
           (SELECT ROUND(AVG(ok) * 100, 2) FROM checks c WHERE c.site_id = s.id AND c.at >= ?) AS uptime_24h,
           (SELECT ROUND(AVG(ok) * 100, 2) FROM checks c WHERE c.site_id = s.id AND c.at >= ?) AS uptime_7d,
           (SELECT ROUND(AVG(ok) * 100, 2) FROM checks c WHERE c.site_id = s.id AND c.at >= ?) AS uptime_30d,
           (SELECT response_ms FROM checks c WHERE c.site_id = s.id ORDER BY at DESC LIMIT 1) AS last_response_ms
         FROM sites s ORDER BY s.status = 'down' DESC, s.name COLLATE NOCASE`,
      )
      .all(now - DAY, now - 7 * DAY, now - 30 * DAY);
  });

  app.post<{ Body: SiteInput }>(
    '/api/sites',
    { preHandler: requireAuth, schema: { body: { ...siteBody, required: ['name', 'url'] } } },
    async (req, reply) => {
      const b = req.body;
      const result = db
        .prepare(
          `INSERT INTO sites (name, url, interval_sec, keyword, enabled, check_domain, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          b.name ?? '',
          b.url ?? '',
          b.interval_sec ?? 60,
          b.keyword || null,
          b.enabled === false ? 0 : 1,
          b.check_domain === false ? 0 : 1,
          Date.now(),
        );
      const id = Number(result.lastInsertRowid);
      void options.runNow(id);
      return reply.code(201).send(getSite(db, id));
    },
  );

  app.patch<{ Params: { id: string }; Body: SiteInput }>(
    '/api/sites/:id',
    { preHandler: requireAuth, schema: { body: siteBody } },
    async (req, reply) => {
      const site = getSite(db, Number(req.params.id));
      if (!site) return reply.code(404).send({ error: 'Site não encontrado.' });
      const b = req.body;
      const urlChanged = b.url !== undefined && b.url !== site.url;
      db.prepare(
        `UPDATE sites SET name = ?, url = ?, interval_sec = ?, keyword = ?, enabled = ?, check_domain = ?
         ${urlChanged ? ', ssl_checked_at = NULL, domain_checked_at = NULL' : ''} WHERE id = ?`,
      ).run(
        b.name ?? site.name,
        b.url ?? site.url,
        b.interval_sec ?? site.interval_sec,
        b.keyword === undefined ? site.keyword : b.keyword || null,
        b.enabled === undefined ? site.enabled : Number(b.enabled),
        b.check_domain === undefined ? site.check_domain : Number(b.check_domain),
        site.id,
      );
      if (urlChanged) void options.runNow(site.id);
      return getSite(db, site.id);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/sites/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const result = db.prepare('DELETE FROM sites WHERE id = ?').run(Number(req.params.id));
      if (!result.changes) return reply.code(404).send({ error: 'Site não encontrado.' });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/sites/:id/check',
    { preHandler: requireAuth },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!getSite(db, id)) return reply.code(404).send({ error: 'Site não encontrado.' });
      await options.runNow(id);
      return getSite(db, id);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { range?: string } }>(
    '/api/sites/:id/checks',
    { preHandler: requireAuth },
    async (req) => {
      const span = RANGES[req.query.range ?? '24h'] ?? DAY;
      const bucket = Math.max(60_000, Math.ceil(span / MAX_POINTS));
      return db
        .prepare(
          `SELECT (at / ?) * ? AS t, ROUND(AVG(response_ms)) AS ms, MIN(ok) AS ok, COUNT(*) AS n
           FROM checks WHERE site_id = ? AND at >= ? GROUP BY 1 ORDER BY 1`,
        )
        .all(bucket, bucket, Number(req.params.id), Date.now() - span);
    },
  );

  app.get<{ Params: { id: string } }>('/api/sites/:id/incidents', { preHandler: requireAuth }, async (req) =>
    db
      .prepare(
        'SELECT * FROM incidents WHERE site_id = ? AND started_at >= ? ORDER BY started_at DESC LIMIT 50',
      )
      .all(Number(req.params.id), Date.now() - 90 * DAY),
  );

  // ─── Painel (SPA) ─────────────────────────────────────────────────────────
  const webDir = options.webDir;
  if (webDir && existsSync(path.join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDir,
      maxAge: HOUR,
      setHeaders: (res, file) => {
        if (file.includes(`${path.sep}assets${path.sep}`))
          res.header('cache-control', 'public, max-age=31536000, immutable');
        if (file.endsWith('index.html')) res.header('cache-control', 'no-cache');
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || !webDir || !existsSync(path.join(webDir, 'index.html'))) {
      return reply.code(404).send({ error: 'Não encontrado.' });
    }
    return reply.header('cache-control', 'no-cache').sendFile('index.html');
  });

  return app;
}
