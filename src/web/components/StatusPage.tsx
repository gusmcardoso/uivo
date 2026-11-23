import { useEffect, useState } from 'react';
import { api, type PublicStatus } from '../api.ts';
import { duration, formatUptime } from '../format.ts';
import { Logo } from './Logo.tsx';

const REFRESH_MS = 60_000;

function barColor(value: number | null): string {
  if (value === null) return 'bg-zinc-800';
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
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">{data?.title ?? 'Status'}</h1>

      {failed && <p className="mt-6 text-sm text-red-300">Não foi possível carregar o status agora.</p>}

      {data && (
        <div
          className={`mt-6 flex items-center gap-3 rounded-2xl border p-5 ${
            allUp ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-red-500/30 bg-red-500/10'
          }`}
        >
          <span className={`size-3 rounded-full ${allUp ? 'bg-emerald-400' : 'bg-red-500'}`} />
          <span className="font-medium">
            {data.sites.length === 0
              ? 'Nenhum serviço publicado ainda.'
              : allUp
                ? 'Todos os serviços estão operando normalmente.'
                : `${down.length} serviço(s) com problema no momento.`}
          </span>
        </div>
      )}

      <section className="mt-6 space-y-3">
        {data?.sites.map((s) => (
          <article key={s.id} className="card p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate font-medium">{s.name}</h2>
                <p className="truncate text-xs text-zinc-500">{s.host}</p>
              </div>
              <div className="text-right text-sm">
                <div className={s.status === 'down' ? 'font-medium text-red-400' : 'text-emerald-400'}>
                  {s.status === 'down' ? 'Fora do ar' : s.status === 'up' ? 'Operacional' : 'Verificando'}
                </div>
                <div className="text-xs text-zinc-500">
                  {s.downSince
                    ? `há ${duration(Date.now() - s.downSince)}`
                    : `${formatUptime(s.uptime)} em ${data.days} dias`}
                </div>
              </div>
            </div>
            <div className="mt-4 flex h-8 gap-[2px]" role="img" aria-label={`Histórico de ${data.days} dias`}>
              {s.history.map((value, i) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: posição fixa = dia do histórico
                  key={i}
                  className={`flex-1 rounded-[2px] ${barColor(value)}`}
                  title={`${dayLabel(i, s.history.length)}: ${value === null ? 'sem dados' : formatUptime(value)}`}
                />
              ))}
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] text-zinc-500">
              <span>{data.days} dias atrás</span>
              <span>hoje</span>
            </div>
          </article>
        ))}
      </section>

      <footer className="mt-10 flex items-center justify-center gap-2 text-xs text-zinc-500">
        Monitorado com
        <a
          href="https://github.com/gusmcardoso/uptrue"
          className="opacity-80 hover:opacity-100"
          rel="noopener"
        >
          <span className="scale-75 inline-block origin-left">
            <Logo />
          </span>
        </a>
      </footer>
    </main>
  );
}
