import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import type { CheckPoint, Phase, PhaseTimes, TimingSummary } from '../api.ts';

export const PHASES: { key: Phase; label: string; color: string; tip: string }[] = [
  {
    key: 'redirect',
    label: 'Redirecionamentos',
    color: '#71717a',
    tip: 'Redirecionamentos custam uma ida e volta cada. Aponte links e anúncios direto para a URL final.',
  },
  {
    key: 'dns',
    label: 'DNS',
    color: '#a78bfa',
    tip: 'A resolução do domínio está lenta. Um DNS mais rápido (Cloudflare, por exemplo) costuma resolver.',
  },
  {
    key: 'connect',
    label: 'Conexão',
    color: '#38bdf8',
    tip: 'A conexão até o servidor demora: ele está longe ou a rede está congestionada. Uma CDN ou um servidor mais próximo ajudam.',
  },
  {
    key: 'tls',
    label: 'TLS',
    color: '#fbbf24',
    tip: 'O handshake da criptografia está lento. Ative TLS 1.3 e OCSP stapling no servidor.',
  },
  {
    key: 'wait',
    label: 'Servidor',
    color: '#34d399',
    tip: 'O servidor demora para montar a página: banco de dados, código ou falta de cache. Cache de página costuma ter o maior ganho.',
  },
  {
    key: 'download',
    label: 'Download',
    color: '#fb7185',
    tip: 'A página é pesada para baixar. Ative compressão e reduza o HTML e os scripts.',
  },
];

const axisStyle = { stroke: '#71717a', grid: { stroke: '#27272a' }, ticks: { stroke: '#27272a' } };

/** Gráfico em camadas: cada faixa é uma etapa, empilhadas até o tempo total. */
export function PhaseChart({ points }: { points: CheckPoint[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || points.length < 2) return;
    const xs = points.map((p) => p.t / 1000);
    // Acumulados: camada i = soma das etapas 0..i (nulo nas checagens antigas, sem etapas)
    const cumulative = PHASES.map((_, i) =>
      points.map((p) =>
        p.wait === null ? null : PHASES.slice(0, i + 1).reduce((sum, ph) => sum + (p[ph.key] ?? 0), 0),
      ),
    );
    const long = xs[xs.length - 1] - xs[0] > 2 * 86_400;
    const plot = new uPlot(
      {
        width: el.clientWidth,
        height: 240,
        cursor: { y: false },
        legend: { show: false },
        scales: { x: { time: true }, y: { range: (_u, _min, max) => [0, Math.max(100, max * 1.15)] } },
        axes: [
          {
            ...axisStyle,
            values: (_u, splits) =>
              splits.map((v) =>
                new Date(v * 1000).toLocaleString(
                  'pt-BR',
                  long ? { day: '2-digit', month: '2-digit' } : { hour: '2-digit', minute: '2-digit' },
                ),
              ),
          },
          { ...axisStyle, values: (_u, v) => v.map((n) => `${n} ms`), size: 64 },
        ],
        // Da maior camada para a menor: cada uma pinta por cima da anterior, formando a pilha
        series: [
          {},
          ...PHASES.map((ph) => ({
            label: ph.label,
            stroke: ph.color,
            width: 1,
            fill: ph.color,
            points: { show: false },
          })).reverse(),
        ],
      },
      [xs, ...[...cumulative].reverse()],
      el,
    );
    const resize = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height: 240 }));
    resize.observe(el);
    return () => {
      resize.disconnect();
      plot.destroy();
    };
  }, [points]);

  return (
    <div>
      <div ref={ref} className="w-full" />
      <Legend />
    </div>
  );
}

function Legend() {
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
      {PHASES.map((ph) => (
        <span key={ph.key} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: ph.color }} />
          {ph.label}
        </span>
      ))}
    </div>
  );
}

const fmtBytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(2)} MB`;

/** Etapa que mais pesa na média, com a dica de como melhorar (só quando passa de 40% do total). */
export function diagnose(avg: PhaseTimes | null): { label: string; share: number; tip: string } | null {
  if (!avg || avg.wait === null) return null;
  const total = PHASES.reduce((s, ph) => s + (avg[ph.key] ?? 0), 0);
  if (total < 50) return null;
  const top = PHASES.reduce((a, b) => ((avg[b.key] ?? 0) > (avg[a.key] ?? 0) ? b : a));
  const share = (avg[top.key] ?? 0) / total;
  return share >= 0.4 ? { label: top.label, share, tip: top.tip } : null;
}

/** Cascata da última checagem (como a aba Network do navegador) e detalhes da resposta. */
export function LastCheck({ timing }: { timing: TimingSummary }) {
  const last = timing.last;
  const tip = diagnose(timing.average);
  if (!last) return null;
  const t = last.timings;
  const total = Math.max(
    1,
    PHASES.reduce((s, ph) => s + t[ph.key], 0),
  );

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1.5 flex justify-between text-xs text-zinc-500">
          <span>Última checagem</span>
          <span className="tabular-nums">{t.total} ms no total</span>
        </div>
        <div
          className="flex h-7 overflow-hidden rounded-md bg-zinc-950"
          role="img"
          aria-label="Tempo de cada etapa"
        >
          {PHASES.filter((ph) => t[ph.key] > 0).map((ph) => (
            <span
              key={ph.key}
              className="h-full"
              style={{ width: `${(t[ph.key] / total) * 100}%`, background: ph.color, minWidth: 3 }}
              title={`${ph.label}: ${t[ph.key]} ms`}
            />
          ))}
        </div>
        <div className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1 text-xs sm:grid-cols-6">
          {PHASES.map((ph) => (
            <div key={ph.key} className="flex items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-sm" style={{ background: ph.color }} />
              <span className="text-zinc-400">{ph.label}</span>
              <span className="ml-auto font-medium tabular-nums text-zinc-200">{t[ph.key]} ms</span>
            </div>
          ))}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Detail label="Tamanho transferido" value={last.bytes === null ? '—' : fmtBytes(last.bytes)} />
        <Detail
          label="Compressão"
          value={last.encoding ?? 'nenhuma'}
          warn={!last.encoding && (last.bytes ?? 0) > 10_240}
        />
        <Detail label="Redirecionamentos" value={String(last.redirects)} warn={last.redirects > 1} />
        <Detail label="Status" value={last.statusCode === null ? '—' : String(last.statusCode)} />
      </dl>
      {last.finalUrl && last.redirects > 0 && (
        <p className="truncate text-xs text-zinc-500">URL final: {last.finalUrl}</p>
      )}

      {tip && (
        <p className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3.5 text-sm text-zinc-300">
          <span className="font-medium text-emerald-300">
            {tip.label} responde por {Math.round(tip.share * 100)}% do tempo.
          </span>{' '}
          {tip.tip}
        </p>
      )}
    </div>
  );
}

function Detail({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className={`font-medium ${warn ? 'text-amber-400' : ''}`}>{value}</dd>
    </div>
  );
}
