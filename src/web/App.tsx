import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type Overview, type OverviewSite, type Site } from './api.ts';
import { Footer } from './components/Footer.tsx';
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
import { PixelBackground } from './components/PixelBackground.tsx';
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

  return (
    <>
      <PixelBackground />
      {session === 'loading' ? null : session !== 'in' ? (
        <Login setup={session === 'setup'} onDone={() => setSession('in')} />
      ) : (
        <Dashboard onLogout={() => setSession('login')} />
      )}
    </>
  );
}

export const TONES = {
  ok: 'text-emerald-400',
  warn: 'text-amber-400',
  bad: 'text-red-400',
  none: 'text-zinc-500',
};

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [editing, setEditing] = useState<Site | 'new' | null>(null);
  const [reporting, setReporting] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [checking, setChecking] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, o] = await Promise.all([api.sites(), api.overview()]);
      setSites(s);
      setOverview(o);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onLogout();
    }
  }, [onLogout]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  /** Logo: volta para o início (nenhum site aberto, topo da página). */
  function goHome() {
    setOpen(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

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
  const bySite = new Map((overview?.sites ?? []).map((o) => [o.id, o]));

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b border-zinc-800/80 bg-zinc-950/70 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <button
            type="button"
            onClick={goHome}
            className="rounded-sm outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-brand/60"
            aria-label="Uivo: voltar ao início"
            title="Início"
          >
            <Logo />
          </button>
          <nav className="flex items-center gap-1">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setReporting(true)}
              disabled={!sites?.length}
              title="Relatório mensal em PDF"
            >
              <IconReport />
              <span className="hidden sm:inline">relatório</span>
            </button>
            <a
              className="btn-ghost"
              href="/status"
              target="_blank"
              rel="noopener"
              title="Página de status pública"
            >
              <IconGlobe />
              <span className="hidden sm:inline">status</span>
            </a>
            <button type="button" className="btn-ghost" onClick={logout} title="Sair">
              <IconLogout />
              <span className="hidden sm:inline">sair</span>
            </button>
            <button type="button" className="btn-primary ml-1.5" onClick={() => setEditing('new')}>
              <IconPlus />
              <span className="hidden sm:inline">adicionar site</span>
            </button>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-6 pb-10">
        {sites !== null && list.length === 0 ? (
          <div className="card grid place-items-center gap-3 p-12 text-center">
            <p className="font-mono text-sm text-zinc-300">
              $ uivo status<span className="cursor-blink">_</span>
            </p>
            <p className="max-w-sm text-sm text-zinc-500">
              Nenhum site monitorado ainda. Cadastre um endereço e o Uivo passa a checar disponibilidade,
              tempo de resposta, SSL, domínio e segurança.
            </p>
            <button type="button" className="btn-primary mt-2" onClick={() => setEditing('new')}>
              <IconPlus /> adicionar o primeiro site
            </button>
          </div>
        ) : (
          sites && <Summary sites={list} overview={overview} onOpen={(id) => setOpen(id)} />
        )}

        {list.length > 0 && (
          <section className="card mt-4 overflow-hidden">
            <div className="flex items-center justify-between border-b border-zinc-800/80 px-4 py-2.5">
              <span className="panel-title">{`// sites (${list.length})`}</span>
              <span className="panel-title hidden md:inline">últimas 24 h, hora a hora</span>
            </div>
            <div className="hidden grid-cols-[minmax(0,1fr)_10rem_4.5rem_6rem_3.5rem_4rem_4rem_6.5rem] items-center gap-4 border-b border-zinc-800/60 px-4 py-2 md:grid">
              <span className="label-xs">site</span>
              <span className="label-xs">24 h</span>
              <span className="label-xs">uptime</span>
              <span className="label-xs">resposta</span>
              <span className="label-xs" title="Nota de saúde: disponibilidade, segurança e validade">
                nota
              </span>
              <span className="label-xs">ssl</span>
              <span className="label-xs">domínio</span>
              <span />
            </div>
            <ul className="divide-y divide-zinc-800/60">
              {list.map((site) => (
                <li key={site.id}>
                  <SiteRow
                    site={site}
                    ov={bySite.get(site.id)}
                    from={overview?.from}
                    open={open === site.id}
                    checking={checking === site.id}
                    onToggle={() => setOpen(open === site.id ? null : site.id)}
                    onCheck={() => checkNow(site)}
                    onEdit={() => setEditing(site)}
                    onRemove={() => remove(site)}
                  />
                  {open === site.id && <SiteDetail site={site} onChange={load} />}
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      <Footer className="border-t border-zinc-800/60 bg-zinc-950/60 px-4 py-5 backdrop-blur-sm" />

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

// ─── Resumo: estado agora, números do dia e o que pede atenção ───────────────

interface Attention {
  key: string;
  tone: 'bad' | 'warn';
  site: Site;
  text: string;
}

function attentionList(sites: Site[], overview: Overview | null): Attention[] {
  const out: Attention[] = [];
  const ov = new Map((overview?.sites ?? []).map((o) => [o.id, o]));
  for (const s of sites) {
    if (!s.enabled) continue;
    if (s.status === 'down')
      out.push({
        key: `down${s.id}`,
        tone: 'bad',
        site: s,
        text: `fora do ar${s.last_error ? `: ${s.last_error}` : ''}`,
      });
    const ssl = daysUntil(s.ssl_expires_at);
    if (ssl !== null && ssl <= 14)
      out.push({
        key: `ssl${s.id}`,
        tone: ssl <= 3 ? 'bad' : 'warn',
        site: s,
        text: ssl < 0 ? 'certificado SSL vencido' : `certificado SSL vence em ${ssl} dias`,
      });
    const dom = s.check_domain ? daysUntil(s.domain_expires_at) : null;
    if (dom !== null && dom <= 30)
      out.push({
        key: `dom${s.id}`,
        tone: dom <= 7 ? 'bad' : 'warn',
        site: s,
        text: dom < 0 ? 'domínio vencido' : `domínio vence em ${dom} dias`,
      });
    if (s.security_score !== null && s.security_score < 70)
      out.push({ key: `sec${s.id}`, tone: 'warn', site: s, text: `nota de segurança ${s.security_score}` });
    const change = ov.get(s.id)?.responseChange ?? null;
    if (change !== null && change >= 30 && s.status === 'up')
      out.push({
        key: `slow${s.id}`,
        tone: 'warn',
        site: s,
        text: `resposta ${change}% mais lenta que ontem`,
      });
    if (s.status === 'up' && s.last_challenge)
      out.push({
        key: `ch${s.id}`,
        tone: 'warn',
        site: s,
        text: `conteúdo não verificável (firewall ${s.last_challenge})`,
      });
  }
  return out.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'bad' ? -1 : 1));
}

function Summary({
  sites,
  overview,
  onOpen,
}: {
  sites: Site[];
  overview: Overview | null;
  onOpen: (id: number) => void;
}) {
  const active = sites.filter((s) => s.enabled);
  const up = active.filter((s) => s.status === 'up').length;
  const down = active.filter((s) => s.status === 'down');
  const attention = attentionList(sites, overview);
  const ok = overview?.sites.filter((o) => o.responseMs !== null) ?? [];
  const avgMs = ok.length ? Math.round(ok.reduce((a, o) => a + (o.responseMs ?? 0), 0) / ok.length) : null;
  const changes = ok.map((o) => o.responseChange).filter((c): c is number => c !== null);
  const avgChange = changes.length ? Math.round(changes.reduce((a, b) => a + b, 0) / changes.length) : null;

  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <div className="card p-5">
        <p className="font-mono text-xs text-zinc-500">
          <span className="text-brand">$</span> uivo status<span className="cursor-blink">_</span>
        </p>
        <p className="mt-3 text-3xl font-semibold tracking-tight text-zinc-100">
          <span className={up === 0 && active.length ? 'text-red-400' : 'text-emerald-400'}>{up}</span>
          <span className="text-zinc-600"> / </span>
          {active.length} <span className="text-lg font-normal text-zinc-400">sites no ar</span>
        </p>
        {down.length > 0 ? (
          <ul className="mt-2 space-y-1 font-mono text-xs">
            {down.map((s) => (
              <li key={s.id}>
                <button type="button" className="text-red-300 hover:underline" onClick={() => onOpen(s.id)}>
                  ✕ {s.name}
                </button>
                <span className="text-zinc-500"> · {s.last_error ?? 'sem resposta'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 font-mono text-xs text-emerald-400/80">✓ tudo respondendo agora</p>
        )}
        <dl className="mt-5 grid grid-cols-3 gap-4 border-t border-zinc-800/80 pt-4">
          <Stat label="checagens 24h" value={overview ? overview.checks24h.toLocaleString('pt-BR') : '—'} />
          <Stat
            label="quedas 24h"
            value={overview ? String(overview.incidents24h) : '—'}
            tone={overview?.incidents24h ? 'bad' : undefined}
          />
          <Stat
            label="resposta média"
            value={avgMs === null ? '—' : `${avgMs} ms`}
            extra={avgChange === null ? null : <Trend change={avgChange} compact />}
          />
        </dl>
      </div>

      <div className="card flex flex-col p-5">
        <div className="flex items-center justify-between">
          <span className="panel-title">{'// pedindo atenção'}</span>
          <span className="font-mono text-[11px] text-zinc-600">{attention.length}</span>
        </div>
        {attention.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500">Nada pedindo atenção agora. Pode tomar o café em paz.</p>
        ) : (
          <ul className="mt-3 max-h-48 space-y-1.5 overflow-y-auto pr-1">
            {attention.map((a) => (
              <li key={a.key}>
                <button
                  type="button"
                  onClick={() => onOpen(a.site.id)}
                  className="flex w-full items-baseline gap-2 rounded-sm px-1.5 py-1 text-left text-sm hover:bg-zinc-900/70"
                >
                  <span
                    className={`font-mono text-xs ${a.tone === 'bad' ? 'text-red-400' : 'text-amber-400'}`}
                  >
                    {a.tone === 'bad' ? '✕' : '!'}
                  </span>
                  <span className="text-zinc-200">{a.site.name}</span>
                  <span className="truncate text-zinc-500">{a.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
  extra,
}: {
  label: string;
  value: string;
  tone?: 'bad';
  extra?: React.ReactNode;
}) {
  return (
    <div>
      <dt className="label-xs">{label}</dt>
      <dd className={`mt-1 font-mono text-lg tabular-nums ${tone ? TONES[tone] : 'text-zinc-100'}`}>
        {value} {extra}
      </dd>
    </div>
  );
}

/** Variação contra ontem: mais lento é pior. */
function Trend({ change, compact = false }: { change: number; compact?: boolean }) {
  if (Math.abs(change) < 5) return compact ? null : <span className="text-xs text-zinc-500">= ontem</span>;
  return (
    <span
      className={`text-xs ${change > 0 ? 'text-amber-400' : 'text-emerald-400'}`}
      title="Comparado com as 24 h anteriores"
    >
      {change > 0 ? '↑' : '↓'}
      {Math.abs(change)}%
    </span>
  );
}

// ─── Linha de site ─────────────────────────────────────────────────────────

type DotStatus = Site['status'] | 'paused' | 'limited';
const statusOf = (site: Site): DotStatus =>
  !site.enabled ? 'paused' : site.status === 'up' && site.last_challenge ? 'limited' : site.status;

const hourColor = (u: number | null) =>
  u === null ? 'bg-zinc-800/70' : u >= 99.9 ? 'bg-emerald-400/80' : u >= 95 ? 'bg-amber-400' : 'bg-red-500';

/** 24 quadradinhos, um por hora (o mais à direita é a hora atual). */
function HourStrip({ ov, from }: { ov: OverviewSite | undefined; from: number | undefined }) {
  const hours = ov?.hours ?? Array(24).fill(null);
  return (
    <div
      className="flex h-4 items-stretch gap-[2px]"
      role="img"
      aria-label="Disponibilidade nas últimas 24 horas"
    >
      {hours.map((h, i) => {
        const label = from
          ? new Date(from + i * 3_600_000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
          : '';
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: posição fixa = hora do dia
            key={i}
            className={`w-1 flex-1 rounded-[1px] ${hourColor(h?.uptime ?? null)}`}
            title={
              h
                ? `${label}: ${formatUptime(h.uptime)} no ar${h.ms ? `, ${h.ms} ms` : ''}`
                : `${label}: sem checagens`
            }
          />
        );
      })}
    </div>
  );
}

function SiteRow({
  site,
  ov,
  from,
  open,
  checking,
  onToggle,
  onCheck,
  onEdit,
  onRemove,
}: {
  site: Site;
  ov: OverviewSite | undefined;
  from: number | undefined;
  open: boolean;
  checking: boolean;
  onToggle: () => void;
  onCheck: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const status = statusOf(site);
  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2.5 px-4 py-3 transition-colors md:grid-cols-[minmax(0,1fr)_10rem_4.5rem_6rem_3.5rem_4rem_4rem_6.5rem] ${open ? 'bg-zinc-900/60' : 'hover:bg-zinc-900/40'}`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex min-w-0 items-center gap-3 text-left"
        aria-expanded={open}
      >
        <span className="text-zinc-600">
          <IconChevron open={open} />
        </span>
        <StatusDot status={status} />
        <div className="min-w-0">
          <div className="truncate font-medium text-zinc-100">{site.name}</div>
          <div className="truncate font-mono text-[11px] text-zinc-500">
            {hostOf(site.url)} · {site.enabled ? relativeTime(site.last_checked_at) : 'pausado'}
            {site.status === 'down' && site.last_error ? (
              <span className="text-red-400"> · {site.last_error}</span>
            ) : null}
          </div>
        </div>
      </button>
      <div className="col-span-2 row-start-2 md:col-span-1 md:row-start-auto">
        <HourStrip ov={ov} from={from} />
      </div>
      <div className="col-span-2 row-start-3 grid grid-cols-5 gap-3 md:col-span-1 md:row-start-auto md:contents">
        <Cell label="uptime">{formatUptime(site.uptime_24h)}</Cell>
        <Cell label="resposta">
          {site.status === 'down' ? (
            <span className="text-red-400">falhou</span>
          ) : site.last_response_ms === null ? (
            '—'
          ) : (
            <>
              {site.last_response_ms} ms{' '}
              {ov?.responseChange != null && <Trend change={ov.responseChange} compact />}
            </>
          )}
        </Cell>
        <Cell label="nota" title="Nota de saúde: disponibilidade, segurança e validade">
          <span className={scoreTone(site.health_score)}>{site.health_score ?? '—'}</span>
        </Cell>
        <Expiry
          label="ssl"
          days={daysUntil(site.ssl_expires_at)}
          warn={14}
          title={site.ssl_error ?? site.ssl_issuer ?? undefined}
        />
        <Expiry
          label="domínio"
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
          disabled={checking}
          onClick={onCheck}
        >
          <IconRefresh spinning={checking} />
        </button>
        <button
          type="button"
          className="btn-icon"
          title="Editar"
          aria-label={`Editar ${site.name}`}
          onClick={onEdit}
        >
          <IconEdit />
        </button>
        <button
          type="button"
          className="btn-icon hover:text-red-400"
          title="Remover"
          aria-label={`Remover ${site.name}`}
          onClick={onRemove}
        >
          <IconTrash />
        </button>
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
    <span className="relative flex size-2 shrink-0" title={label}>
      {status === 'down' && (
        <span className="absolute inline-flex size-full animate-ping rounded-[1px] bg-red-500 opacity-60" />
      )}
      <span className={`relative inline-flex size-2 rounded-[1px] ${color}`} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function Cell({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <div className="font-mono text-[13px] tabular-nums" title={title}>
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
