import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import { api, type CheckPoint, type Incident, type Site } from '../api.ts';
import { dateTime, duration, formatUptime } from '../format.ts';
import { SecurityPanel } from './SecurityPanel.tsx';

const RANGES = [
  { key: '24h', label: '24 h' },
  { key: '7d', label: '7 dias' },
  { key: '30d', label: '30 dias' },
];

function ResponseChart({ points }: { points: CheckPoint[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || points.length < 2) return;
    const xs = points.map((p) => p.t / 1000);
    const ms = points.map((p) => p.ms);
    const down = points.map((p) => (p.ok ? null : p.ms));
    const plot = new uPlot(
      {
        width: el.clientWidth,
        height: 220,
        cursor: { y: false },
        scales: { x: { time: true }, y: { range: (_u, _min, max) => [0, Math.max(100, max * 1.15)] } },
        axes: [
          {
            stroke: '#71717a',
            grid: { stroke: '#27272a' },
            ticks: { stroke: '#27272a' },
            values: (_u, splits) => {
              const long = xs.length > 1 && xs[xs.length - 1] - xs[0] > 2 * 86_400;
              return splits.map((v) =>
                new Date(v * 1000).toLocaleString(
                  'pt-BR',
                  long ? { day: '2-digit', month: '2-digit' } : { hour: '2-digit', minute: '2-digit' },
                ),
              );
            },
          },
          {
            stroke: '#71717a',
            grid: { stroke: '#27272a' },
            ticks: { stroke: '#27272a' },
            values: (_u, v) => v.map((n) => `${n} ms`),
            size: 64,
          },
        ],
        series: [
          {},
          {
            label: 'Resposta',
            stroke: '#34d399',
            width: 2,
            fill: 'rgba(52, 211, 153, 0.12)',
            points: { show: false },
          },
          {
            label: 'Falha',
            stroke: 'transparent',
            points: { show: true, size: 7, fill: '#f87171', stroke: '#f87171' },
          },
        ],
      },
      [xs, ms, down],
      el,
    );
    const resize = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height: 220 }));
    resize.observe(el);
    return () => {
      resize.disconnect();
      plot.destroy();
    };
  }, [points]);

  if (points.length < 2)
    return (
      <p className="grid h-[220px] place-items-center text-sm text-zinc-500">
        {points.length === 0
          ? 'Ainda sem checagens neste período.'
          : 'Coletando dados: o gráfico aparece em alguns minutos.'}
      </p>
    );
  return <div ref={ref} className="w-full" />;
}

export function SiteDetail({ site, onChange }: { site: Site; onChange: () => void }) {
  const [tab, setTab] = useState<'perf' | 'security'>('perf');
  return (
    <div className="border-t border-zinc-800">
      <div className="flex gap-1 px-5 pt-4">
        {(
          [
            ['perf', 'Desempenho'],
            ['security', 'Segurança'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${tab === key ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'perf' ? (
        <Performance site={site} />
      ) : (
        <div className="p-5">
          <SecurityPanel siteId={site.id} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

function Performance({ site }: { site: Site }) {
  const [range, setRange] = useState('24h');
  const [points, setPoints] = useState<CheckPoint[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: recarrega a cada nova checagem do site
  useEffect(() => {
    api
      .checks(site.id, range)
      .then(setPoints)
      .catch(() => setPoints([]));
    api
      .incidents(site.id)
      .then(setIncidents)
      .catch(() => setIncidents([]));
  }, [site.id, range, site.last_checked_at]);

  const avg = points.length ? Math.round(points.reduce((s, p) => s + p.ms, 0) / points.length) : null;

  return (
    <div className="space-y-5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-6 text-sm">
          <Stat label="Uptime 24 h" value={formatUptime(site.uptime_24h)} />
          <Stat label="Uptime 7 dias" value={formatUptime(site.uptime_7d)} />
          <Stat label="Uptime 30 dias" value={formatUptime(site.uptime_30d)} />
          <Stat label="Resposta média" value={avg === null ? '—' : `${avg} ms`} />
        </div>
        <div className="flex rounded-lg bg-zinc-950 p-1">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              className={`rounded-md px-3 py-1 text-xs font-medium ${range === r.key ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white'}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <ResponseChart points={points} />
      <div>
        <h3 className="mb-2 text-sm font-medium text-zinc-300">Incidentes (90 dias)</h3>
        {incidents.length === 0 ? (
          <p className="text-sm text-zinc-500">Nenhuma queda registrada. 🎉</p>
        ) : (
          <ul className="divide-y divide-zinc-800 text-sm">
            {incidents.map((i) => (
              <li key={i.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span className="text-zinc-300">
                  {dateTime(i.started_at)} · {i.reason ?? 'Falha'}
                </span>
                <span className={i.ended_at ? 'text-zinc-400' : 'font-medium text-red-400'}>
                  {i.ended_at ? `durou ${duration(i.ended_at - i.started_at)}` : 'em andamento'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="font-semibold tabular-nums">{value}</div>
    </div>
  );
}
