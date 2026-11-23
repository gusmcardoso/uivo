import type { Site } from './db.ts';
import { DAY } from './util.ts';

/**
 * Nota de saúde (0–100):
 *   disponibilidade 40 (uptime de 7 dias: 95% → 0, 100% → 40)
 *   segurança       40 (nota da última auditoria)
 *   validade        20 (SSL 10 + domínio 10: ok, perto de vencer = metade, vencido = 0)
 * Sem auditoria ainda, a nota é calculada só com disponibilidade e validade.
 */
export function healthScore(
  site: Pick<
    Site,
    'url' | 'check_domain' | 'ssl_expires_at' | 'ssl_error' | 'domain_expires_at' | 'security_score'
  >,
  uptime7d: number | null,
  now = Date.now(),
): number | null {
  if (uptime7d === null && site.security_score === null) return null;

  const availability = uptime7d === null ? 40 : Math.min(1, Math.max(0, (uptime7d - 95) / 5)) * 40;

  const days = (ts: number | null) => (ts === null ? null : (ts - now) / DAY);
  let ssl = 0;
  if (site.url.startsWith('https:')) {
    const d = days(site.ssl_expires_at);
    if (d === null) ssl = site.ssl_error ? 0 : 10;
    else ssl = d < 0 ? 0 : d <= 14 ? 5 : 10;
  }
  let domain = 10;
  if (site.check_domain && site.domain_expires_at !== null) {
    const d = days(site.domain_expires_at) ?? 0;
    domain = d < 0 ? 0 : d <= 30 ? 5 : 10;
  }
  const validity = ssl + domain;

  if (site.security_score === null) return Math.round(((availability + validity) / 60) * 100);
  return Math.round(availability + (site.security_score / 100) * 40 + validity);
}
