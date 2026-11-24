import { type FormEvent, useState } from 'react';
import { api } from '../api.ts';
import { Logo } from './Logo.tsx';

export function Login({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await (setup ? api.setup(email, password) : api.login(email, password));
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden px-4">
      <div
        className="pointer-events-none absolute top-1/3 left-1/2 size-[36rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky-400/[0.06] blur-3xl"
        aria-hidden="true"
      />
      <form
        onSubmit={submit}
        className="card relative w-full max-w-sm space-y-5 bg-zinc-900/70 p-7 backdrop-blur"
      >
        <Logo className="h-10" />
        <div>
          <h1 className="text-lg font-semibold">{setup ? 'Crie a conta de administrador' : 'Entrar'}</h1>
          <p className="mt-1 text-sm text-zinc-400">
            {setup
              ? 'Primeiro acesso: essa conta gerencia os sites monitorados.'
              : 'Acesse o painel de monitoramento.'}
          </p>
        </div>
        <label className="block space-y-1.5 text-sm">
          <span className="text-zinc-300">E-mail</span>
          <input
            className="input"
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="text-zinc-300">Senha</span>
          <input
            className="input"
            type="password"
            required
            minLength={8}
            autoComplete={setup ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? 'Aguarde…' : setup ? 'Criar conta' : 'Entrar'}
        </button>
      </form>
    </main>
  );
}
