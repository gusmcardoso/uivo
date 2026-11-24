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
import { Bell, Toasts, useNotifications } from './components/Notifications.tsx';
import { PixelBackground } from './components/PixelBackground.tsx';
import { ReportDialog } from './components/ReportDialog.tsx';
import { scoreTone } from './components/SecurityPanel.tsx';
import { SiteDetail } from './components/SiteDetail.tsx';
import { SiteForm } from './components/SiteForm.tsx';
import { StatusPage } from './components/StatusPage.tsx';
import { daysUntil, expiryTone, formatUptime, hostOf, relativeTime } from './format.ts';
import { clientsOf, groupByClient, type SortMode, sortSites } from './sort.ts';

type Session = 'loading' | 'setup' | 'login' | 'in';

/** Preferências da lista guardadas no navegador (só conveniência: sem elas, vale o padrão). */
const pref = (key: string) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
const savePref = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // modo privado ou armazenamento bloqueado: segue sem lembrar
  }
};

const routeSiteId = () => {
  const m = /^\/sites\/(\d+)\/?$/.exec(window.location.pathname);
  return m ? Number(m[1]) : null;
};
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
  // endereço próprio por site: /sites/:id (o voltar do navegador e o F5 funcionam)
  const [siteId, setSiteId] = useState<number | null>(routeSiteId);
  const [checking, setChecking] = useState<number | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>(() =>
    pref('uivo.ordem') === 'nome' ? 'nome' : 'situacao',
  );
  const [grouped, setGrouped] = useState(() => pref('uivo.agrupar') === '1');
  const notes = useNotifications(onLogout);

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

  useEffect(() => {
    const onPop = () => setSiteId(routeSiteId());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /** Vai para um site (ou para o início, com null), atualizando o endereço do navegador. */
  function navigate(id: number | null) {
    const target = id === null ? '/' : `/sites/${id}`;
    if (window.location.pathname !== target) window.history.pushState(null, '', target);
    setSiteId(id);
    window.scrollTo({ top: 0 });
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
    if (siteId === site.id) navigate(null);
    await load();
  }

  async function logout() {
    await api.logout().catch(() => undefined);
    onLogout();
  }

  const list = sites ?? [];
  const bySite = new Map((overview?.sites ?? []).map((o) => [o.id, o]));
  const current = siteId === null ? null : (list.find((s) => s.id === siteId) ?? null);
  const ordered = sortSites(list, sortMode);
  const groups = grouped ? groupByClient(list, sortMode) : null;
  // um aviso novo (queda, volta…) atualiza a lista na hora, sem esperar os 30 s
  const lastToast = notes.toasts[notes.toasts.length - 1]?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: recarrega quando chega aviso novo
  useEffect(() => {
    if (lastToast) void load();
  }, [lastToast]);

  useEffect(() => {
    document.title = current ? `${current.name} · Uivo` : 'Uivo';
  }, [current]);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b border-zinc-800/80 bg-zinc-950/70 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <button
            type="button"
            onClick={() => navigate(null)}
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
            <Bell
              items={notes.items}
              unread={notes.unread}
              onOpenSite={navigate}
              onMarkAllRead={notes.markAllRead}
            />
            <button type="button" className="btn-ghost" onClick={logout} title="Sair">
              <IconLogout />
              <span className="hidden sm:inline">Sair</span>
            </button>
            <button type="button" className="btn-primary ml-1.5" onClick={() => setEditing('new')}>
              <IconPlus />
              <span className="hidden sm:inline">Adicionar site</span>
            </button>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-6 pb-10">
        {siteId !== null ? (
          sites === null ? null : current ? (
            <SitePage
              site={current}
              ov={bySite.get(current.id)}
              from={overview?.from}
              checking={checking === current.id}
              onBack={() => navigate(null)}
              onCheck={() => checkNow(current)}
              onEdit={() => setEditing(current)}
              onRemove={() => remove(current)}
              onChange={load}
            />
          ) : (
            <div className="card grid place-items-center gap-3 p-12 text-center">
              <p className="text-zinc-300">Site não encontrado.</p>
              <p className="text-sm text-zinc-500">Ele pode ter sido removido.</p>
              <button type="button" className="btn mt-2" onClick={() => navigate(null)}>
                ← Voltar para todos os sites
              </button>
            </div>
          )
        ) : sites !== null && list.length === 0 ? (
          <div className="card grid place-items-center gap-3 p-12 text-center">
            <p className="text-sm text-zinc-300">
              $ uivo status<span className="cursor-blink">_</span>
            </p>
            <p className="max-w-sm text-sm text-zinc-500">
              Nenhum site monitorado ainda. Cadastre um endereço e o Uivo passa a checar disponibilidade,
              tempo de resposta, SSL, domínio e segurança.
            </p>
            <button type="button" className="btn-primary mt-2" onClick={() => setEditing('new')}>
              <IconPlus /> Adicionar o primeiro site
            </button>
          </div>
        ) : (
          sites && <Summary sites={list} overview={overview} onOpen={navigate} />
        )}

        {siteId === null && list.length > 0 && (
          <section className="card mt-4 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/80 px-4 py-2.5">
              <span className="panel-title">
                Sites <span className="text-zinc-600">{list.length}</span>
              </span>
              <div className="flex items-center gap-2">
                <div className="flex rounded-sm border border-zinc-800 p-0.5" title="Ordem da lista">
                  {(
                    [
                      ['situacao', 'Situação'],
                      ['nome', 'Nome'],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={sortMode === key}
                      onClick={() => {
                        setSortMode(key);
                        savePref('uivo.ordem', key);
                      }}
                      className={`rounded-[2px] px-2.5 py-1 text-xs ${sortMode === key ? 'bg-brand/15 text-brand' : 'text-zinc-500 hover:text-zinc-200'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  aria-pressed={grouped}
                  onClick={() => {
                    setGrouped(!grouped);
                    savePref('uivo.agrupar', grouped ? '0' : '1');
                  }}
                  className={`rounded-sm border px-2.5 py-1 text-xs transition-colors ${grouped ? 'border-brand/50 bg-brand/10 text-brand' : 'border-zinc-800 text-zinc-500 hover:text-zinc-200'}`}
                >
                  Agrupar por cliente
                </button>
              </div>
            </div>
            <div className="hidden grid-cols-[minmax(0,1fr)_10rem_4.5rem_6rem_3.5rem_4rem_4rem_6.5rem] items-center gap-4 border-b border-zinc-800/60 px-4 py-2 md:grid">
              <span className="label-xs">Site</span>
              <span className="label-xs">Últimas 24 h</span>
              <span className="label-xs">Uptime</span>
              <span className="label-xs">Resposta</span>
              <span className="label-xs" title="Nota de saúde: disponibilidade, segurança e validade">
                Nota
              </span>
              <span className="label-xs">SSL</span>
              <span className="label-xs">Domínio</span>
              <span />
            </div>
            {groups ? (
              groups.map((g) => (
                <div key={g.client ?? '\u0000'}>
                  <div className="flex items-center gap-3 border-b border-zinc-800/60 bg-zinc-900/40 px-4 py-2">
                    <span className="text-sm font-medium text-zinc-200">{g.client ?? 'Sem cliente'}</span>
                    <span className="text-xs text-zinc-600">
                      {g.sites.length} site{g.sites.length === 1 ? '' : 's'}
                    </span>
                    {g.down > 0 && <span className="text-xs text-red-400">{g.down} fora do ar</span>}
                    {g.attention > 0 && (
                      <span className="text-xs text-amber-400">{g.attention} pedindo atenção</span>
                    )}
                  </div>
                  <ul className="divide-y divide-zinc-800/60 border-b border-zinc-800/60 last:border-b-0">
                    {g.sites.map((site) => (
                      <li key={site.id}>
                        <SiteRow
                          site={site}
                          ov={bySite.get(site.id)}
                          from={overview?.from}
                          checking={checking === site.id}
                          onOpen={() => navigate(site.id)}
                          onCheck={() => checkNow(site)}
                          onEdit={() => setEditing(site)}
                          onRemove={() => remove(site)}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            ) : (
              <ul className="divide-y divide-zinc-800/60">
                {ordered.map((site) => (
                  <li key={site.id}>
                    <SiteRow
                      site={site}
                      ov={bySite.get(site.id)}
                      from={overview?.from}
                      checking={checking === site.id}
                      onOpen={() => navigate(site.id)}
                      onCheck={() => checkNow(site)}
                      onEdit={() => setEditing(site)}
                      onRemove={() => remove(site)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </main>

      <Footer className="border-t border-zinc-800/60 bg-zinc-950/60 px-4 py-5 backdrop-blur-sm" />

      {reporting && sites && <ReportDialog sites={sites} onClose={() => setReporting(false)} />}
      <Toasts toasts={notes.toasts} onDismiss={notes.dismiss} onOpen={navigate} />
      {editing && (
        <SiteForm
          site={editing === 'new' ? undefined : editing}
          clients={clientsOf(list)}
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
        <p className="text-xs text-zinc-500">
          <span className="text-brand">$</span> uivo status<span className="cursor-blink">_</span>
        </p>
        <p className="mt-3 text-3xl font-semibold tracking-tight text-zinc-100">
          <span className={up === 0 && active.length ? 'text-red-400' : 'text-emerald-400'}>{up}</span>
          <span className="text-zinc-600"> / </span>
          {active.length} <span className="text-lg font-normal text-zinc-400">sites no ar</span>
        </p>
        {down.length > 0 ? (
          <ul className="mt-2 space-y-1 text-xs">
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
          <p className="mt-2 text-xs text-emerald-400/80">✓ tudo respondendo agora</p>
        )}
        <dl className="mt-5 grid grid-cols-3 gap-4 border-t border-zinc-800/80 pt-4">
          <Stat
            label="Checagens (24 h)"
            value={overview ? overview.checks24h.toLocaleString('pt-BR') : '—'}
          />
          <Stat
            label="Quedas (24 h)"
            value={overview ? String(overview.incidents24h) : '—'}
            tone={overview?.incidents24h ? 'bad' : undefined}
          />
          <Stat
            label="Resposta média"
            value={avgMs === null ? '—' : `${avgMs} ms`}
            extra={avgChange === null ? null : <Trend change={avgChange} compact />}
          />
        </dl>
      </div>

      <div className="card flex flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-zinc-800/80 px-5 py-3.5">
          <span className="panel-title">Pedindo atenção</span>
          {attention.length > 0 && (
            <span
              className={`rounded-sm px-1.5 py-0.5 text-xs font-medium tabular-nums ${
                attention.some((x) => x.tone === 'bad')
                  ? 'bg-red-500/15 text-red-300'
                  : 'bg-amber-400/15 text-amber-300'
              }`}
            >
              {attention.length}
            </span>
          )}
        </div>
        {attention.length === 0 ? (
          <div className="flex flex-1 flex-col items-start justify-center gap-1 px-5 py-6">
            <span className="text-sm text-emerald-400">Tudo em ordem.</span>
            <span className="text-xs text-zinc-500">
              Nada pedindo atenção agora. Pode tomar o café em paz.
            </span>
          </div>
        ) : (
          <ul className="max-h-56 divide-y divide-zinc-800/60 overflow-y-auto">
            {attention.map((a) => (
              <li key={a.key}>
                <button
                  type="button"
                  onClick={() => onOpen(a.site.id)}
                  className="group flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors hover:bg-zinc-900/60"
                >
                  <span
                    className={`h-8 w-0.5 shrink-0 rounded-full ${a.tone === 'bad' ? 'bg-red-500' : 'bg-amber-400'}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-zinc-100">{a.site.name}</span>
                    <span className="block truncate text-xs text-zinc-500">{a.text}</span>
                  </span>
                  <span className="text-xs text-zinc-600 transition-colors group-hover:text-zinc-300">
                    abrir ›
                  </span>
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
      <dd className={`mt-1 text-lg tabular-nums ${tone ? TONES[tone] : 'text-zinc-100'}`}>
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
  checking,
  onOpen,
  onCheck,
  onEdit,
  onRemove,
}: {
  site: Site;
  ov: OverviewSite | undefined;
  from: number | undefined;
  checking: boolean;
  onOpen: () => void;
  onCheck: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const status = statusOf(site);
  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2.5 px-4 py-3 transition-colors md:grid-cols-[minmax(0,1fr)_10rem_4.5rem_6rem_3.5rem_4rem_4rem_6.5rem] group hover:bg-zinc-900/40`}
    >
      <a
        href={`/sites/${site.id}`}
        onClick={(e) => {
          // clique normal abre aqui mesmo; Ctrl/Cmd+clique ou botão do meio abre em outra aba
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          onOpen();
        }}
        className="flex min-w-0 items-center gap-3 text-left"
      >
        <StatusDot status={status} />
        <div className="min-w-0">
          <div className="truncate font-medium text-zinc-100">{site.name}</div>
          <div className="truncate text-[11px] text-zinc-500">
            {hostOf(site.url)} · {site.enabled ? relativeTime(site.last_checked_at) : 'pausado'}
            {site.status === 'down' && site.last_error ? (
              <span className="text-red-400"> · {site.last_error}</span>
            ) : null}
          </div>
        </div>
        <span className="text-zinc-700 transition-colors group-hover:text-zinc-300">
          <IconChevron open={false} />
        </span>
      </a>
      <div className="col-span-2 row-start-2 md:col-span-1 md:row-start-auto">
        <HourStrip ov={ov} from={from} />
      </div>
      <div className="col-span-2 row-start-3 grid grid-cols-5 gap-3 md:col-span-1 md:row-start-auto md:contents">
        <Cell label="Uptime">{formatUptime(site.uptime_24h)}</Cell>
        <Cell label="Resposta">
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
        <Cell label="Nota" title="Nota de saúde: disponibilidade, segurança e validade">
          <span className={scoreTone(site.health_score)}>{site.health_score ?? '—'}</span>
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

/** Página própria de um site (/sites/:id): cabeçalho com os números de agora e as abas de detalhe. */
function SitePage({
  site,
  ov,
  from,
  checking,
  onBack,
  onCheck,
  onEdit,
  onRemove,
  onChange,
}: {
  site: Site;
  ov: OverviewSite | undefined;
  from: number | undefined;
  checking: boolean;
  onBack: () => void;
  onCheck: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onChange: () => void;
}) {
  const status = statusOf(site);
  return (
    <div className="space-y-4">
      <a
        href="/"
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.button !== 0) return;
          e.preventDefault();
          onBack();
        }}
        className="inline-flex items-center gap-1.5 text-sm text-zinc-500 transition-colors hover:text-zinc-200"
      >
        ← Todos os sites
      </a>
      <section className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <StatusDot status={status} />
              <h1 className="truncate text-2xl font-semibold tracking-tight text-zinc-100">{site.name}</h1>
            </div>
            <a
              href={site.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-block truncate text-sm text-zinc-500 hover:text-brand"
            >
              {site.url} ↗
            </a>
            <p className="mt-1 text-xs text-zinc-500">
              {site.enabled ? `verificado ${relativeTime(site.last_checked_at)}` : 'monitoramento pausado'}
              {site.status === 'down' && site.last_error ? (
                <span className="text-red-400"> · fora do ar: {site.last_error}</span>
              ) : null}
            </p>
          </div>
          <div className="flex gap-1.5">
            <button type="button" className="btn" disabled={checking} onClick={onCheck}>
              <IconRefresh spinning={checking} /> Verificar agora
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
        <div className="mt-5 grid grid-cols-2 gap-4 border-t border-zinc-800/80 pt-4 sm:grid-cols-3 lg:grid-cols-[repeat(5,minmax(0,1fr))_14rem]">
          <Cell always label="Uptime 24 h">
            {formatUptime(site.uptime_24h)}
          </Cell>
          <Cell always label="Resposta">
            {site.status === 'down' ? (
              <span className="text-red-400">falhou</span>
            ) : site.last_response_ms === null ? (
              '—'
            ) : (
              <>
                {site.last_response_ms} ms{' '}
                {ov?.responseChange != null && <Trend change={ov.responseChange} />}
              </>
            )}
          </Cell>
          <Cell always label="Nota de saúde">
            <span className={scoreTone(site.health_score)}>{site.health_score ?? '—'}</span>
          </Cell>
          <Expiry
            always
            label="SSL"
            days={daysUntil(site.ssl_expires_at)}
            warn={14}
            title={site.ssl_error ?? site.ssl_issuer ?? undefined}
          />
          <Expiry
            always
            label="Domínio"
            days={site.check_domain ? daysUntil(site.domain_expires_at) : null}
            warn={30}
            title={site.domain_error ?? undefined}
          />
          <div className="col-span-2 sm:col-span-3 lg:col-span-1">
            <div className="label-xs mb-1.5">Últimas 24 h</div>
            <HourStrip ov={ov} from={from} />
          </div>
        </div>
      </section>
      <section className="card overflow-hidden">
        <SiteDetail site={site} onChange={onChange} />
      </section>
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

function Cell({
  label,
  title,
  children,
  always = false,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
  /** rótulo visível também no desktop (na lista, o cabeçalho da tabela já mostra) */
  always?: boolean;
}) {
  return (
    <div className="text-[13px] tabular-nums" title={title}>
      <div className={`label-xs ${always ? 'mb-1' : 'md:hidden'}`}>{label}</div>
      <div className="text-zinc-200">{children}</div>
    </div>
  );
}

function Expiry({
  label,
  days,
  warn,
  title,
  always,
}: {
  label: string;
  days: number | null;
  warn: number;
  title?: string;
  always?: boolean;
}) {
  const tone = expiryTone(days, warn);
  return (
    <Cell label={label} title={title} always={always}>
      <span className={tone === 'none' ? 'text-zinc-500' : tone === 'ok' ? 'text-zinc-300' : TONES[tone]}>
        {days === null ? '—' : days < 0 ? 'vencido' : `${days} d`}
      </span>
    </Cell>
  );
}
