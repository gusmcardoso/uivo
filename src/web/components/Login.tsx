import { type FormEvent, useState } from 'react';
import { api } from '../api.ts';
import { Footer } from './Footer.tsx';
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
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-zinc-800/80 bg-zinc-950/60 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl justify-center px-4 py-3.5">
          <Logo className="h-9" />
        </div>
      </header>
      <main className="grid flex-1 place-items-center px-4 py-10">
        <form onSubmit={submit} className="card w-full max-w-sm space-y-5 p-7">
          <div>
            <p className="font-mono text-xs text-zinc-500">
              <span className="text-brand">$</span> uivo {setup ? 'init' : 'login'}
              <span className="cursor-blink">_</span>
            </p>
            <h1 className="mt-2 text-lg font-semibold text-zinc-100">
              {setup ? 'Crie a conta de administrador' : 'Entrar no painel'}
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              {setup
                ? 'Primeiro acesso: essa conta gerencia os sites monitorados.'
                : 'Seus sites, vigiados de perto.'}
            </p>
          </div>
          <label className="block space-y-1.5">
            <span className="label-xs">e-mail</span>
            <input
              className="input"
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="label-xs">senha</span>
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
          {error && (
            <p className="rounded-sm border border-red-500/30 bg-red-500/10 px-3 py-2 font-mono text-xs text-red-300">
              {error}
            </p>
          )}
          <button type="submit" className="btn-primary w-full py-2" disabled={busy}>
            {busy ? 'aguarde…' : setup ? 'criar conta' : 'entrar'}
          </button>
        </form>
      </main>
      <Footer className="px-4 py-5" />
    </div>
  );
}
