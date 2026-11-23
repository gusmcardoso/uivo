import { auditSecurity, type Finding, scoreOf } from './checks/security.ts';
import { type Site, siteHeaders } from './db.ts';
import type { MonitorDeps } from './monitor.ts';
import { DAY, escapeHtml as esc } from './util.ts';

export const AUDIT_EVERY = DAY;
const KEEP_AUDITS = 30;

export interface AuditDeps extends MonitorDeps {
  audit?: typeof auditSecurity;
}

export interface StoredAudit {
  at: number;
  score: number;
  findings: Finding[];
  passed: string[];
  script_hosts: string[];
  error: string | null;
}

export function latestAudit(deps: Pick<MonitorDeps, 'db'>, siteId: number): StoredAudit | null {
  const row = deps.db
    .prepare('SELECT * FROM audits WHERE site_id = ? ORDER BY at DESC, id DESC LIMIT 1')
    .get(siteId) as
    | {
        at: number;
        score: number;
        findings: string;
        passed: string;
        script_hosts: string;
        error: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    at: row.at,
    score: row.score,
    findings: JSON.parse(row.findings),
    passed: JSON.parse(row.passed),
    script_hosts: JSON.parse(row.script_hosts),
    error: row.error,
  };
}

/**
 * Auditoria de segurança (1x ao dia, ou forçada pelo painel). Além das checagens passivas,
 * compara os scripts externos com a referência aceita: script novo de domínio desconhecido é
 * sinal clássico de site adulterado. Avisa no Telegram só os achados graves que são novos.
 */
export async function runSecurityAudit(
  site: Site,
  deps: AuditDeps,
  force = false,
): Promise<StoredAudit | null> {
  const { db } = deps;
  const now = (deps.now ?? Date.now)();
  if (!force && site.security_checked_at && now - site.security_checked_at < AUDIT_EVERY) return null;

  const result = await (deps.audit ?? auditSecurity)(site.url, fetch, siteHeaders(site));
  if (result.error) {
    // Site inacessível ou barrado por desafio: não muda a nota, mas registra o motivo para o painel.
    db.prepare('UPDATE sites SET security_checked_at = ?, security_error = ? WHERE id = ?').run(
      now,
      result.error,
      site.id,
    );
    return null;
  }

  const findings = [...result.findings];
  const baseline: string[] | null = site.script_hosts ? JSON.parse(site.script_hosts) : null;
  if (baseline === null) {
    db.prepare('UPDATE sites SET script_hosts = ? WHERE id = ?').run(
      JSON.stringify(result.scriptHosts),
      site.id,
    );
  } else {
    for (const host of result.scriptHosts.filter((h) => !baseline.includes(h))) {
      findings.push({
        id: `new-script:${host}`,
        severity: 'high',
        title: `Novo script externo: ${host}`,
        detail: 'A página passou a carregar um script de um domínio que não estava lá antes.',
        fix: 'Se foi você quem adicionou (analytics, chat, pixel), aceite os scripts atuais no painel. Se não, o site pode ter sido adulterado.',
      });
    }
  }

  const previous = latestAudit(deps, site.id);
  const score = scoreOf(findings);
  db.prepare(
    'INSERT INTO audits (site_id, at, score, findings, passed, script_hosts, error) VALUES (?, ?, ?, ?, ?, ?, NULL)',
  ).run(
    site.id,
    now,
    score,
    JSON.stringify(findings),
    JSON.stringify(result.passed),
    JSON.stringify(result.scriptHosts),
  );
  db.prepare(
    'UPDATE sites SET security_score = ?, security_checked_at = ?, security_error = NULL WHERE id = ?',
  ).run(score, now, site.id);
  db.prepare(
    `DELETE FROM audits WHERE site_id = ? AND id NOT IN
       (SELECT id FROM audits WHERE site_id = ? ORDER BY at DESC, id DESC LIMIT ?)`,
  ).run(site.id, site.id, KEEP_AUDITS);

  const known = new Set(previous?.findings.map((f) => f.id) ?? []);
  const fresh = findings.filter((f) => !known.has(f.id));
  for (const f of fresh) {
    deps.event?.('security.finding', {
      site: site.name,
      url: site.url,
      id: f.id,
      severity: f.severity,
      title: f.title,
    });
  }
  const serious = fresh.filter((f) => f.severity === 'critical' || f.severity === 'high');
  if (serious.length) {
    const lines = serious.map((f) => `• ${esc(f.title)}`).join('\n');
    await deps.notify(
      `🛡️ <b>${esc(site.name)}</b>: ${serious.length} problema(s) de segurança novo(s)\n${lines}\nNota de segurança: ${score}/100`,
    );
  }

  return { at: now, score, findings, passed: result.passed, script_hosts: result.scriptHosts, error: null };
}

/** Aceita os scripts externos atuais como referência e refaz a nota sem os alertas de script novo. */
export function acceptScripts(deps: Pick<MonitorDeps, 'db'>, site: Site): StoredAudit | null {
  const audit = latestAudit(deps, site.id);
  if (!audit) return null;
  const findings = audit.findings.filter((f) => !f.id.startsWith('new-script:'));
  const score = scoreOf(findings);
  deps.db
    .prepare('UPDATE sites SET script_hosts = ?, security_score = ? WHERE id = ?')
    .run(JSON.stringify(audit.script_hosts), score, site.id);
  deps.db
    .prepare(
      'UPDATE audits SET findings = ?, score = ? WHERE id = (SELECT id FROM audits WHERE site_id = ? ORDER BY at DESC, id DESC LIMIT 1)',
    )
    .run(JSON.stringify(findings), score, site.id);
  return { ...audit, findings, score };
}
