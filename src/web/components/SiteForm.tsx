import { type FormEvent, useEffect, useState } from 'react';
import { api, type Site, type SitePayload } from '../api.ts';

const INTERVALS = [
  { value: 30, label: '30 segundos' },
  { value: 60, label: '1 minuto' },
  { value: 300, label: '5 minutos' },
  { value: 900, label: '15 minutos' },
  { value: 3600, label: '1 hora' },
];

export function SiteForm({
  site,
  onClose,
  onSaved,
}: {
  site?: Site;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<SitePayload>({
    name: site?.name ?? '',
    url: site?.url ?? 'https://',
    interval_sec: site?.interval_sec ?? 60,
    keyword: site?.keyword ?? '',
    enabled: site ? Boolean(site.enabled) : true,
    check_domain: site ? Boolean(site.check_domain) : true,
    public: site ? Boolean(site.public) : false,
  });
  // Cabeçalhos de liberação: os valores salvos nunca voltam do servidor (só os nomes);
  // valor em branco num nome já salvo mantém o segredo.
  const [headers, setHeaders] = useState<{ name: string; value: string; saved: boolean }[]>(
    (site?.custom_header_names ?? []).map((name) => ({ name, value: '', saved: true })),
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof SitePayload>(key: K, value: SitePayload[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body = {
      ...form,
      name: form.name.trim(),
      url: form.url.trim(),
      keyword: form.keyword?.trim() || null,
      headers: Object.fromEntries(headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value])),
    };
    try {
      await (site ? api.updateSite(site.id, body) : api.createSite(body));
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

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
        <h2 className="text-lg font-semibold">{site ? 'Editar site' : 'Novo site'}</h2>
        <label className="block space-y-1.5 text-sm">
          <span className="label-xs">Nome</span>
          <input
            className="input"
            required
            maxLength={80}
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Loja do cliente"
          />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="label-xs">Endereço</span>
          <input
            className="input"
            type="url"
            required
            value={form.url}
            onChange={(e) => set('url', e.target.value)}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1.5 text-sm">
            <span className="label-xs">Verificar a cada</span>
            <select
              className="input"
              value={form.interval_sec}
              onChange={(e) => set('interval_sec', Number(e.target.value))}
            >
              {INTERVALS.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="label-xs">Palavra-chave</span>
            <input
              className="input"
              maxLength={200}
              value={form.keyword ?? ''}
              onChange={(e) => set('keyword', e.target.value)}
              placeholder="opcional"
            />
          </label>
        </div>
        <p className="-mt-1 text-xs text-zinc-500">
          Com palavra-chave, o site só conta como no ar se o texto aparecer na página (detecta página em
          branco ou erro com 200).
        </p>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            className="accent-sky-300"
            checked={form.check_domain}
            onChange={(e) => set('check_domain', e.target.checked)}
          />
          Avisar vencimento do domínio
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            className="accent-sky-300"
            checked={form.public}
            onChange={(e) => set('public', e.target.checked)}
          />
          Mostrar na página de status pública
        </label>
        <fieldset className="space-y-2">
          <legend className="text-sm text-zinc-300">Cabeçalhos de liberação (opcional)</legend>
          <p className="text-xs text-zinc-500">
            Para sites atrás de firewall com desafio anti-bot: o Uivo envia o cabeçalho e o firewall libera
            quem o tiver. Os valores ficam só no servidor e não são exibidos de novo.
          </p>
          {headers.map((h, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: linhas editáveis sem identificador próprio
            <div key={i} className="flex gap-2">
              <input
                className="input"
                placeholder="x-uivo-key"
                maxLength={64}
                value={h.name}
                onChange={(e) =>
                  setHeaders((list) =>
                    list.map((x, j) => (j === i ? { ...x, name: e.target.value, saved: false } : x)),
                  )
                }
              />
              <input
                className="input"
                type="password"
                autoComplete="off"
                maxLength={512}
                placeholder={h.saved ? 'manter o valor salvo' : 'valor secreto'}
                value={h.value}
                onChange={(e) =>
                  setHeaders((list) => list.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
                }
              />
              <button
                type="button"
                className="btn-ghost px-2.5 hover:text-red-400"
                title="Remover"
                onClick={() => setHeaders((list) => list.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
          {headers.length < 5 && (
            <button
              type="button"
              className="btn-ghost px-0 text-brand hover:bg-transparent"
              onClick={() => setHeaders((list) => [...list, { name: '', value: '', saved: false }])}
            >
              + Adicionar cabeçalho
            </button>
          )}
        </fieldset>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            className="accent-sky-300"
            checked={form.enabled}
            onChange={(e) => set('enabled', e.target.checked)}
          />
          Monitoramento ativo
        </label>
        {error && (
          <p className="rounded-sm border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </form>
    </div>
  );
}
