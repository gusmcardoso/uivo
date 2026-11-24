import type { DatabaseSync } from 'node:sqlite';
import { latestAudit } from '../audit.ts';
import type { Finding } from '../checks/security.ts';
import type { Site } from '../db.ts';
import { healthScore } from '../health.ts';
import { DAY } from '../util.ts';

export interface ReportIncident {
  start: number;
  end: number | null;
  /** Duração dentro do período (quedas que atravessam a virada do mês são cortadas). */
  durationMs: number;
  reason: string | null;
}

export interface ReportSite {
  id: number;
  name: string;
  url: string;
  healthScore: number | null;
  securityScore: number | null;
  /** Uptime do período, em %, ou null se não houve checagem. */
  uptime: number | null;
  /** Checagens feitas ÷ esperadas pelo intervalo configurado, em % (0–100). */
  coverage: number;
  checks: number;
  avgResponseMs: number | null;
  p95ResponseMs: number | null;
  downtimeMs: number;
  incidents: ReportIncident[];
  /** Uptime de cada dia do período (null = dia sem checagens). */
  daily: (number | null)[];
  sslDays: number | null;
  domainDays: number | null;
  findings: Finding[];
}

export interface ReportData {
  title: string;
  author: string | null;
  from: number;
  to: number;
  generatedAt: number;
  sites: ReportSite[];
}

/** Início e fim (exclusivo) do mês no fuso do servidor (TZ, ex.: America/Sao_Paulo). */
export function monthRange(year: number, month: number): { from: number; to: number } {
  return { from: new Date(year, month - 1, 1).getTime(), to: new Date(year, month, 1).getTime() };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1];
}

export function buildReport(
  db: DatabaseSync,
  options: {
    year: number;
    month: number;
    siteIds?: number[];
    title?: string;
    author?: string | null;
    now?: number;
  },
): ReportData {
  const now = options.now ?? Date.now();
  const { from, to } = monthRange(options.year, options.month);
  // Período que já passou: um mês em andamento vai só até agora (cobertura e quedas não contam o futuro)
  const end = Math.min(to, now);

  const all = db.prepare('SELECT * FROM sites ORDER BY name COLLATE NOCASE').all() as unknown as Site[];
  const sites = options.siteIds?.length ? all.filter((s) => options.siteIds?.includes(s.id)) : all;

  // Dias do período (meia-noite local de cada dia)
  const days: number[] = [];
  for (let d = new Date(from); d.getTime() < to; d.setDate(d.getDate() + 1)) days.push(d.getTime());

  return {
    title: options.title?.trim() || 'Relatório de monitoramento',
    author: options.author ?? null,
    from,
    to,
    generatedAt: now,
    sites: sites.map((site) => {
      const rows = db
        .prepare(
          'SELECT at, ok, response_ms FROM checks WHERE site_id = ? AND at >= ? AND at < ? ORDER BY at',
        )
        .all(site.id, from, end) as { at: number; ok: number; response_ms: number }[];
      const okRows = rows.filter((r) => r.ok);
      const times = okRows.map((r) => r.response_ms).sort((a, b) => a - b);

      const expected = Math.max(
        1,
        Math.floor((end - Math.max(from, Math.min(site.created_at, end))) / (site.interval_sec * 1000)),
      );
      const coverage = end <= from ? 0 : Math.min(100, Math.round((rows.length / expected) * 1000) / 10);

      const incidents = (
        db
          .prepare(
            `SELECT started_at, ended_at, reason FROM incidents
             WHERE site_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at`,
          )
          .all(site.id, end, from) as { started_at: number; ended_at: number | null; reason: string | null }[]
      ).map((i) => ({
        start: i.started_at,
        end: i.ended_at,
        durationMs: Math.max(0, Math.min(i.ended_at ?? end, end) - Math.max(i.started_at, from)),
        reason: i.reason,
      }));

      const daily = days.map((dayStart, idx) => {
        const dayEnd = days[idx + 1] ?? to;
        const inDay = rows.filter((r) => r.at >= dayStart && r.at < dayEnd);
        return inDay.length ? (inDay.filter((r) => r.ok).length / inDay.length) * 100 : null;
      });

      const uptime7d = (() => {
        const r = db
          .prepare('SELECT AVG(ok) * 100 AS u FROM checks WHERE site_id = ? AND at >= ?')
          .get(site.id, now - 7 * DAY) as {
          u: number | null;
        };
        return r.u;
      })();
      const audit = latestAudit({ db }, site.id);
      const daysTo = (ts: number | null) => (ts === null ? null : Math.floor((ts - now) / DAY));

      return {
        id: site.id,
        name: site.name,
        url: site.url,
        healthScore: healthScore(site, uptime7d, now),
        securityScore: site.security_score,
        uptime: rows.length ? Math.round((okRows.length / rows.length) * 10000) / 100 : null,
        coverage,
        checks: rows.length,
        avgResponseMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
        p95ResponseMs: percentile(times, 95),
        downtimeMs: incidents.reduce((sum, i) => sum + i.durationMs, 0),
        incidents,
        daily,
        sslDays: site.url.startsWith('https:') ? daysTo(site.ssl_expires_at) : null,
        domainDays: site.check_domain ? daysTo(site.domain_expires_at) : null,
        findings: audit?.findings ?? [],
      };
    }),
  };
}
