import { useEffect, useRef, useState } from 'react';
import { api, type CheckPoint, type Moment } from '../api.ts';
import { PHASES } from './TimingPanel.tsx';

/** Posição do cursor no gráfico, em px relativos ao container do gráfico. */
export interface Hover {
  idx: number;
  x: number;
  width: number;
}

const time = (t: number, withDay: boolean) =>
  new Date(t).toLocaleString(
    'pt-BR',
    withDay
      ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }
      : { hour: '2-digit', minute: '2-digit' },
  );

/** Diferença percentual contra uma referência, em palavras (mais lento = pior). */
function Delta({ now, ref }: { now: number | null; ref: number | null }) {
  if (now === null || ref === null || ref <= 0) return <span className="text-zinc-600">sem dados</span>;
  const pct = Math.round(((now - ref) / ref) * 100);
  if (Math.abs(pct) < 5) return <span className="text-zinc-400">{ref} ms · igual</span>;
  const slower = pct > 0;
  return (
    <span className="tabular-nums">
      <span className="text-zinc-400">{ref} ms · </span>
      <span className={slower ? (pct >= 50 ? 'text-red-400' : 'text-orange-400') : 'text-emerald-400'}>
        {slower ? `+${pct}% mais lento` : `${pct}% mais rápido`}
      </span>
    </span>
  );
}

/**
 * Detalhe do ponto sob o mouse: resposta, etapas, falhas e comparação com o mesmo horário
 * ontem, há 7 dias e o normal desse horário (média dos 7 dias anteriores).
 */
export function MomentTooltip({
  siteId,
  point,
  hover,
  bucketMs,
  longRange,
}: {
  siteId: number;
  point: CheckPoint;
  hover: Hover;
  bucketMs: number;
  longRange: boolean;
}) {
  const cache = useRef(new Map<string, Moment>());
  const [moment, setMoment] = useState<Moment | null>(null);
  const key = `${siteId}:${point.t}:${bucketMs}`;

  useEffect(() => {
    const hit = cache.current.get(key);
    if (hit) {
      setMoment(hit);
      return;
    }
    setMoment(null);
    // espera o mouse parar um instante antes de consultar (evita uma requisição por pixel)
    const timer = setTimeout(() => {
      api
        .moment(siteId, point.t, bucketMs)
        .then((m) => {
          cache.current.set(key, m);
          setMoment(m);
        })
        .catch(() => undefined);
    }, 120);
    return () => clearTimeout(timer);
  }, [key, siteId, point.t, bucketMs]);

  const failed = point.ok === 0;
  const hasPhases = point.wait !== null;
  const now = moment?.current.avg ?? (failed ? null : point.ms);
  const left = hover.x > hover.width / 2;
  const fails = moment?.current.fails;

  return (
    <div
      className="pointer-events-none absolute top-2 z-10 w-80 rounded-xl border border-zinc-700/80 bg-zinc-900/95 p-3.5 text-xs shadow-2xl shadow-black/50 backdrop-blur"
      style={left ? { right: hover.width - hover.x + 14 } : { left: hover.x + 14 }}
      role="status"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-zinc-200">
          {time(point.t, longRange)} – {time(point.t + bucketMs, false)}
        </span>
        <span className="text-zinc-500">
          {point.n} checage{point.n === 1 ? 'm' : 'ns'}
        </span>
      </div>

      <div className="mt-2.5 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums text-zinc-100">
          {now === null ? '—' : `${now} ms`}
        </span>
        <span className="text-zinc-500">resposta média</span>
      </div>
      {moment && moment.current.min !== null && moment.current.max !== moment.current.min && (
        <div className="text-zinc-500 tabular-nums">
          de {moment.current.min} a {moment.current.max} ms
        </div>
      )}
      {(failed || (fails ?? 0) > 0) && (
        <div className="mt-2 rounded-md bg-red-500/10 px-2 py-1 text-red-300">
          {fails ? `${fails} de ${moment?.current.n} checagens falharam` : 'Houve falha neste intervalo'}
          {moment?.incidents[0]?.reason ? ` · ${moment.incidents[0].reason}` : ''}
        </div>
      )}

      {hasPhases && (
        <div className="mt-3">
          <div className="flex h-1.5 overflow-hidden rounded-full bg-zinc-800">
            {PHASES.filter((ph) => (point[ph.key] ?? 0) > 0).map((ph) => (
              <span
                key={ph.key}
                style={{
                  width: `${((point[ph.key] ?? 0) / Math.max(1, point.ms)) * 100}%`,
                  background: ph.color,
                }}
              />
            ))}
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5">
            {PHASES.filter((ph) => (point[ph.key] ?? 0) > 0).map((ph) => (
              <span key={ph.key} className="flex items-center gap-1 text-zinc-400">
                <span className="size-1.5 rounded-full" style={{ background: ph.color }} />
                {ph.label} <span className="ml-auto tabular-nums text-zinc-300">{point[ph.key]}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 space-y-1 border-t border-zinc-800 pt-2.5">
        <div className="label-xs mb-1">Comparado com</div>
        {moment ? (
          <>
            <Row label="Ontem, mesma hora">
              <Delta now={now} ref={moment.yesterday.avg} />
            </Row>
            <Row label="Há 7 dias">
              <Delta now={now} ref={moment.lastWeek.avg} />
            </Row>
            <Row label={`Normal (${moment.typical.days} dias)`}>
              <Delta now={now} ref={moment.typical.avg} />
            </Row>
          </>
        ) : (
          <div className="text-zinc-600">carregando…</div>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="shrink-0 text-zinc-500">{label}</span>
      {children}
    </div>
  );
}
