import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import { api, type CheckPoint, type Incident, type Site, type TimingSummary } from '../api.ts';
import { dateTime, duration, formatUptime } from '../format.ts';
import { type Hover, MomentTooltip } from './MomentTooltip.tsx';
import { SecurityPanel } from './SecurityPanel.tsx';
import { LastCheck, PhaseChart } from './TimingPanel.tsx';

const DAY = 86_400_000;
const RANGES = [
  { key: '24h', label: '24 h', span: DAY },
  { key: '7d', label: '7 dias', span: 7 * DAY },
  { key: '30d', label: '30 dias', span: 30 * DAY },
];
/** Tamanho de cada ponto do gráfico (mesma conta do servidor: até 300 pontos, mínimo 1 minuto). */
const bucketOf = (range: string) =>
  Math.max(60_000, Math.ceil((RANGES.find((r) => r.key === range)?.span ?? DAY) / 300));

function ResponseChart({ points, onHover }: { points: CheckPoint[]; onHover?: (h: Hover | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;

  useEffect(() => {
    const el = ref.current;
    if (!el || points.length < 2) return;
    const xs = points.map((p) => p.t / 1000);
    const ms = points.map((p) => p.ms);
    const down = points.map((p) => (p.ok ? null : 0.93));
    const okMs = points.map((p) => (p.ok ? p.ms : null));
    const plot = new uPlot(
      {
        width: el.clientWidth,
        height: 220,
        cursor: { y: false },
        hooks: {
          // posição do cursor para o detalhe do ponto (null quando o mouse sai do gráfico)
          setCursor: [
            (u) => {
              const idx = u.cursor.idx;
              const left = u.cursor.left ?? -1;
              if (idx == null || left < 0) return onHoverRef.current?.(null);
              const over = u.over.getBoundingClientRect();
              const box = el.getBoundingClientRect();
              onHoverRef.current?.({ idx, x: over.left - box.left + left, width: box.width });
            },
          ],
        },
        scales: {
          x: { time: true },
          y: { range: (_u, _min, max) => [0, Math.max(100, max * 1.15)] },
          fail: { range: [0, 1] },
        },
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
            stroke: '#fbbf24',
            width: 2,
            fill: 'rgba(251, 191, 36, 0.10)',
            points: { show: false },
          },
          {
            label: 'Falha',
            scale: 'fail',
            stroke: 'transparent',
            points: { show: true, size: 8, fill: '#f87171', stroke: '#f87171' },
          },
        ],
      },
      [xs, okMs, down],
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
  const [timing, setTiming] = useState<TimingSummary | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: recarrega a cada nova checagem do site
  useEffect(() => {
    api
      .checks(site.id, range)
      .then(setPoints)
      .catch(() => setPoints([]));
    api
      .timing(site.id, range)
      .then(setTiming)
      .catch(() => setTiming(null));
    api
      .incidents(site.id)
      .then(setIncidents)
      .catch(() => setIncidents([]));
  }, [site.id, range, site.last_checked_at]);

  // média só das checagens que responderam: uma queda não é "lentidão"
  const okPoints = points.filter((p) => p.ok);
  const avg = okPoints.length ? Math.round(okPoints.reduce((s, p) => s + p.ms, 0) / okPoints.length) : null;

  return (
    <div className="space-y-5 p-5">
      {site.last_challenge && (
        <div className="rounded-xl border border-orange-500/30 bg-orange-500/5 p-3.5 text-sm text-zinc-300">
          <p className="font-medium text-orange-300">
            Conteúdo não verificável: o firewall ({site.last_challenge}) exige um navegador.
          </p>
          <p className="mt-1">
            O site está no ar: DNS, conexão, certificado (em HTTPS) e a resposta do servidor foram
            confirmados. Só a página (e a palavra-chave) não pode ser lida. Para a verificação completa,
            cadastre um cabeçalho de liberação em{' '}
            <span className="text-zinc-100">Editar → Cabeçalhos de liberação</span> e crie no firewall uma
            regra que libere esse cabeçalho, ou libere o IP do servidor do Uivo.
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-6 text-sm">
          <Stat label="Uptime 24 h" value={formatUptime(site.uptime_24h)} />
          <Stat label="Uptime 7 dias" value={formatUptime(site.uptime_7d)} />
          <Stat label="Uptime 30 dias" value={formatUptime(site.uptime_30d)} />
          <Stat label="Resposta média" value={avg === null ? '—' : `${avg} ms`} />
          <Stat
            label="p95"
            value={timing?.p95 == null ? '—' : `${timing.p95} ms`}
            hint="95% das respostas foram mais rápidas que isso"
          />
          <Stat
            label="p99"
            value={timing?.p99 == null ? '—' : `${timing.p99} ms`}
            hint="O pior caso de 1 em cada 100 acessos"
          />
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
      <div className="relative">
        {points.filter((p) => p.wait !== null).length >= 2 ? (
          <PhaseChart points={points} onHover={setHover} />
        ) : (
          <ResponseChart points={points} onHover={setHover} />
        )}
        {hover && points[hover.idx] && (
          <MomentTooltip
            siteId={site.id}
            point={points[hover.idx]}
            hover={hover}
            bucketMs={bucketOf(range)}
            longRange={range !== '24h'}
          />
        )}
      </div>
      <p className="-mt-3 text-xs text-zinc-600">
        Passe o mouse no gráfico para ver o detalhe de cada momento e comparar com dias anteriores.
      </p>
      {timing?.last && <LastCheck timing={timing} />}
      <div>
        <h3 className="mb-2 text-sm font-medium text-zinc-300">Incidentes (90 dias)</h3>
        {incidents.length === 0 ? (
          <p className="text-sm text-zinc-500">Nenhuma queda registrada.</p>
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

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="font-semibold tabular-nums">{value}</div>
    </div>
  );
}
