import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type Site } from './api.ts';
import {
  IconChevron,
  IconEdit,
  IconGlobe,
  IconLogout,
  IconPlus,
  IconRefresh,
  IconReport,
  IconTrash,
} from './components/Icons.tsx';
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
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <Logo />
          <nav className="flex items-center gap-1">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setReporting(true)}
              disabled={!sites?.length}
              title="Relatório mensal em PDF"
            >
              <IconReport />
              <span className="hidden sm:inline">Relatório</span>
            </button>
            <a
              className="btn-ghost"
              href="/status"
              target="_blank"
              rel="noopener"
              title="Página de status pública"
            >
              <IconGlobe />
              <span className="hidden sm:inline">Status</span>
            </a>
            <button type="button" className="btn-ghost" onClick={logout} title="Sair">
              <IconLogout />
              <span className="hidden sm:inline">Sair</span>
            </button>
            <button type="button" className="btn-primary ml-2" onClick={() => setEditing('new')}>
              <IconPlus />
              <span className="hidden sm:inline">Adicionar site</span>
            </button>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pt-6 pb-16">
        <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Summary label="Sites monitorados" value={list.length} />
          <Summary
            label="No ar"
            value={list.filter((s) => s.enabled && s.status === 'up').length}
            tone="ok"
          />
          <Summary label="Fora do ar" value={down} tone={down ? 'bad' : undefined} />
          <Summary label="Vencimentos próximos" value={warnings} tone={warnings ? 'warn' : undefined} />
        </section>

        {sites !== null && list.length === 0 && (
          <div className="card grid place-items-center gap-3 p-12 text-center">
            <p className="text-zinc-300">Nenhum site monitorado ainda.</p>
            <p className="max-w-sm text-sm text-zinc-500">
              Cadastre um endereço e o Uivo passa a checar disponibilidade, tempo de resposta, SSL, domínio e
              segurança.
            </p>
            <button type="button" className="btn-primary mt-2" onClick={() => setEditing('new')}>
              <IconPlus /> Adicionar o primeiro site
            </button>
          </div>
        )}

        {list.length > 0 && (
          <section className="card overflow-hidden">
            <div className="hidden grid-cols-[minmax(0,1fr)_4rem_5rem_5.5rem_4.5rem_4.5rem_6.5rem] items-center gap-4 border-b border-zinc-800/80 px-4 py-2.5 md:grid">
              <span className="label-xs">Site</span>
              <span className="label-xs" title="Disponibilidade, segurança e validade">
                Nota
              </span>
              <span className="label-xs">Uptime 24 h</span>
              <span className="label-xs">Resposta</span>
              <span className="label-xs">SSL</span>
              <span className="label-xs">Domínio</span>
              <span />
            </div>
            <ul className="divide-y divide-zinc-800/80">
              {list.map((site) => (
                <li key={site.id}>
                  <div
                    className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 px-4 py-3 transition-colors md:grid-cols-[minmax(0,1fr)_4rem_5rem_5.5rem_4.5rem_4.5rem_6.5rem] ${open === site.id ? 'bg-zinc-900/60' : 'hover:bg-zinc-900/40'}`}
                  >
                    <button
                      type="button"
                      onClick={() => setOpen(open === site.id ? null : site.id)}
                      className="flex min-w-0 items-center gap-3 text-left"
                      aria-expanded={open === site.id}
                    >
                      <span className="text-zinc-600">
                        <IconChevron open={open === site.id} />
                      </span>
                      <StatusDot status={statusOf(site)} />
                      <div className="min-w-0">
                        <div className="truncate font-medium text-zinc-100">{site.name}</div>
                        <div className="truncate text-xs text-zinc-500">
                          {hostOf(site.url)} · {site.enabled ? relativeTime(site.last_checked_at) : 'pausado'}
                          {site.status === 'down' && site.last_error ? (
                            <span className="text-red-400"> · {site.last_error}</span>
                          ) : null}
                          {site.status === 'up' && site.last_challenge ? (
                            <span className="text-amber-300">
                              {' '}
                              · conteúdo não verificável: firewall ({site.last_challenge})
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </button>
                    <div className="col-span-2 row-start-2 grid grid-cols-5 gap-3 md:col-span-1 md:row-start-auto md:contents">
                      <Cell label="Nota" title="Nota de saúde: disponibilidade, segurança e validade">
                        <span className={`font-semibold ${scoreTone(site.health_score)}`}>
                          {site.health_score ?? '—'}
                        </span>
                      </Cell>
                      <Cell label="Uptime 24 h">{formatUptime(site.uptime_24h)}</Cell>
                      <Cell label="Resposta">
                        {site.status === 'down' ? (
                          <span className="text-red-400">falhou</span>
                        ) : site.last_response_ms === null ? (
                          '—'
                        ) : (
                          `${site.last_response_ms} ms`
                        )}
                      </Cell>
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
                    </div>
                    <div className="col-start-2 row-start-1 flex justify-end gap-0.5 md:col-start-auto md:row-start-auto">
                      <button
                        type="button"
                        className="btn-icon"
                        title="Verificar agora"
                        aria-label={`Verificar ${site.name} agora`}
                        disabled={checking === site.id}
                        onClick={() => checkNow(site)}
                      >
                        <IconRefresh spinning={checking === site.id} />
                      </button>
                      <button
                        type="button"
                        className="btn-icon"
                        title="Editar"
                        aria-label={`Editar ${site.name}`}
                        onClick={() => setEditing(site)}
                      >
                        <IconEdit />
                      </button>
                      <button
                        type="button"
                        className="btn-icon hover:text-red-400"
                        title="Remover"
                        aria-label={`Remover ${site.name}`}
                        onClick={() => remove(site)}
                      >
                        <IconTrash />
                      </button>
                    </div>
                  </div>
                  {open === site.id && <SiteDetail site={site} onChange={load} />}
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

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

type DotStatus = Site['status'] | 'paused' | 'limited';
const statusOf = (site: Site): DotStatus =>
  !site.enabled ? 'paused' : site.status === 'up' && site.last_challenge ? 'limited' : site.status;

export const TONES = {
  ok: 'text-emerald-400',
  warn: 'text-amber-400',
  bad: 'text-red-400',
  none: 'text-zinc-500',
};

function Summary({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="card px-4 py-3.5">
      <div className="label-xs">{label}</div>
      <div className={`mt-1.5 text-3xl font-semibold tabular-nums ${tone ? TONES[tone] : 'text-zinc-100'}`}>
        {value}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: DotStatus }) {
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
    <span className="relative flex size-2.5 shrink-0" title={label}>
      {status === 'down' && (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-60" />
      )}
      <span className={`relative inline-flex size-2.5 rounded-full ${color}`} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function Cell({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <div className="text-sm tabular-nums" title={title}>
      <div className="label-xs md:hidden">{label}</div>
      <div className="text-zinc-200">{children}</div>
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
    <Cell label={label} title={title}>
      <span className={tone === 'none' ? 'text-zinc-500' : tone === 'ok' ? 'text-zinc-300' : TONES[tone]}>
        {days === null ? '—' : days < 0 ? 'vencido' : `${days} d`}
      </span>
    </Cell>
  );
}
