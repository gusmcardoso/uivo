import { useCallback, useEffect, useRef, useState } from 'react';
import { type AppNotification, api } from '../api.ts';
import { relativeTime } from '../format.ts';

/*
 * Avisos do painel, no padrão mais comum: "toast" no canto inferior direito quando algo
 * acontece (some sozinho; queda fica até ser fechada) e uma central no sino do cabeçalho.
 */

const POLL_MS = 15_000;
const LEVEL = {
  bad: { bar: 'bg-red-500', dot: 'bg-red-500', label: 'Fora do ar' },
  warn: { bar: 'bg-amber-400', dot: 'bg-amber-400', label: 'Atenção' },
  good: { bar: 'bg-emerald-400', dot: 'bg-emerald-400', label: 'Resolvido' },
  info: { bar: 'bg-brand', dot: 'bg-brand', label: 'Aviso' },
} as const;

export function useNotifications(onUnauthorized: () => void) {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [toasts, setToasts] = useState<AppNotification[]>([]);
  const lastId = useRef<number | null>(null);

  const poll = useCallback(async () => {
    try {
      if (lastId.current === null) {
        // primeira carga: só a lista do sino, sem popup dos avisos antigos
        const r = await api.notifications();
        setItems(r.items);
        setUnread(r.unread);
        lastId.current = r.lastId;
        return;
      }
      const r = await api.notifications(lastId.current);
      if (r.items.length) {
        const fresh = [...r.items].reverse();
        setItems((list) => [...fresh, ...list].slice(0, 50));
        setToasts((list) => [...list, ...r.items].slice(-4));
        lastId.current = r.items[r.items.length - 1].id;
      }
      setUnread(r.unread);
    } catch (err) {
      if ((err as { status?: number }).status === 401) onUnauthorized();
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
  }, [poll]);

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const markAllRead = useCallback(async () => {
    const r = await api.markNotificationsRead(lastId.current ?? undefined).catch(() => null);
    if (r) setUnread(r.unread);
  }, []);

  return { items, unread, toasts, dismiss, markAllRead, refresh: poll };
}

/** Popups no canto inferior direito. */
export function Toasts({
  toasts,
  onDismiss,
  onOpen,
}: {
  toasts: AppNotification[];
  onDismiss: (id: number) => void;
  onOpen: (siteId: number) => void;
}) {
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-30 flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2">
      {toasts.map((t) => (
        <Toast key={t.id} n={t} onDismiss={() => onDismiss(t.id)} onOpen={onOpen} />
      ))}
    </div>
  );
}

function Toast({
  n,
  onDismiss,
  onOpen,
}: {
  n: AppNotification;
  onDismiss: () => void;
  onOpen: (siteId: number) => void;
}) {
  // queda fica até ser fechada; o resto some depois de alguns segundos (pausa com o mouse em cima)
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (n.level === 'bad' || paused) return;
    const timer = setTimeout(onDismiss, 8000);
    return () => clearTimeout(timer);
  }, [n.level, paused, onDismiss]);
  const l = LEVEL[n.level];
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: o mouse em cima só pausa o sumiço automático
    <div
      role={n.level === 'bad' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className="toast-in pointer-events-auto flex overflow-hidden rounded-md border border-zinc-700/80 bg-zinc-900/95 shadow-2xl shadow-black/50 backdrop-blur"
    >
      <span className={`w-1 shrink-0 ${l.bar}`} />
      <button
        type="button"
        className="min-w-0 flex-1 px-3.5 py-3 text-left"
        onClick={() => {
          if (n.site_id) onOpen(n.site_id);
          onDismiss();
        }}
      >
        <span className="block text-sm font-medium text-zinc-100">{n.title}</span>
        {n.detail && <span className="mt-0.5 block text-xs text-zinc-400">{n.detail}</span>}
        <span className="mt-1 block text-[11px] text-zinc-400">{l.label} · agora</span>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="self-start px-3 py-2.5 text-zinc-400 hover:text-zinc-200"
        aria-label="Fechar aviso"
      >
        ×
      </button>
    </div>
  );
}

/** Sino do cabeçalho com a central de avisos. */
export function Bell({
  items,
  unread,
  onOpenSite,
  onMarkAllRead,
}: {
  items: AppNotification[];
  unread: number;
  onOpenSite: (siteId: number) => void;
  onMarkAllRead: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && unread) onMarkAllRead();
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="btn-icon relative"
        onClick={toggle}
        aria-expanded={open}
        aria-label={unread ? `Avisos: ${unread} não lido(s)` : 'Avisos'}
        title="Avisos"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className="size-4"
          aria-hidden="true"
        >
          <path
            d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white tabular-nums">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute top-full right-0 z-30 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/95 shadow-2xl shadow-black/60 backdrop-blur">
          <div className="flex items-center justify-between border-b border-zinc-800/80 px-4 py-3">
            <span className="panel-title">Avisos</span>
            <span className="text-xs text-zinc-400">últimos {items.length}</span>
          </div>
          {items.length === 0 ? (
            <p className="px-4 py-6 text-sm text-zinc-400">
              Nenhum aviso ainda. Quando um site cair, ficar instável ou voltar, aparece aqui.
            </p>
          ) : (
            <ul className="max-h-96 divide-y divide-zinc-800/60 overflow-y-auto">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className="flex w-full gap-3 px-4 py-2.5 text-left hover:bg-zinc-900/70"
                    onClick={() => {
                      setOpen(false);
                      if (n.site_id) onOpenSite(n.site_id);
                    }}
                  >
                    <span className={`mt-1.5 size-2 shrink-0 rounded-[1px] ${LEVEL[n.level].dot}`} />
                    <span className="min-w-0">
                      <span className="block text-sm text-zinc-100">{n.title}</span>
                      {n.detail && <span className="block truncate text-xs text-zinc-400">{n.detail}</span>}
                      <span className="block text-[11px] text-zinc-400">{relativeTime(n.at)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
