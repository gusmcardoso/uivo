import { useEffect, useState } from 'react';
import { api, type PublicStatus } from '../api.ts';
import { duration, formatUptime } from '../format.ts';
import { Footer } from './Footer.tsx';
import { Logo } from './Logo.tsx';
import { PixelBackground } from './PixelBackground.tsx';

const REFRESH_MS = 60_000;

function barColor(value: number | null): string {
  if (value === null) return 'bg-zinc-800/70';
  if (value >= 99.5) return 'bg-emerald-500';
  if (value >= 95) return 'bg-amber-400';
  return 'bg-red-500';
}

function dayLabel(index: number, total: number): string {
  const date = new Date(Date.now() - (total - 1 - index) * 86_400_000);
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

export function StatusPage() {
  const [data, setData] = useState<PublicStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const load = () =>
      api
        .publicStatus()
        .then((d) => {
          setData(d);
          setFailed(false);
          document.title = d.title;
        })
        .catch(() => setFailed(true));
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const down = data?.sites.filter((s) => s.status === 'down') ?? [];
  const allUp = data !== null && data.sites.length > 0 && down.length === 0;

  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <PixelBackground />
      <p className="font-mono text-xs text-zinc-500">
        <span className="text-brand">$</span> uivo status --público<span className="cursor-blink">_</span>
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-100">{data?.title ?? 'Status'}</h1>
      {data && (
        <p className="mt-1 text-sm text-zinc-500">
          Atualizado às{' '}
          {new Date(data.updatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
        </p>
      )}

      {failed && <p className="mt-6 text-sm text-red-300">Não foi possível carregar o status agora.</p>}

      {data && (
        <div
          className={`mt-6 flex items-center gap-3 rounded-md border px-5 py-4 backdrop-blur-[2px] ${
            allUp ? 'border-emerald-500/25 bg-emerald-950/40' : 'border-red-500/30 bg-red-950/40'
          }`}
        >
          <span className="relative flex size-2.5">
            {!allUp && data.sites.length > 0 && (
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-60" />
            )}
            <span className={`relative size-2.5 rounded-full ${allUp ? 'bg-emerald-400' : 'bg-red-500'}`} />
          </span>
          <span className="font-medium text-zinc-100">
            {data.sites.length === 0
              ? 'Nenhum serviço publicado ainda.'
              : allUp
                ? 'Todos os serviços estão operando normalmente.'
                : `${down.length} serviço(s) com problema no momento.`}
          </span>
        </div>
      )}

      {data && data.sites.length > 0 && (
        <section className="card mt-6 divide-y divide-zinc-800/80">
          {data.sites.map((s) => (
            <article key={s.id} className="px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate font-medium text-zinc-100">{s.name}</h2>
                  <p className="truncate text-xs text-zinc-500">{s.host}</p>
                </div>
                <div className="text-right text-sm">
                  <div className={s.status === 'down' ? 'font-medium text-red-400' : 'text-emerald-400'}>
                    {s.status === 'down' ? 'Fora do ar' : s.status === 'up' ? 'Operacional' : 'Verificando'}
                  </div>
                  <div className="text-xs text-zinc-500 tabular-nums">
                    {s.downSince
                      ? `há ${duration(Date.now() - s.downSince)}`
                      : `${formatUptime(s.uptime)} em ${data.days} dias`}
                  </div>
                </div>
              </div>
              <div
                className="mt-3 flex h-7 gap-[2px]"
                role="img"
                aria-label={`Histórico de ${data.days} dias`}
              >
                {s.history.map((value, i) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: posição fixa = dia do histórico
                    key={i}
                    className={`flex-1 rounded-[2px] ${barColor(value)}`}
                    title={`${dayLabel(i, s.history.length)}: ${value === null ? 'sem dados' : formatUptime(value)}`}
                  />
                ))}
              </div>
              <div className="mt-1.5 flex justify-between text-[11px] text-zinc-600">
                <span>{data.days} dias atrás</span>
                <span>hoje</span>
              </div>
            </article>
          ))}
        </section>
      )}

      <div className="mt-12 flex items-center justify-center gap-2 font-mono text-[11px] text-zinc-500">
        monitorado com
        <a
          href="https://github.com/gusmcardoso/uivo"
          className="opacity-70 transition-opacity hover:opacity-100"
          rel="noopener"
        >
          <Logo className="h-5" />
        </a>
      </div>
      <Footer className="mt-4" />
    </main>
  );
}
