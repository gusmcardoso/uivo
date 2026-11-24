import { useState } from 'react';
import { api, type Site } from '../api.ts';

type Theme = 'escuro' | 'claro';

/** Selo "monitorado com uivo": prévia ao vivo e o código pronto para colar no rodapé do site. */
export function BadgePanel({ site, onChange }: { site: Site; onChange: () => void }) {
  const [theme, setTheme] = useState<Theme>('escuro');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const origin = window.location.origin;
  const src = `${origin}/badge/${site.id}.svg${theme === 'claro' ? '?tema=claro' : ''}`;
  const code = `<a href="${origin}/status" target="_blank" rel="noopener" title="Status do site">\n  <img src="${src}" alt="Monitorado com Uivo" height="24">\n</a>`;

  async function makePublic() {
    setBusy(true);
    try {
      await api.updateSite(site.id, { public: true });
      onChange();
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(code).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  if (!site.public) {
    return (
      <div className="max-w-xl space-y-3">
        <h3 className="panel-title">Selo "monitorado com uivo"</h3>
        <p className="text-sm text-zinc-400">
          Um selo para o rodapé do site, com o status ao vivo e o uptime dos últimos 30 dias. Clicar nele leva
          à página de status pública.
        </p>
        <p className="text-sm text-zinc-400">
          Para usar, o site precisa aparecer na{' '}
          <span className="text-zinc-200">página de status pública</span> (só nome, situação e uptime ficam
          visíveis; o endereço monitorado e os detalhes continuam privados).
        </p>
        <button type="button" className="btn-primary" disabled={busy} onClick={makePublic}>
          {busy ? 'Salvando…' : 'Mostrar na página de status e liberar o selo'}
        </button>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className="space-y-4">
        <div>
          <h3 className="panel-title">Selo "monitorado com uivo"</h3>
          <p className="mt-1 text-sm text-zinc-400">
            Cole no rodapé do site, ao lado dos créditos. O ponto fica verde quando o site está no ar e
            vermelho se cair; o número é o uptime dos últimos 30 dias. Atualiza sozinho a cada 5 minutos.
          </p>
        </div>
        <div className="flex gap-1 rounded-sm border border-zinc-800 p-0.5">
          {(['escuro', 'claro'] as const).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={theme === t}
              onClick={() => setTheme(t)}
              className={`flex-1 rounded-[2px] px-3 py-1 text-xs ${theme === t ? 'bg-brand/15 text-brand' : 'text-zinc-500 hover:text-zinc-200'}`}
            >
              {t === 'escuro' ? 'Para fundo escuro' : 'Para fundo claro'}
            </button>
          ))}
        </div>
        <div
          className={`grid place-items-center rounded-sm border border-zinc-800 p-8 ${theme === 'claro' ? 'bg-zinc-100' : 'bg-zinc-950'}`}
        >
          <img src={src} alt="Prévia do selo" height={24} />
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="label-xs">Código para colar no site</span>
          <button type="button" className="btn" onClick={copy}>
            {copied ? 'Copiado ✓' : 'Copiar código'}
          </button>
        </div>
        <pre className="overflow-x-auto rounded-sm border border-zinc-800 bg-zinc-950/80 p-3 text-xs leading-relaxed text-zinc-300">
          {code}
        </pre>
        <p className="text-xs text-zinc-500">
          Funciona em qualquer site (HTML, WordPress, React…). Se o site deixar de ser público, o selo para de
          aparecer.
        </p>
      </div>
    </div>
  );
}
