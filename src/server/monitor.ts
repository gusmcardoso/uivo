import type { DatabaseSync } from 'node:sqlite';
import type { Notifier } from './alerts/telegram.ts';
import { checkDomain } from './checks/domain.ts';
import { checkHttp, type HttpResult } from './checks/http.ts';
import { checkSsl } from './checks/ssl.ts';
import { getSite, type Site } from './db.ts';
import { DAY, escapeHtml as esc, formatDuration, HOUR } from './util.ts';

/** Falhas seguidas necessárias para declarar o site fora do ar (evita alarme falso). */
export const CONFIRM_FAILURES = 2;
const SSL_EVERY = 6 * HOUR;
const DOMAIN_EVERY = DAY;
const SSL_THRESHOLDS = [14, 3];
const DOMAIN_THRESHOLDS = [30, 7];

export interface MonitorDeps {
  db: DatabaseSync;
  notify: Notifier;
  http?: typeof checkHttp;
  ssl?: typeof checkSsl;
  domain?: typeof checkDomain;
  now?: () => number;
}

interface OpenIncident {
  id: number;
  started_at: number;
}

/** Executa a checagem HTTP, grava o resultado e trata as mudanças de estado (queda/volta). */
export async function runSiteCheck(site: Site, deps: MonitorDeps): Promise<HttpResult> {
  const { db, notify } = deps;
  const result = await (deps.http ?? checkHttp)(site.url, { keyword: site.keyword });
  const now = (deps.now ?? Date.now)();

  db.prepare(
    'INSERT INTO checks (site_id, at, ok, status_code, response_ms, error) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(site.id, now, result.ok ? 1 : 0, result.statusCode, result.responseMs, result.error);

  if (result.ok) {
    if (site.status === 'down') {
      const incident = db
        .prepare(
          'SELECT id, started_at FROM incidents WHERE site_id = ? AND ended_at IS NULL ORDER BY id DESC',
        )
        .get(site.id) as unknown as OpenIncident | undefined;
      if (incident) db.prepare('UPDATE incidents SET ended_at = ? WHERE id = ?').run(now, incident.id);
      const duration = incident ? `\nFicou fora por ${formatDuration(now - incident.started_at)}` : '';
      await notify(`✅ <b>${esc(site.name)}</b> voltou ao ar\n${esc(site.url)}${duration}`);
    }
    db.prepare(
      "UPDATE sites SET status = 'up', fail_streak = 0, last_checked_at = ?, last_error = NULL WHERE id = ?",
    ).run(now, site.id);
    return result;
  }

  const streak = site.fail_streak + 1;
  let status = site.status;
  if (streak >= CONFIRM_FAILURES && site.status !== 'down') {
    status = 'down';
    db.prepare('INSERT INTO incidents (site_id, started_at, reason) VALUES (?, ?, ?)').run(
      site.id,
      now,
      result.error,
    );
    await notify(
      `🔴 <b>${esc(site.name)}</b> está fora do ar\n${esc(site.url)}\nMotivo: ${esc(result.error ?? 'desconhecido')}`,
    );
  }
  db.prepare(
    'UPDATE sites SET status = ?, fail_streak = ?, last_checked_at = ?, last_error = ? WHERE id = ?',
  ).run(status, streak, now, result.error, site.id);
  return result;
}

/** Certificado SSL (a cada 6 h) e vencimento do domínio (1x ao dia), com aviso por limite de dias. */
export async function runExpiryChecks(site: Site, deps: MonitorDeps): Promise<void> {
  const { db } = deps;
  const now = (deps.now ?? Date.now)();

  if (site.url.startsWith('https:') && (!site.ssl_checked_at || now - site.ssl_checked_at >= SSL_EVERY)) {
    const ssl = await (deps.ssl ?? checkSsl)(site.url);
    db.prepare(
      'UPDATE sites SET ssl_expires_at = ?, ssl_issuer = ?, ssl_error = ?, ssl_checked_at = ? WHERE id = ?',
    ).run(ssl.expiresAt, ssl.issuer, ssl.error, now, site.id);
    if (ssl.expiresAt) await warnExpiry(deps, site, 'ssl', ssl.expiresAt, SSL_THRESHOLDS, now);
  }

  if (site.check_domain && (!site.domain_checked_at || now - site.domain_checked_at >= DOMAIN_EVERY)) {
    const domain = await (deps.domain ?? checkDomain)(site.url);
    db.prepare(
      'UPDATE sites SET domain_expires_at = ?, domain_error = ?, domain_checked_at = ? WHERE id = ?',
    ).run(domain.expiresAt, domain.error, now, site.id);
    if (domain.expiresAt) await warnExpiry(deps, site, 'domain', domain.expiresAt, DOMAIN_THRESHOLDS, now);
  }
}

async function warnExpiry(
  deps: MonitorDeps,
  site: Site,
  kind: 'ssl' | 'domain',
  expiresAt: number,
  thresholds: number[],
  now: number,
): Promise<void> {
  const days = Math.floor((expiresAt - now) / DAY);
  const crossed = thresholds.filter((t) => days <= t);
  if (crossed.length === 0) {
    // Renovado (ou ainda longe): libera os avisos para o próximo ciclo.
    deps.db.prepare('DELETE FROM notices WHERE site_id = ? AND kind = ?').run(site.id, kind);
    return;
  }
  const threshold = Math.min(...crossed);
  const inserted = deps.db
    .prepare('INSERT OR IGNORE INTO notices (site_id, kind, threshold, sent_at) VALUES (?, ?, ?, ?)')
    .run(site.id, kind, threshold, now);
  if (!inserted.changes) return;
  const what = kind === 'ssl' ? 'Certificado SSL' : 'Domínio';
  const when = days < 0 ? 'venceu' : days === 0 ? 'vence hoje' : `vence em ${days} dia(s)`;
  await deps.notify(`⚠️ ${what} de <b>${esc(site.name)}</b> ${when}\n${esc(site.url)}`);
}

export interface SchedulerOptions extends MonitorDeps {
  concurrency: number;
  retentionDays: number;
  tickMs?: number;
  log: { error: (err: unknown) => void };
}

/** Agendador: a cada tick dispara os sites vencidos, respeitando o limite de concorrência. */
export function startScheduler(options: SchedulerOptions): {
  stop: () => void;
  runNow: (id: number) => Promise<void>;
} {
  const { db, log } = options;
  const running = new Set<number>();

  const run = async (id: number) => {
    const site = getSite(db, id);
    if (!site || running.has(id)) return;
    running.add(id);
    try {
      await runSiteCheck(site, options);
      await runExpiryChecks(site, options);
    } catch (err) {
      log.error(err);
    } finally {
      running.delete(id);
    }
  };

  const tick = () => {
    const due = db
      .prepare(
        `SELECT id FROM sites WHERE enabled = 1
           AND (last_checked_at IS NULL OR last_checked_at + interval_sec * 1000 <= ?)
         ORDER BY last_checked_at IS NOT NULL, last_checked_at`,
      )
      .all(Date.now()) as unknown as { id: number }[];
    for (const { id } of due) {
      if (running.size >= options.concurrency) break;
      if (!running.has(id)) void run(id);
    }
  };

  const purge = () => {
    db.prepare('DELETE FROM checks WHERE at < ?').run(Date.now() - options.retentionDays * DAY);
  };

  const tickTimer = setInterval(tick, options.tickMs ?? 5_000);
  const purgeTimer = setInterval(purge, HOUR);
  tick();
  purge();

  return {
    stop: () => {
      clearInterval(tickTimer);
      clearInterval(purgeTimer);
    },
    runNow: run,
  };
}
