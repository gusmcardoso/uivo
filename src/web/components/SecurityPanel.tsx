import { useEffect, useState } from 'react';
import { api, type SecurityAudit, type Severity } from '../api.ts';
import { relativeTime } from '../format.ts';

const ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];

const SEVERITY: Record<Severity, { label: string; text: string; bar: string; hint: string }> = {
  critical: { label: 'Crítico', text: 'text-red-400', bar: 'bg-red-500', hint: 'corrigir hoje' },
  high: { label: 'Alto', text: 'text-orange-400', bar: 'bg-orange-400', hint: 'corrigir esta semana' },
  medium: { label: 'Médio', text: 'text-amber-400', bar: 'bg-amber-400', hint: 'planejar a correção' },
  low: { label: 'Baixo', text: 'text-zinc-400', bar: 'bg-zinc-500', hint: 'quando der' },
};

export function scoreTone(score: number | null): string {
  if (score === null) return 'text-zinc-500';
  if (score >= 90) return 'text-emerald-400';
  if (score >= 70) return 'text-amber-400';
  return 'text-red-400';
}

const verdict = (score: number | null) =>
  score === null
    ? 'ainda não auditado'
    : score >= 90
      ? 'bem protegido'
      : score >= 70
        ? 'alguns pontos a melhorar'
        : 'precisa de atenção';

/** Nota de 0 a 100 num anel, como um medidor. */
function ScoreRing({ score }: { score: number | null }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const pct = score === null ? 0 : score / 100;
  const color = score === null ? '#3f3f46' : score >= 90 ? '#34d399' : score >= 70 ? '#fbbf24' : '#f87171';
  return (
    <svg
      viewBox="0 0 100 100"
      className="size-28 shrink-0"
      role="img"
      aria-label={`Nota de segurança ${score ?? 'sem dados'}`}
    >
      <circle cx="50" cy="50" r={r} fill="none" stroke="#27272a" strokeWidth="7" />
      <circle
        cx="50"
        cy="50"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="7"
        strokeDasharray={`${pct * c} ${c}`}
        strokeLinecap="butt"
        transform="rotate(-90 50 50)"
      />
      <text x="50" y="55" textAnchor="middle" className="fill-zinc-100" style={{ fontSize: 24 }}>
        {score ?? '—'}
      </text>
    </svg>
  );
}

