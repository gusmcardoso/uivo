import { useEffect, useRef, useState } from 'react';
import type { Site } from '../api.ts';
import { clientsOf, countBySeverity, type SiteFilter, type SortMode } from '../sort.ts';

/*
 * Barra da lista de sites: busca por texto e um painel de filtros (situação, cliente, ordem e
 * agrupamento). A ordem padrão é por situação, com o mais crítico no topo.
 */

export const SITUATIONS = [
  { value: 0, label: 'Fora do ar', dot: 'bg-red-500' },
  { value: 1, label: 'Pedindo atenção', dot: 'bg-amber-400' },
  { value: 2, label: 'No ar', dot: 'bg-emerald-400' },
  { value: 3, label: 'Aguardando', dot: 'bg-zinc-400' },
  { value: 4, label: 'Pausados', dot: 'bg-zinc-600' },
];

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

export function SiteToolbar({
  sites,
  shown,
  filter,
  onFilter,
  sortMode,
  onSort,
  grouped,
  onGroup,
}: {
  sites: Site[];
  shown: number;
  filter: SiteFilter;
  onFilter: (f: SiteFilter) => void;
  sortMode: SortMode;
  onSort: (m: SortMode) => void;
  grouped: boolean;
  onGroup: (g: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const counts = countBySeverity(sites);
  const clients = clientsOf(sites);
  const hasNoClient = sites.some((s) => !s.client?.trim());
  const picked = filter.situations.length + filter.clients.length;

  // "/" leva para a busca (como no GitHub); Esc fecha o painel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        search.current?.focus();
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const chip = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-xs transition-colors ${
      active
        ? 'border-brand/60 bg-brand/10 text-brand'
        : 'border-zinc-800 text-zinc-300 hover:border-zinc-600 hover:text-white'
    }`;

  return (
    <div className="border-b border-zinc-800/80">
      <div className="relative flex flex-wrap items-center gap-2 px-4 py-2.5">
        <span className="panel-title mr-1 basis-full whitespace-nowrap sm:basis-auto">
          Sites{' '}
          <span className="text-zinc-400 tabular-nums">
            {shown === sites.length ? sites.length : `${shown} de ${sites.length}`}
          </span>
        </span>
        <div className="relative min-w-[11rem] flex-1">
          <svg
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-zinc-400"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" strokeLinecap="round" />
          </svg>
          <input
            ref={search}
            type="search"
            className="input py-1.5 pr-8 pl-8"
            placeholder="Buscar site ou cliente"
            aria-label="Buscar sites"
            value={filter.query}
            onChange={(e) => onFilter({ ...filter, query: e.target.value })}
          />
          {filter.query ? (
            <button
              type="button"
              className="absolute top-1/2 right-2 -translate-y-1/2 px-1 text-xs text-zinc-400 hover:text-white"
              aria-label="Limpar busca"
              onClick={() => {
                onFilter({ ...filter, query: '' });
                search.current?.focus();
              }}
            >
              ✕
            </button>
          ) : (
            <kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded-[3px] border border-zinc-700 px-1.5 text-[10px] text-zinc-400 sm:block">
              /
            </kbd>
          )}
        </div>
        <div ref={box} className="sm:relative">
          <button
            type="button"
            className={`btn py-1.5 text-xs ${open || picked ? 'border-brand/50 text-brand' : ''}`}
            aria-expanded={open}
            aria-haspopup="dialog"
            onClick={() => setOpen(!open)}
          >
            <svg
              viewBox="0 0 16 16"
              className="size-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <path d="M2 4h12M4.5 8h7M7 12h2" strokeLinecap="round" />
            </svg>
            Filtros
            {picked > 0 && (
              <span className="rounded-[3px] bg-brand px-1 text-[10px] font-semibold text-zinc-950 tabular-nums">
                {picked}
              </span>
            )}
          </button>
          {open && (
            <div
              role="dialog"
              aria-label="Filtros da lista"
              className="card absolute top-full right-4 left-4 z-30 mt-1 space-y-4 sm:right-0 sm:left-auto sm:mt-2 sm:w-[22rem] bg-zinc-950/95 p-4 shadow-2xl shadow-black/60"
            >
              <Group title="Situação">
                {SITUATIONS.filter((s) => counts[s.value] > 0 || filter.situations.includes(s.value)).map(
                  (s) => (
                    <button
                      key={s.value}
                      type="button"
                      aria-pressed={filter.situations.includes(s.value)}
                      className={chip(filter.situations.includes(s.value))}
                      onClick={() => onFilter({ ...filter, situations: toggle(filter.situations, s.value) })}
                    >
                      <span className={`size-1.5 rounded-[1px] ${s.dot}`} />
                      {s.label}
                      <span className="text-zinc-400 tabular-nums">{counts[s.value]}</span>
                    </button>
                  ),
                )}
              </Group>
              {clients.length > 0 && (
                <Group title="Cliente">
                  {[...clients, ...(hasNoClient ? [''] : [])].map((c) => (
                    <button
                      key={c || '\u0000'}
                      type="button"
                      aria-pressed={filter.clients.includes(c)}
                      className={chip(filter.clients.includes(c))}
                      onClick={() => onFilter({ ...filter, clients: toggle(filter.clients, c) })}
                    >
                      {c || 'Sem cliente'}
                    </button>
                  ))}
                </Group>
              )}
              <Group title="Ordenar por">
                {(
                  [
                    ['situacao', 'Situação (mais crítico primeiro)'],
                    ['nome', 'Nome'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={sortMode === key}
                    className={chip(sortMode === key)}
                    onClick={() => onSort(key)}
                  >
                    {label}
                  </button>
                ))}
              </Group>
              <label className="flex cursor-pointer items-center justify-between gap-3 text-sm text-zinc-200">
                Agrupar por cliente
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={grouped}
                  onChange={(e) => onGroup(e.target.checked)}
                />
                <span className="relative h-4 w-7 rounded-full bg-zinc-700 transition-colors peer-checked:bg-brand peer-focus-visible:ring-2 peer-focus-visible:ring-brand/60 after:absolute after:top-0.5 after:left-0.5 after:size-3 after:rounded-full after:bg-zinc-950 after:transition-transform peer-checked:after:translate-x-3" />
              </label>
              <div className="flex justify-between border-t border-zinc-800/80 pt-3">
                <button
                  type="button"
                  className="text-xs text-zinc-300 hover:text-white disabled:opacity-40"
                  disabled={!picked && !filter.query}
                  onClick={() => onFilter({ query: '', situations: [], clients: [] })}
                >
                  Limpar filtros
                </button>
                <button
                  type="button"
                  className="text-xs text-brand hover:underline"
                  onClick={() => setOpen(false)}
                >
                  Pronto
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      {picked > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2.5">
          {filter.situations.map((v) => {
            const s = SITUATIONS[v];
            return (
              <button
                key={`s${v}`}
                type="button"
                className={chip(true)}
                title="Remover filtro"
                onClick={() => onFilter({ ...filter, situations: toggle(filter.situations, v) })}
              >
                <span className={`size-1.5 rounded-[1px] ${s.dot}`} />
                {s.label} ✕
              </button>
            );
          })}
          {filter.clients.map((c) => (
            <button
              key={`c${c}`}
              type="button"
              className={chip(true)}
              title="Remover filtro"
              onClick={() => onFilter({ ...filter, clients: toggle(filter.clients, c) })}
            >
              {c || 'Sem cliente'} ✕
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset>
      <legend className="label-xs mb-2">{title}</legend>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </fieldset>
  );
}
