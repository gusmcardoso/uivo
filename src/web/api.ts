export type Status = 'up' | 'down' | 'unknown';

export interface Site {
  id: number;
  name: string;
  url: string;
  interval_sec: number;
  keyword: string | null;
  enabled: number;
  check_domain: number;
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
}

export interface CheckPoint {
  t: number;
  ms: number;
  ok: number;
  n: number;
}

export interface Incident {
  id: number;
  started_at: number;
  ended_at: number | null;
  reason: string | null;
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
  createSite: (body: SitePayload) => request<Site>('POST', '/api/sites', body),
  updateSite: (id: number, body: Partial<SitePayload>) => request<Site>('PATCH', `/api/sites/${id}`, body),
  deleteSite: (id: number) => request('DELETE', `/api/sites/${id}`),
  checkNow: (id: number) => request<Site>('POST', `/api/sites/${id}/check`, {}),
  checks: (id: number, range: string) =>
    request<CheckPoint[]>('GET', `/api/sites/${id}/checks?range=${range}`),
  incidents: (id: number) => request<Incident[]>('GET', `/api/sites/${id}/incidents`),
};
