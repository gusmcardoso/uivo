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
          <span className="text-zinc-300">Nome</span>
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
          <span className="text-zinc-300">Endereço</span>
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
            <span className="text-zinc-300">Verificar a cada</span>
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
            <span className="text-zinc-300">Palavra-chave</span>
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
            className="accent-emerald-500"
            checked={form.check_domain}
            onChange={(e) => set('check_domain', e.target.checked)}
          />
          Avisar vencimento do domínio
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            className="accent-emerald-500"
            checked={form.public}
            onChange={(e) => set('public', e.target.checked)}
          />
          Mostrar na página de status pública
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            className="accent-emerald-500"
            checked={form.enabled}
            onChange={(e) => set('enabled', e.target.checked)}
          />
          Monitoramento ativo
        </label>
        {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
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
