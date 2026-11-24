import type { Site } from './api.ts';

/*
 * Ordem da lista de sites: por situação (o que está quebrado primeiro) ou por nome, e o
 * agrupamento por cliente. Funções puras, testadas em test/sort.test.ts.
 */

export type SortMode = 'situacao' | 'nome';

const DAY = 86_400_000;
const daysUntil = (ts: number | null, now: number) => (ts === null ? null : Math.floor((ts - now) / DAY));

/** 0 = fora do ar, 1 = pedindo atenção, 2 = no ar, 3 = aguardando, 4 = pausado. */
export function severity(site: Site, now = Date.now()): number {
  if (!site.enabled) return 4;
  if (site.status === 'down') return 0;
  const ssl = daysUntil(site.ssl_expires_at, now);
  const dom = site.check_domain ? daysUntil(site.domain_expires_at, now) : null;
  const attention =
    (ssl !== null && ssl <= 14) ||
    (dom !== null && dom <= 30) ||
    (site.security_score !== null && site.security_score < 70) ||
    Boolean(site.last_challenge) ||
    (site.uptime_24h !== null && site.uptime_24h < 99.5);
  if (attention) return 1;
  return site.status === 'up' ? 2 : 3;
}

const byName = (a: Site, b: Site) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' });

export function sortSites(sites: Site[], mode: SortMode, now = Date.now()): Site[] {
  const list = [...sites];
  if (mode === 'nome') return list.sort(byName);
  return list.sort((a, b) => severity(a, now) - severity(b, now) || byName(a, b));
}

export interface SiteGroup {
  /** null = sites sem cliente */
  client: string | null;
  sites: Site[];
  down: number;
  attention: number;
}

/** Agrupa por cliente: em ordem alfabética, com "sem cliente" por último; dentro, a ordem escolhida. */
export function groupByClient(sites: Site[], mode: SortMode, now = Date.now()): SiteGroup[] {
  const map = new Map<string | null, Site[]>();
  for (const s of sites) {
    const key = s.client?.trim() || null;
    map.set(key, [...(map.get(key) ?? []), s]);
  }
  return [...map.entries()]
    .sort(([a], [b]) =>
      a === null ? 1 : b === null ? -1 : a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }),
    )
    .map(([client, list]) => ({
      client,
      sites: sortSites(list, mode, now),
      down: list.filter((s) => severity(s, now) === 0).length,
      attention: list.filter((s) => severity(s, now) === 1).length,
    }));
}

/** Clientes já usados (para sugerir no formulário e filtrar o relatório). */
export const clientsOf = (sites: Site[]) =>
  [...new Set(sites.map((s) => s.client?.trim()).filter((c): c is string => Boolean(c)))].sort((a, b) =>
    a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }),
  );
