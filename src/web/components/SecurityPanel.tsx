import { useEffect, useState } from 'react';
import { api, type SecurityAudit, type Severity } from '../api.ts';
import { relativeTime } from '../format.ts';

const ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const SEVERITY: Record<Severity, { label: string; className: string }> = {
  critical: { label: 'Crítico', className: 'bg-red-500/15 text-red-300 ring-red-500/30' },
  high: { label: 'Alto', className: 'bg-orange-500/15 text-orange-300 ring-orange-500/30' },
  medium: { label: 'Médio', className: 'bg-amber-500/15 text-amber-300 ring-amber-500/30' },
  low: { label: 'Baixo', className: 'bg-zinc-500/15 text-zinc-300 ring-zinc-500/30' },
};

export function scoreTone(score: number | null): string {
  if (score === null) return 'text-zinc-500';
  if (score >= 90) return 'text-emerald-400';
  if (score >= 70) return 'text-amber-400';
  return 'text-red-400';
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

  const hasNewScripts = audit?.findings.some((f) => f.id.startsWith('new-script:')) ?? false;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <span className={`text-3xl font-semibold tabular-nums ${scoreTone(audit?.score ?? null)}`}>
            {audit?.score ?? '—'}
          </span>
          <span className="text-sm text-zinc-400">
            nota de segurança{audit?.at ? ` · auditado ${relativeTime(audit.at)}` : ' · ainda não auditado'}
          </span>
        </div>
        <div className="flex gap-2">
          {hasNewScripts && (
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => run('accept')}>
              Aceitar scripts atuais
            </button>
          )}
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => run('audit')}>
            {busy ? 'Auditando…' : 'Auditar agora'}
          </button>
        </div>
      </div>

      {audit && audit.findings.length > 0 && (
        <ul className="space-y-2">
          {[...audit.findings]
            .sort((a, b) => ORDER[a.severity] - ORDER[b.severity])
            .map((f) => (
              <li key={f.id} className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-md px-2 py-0.5 text-xs font-medium ring-1 ${SEVERITY[f.severity].className}`}
                  >
                    {SEVERITY[f.severity].label}
                  </span>
                  <span className="font-medium">{f.title}</span>
                </div>
                <p className="mt-1.5 text-sm text-zinc-400">{f.detail}</p>
                <p className="mt-1 text-sm text-emerald-300/90">
                  <span className="text-zinc-500">Como corrigir: </span>
                  {f.fix}
                </p>
              </li>
            ))}
        </ul>
      )}

      {audit?.at && audit.findings.length === 0 && (
        <p className="text-sm text-emerald-400">Nenhum problema encontrado. 🛡️</p>
      )}

      {audit && audit.passed.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {audit.passed.map((p) => (
            <span key={p} className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300">
              ✓ {p}
            </span>
          ))}
        </div>
      )}

      <p className="text-xs text-zinc-500">
        Auditoria passiva, 1x ao dia: lê só o que qualquer visitante acessa (página, cabeçalhos e endereços
        públicos conhecidos). Use apenas em sites que você administra.
      </p>
    </div>
  );
}
