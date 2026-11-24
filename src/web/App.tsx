import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type Site } from './api.ts';
import { Login } from './components/Login.tsx';
import { Logo } from './components/Logo.tsx';
import { ReportDialog } from './components/ReportDialog.tsx';
import { scoreTone } from './components/SecurityPanel.tsx';
import { SiteDetail } from './components/SiteDetail.tsx';
import { SiteForm } from './components/SiteForm.tsx';
import { StatusPage } from './components/StatusPage.tsx';
import { daysUntil, expiryTone, formatUptime, hostOf, relativeTime } from './format.ts';

type Session = 'loading' | 'setup' | 'login' | 'in';
const REFRESH_MS = 30_000;

export function App() {
  if (window.location.pathname.replace(/\/+$/, '') === '/status') return <StatusPage />;
  return <Admin />;
}

function Admin() {
  const [session, setSession] = useState<Session>('loading');

  const loadSession = useCallback(async () => {
    const s = await api.session().catch(() => ({ authenticated: false, needsSetup: false }));
    setSession(s.authenticated ? 'in' : s.needsSetup ? 'setup' : 'login');
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  if (session === 'loading') return null;
  if (session !== 'in') return <Login setup={session === 'setup'} onDone={() => setSession('in')} />;
  return <Dashboard onLogout={() => setSession('login')} />;
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [editing, setEditing] = useState<Site | 'new' | null>(null);
  const [reporting, setReporting] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [checking, setChecking] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setSites(await api.sites());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onLogout();
    }
  }, [onLogout]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function checkNow(site: Site) {
    setChecking(site.id);
    await api.checkNow(site.id).catch(() => undefined);
    await load();
    setChecking(null);
  }

  async function remove(site: Site) {
    if (!window.confirm(`Remover "${site.name}" e todo o histórico?`)) return;
    await api.deleteSite(site.id);
    await load();
  }

  async function logout() {
    await api.logout().catch(() => undefined);
    onLogout();
  }

  const list = sites ?? [];
  const down = list.filter((s) => s.enabled && s.status === 'down').length;
  const warnings = list.filter((s) => {
    const ssl = daysUntil(s.ssl_expires_at);
    const dom = daysUntil(s.domain_expires_at);
    return (ssl !== null && ssl <= 14) || (dom !== null && dom <= 30);
  }).length;

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16">
      <header className="flex items-center justify-between py-6">
        <Logo />
        <div className="flex items-center gap-2">
          <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
            + Adicionar site
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setReporting(true)}
            disabled={!sites?.length}
          >
            Relatório
          </button>
          <a className="btn-ghost" href="/status" target="_blank" rel="noopener">
            Página de status
          </a>
          <button type="button" className="btn-ghost" onClick={logout}>
            Sair
          </button>
        </div>
      </header>

      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Summary label="Sites monitorados" value={list.length} />
        <Summary label="No ar" value={list.filter((s) => s.enabled && s.status === 'up').length} tone="ok" />
        <Summary label="Fora do ar" value={down} tone={down ? 'bad' : undefined} />
        <Summary label="Vencimentos próximos" value={warnings} tone={warnings ? 'warn' : undefined} />
      </section>

      {sites !== null && list.length === 0 && (
        <div className="card grid place-items-center gap-3 p-12 text-center">
          <p className="text-zinc-300">Nenhum site monitorado ainda.</p>
          <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
            Adicionar o primeiro site
          </button>
        </div>
      )}

      <section className="space-y-3">
        {list.map((site) => (
          <article key={site.id} className="card overflow-hidden">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 p-4 md:flex-nowrap">
              <button
                type="button"
                onClick={() => setOpen(open === site.id ? null : site.id)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                aria-expanded={open === site.id}
              >
                <StatusDot
                  status={
                    !site.enabled
                      ? 'paused'
                      : site.status === 'up' && site.last_challenge
                        ? 'limited'
                        : site.status
                  }
                />
                <div className="min-w-0">
                  <div className="truncate font-medium">{site.name}</div>
                  <div className="truncate text-xs text-zinc-500">
                    {hostOf(site.url)} · {site.enabled ? relativeTime(site.last_checked_at) : 'pausado'}
                    {site.status === 'down' && site.last_error ? ` · ${site.last_error}` : ''}
                    {site.status === 'up' && site.last_challenge
                      ? ` · conteúdo não verificável: firewall (${site.last_challenge})`
                      : ''}
                  </div>
                </div>
              </button>
              <div className="w-14 text-sm" title="Nota de saúde: disponibilidade, segurança e validade">
                <div className="text-xs text-zinc-500">Nota</div>
                <div
                  className={`text-lg font-semibold leading-tight tabular-nums ${scoreTone(site.health_score)}`}
                >
                  {site.health_score ?? '—'}
                </div>
              </div>
              <Metric label="24 h" value={formatUptime(site.uptime_24h)} />
              <Metric
                label="Resposta"
                value={site.last_response_ms === null ? '—' : `${site.last_response_ms} ms`}
              />
              <Expiry
                label="SSL"
                days={daysUntil(site.ssl_expires_at)}
                warn={14}
                title={site.ssl_error ?? site.ssl_issuer ?? undefined}
              />
              <Expiry
                label="Domínio"
                days={site.check_domain ? daysUntil(site.domain_expires_at) : null}
                warn={30}
                title={site.domain_error ?? undefined}
              />
              <div className="flex gap-1">
                <button
                  type="button"
                  className="btn-ghost px-2.5"
                  title="Verificar agora"
                  disabled={checking === site.id}
                  onClick={() => checkNow(site)}
                >
                  {checking === site.id ? '…' : '↻'}
                </button>
                <button
                  type="button"
                  className="btn-ghost px-2.5"
                  title="Editar"
                  onClick={() => setEditing(site)}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="btn-ghost px-2.5 hover:text-red-400"
                  title="Remover"
                  onClick={() => remove(site)}
                >
                  ✕
                </button>
              </div>
            </div>
            {open === site.id && <SiteDetail site={site} onChange={load} />}
          </article>
        ))}
      </section>

      {reporting && sites && <ReportDialog sites={sites} onClose={() => setReporting(false)} />}

      {editing && (
        <SiteForm
          site={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

const TONES = { ok: 'text-emerald-400', warn: 'text-amber-400', bad: 'text-red-400', none: 'text-zinc-500' };

function Summary({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone ? TONES[tone] : ''}`}>{value}</div>
    </div>
  );
}

function StatusDot({ status }: { status: Site['status'] | 'paused' | 'limited' }) {
  const color = {
    up: 'bg-emerald-400',
    limited: 'bg-emerald-400 ring-2 ring-amber-400/70',
    down: 'bg-red-500',
    unknown: 'bg-zinc-500',
    paused: 'bg-zinc-700',
  }[status];
  const label = {
    up: 'No ar',
    limited: 'No ar (conteúdo não verificado: desafio anti-bot)',
    down: 'Fora do ar',
    unknown: 'Aguardando',
    paused: 'Pausado',
  }[status];
  return (
    <span className="relative flex size-3 shrink-0" title={label}>
      {status === 'down' && (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-60" />
      )}
      <span className={`relative inline-flex size-3 rounded-full ${color}`} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="w-20 text-sm">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="font-medium tabular-nums">{value}</div>
    </div>
  );
}

function Expiry({
  label,
  days,
  warn,
  title,
}: {
  label: string;
  days: number | null;
  warn: number;
  title?: string;
}) {
  const tone = expiryTone(days, warn);
  return (
    <div className="w-20 text-sm" title={title}>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`font-medium tabular-nums ${TONES[tone]}`}>
        {days === null ? '—' : days < 0 ? 'vencido' : `${days} d`}
      </div>
    </div>
  );
}
