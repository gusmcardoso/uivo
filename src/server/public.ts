import { timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { Site } from './db.ts';
import { DAY } from './util.ts';

export const STATUS_DAYS = 90;

interface PublicOptions {
  metricsToken?: string;
  statusTitle?: string;
}

interface DayRow {
  site_id: number;
  day: number;
  uptime: number;
}

/** Rotas sem login: página de status (só sites marcados como públicos) e métricas do Prometheus. */
export function registerPublicRoutes(app: FastifyInstance, db: DatabaseSync, options: PublicOptions): void {
  // ─── Página de status pública ─────────────────────────────────────────────
  app.get('/api/public/status', async (_req, reply) => {
    const now = Date.now();
    const since = Math.floor((now - (STATUS_DAYS - 1) * DAY) / DAY) * DAY;
    const sites = db
      .prepare('SELECT * FROM sites WHERE public = 1 AND enabled = 1 ORDER BY name COLLATE NOCASE')
      .all() as unknown as Site[];
    const days = db
      .prepare(
        `SELECT c.site_id, (c.at / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS day, AVG(c.ok) * 100 AS uptime
         FROM checks c JOIN sites s ON s.id = c.site_id
         WHERE s.public = 1 AND c.at >= ? GROUP BY c.site_id, day`,
      )
      .all(DAY, DAY, since) as unknown as DayRow[];
    const uptime = db.prepare(
      'SELECT ROUND(AVG(ok) * 100, 2) AS u FROM checks WHERE site_id = ? AND at >= ?',
    );
    const openIncident = db.prepare(
      'SELECT started_at FROM incidents WHERE site_id = ? AND ended_at IS NULL ORDER BY id DESC',
    );

    reply.header('cache-control', 'public, max-age=30');
    return {
      title: options.statusTitle ?? 'Status dos serviços',
      updatedAt: now,
      days: STATUS_DAYS,
      sites: sites.map((s) => ({
        id: s.id,
        name: s.name,
        host: new URL(s.url).host,
        status: s.status,
        uptime: (uptime.get(s.id, since) as { u: number | null }).u,
        downSince: (openIncident.get(s.id) as { started_at: number } | undefined)?.started_at ?? null,
        // Um valor por dia (mais antigo → hoje); null = sem checagens naquele dia
        history: Array.from({ length: STATUS_DAYS }, (_, i) => {
          const day = since + i * DAY;
          const row = days.find((d) => d.site_id === s.id && d.day === day);
          return row ? Math.round(row.uptime * 100) / 100 : null;
        }),
      })),
    };
  });

  // ─── Métricas no formato Prometheus ───────────────────────────────────────
  app.get('/metrics', async (req, reply) => {
    const token = options.metricsToken;
    if (!token) return reply.code(404).send({ error: 'Defina METRICS_TOKEN para habilitar o /metrics.' });
    const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    const expected = Buffer.from(token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'Token inválido.' });
    }
    reply.type('text/plain; version=0.0.4; charset=utf-8');
    return renderMetrics(db);
  });
}

function label(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export function renderMetrics(db: DatabaseSync, now = Date.now()): string {
  const sites = db.prepare('SELECT * FROM sites WHERE enabled = 1').all() as unknown as Site[];
  const last = db.prepare('SELECT response_ms FROM checks WHERE site_id = ? ORDER BY at DESC LIMIT 1');
  const ratio = db.prepare('SELECT AVG(ok) AS r FROM checks WHERE site_id = ? AND at >= ?');

  const metrics: { name: string; help: string; type: string; lines: string[] }[] = [
    {
      name: 'uptrue_site_up',
      help: 'Site no ar (1), fora (0) ou aguardando (-1).',
      type: 'gauge',
      lines: [],
    },
    {
      name: 'uptrue_site_response_seconds',
      help: 'Tempo da última resposta HTTP.',
      type: 'gauge',
      lines: [],
    },
    {
      name: 'uptrue_site_uptime_ratio',
      help: 'Fração de checagens com sucesso na janela.',
      type: 'gauge',
      lines: [],
    },
    {
      name: 'uptrue_ssl_expiry_timestamp_seconds',
      help: 'Vencimento do certificado SSL (Unix).',
      type: 'gauge',
      lines: [],
    },
    {
      name: 'uptrue_domain_expiry_timestamp_seconds',
      help: 'Vencimento do domínio (Unix).',
      type: 'gauge',
      lines: [],
    },
  ];
  const [up, response, uptime, ssl, domain] = metrics;

  for (const s of sites) {
    const l = `site="${label(s.name)}",url="${label(s.url)}"`;
    up.lines.push(`uptrue_site_up{${l}} ${s.status === 'up' ? 1 : s.status === 'down' ? 0 : -1}`);
    const ms = (last.get(s.id) as { response_ms: number } | undefined)?.response_ms;
    if (ms !== undefined) response.lines.push(`uptrue_site_response_seconds{${l}} ${ms / 1000}`);
    for (const [window, span] of [
      ['24h', DAY],
      ['7d', 7 * DAY],
      ['30d', 30 * DAY],
    ] as const) {
      const r = (ratio.get(s.id, now - span) as { r: number | null }).r;
      if (r !== null) uptime.lines.push(`uptrue_site_uptime_ratio{${l},window="${window}"} ${r}`);
    }
    if (s.ssl_expires_at)
      ssl.lines.push(`uptrue_ssl_expiry_timestamp_seconds{${l}} ${Math.floor(s.ssl_expires_at / 1000)}`);
    if (s.domain_expires_at) {
      domain.lines.push(
        `uptrue_domain_expiry_timestamp_seconds{${l}} ${Math.floor(s.domain_expires_at / 1000)}`,
      );
    }
  }

  return `${metrics
    .map((m) => [`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} ${m.type}`, ...m.lines].join('\n'))
    .join('\n')}\n`;
}
