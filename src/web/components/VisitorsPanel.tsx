import { useEffect, useState } from 'react';
import { api, type Site, type Visitors } from '../api.ts';

/*
 * Visitantes do site pelo Web Analytics da Vercel: números do dia, da semana e do mês, barras dos
 * últimos 30 dias e dos últimos meses (quando o plano guarda esse histórico).
 */

const n = (v: number) => v.toLocaleString('pt-BR');
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const dayLabel = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const monthName = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]}/${month.slice(2, 4)}`;
/** rótulo curto embaixo da barra: só o mês, com o ano em janeiro e na primeira barra */
const monthLabel = (month: string, first: boolean) =>
  first || month.endsWith('-01') ? monthName(month) : MONTHS[Number(month.slice(5, 7)) - 1];

export function VisitorsPanel({ site }: { site: Site }) {
  const [data, setData] = useState<Visitors | null>(null);
  const [failed, setFailed] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: recarrega quando o projeto muda
  useEffect(() => {
    let alive = true;
    setData(null);
    setFailed(false);
    api
      .visitors(site.id)
      .then((v) => alive && setData(v))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [site.id, site.vercel_project]);

  if (failed) return <Note>Não foi possível carregar os visitantes agora.</Note>;
  if (!data) return <Note>Consultando a Vercel…</Note>;
  if (!data.configured)
    return data.reason === 'token' ? (
      <Note>
        Para ver os visitantes, defina <code className="text-zinc-200">VERCEL_TOKEN</code> no{' '}
        <code className="text-zinc-200">.env</code> do servidor (um token criado em vercel.com → Account
        Settings → Tokens) e reinicie o Uivo.
      </Note>
    ) : (
      <Note>Informe o projeto da Vercel deste site em “Editar”.</Note>
    );
  if (data.error !== null) return <Note tone="warn">{data.error}</Note>;

  const days = data.days;
  const today = days[days.length - 1];
  const yesterday = days[days.length - 2];
  const week = days.slice(-7).reduce((a, d) => a + d.visitors, 0);
  const prevWeek = days.slice(-14, -7).reduce((a, d) => a + d.visitors, 0);
  const change = prevWeek ? Math.round(((week - prevWeek) / prevWeek) * 100) : null;

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Hoje" value={n(today.visitors)} hint={`${n(today.pageviews)} páginas vistas`} />
        <Stat label="Ontem" value={n(yesterday.visitors)} hint={`${n(yesterday.pageviews)} páginas vistas`} />
        <Stat
          label="Últimos 7 dias"
          value={n(week)}
          hint={
            change === null
              ? 'soma dos visitantes de cada dia'
              : `${change >= 0 ? '↑' : '↓'} ${Math.abs(change)}% contra a semana anterior`
          }
        />
        <Stat
          label="Este mês"
          value={n(data.thisMonth.visitors)}
          hint={`visitantes únicos · ${n(data.thisMonth.pageviews)} páginas vistas`}
        />
      </dl>

      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <span className="panel-title">Visitantes por dia</span>
          <span className="text-xs text-zinc-400">últimos 30 dias</span>
        </div>
        <Bars
          items={days.map((d) => ({
            key: d.date,
            value: d.visitors,
            label: dayLabel(d.date),
            title: `${dayLabel(d.date)}: ${n(d.visitors)} visitantes, ${n(d.pageviews)} páginas vistas`,
          }))}
          every={5}
        />
      </div>

      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <span className="panel-title">Visitantes por mês</span>
          {!data.monthsLimited && <span className="text-xs text-zinc-400">últimos 12 meses</span>}
        </div>
        {data.monthsLimited ? (
          <p className="text-sm text-zinc-400">
            A Vercel ainda não tem histórico de mais de um mês para este projeto. No plano Hobby ela guarda só
            o último mês; o gráfico mensal aparece quando houver mais meses (plano Pro guarda 12).
          </p>
        ) : (
          <Bars
            items={data.months.map((m, i) => ({
              key: m.month,
              value: m.visitors,
              label: monthLabel(m.month, i === 0),
              title: `${monthName(m.month)}: ${n(m.visitors)} visitantes, ${n(m.pageviews)} páginas vistas`,
            }))}
            every={1}
          />
        )}
      </div>

      <p className="text-xs text-zinc-400">
        Dados do Web Analytics da Vercel (só produção, dias em UTC), atualizados a cada 10 minutos.
      </p>
    </div>
  );
}

function Note({ children, tone }: { children: React.ReactNode; tone?: 'warn' }) {
  return <p className={`text-sm ${tone === 'warn' ? 'text-amber-300' : 'text-zinc-300'}`}>{children}</p>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <dt className="label-xs">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums text-zinc-100">{value}</dd>
      <dd className="mt-0.5 text-xs text-zinc-400">{hint}</dd>
    </div>
  );
}

function Bars({
  items,
  every,
}: {
  items: { key: string; value: number; label: string; title: string }[];
  /** de quantas em quantas barras mostrar o rótulo embaixo */
  every: number;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div>
      <div
        className="flex h-36 items-end gap-[3px] border-b border-zinc-800"
        role="img"
        aria-label="Gráfico de visitantes"
      >
        {items.map((i) => (
          <div key={i.key} className="group relative flex h-full flex-1 items-end" title={i.title}>
            <div
              className="w-full rounded-t-[1px] bg-brand/70 transition-colors group-hover:bg-brand"
              style={{ height: `${Math.max(i.value ? 3 : 1, (i.value / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[3px]">
        {items.map((i, idx) => (
          <span
            key={i.key}
            className="flex-1 whitespace-nowrap text-center text-[10px] text-zinc-400 tabular-nums"
          >
            {(items.length - 1 - idx) % every === 0 ? i.label : ''}
          </span>
        ))}
      </div>
    </div>
  );
}
