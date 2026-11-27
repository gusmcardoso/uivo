/*
 * Visitantes do site pelo Web Analytics da Vercel (API oficial de consulta).
 *
 * O token fica só no servidor (variável VERCEL_TOKEN) e nunca sai pela API do painel. Cada site
 * aponta para um projeto da Vercel como "projeto" ou "time/projeto". As respostas ficam 10 minutos
 * em memória, para não gastar o limite da Vercel a cada F5.
 */

const API = 'https://api.vercel.com/v1/query/web-analytics/visits';
const TTL_MS = 10 * 60_000;
const ERROR_TTL_MS = 60_000;
const TIMEOUT_MS = 8_000;

/** "projeto" ou "time/projeto" (time = id "team_..." ou o slug do time). */
export const VERCEL_PROJECT_PATTERN = '^([A-Za-z0-9_-]{1,64}/)?[A-Za-z0-9][A-Za-z0-9._-]{0,99}$';
const projectRe = new RegExp(VERCEL_PROJECT_PATTERN);

export interface VisitorsDay {
  /** AAAA-MM-DD (dia em UTC, como a Vercel agrupa) */
  date: string;
  visitors: number;
  pageviews: number;
}

export interface VisitorsMonth {
  /** AAAA-MM */
  month: string;
  visitors: number;
  pageviews: number;
}

export interface Visitors {
  /** últimos 30 dias, um item por dia (dias sem visita entram com zero) */
  days: VisitorsDay[];
  /** visitantes únicos do mês corrente */
  thisMonth: { visitors: number; pageviews: number };
  /** últimos 12 meses; vazio quando o plano não guarda tanto histórico (Hobby guarda 1 mês) */
  months: VisitorsMonth[];
  monthsLimited: boolean;
  fetchedAt: number;
}

export type VisitorsResult =
  | { configured: false; reason: 'token' | 'project' }
  | { configured: true; error: string }
  | ({ configured: true; error: null } & Visitors);

export class VercelError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface VercelClientOptions {
  token?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const ymd = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export function parseProject(value: string): { project: string; team: string | null } | null {
  const v = value.trim();
  if (!projectRe.test(v)) return null;
  const slash = v.indexOf('/');
  return slash < 0 ? { project: v, team: null } : { project: v.slice(slash + 1), team: v.slice(0, slash) };
}

/** Mensagem para o painel, sem repetir o que a Vercel respondeu (pode conter detalhes internos). */
function friendly(status: number): string {
  if (status === 401 || status === 403) return 'O token da Vercel não tem acesso a este projeto.';
  if (status === 404) return 'Projeto não encontrado na Vercel, ou o Web Analytics está desligado nele.';
  if (status === 402) return 'O plano da Vercel não permite esta consulta.';
  if (status === 429) return 'Limite de consultas da Vercel atingido. Tente de novo em alguns minutos.';
  return 'A Vercel não respondeu agora. Tente de novo em instantes.';
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

export function vercelClient(options: VercelClientOptions) {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { until: number; value: VisitorsResult }>();

  async function query(
    kind: 'count' | 'aggregate',
    target: { project: string; team: string | null },
    params: Record<string, string>,
  ) {
    const url = new URL(`${API}/${kind}`);
    url.searchParams.set('projectId', target.project);
    if (target.team) url.searchParams.set(target.team.startsWith('team_') ? 'teamId' : 'slug', target.team);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: { authorization: `Bearer ${options.token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new VercelError(friendly(0), 0);
    }
    if (!res.ok) throw new VercelError(friendly(res.status), res.status);
    const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
    if (!body || typeof body !== 'object') throw new VercelError(friendly(0), 0);
    return body.data;
  }

  async function load(target: { project: string; team: string | null }): Promise<Visitors> {
    const t = now();
    const today = ymd(t);
    const start30 = ymd(t - 29 * 86_400_000);
    const d = new Date(t);
    const monthStart = `${today.slice(0, 7)}-01`;
    const start12 = ymd(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 11, 1));

    const [daily, month, monthly] = await Promise.all([
      query('aggregate', target, { since: start30, until: today, by: 'day', limit: '100' }),
      query('count', target, { since: monthStart, until: today }),
      // histórico mensal: no plano Hobby a Vercel só guarda 1 mês, então a falha aqui não é erro
      query('aggregate', target, { since: start12, until: today, by: 'month', limit: '100' }).catch(
        (err: unknown) => {
          if (err instanceof VercelError && (err.status === 401 || err.status === 403)) throw err;
          return null;
        },
      ),
    ]);

    const byDay = new Map<string, { visitors: number; pageviews: number }>();
    for (const row of Array.isArray(daily) ? daily : []) {
      const ts = typeof row?.timestamp === 'string' ? row.timestamp.slice(0, 10) : null;
      if (ts) byDay.set(ts, { visitors: num(row.visitors), pageviews: num(row.pageviews) });
    }
    const days: VisitorsDay[] = Array.from({ length: 30 }, (_, i) => {
      const date = ymd(t - (29 - i) * 86_400_000);
      return { date, ...(byDay.get(date) ?? { visitors: 0, pageviews: 0 }) };
    });

    const months: VisitorsMonth[] = (Array.isArray(monthly) ? monthly : [])
      .filter((row) => typeof row?.timestamp === 'string')
      .map((row) => ({
        month: String(row.timestamp).slice(0, 7),
        visitors: num(row.visitors),
        pageviews: num(row.pageviews),
      }));
    const m = (month ?? {}) as { visitors?: unknown; pageviews?: unknown };

    return {
      days,
      thisMonth: { visitors: num(m.visitors), pageviews: num(m.pageviews) },
      months,
      // menos de 2 meses de histórico: não vale desenhar o gráfico mensal
      monthsLimited: months.length < 2,
      fetchedAt: t,
    };
  }

  return {
    get configured() {
      return Boolean(options.token);
    },

    async visitors(projectSetting: string | null): Promise<VisitorsResult> {
      if (!options.token) return { configured: false, reason: 'token' };
      const target = projectSetting ? parseProject(projectSetting) : null;
      if (!target) return { configured: false, reason: 'project' };
      const key = `${target.team ?? ''}/${target.project}`;
      const hit = cache.get(key);
      if (hit && hit.until > now()) return hit.value;
      let value: VisitorsResult;
      let ttl = TTL_MS;
      try {
        value = { configured: true, error: null, ...(await load(target)) };
      } catch (err) {
        value = { configured: true, error: err instanceof VercelError ? err.message : friendly(0) };
        ttl = ERROR_TTL_MS;
      }
      cache.set(key, { until: now() + ttl, value });
      return value;
    },
  };
}

export type VercelClient = ReturnType<typeof vercelClient>;
