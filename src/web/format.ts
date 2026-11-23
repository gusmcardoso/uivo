const DAY = 86_400_000;

export function daysUntil(ts: number | null): number | null {
  return ts === null ? null : Math.floor((ts - Date.now()) / DAY);
}

/** Tom de cor por proximidade do vencimento. */
export function expiryTone(days: number | null, warn: number): 'ok' | 'warn' | 'bad' | 'none' {
  if (days === null) return 'none';
  if (days <= Math.min(7, warn / 2)) return 'bad';
  if (days <= warn) return 'warn';
  return 'ok';
}

export function formatUptime(value: number | null): string {
  if (value === null) return '—';
  return `${value.toFixed(Number.isInteger(value) ? 0 : 2).replace('.', ',')}%`;
}

export function relativeTime(ts: number | null): string {
  if (!ts) return 'nunca';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'agora';
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.round(h / 24)} d`;
}

export function duration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h ${min % 60} min` : `${Math.floor(h / 24)} d ${h % 24} h`;
}

export function dateTime(ts: number): string {
  return new Date(ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
