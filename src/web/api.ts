export type Status = 'up' | 'down' | 'unknown';

export interface Site {
  id: number;
  name: string;
  url: string;
  interval_sec: number;
  keyword: string | null;
  enabled: number;
  check_domain: number;
  public: number;
  security_score: number | null;
  security_checked_at: number | null;
  /** Provedor do desafio anti-bot da última checagem (conteúdo não verificado). */
  last_challenge: string | null;
  custom_header_names: string[];
  /** cliente (agrupa os sites na lista) */
  client: string | null;
  health_score: number | null;
  status: Status;
  last_checked_at: number | null;
  last_error: string | null;
  ssl_expires_at: number | null;
  ssl_issuer: string | null;
  ssl_error: string | null;
  domain_expires_at: number | null;
  domain_error: string | null;
  uptime_24h: number | null;
  uptime_7d: number | null;
  uptime_30d: number | null;
  last_response_ms: number | null;
}

export interface SitePayload {
  name: string;
  url: string;
  interval_sec: number;
  keyword: string | null;
  enabled: boolean;
  check_domain: boolean;
  public: boolean;
  client?: string | null;
  /** Valor vazio mantém o segredo já salvo. */
  headers?: Record<string, string>;
}

export type Phase = 'redirect' | 'dns' | 'connect' | 'tls' | 'wait' | 'download';
export type PhaseTimes = Record<Phase, number | null>;

export interface CheckPoint extends PhaseTimes {
  t: number;
  ms: number;
  ok: number;
  n: number;
}

export interface TimingSummary {
  samples: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  average: (PhaseTimes & { bytes: number | null }) | null;
  last: {
    at: number;
    statusCode: number | null;
    timings: Record<Phase | 'total', number>;
    bytes: number | null;
    encoding: string | null;
    redirects: number;
    finalUrl: string | null;
  } | null;
}

interface WindowStats {
  n: number;
  fails: number;
  avg: number | null;
  min: number | null;
  max: number | null;
}

/** Um intervalo do gráfico comparado com o mesmo horário em dias anteriores. */
export interface Moment {
  at: number;
  span: number;
  current: WindowStats;
  yesterday: WindowStats;
  lastWeek: WindowStats;
  typical: { avg: number | null; days: number };
  incidents: { started_at: number; ended_at: number | null; reason: string | null }[];
}

export interface OverviewSite {
  id: number;
  /** 24 faixas de 1 h (a última é a hora atual); null = sem checagens na hora */
  hours: ({ uptime: number; ms: number | null } | null)[];
  responseMs: number | null;
  /** variação da resposta média contra as 24 h anteriores, em % */
  responseChange: number | null;
  incidents24h: number;
}

export interface Overview {
  from: number;
  checks24h: number;
  incidents24h: number;
  sites: OverviewSite[];
}

export interface AppNotification {
  id: number;
  site_id: number | null;
  site_name: string | null;
  at: number;
  kind: 'down' | 'up' | 'unstable' | 'challenge' | 'expiry';
  level: 'bad' | 'warn' | 'good' | 'info';
  title: string;
  detail: string | null;
}

export interface Incident {
  id: number;
  started_at: number;
  ended_at: number | null;
  reason: string | null;
}

export interface PublicStatus {
  title: string;
  updatedAt: number;
  days: number;
  sites: {
    id: number;
    name: string;
    host: string;
    status: Status;
    uptime: number | null;
    downSince: number | null;
    history: (number | null)[];
  }[];
}

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface SecurityAudit {
  at: number | null;
  score: number | null;
  findings: { id: string; severity: Severity; title: string; detail: string; fix: string }[];
  passed: string[];
  script_hosts: string[];
  /** Motivo de a auditoria mais recente não ter sido feita (ex.: desafio anti-bot). */
  error: string | null;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? data.message ?? `Erro ${res.status}`);
  return data as T;
}

export const api = {
  session: () => request<{ authenticated: boolean; needsSetup: boolean }>('GET', '/api/session'),
  setup: (email: string, password: string) => request('POST', '/api/setup', { email, password }),
  login: (email: string, password: string) => request('POST', '/api/login', { email, password }),
  logout: () => request('POST', '/api/logout', {}),
  sites: () => request<Site[]>('GET', '/api/sites'),
  overview: () => request<Overview>('GET', '/api/overview'),
  notifications: (after?: number) =>
    request<{ items: AppNotification[]; unread: number; lastId: number }>(
      'GET',
      `/api/notifications${after === undefined ? '' : `?after=${after}`}`,
    ),
  markNotificationsRead: (upTo?: number) =>
    request<{ unread: number }>('POST', '/api/notifications/read', upTo === undefined ? {} : { upTo }),
  createSite: (body: SitePayload) => request<Site>('POST', '/api/sites', body),
  updateSite: (id: number, body: Partial<SitePayload>) => request<Site>('PATCH', `/api/sites/${id}`, body),
  deleteSite: (id: number) => request('DELETE', `/api/sites/${id}`),
  checkNow: (id: number) => request<Site>('POST', `/api/sites/${id}/check`, {}),
  checks: (id: number, range: string) =>
    request<CheckPoint[]>('GET', `/api/sites/${id}/checks?range=${range}`),
  security: (id: number) => request<SecurityAudit>('GET', `/api/sites/${id}/security`),
  runSecurity: (id: number) => request<SecurityAudit>('POST', `/api/sites/${id}/security`, {}),
  acceptScripts: (id: number) =>
    request<SecurityAudit>('POST', `/api/sites/${id}/security/accept-scripts`, {}),
  publicStatus: () => request<PublicStatus>('GET', '/api/public/status'),
  timing: (id: number, range: string) =>
    request<TimingSummary>('GET', `/api/sites/${id}/timing?range=${range}`),
  incidents: (id: number) => request<Incident[]>('GET', `/api/sites/${id}/incidents`),
  moment: (id: number, at: number, span: number) =>
    request<Moment>('GET', `/api/sites/${id}/moment?at=${at}&span=${span}`),
};