export function SecurityPanel({ siteId, onChange }: { siteId: number; onChange: () => void }) {
  const [audit, setAudit] = useState<SecurityAudit | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .security(siteId)
      .then(setAudit)
      .catch(() => setAudit(null));
  }, [siteId]);

  async function run(action: 'audit' | 'accept') {
    setBusy(true);
    try {
      setAudit(action === 'audit' ? await api.runSecurity(siteId) : await api.acceptScripts(siteId));
      onChange();
    } finally {
      setBusy(false);
    }
  }

  const findings = [...(audit?.findings ?? [])].sort(
    (a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity),
  );
  const counts = ORDER.map((sev) => ({ sev, n: findings.filter((f) => f.severity === sev).length }));
  const hasNewScripts = findings.some((f) => f.id.startsWith('new-script:'));

  return (
    <div className="grid gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
      {/* coluna da nota: veredito, contagem por gravidade e ações */}
      <aside className="space-y-4">
        <div className="flex items-center gap-4">
          <ScoreRing score={audit?.score ?? null} />
          <div>
            <div className={`text-sm font-medium ${scoreTone(audit?.score ?? null)}`}>
              {verdict(audit?.score ?? null)}
            </div>
            <div className="mt-0.5 text-[11px] text-zinc-500">
              {audit?.at ? `auditado ${relativeTime(audit.at)}` : 'sem auditoria'}
            </div>
          </div>
        </div>
        <ul className="space-y-1.5 text-xs">
          {counts.map(({ sev, n }) => (
            <li key={sev} className="flex items-center gap-2">
              <span className={`size-2 rounded-[1px] ${n ? SEVERITY[sev].bar : 'bg-zinc-800'}`} />
              <span className={n ? SEVERITY[sev].text : 'text-zinc-600'}>{SEVERITY[sev].label}</span>
              <span className="ml-auto tabular-nums text-zinc-400">{n}</span>
            </li>
          ))}
          <li className="flex items-center gap-2 border-t border-zinc-800/80 pt-1.5">
            <span className="size-2 rounded-[1px] bg-emerald-400/80" />
            <span className="text-emerald-400/90">Aprovado</span>
            <span className="ml-auto tabular-nums text-zinc-400">{audit?.passed.length ?? 0}</span>
          </li>
        </ul>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn" disabled={busy} onClick={() => run('audit')}>
            {busy ? 'Auditando…' : 'Auditar agora'}
          </button>
          {hasNewScripts && (
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => run('accept')}>
              Aceitar scripts atuais
            </button>
          )}
        </div>
        <p className="text-xs leading-relaxed text-zinc-500">
          Auditoria passiva, 1x ao dia: lê só o que qualquer visitante acessa. Use apenas em sites que você
          administra.
        </p>
      </aside>

      {/* achados: o que fazer, por ordem de gravidade */}
      <div className="min-w-0 space-y-4">
        {audit?.error && (
          <p className="rounded-sm border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">
            A última auditoria não pôde ser feita: {audit.error}
          </p>
        )}

        <div>
          <div className="panel-title mb-2">{`O que corrigir (${findings.length})`}</div>
          {findings.length === 0 ? (
            <p className="text-sm text-zinc-400">
              {audit?.at
                ? 'Nenhum problema encontrado na última auditoria.'
                : 'Rode a primeira auditoria para ver a nota.'}
            </p>
          ) : (
            <ul className="divide-y divide-zinc-800/70 rounded-sm border border-zinc-800/80">
              {findings.map((f) => (
                <li key={f.id}>
                  <details className="group">
                    <summary className="flex cursor-pointer list-none items-start gap-3 px-3.5 py-3 hover:bg-zinc-900/50">
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-[1px] ${SEVERITY[f.severity].bar}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-zinc-100">{f.title}</span>
                        <span className="text-[11px] text-zinc-500">
                          <span className={SEVERITY[f.severity].text}>{SEVERITY[f.severity].label}</span> ·{' '}
                          {SEVERITY[f.severity].hint}
                        </span>
                      </span>
                      <span className="text-xs text-zinc-600 transition-transform group-open:rotate-90">
                        ›
                      </span>
                    </summary>
                    <div className="space-y-2 px-3.5 pb-3.5 pl-8.5 text-sm">
                      <p className="text-zinc-400">{f.detail}</p>
                      <div className="rounded-sm border border-zinc-800 bg-zinc-950/80 p-2.5">
                        <div className="label-xs mb-1">Como corrigir</div>
                        <p className="text-[12.5px] text-brand/90">{f.fix}</p>
                      </div>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </div>

        {audit && audit.script_hosts.length > 0 && (
          <div>
            <div className="panel-title mb-2">Scripts de terceiros na página</div>
            <div className="flex flex-wrap gap-1.5">
              {audit.script_hosts.map((h) => (
                <span key={h} className="rounded-sm border border-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                  {h}
                </span>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-zinc-500">
              Se aparecer um endereço que você não reconhece, o Uivo avisa.
            </p>
          </div>
        )}

        {audit && audit.passed.length > 0 && (
          <details className="group">
            <summary className="panel-title cursor-pointer list-none hover:text-zinc-300">
              {`O que já está certo (${audit.passed.length})`}{' '}
              <span className="group-open:hidden">· ver</span>
            </summary>
            <ul className="mt-2 grid gap-1 sm:grid-cols-2">
              {audit.passed.map((p) => (
                <li key={p} className="flex gap-2 text-sm text-zinc-400">
                  <span className="text-emerald-400">✓</span>
                  {p}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
