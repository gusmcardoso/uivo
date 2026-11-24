import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { acceptScripts, latestAudit } from './audit.ts';
import {
  decodeSession,
  encodeSession,
  hashPassword,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  verifyPassword,
} from './auth.ts';
import { getSite, type Site, siteHeaders } from './db.ts';
import { healthScore } from './health.ts';
import { registerPublicRoutes } from './public.ts';
import { buildReport } from './report/data.ts';
import { renderReport } from './report/pdf.ts';
import { DAY, HOUR } from './util.ts';

export interface AppOptions {
  db: DatabaseSync;
  authSecret: string;
  runNow: (siteId: number) => Promise<void>;
  runAudit?: (siteId: number) => Promise<void>;
  webDir?: string;
  metricsToken?: string;
  statusTitle?: string;
  /** Nome de quem prepara os relatórios (aparece na capa). */
  reportAuthor?: string;
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
    public: { type: 'boolean' },
    // Cabeçalhos de liberação (ex.: segredo do firewall). Valor vazio mantém o já salvo.
    headers: {
      type: 'object',
      maxProperties: 5,
      propertyNames: { pattern: '^[A-Za-z0-9-]{1,64}$' },
      additionalProperties: { type: 'string', maxLength: 512 },
    },
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
  public?: boolean;
  headers?: Record<string, string>;
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
    const rows = db
      .prepare(
        `SELECT s.*,
           (SELECT ROUND(AVG(ok) * 100, 2) FROM checks c WHERE c.site_id = s.id AND c.at >= ?) AS uptime_24h,
           (SELECT ROUND(AVG(ok) * 100, 2) FROM checks c WHERE c.site_id = s.id AND c.at >= ?) AS uptime_7d,
           (SELECT ROUND(AVG(ok) * 100, 2) FROM checks c WHERE c.site_id = s.id AND c.at >= ?) AS uptime_30d,
           (SELECT response_ms FROM checks c WHERE c.site_id = s.id ORDER BY at DESC LIMIT 1) AS last_response_ms
         FROM sites s ORDER BY s.status = 'down' DESC, s.name COLLATE NOCASE`,
      )
      .all(now - DAY, now - 7 * DAY, now - 30 * DAY) as unknown as (Site & { uptime_7d: number | null })[];
    return rows.map((site) => ({
      ...publicSite(site),
      health_score: healthScore(site, site.uptime_7d, now),
    }));
  });

  // ─── Relatório mensal (PDF) ───────────────────────────────────────────────
  app.get<{ Querystring: { month?: string; sites?: string; title?: string } }>(
    '/api/reports/monthly',
    { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(req.query.month ?? '');
      if (!m || Number(m[1]) < 2020)
        return reply.code(400).send({ error: 'Informe o mês no formato AAAA-MM.' });
      const siteIds = (req.query.sites ?? '')
        .split(',')
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v > 0);
      const data = buildReport(db, {
        year: Number(m[1]),
        month: Number(m[2]),
        siteIds,
        title: (req.query.title ?? '').slice(0, 120),
        author: options.reportAuthor ?? null,
      });
      const pdf = await renderReport(data);
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="relatorio-uivo-${m[1]}-${m[2]}.pdf"`)
        .header('cache-control', 'no-store')
        .send(pdf);
    },
  );

  // ─── Segurança ────────────────────────────────────────────────────────────
  /** Última auditoria + o motivo, se a mais recente não pôde ser feita (ex.: desafio anti-bot). */
  const securityView = (siteId: number) => ({
    ...(latestAudit({ db }, siteId) ?? { at: null, score: null, findings: [], passed: [], script_hosts: [] }),
    error: getSite(db, siteId)?.security_error ?? null,
  });
  app.get<{ Params: { id: string } }>(
    '/api/sites/:id/security',
    { preHandler: requireAuth },
    async (req, reply) => {
      const site = getSite(db, Number(req.params.id));
      if (!site) return reply.code(404).send({ error: 'Site não encontrado.' });
      return securityView(site.id);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/sites/:id/security',
    { preHandler: requireAuth },
    async (req, reply) => {
      const site = getSite(db, Number(req.params.id));
      if (!site) return reply.code(404).send({ error: 'Site não encontrado.' });
      await options.runAudit?.(site.id);
      return securityView(site.id);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/sites/:id/security/accept-scripts',
    { preHandler: requireAuth },
    async (req, reply) => {
      const site = getSite(db, Number(req.params.id));
      if (!site) return reply.code(404).send({ error: 'Site não encontrado.' });
      return (
        acceptScripts({ db }, site) ??
        reply.code(409).send({ error: 'Ainda não há auditoria para este site.' })
      );
    },
  );

  app.post<{ Body: SiteInput }>(
    '/api/sites',
    { preHandler: requireAuth, schema: { body: { ...siteBody, required: ['name', 'url'] } } },
    async (req, reply) => {
      const b = req.body;
      const headers = mergeHeaders({}, b.headers);
      if (typeof headers === 'string') return reply.code(400).send({ error: headers });
      const result = db
        .prepare(
          `INSERT INTO sites (name, url, interval_sec, keyword, enabled, check_domain, public, custom_headers, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          b.name ?? '',
          b.url ?? '',
          b.interval_sec ?? 60,
          b.keyword || null,
          b.enabled === false ? 0 : 1,
          b.check_domain === false ? 0 : 1,
          b.public ? 1 : 0,
          Object.keys(headers).length ? JSON.stringify(headers) : null,
          Date.now(),
        );
      const id = Number(result.lastInsertRowid);
      void options.runNow(id);
      return reply.code(201).send(publicSite(getSite(db, id)));
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
      const headers =
        b.headers === undefined ? siteHeaders(site) : mergeHeaders(siteHeaders(site), b.headers);
      if (typeof headers === 'string') return reply.code(400).send({ error: headers });
      db.prepare(
        `UPDATE sites SET name = ?, url = ?, interval_sec = ?, keyword = ?, enabled = ?, check_domain = ?, public = ?,
           custom_headers = ?
         ${urlChanged ? ', ssl_checked_at = NULL, domain_checked_at = NULL' : ''} WHERE id = ?`,
      ).run(
        b.name ?? site.name,
        b.url ?? site.url,
        b.interval_sec ?? site.interval_sec,
        b.keyword === undefined ? site.keyword : b.keyword || null,
        b.enabled === undefined ? site.enabled : Number(b.enabled),
        b.check_domain === undefined ? site.check_domain : Number(b.check_domain),
        b.public === undefined ? site.public : Number(b.public),
        Object.keys(headers).length ? JSON.stringify(headers) : null,
        site.id,
      );
      if (urlChanged) void options.runNow(site.id);
      return publicSite(getSite(db, site.id));
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
      return publicSite(getSite(db, id));
    },
  );

  // Visão geral da tela inicial: as últimas 24 h de cada site, hora a hora, e o que mudou desde ontem
  app.get('/api/overview', { preHandler: requireAuth }, async () => {
    const now = Date.now();
    const hourStart = Math.floor(now / HOUR) * HOUR;
    const from = hourStart - 23 * HOUR; // 24 faixas de 1 h, a última é a hora corrente
    const sites = db.prepare('SELECT id FROM sites ORDER BY name COLLATE NOCASE').all() as { id: number }[];
    const hourly = db.prepare(
      `SELECT (at / ${HOUR}) * ${HOUR} AS h, COUNT(*) AS n, SUM(ok) AS up,
         ROUND(AVG(CASE WHEN ok = 1 THEN response_ms END)) AS ms
       FROM checks WHERE site_id = ? AND at >= ? GROUP BY 1`,
    );
    const window = db.prepare(
      `SELECT COUNT(*) AS n, ROUND(AVG(CASE WHEN ok = 1 THEN response_ms END)) AS ms
       FROM checks WHERE site_id = ? AND at >= ? AND at < ?`,
    );
    const incidents = db.prepare(`SELECT COUNT(*) AS n FROM incidents WHERE site_id = ? AND started_at >= ?`);
    let checks = 0;
    let falls = 0;
    const perSite = sites.map(({ id }) => {
      const rows = new Map(
        (hourly.all(id, from) as { h: number; n: number; up: number; ms: number | null }[]).map((r) => [
          r.h,
          r,
        ]),
      );
      const hours = Array.from({ length: 24 }, (_, i) => {
        const r = rows.get(from + i * HOUR);
        return r ? { uptime: Math.round((r.up / r.n) * 1000) / 10, ms: r.ms } : null;
      });
      const today = window.get(id, now - DAY, now) as { n: number; ms: number | null };
      const yesterday = window.get(id, now - 2 * DAY, now - DAY) as { n: number; ms: number | null };
      const fallsToday = (incidents.get(id, now - DAY) as { n: number }).n;
      checks += today.n;
      falls += fallsToday;
      return {
        id,
        hours,
        responseMs: today.ms,
        // variação da resposta média contra as 24 h anteriores, em % (null sem base de comparação)
        responseChange:
          today.ms !== null && yesterday.ms
            ? Math.round(((today.ms - yesterday.ms) / yesterday.ms) * 100)
            : null,
        incidents24h: fallsToday,
      };
    });
    return { from, checks24h: checks, incidents24h: falls, sites: perSite };
  });

  app.get<{ Params: { id: string }; Querystring: { range?: string } }>(
    '/api/sites/:id/checks',
    { preHandler: requireAuth },
    async (req) => {
      const span = RANGES[req.query.range ?? '24h'] ?? DAY;
      const bucket = Math.max(60_000, Math.ceil(span / MAX_POINTS));
      return db
        .prepare(
          `SELECT (at / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS t, ROUND(AVG(response_ms)) AS ms, MIN(ok) AS ok, COUNT(*) AS n,
             ROUND(AVG(redirect_ms)) AS redirect, ROUND(AVG(dns_ms)) AS dns, ROUND(AVG(connect_ms)) AS connect,
             ROUND(AVG(tls_ms)) AS tls, ROUND(AVG(wait_ms)) AS wait, ROUND(AVG(download_ms)) AS download
           FROM checks WHERE site_id = ? AND at >= ? GROUP BY 1 ORDER BY 1`,
        )
        .all(bucket, bucket, Number(req.params.id), Date.now() - span);
    },
  );

  // Detalhe de um ponto do gráfico, comparado com o mesmo horário em dias anteriores
  app.get<{ Params: { id: string }; Querystring: { at?: string; span?: string } }>(
    '/api/sites/:id/moment',
    { preHandler: requireAuth },
    async (req, reply) => {
      const site = getSite(db, Number(req.params.id));
      if (!site) return reply.code(404).send({ error: 'Site não encontrado.' });
      const at = Number(req.query.at);
      const span = Number(req.query.span);
      if (!Number.isFinite(at) || !Number.isFinite(span) || span < 60_000 || span > DAY) {
        return reply.code(400).send({ error: 'Informe at e span (em ms, de 1 minuto a 1 dia).' });
      }
      const query = db.prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(1 - ok), 0) AS fails,
           ROUND(AVG(CASE WHEN ok = 1 THEN response_ms END)) AS avg,
           MIN(CASE WHEN ok = 1 THEN response_ms END) AS min, MAX(CASE WHEN ok = 1 THEN response_ms END) AS max
         FROM checks WHERE site_id = ? AND at >= ? AND at < ?`,
      );
      const window = (from: number) =>
        query.get(site.id, from, from + span) as {
          n: number;
          fails: number;
          avg: number | null;
          min: number | null;
          max: number | null;
        };
      // "Normal para este horário": média do mesmo intervalo nos 7 dias anteriores (só dias com dados)
      const previous = [1, 2, 3, 4, 5, 6, 7].map((d) => window(at - d * DAY).avg).filter((v) => v !== null);
      const incidents = db
        .prepare(
          `SELECT started_at, ended_at, reason FROM incidents
           WHERE site_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at`,
        )
        .all(site.id, at + span, at);
      return {
        at,
        span,
        current: window(at),
        yesterday: window(at - DAY),
        lastWeek: window(at - 7 * DAY),
        typical: {
          avg: previous.length ? Math.round(previous.reduce((a, b) => a + b, 0) / previous.length) : null,
          days: previous.length,
        },
        incidents,
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { range?: string } }>(
    '/api/sites/:id/timing',
    { preHandler: requireAuth },
    async (req, reply) => {
      const site = getSite(db, Number(req.params.id));
      if (!site) return reply.code(404).send({ error: 'Site não encontrado.' });
      const span = RANGES[req.query.range ?? '24h'] ?? DAY;
      const since = Date.now() - span;
      // Percentis só das checagens com sucesso: queda não é "lentidão"
      const values = (
        db
          .prepare(
            'SELECT response_ms FROM checks WHERE site_id = ? AND at >= ? AND ok = 1 ORDER BY response_ms',
          )
          .all(site.id, since) as { response_ms: number }[]
      ).map((r) => r.response_ms);
      const phases = db
        .prepare(
          `SELECT ROUND(AVG(redirect_ms)) AS redirect, ROUND(AVG(dns_ms)) AS dns, ROUND(AVG(connect_ms)) AS connect,
             ROUND(AVG(tls_ms)) AS tls, ROUND(AVG(wait_ms)) AS wait, ROUND(AVG(download_ms)) AS download,
             ROUND(AVG(bytes)) AS bytes
           FROM checks WHERE site_id = ? AND at >= ? AND ok = 1 AND wait_ms IS NOT NULL`,
        )
        .get(site.id, since);
      return {
        samples: values.length,
        p50: percentile(values, 50),
        p95: percentile(values, 95),
        p99: percentile(values, 99),
        average: phases,
        last: site.last_timing ? JSON.parse(site.last_timing) : null,
      };
    },
  );

  app.get<{ Params: { id: string } }>('/api/sites/:id/incidents', { preHandler: requireAuth }, async (req) =>
    db
      .prepare(
        'SELECT * FROM incidents WHERE site_id = ? AND started_at >= ? ORDER BY started_at DESC LIMIT 50',
      )
      .all(Number(req.params.id), Date.now() - 90 * DAY),
  );

  registerPublicRoutes(app, db, { metricsToken: options.metricsToken, statusTitle: options.statusTitle });

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

/** Percentil pelo método do posto mais próximo; espera a lista já ordenada. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** Cabeçalhos que não podem ser sobrescritos (quebrariam a requisição ou a medição). */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'accept-encoding',
]);

/**
 * Junta os cabeçalhos enviados pelo painel com os já salvos. Valor vazio num nome existente
 * mantém o segredo salvo (o painel nunca recebe os valores de volta); nome ausente é removido.
 */
export function mergeHeaders(
  saved: Record<string, string>,
  incoming: Record<string, string> | undefined,
): Record<string, string> | string {
  if (!incoming) return {};
  const out: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(incoming)) {
    const name = rawName.toLowerCase();
    if (RESERVED_HEADERS.has(name)) return `O cabeçalho "${rawName}" não pode ser personalizado.`;
    if (/[\r\n]/.test(value)) return `Valor inválido no cabeçalho "${rawName}".`;
    const kept = value === '' ? saved[name] : value;
    if (kept) out[name] = kept;
  }
  return out;
}

/** O site como sai pela API: sem campos internos e sem os valores dos cabeçalhos de liberação. */
export function publicSite<T extends Site | undefined>(site: T) {
  if (!site) return site;
  const { script_hosts: _hosts, last_timing: _timing, custom_headers: _headers, ...rest } = site;
  return { ...rest, custom_header_names: Object.keys(siteHeaders(site)) };
}
