import { type FormEvent, useEffect, useState } from 'react';
import type { Site } from '../api.ts';

/** Últimos 12 meses no formato AAAA-MM, do mais recente ao mais antigo. */
function lastMonths(): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < 12; i++) {
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    out.push({ value, label: i === 0 ? `${label} (em andamento)` : label });
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

export function ReportDialog({ sites, onClose }: { sites: Site[]; onClose: () => void }) {
  const months = lastMonths();
  const [month, setMonth] = useState(months[1].value); // padrão: o último mês completo
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<number[]>(sites.map((s) => s.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (selected.length === 0) {
      setError('Escolha pelo menos um site.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const params = new URLSearchParams({ month, sites: selected.join(',') });
      if (title.trim()) params.set('title', title.trim());
      const res = await fetch(`/api/reports/monthly?${params}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Erro ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `relatorio-uivo-${month}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: number) =>
    setSelected((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clique no fundo fecha; teclado fecha com Esc
    <div
      className="fixed inset-0 z-20 grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <form
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
        className="card w-full max-w-md space-y-4 bg-zinc-900 p-6"
      >
        <div>
          <h2 className="text-lg font-semibold">Relatório em PDF</h2>
          <p className="mt-1 text-sm text-zinc-400">
            Uptime, quedas, tempo de resposta, segurança e vencimentos de cada site no mês, pronto para enviar
            ao cliente.
          </p>
        </div>
        <label className="block space-y-1.5 text-sm">
          <span className="label-xs">Mês</span>
          <select className="input" value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="label-xs">Título</span>
          <input
            className="input"
            maxLength={120}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Relatório de monitoramento"
          />
        </label>
        <fieldset className="space-y-1.5">
          <legend className="label-xs mb-1">Sites</legend>
          <div className="max-h-48 space-y-1 overflow-y-auto">
            {sites.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  className="accent-sky-300"
                  checked={selected.includes(s.id)}
                  onChange={() => toggle(s.id)}
                />
                {s.name}
              </label>
            ))}
          </div>
        </fieldset>
        {error && (
          <p className="rounded-sm border border-red-500/30 bg-red-500/10 px-3 py-2 font-mono text-xs text-red-300">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Gerando…' : 'Gerar PDF'}
          </button>
        </div>
      </form>
    </div>
  );
}
