import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const SCRIPT = path.resolve('scripts/observability.sh');

function run(cmd: string, envFile: string) {
  const r = spawnSync('bash', [SCRIPT, cmd], {
    env: { ...process.env, ENV_FILE: envFile },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

function tempEnv(content: string): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'uivo-obs-')), '.env');
  writeFileSync(file, content);
  return file;
}

const value = (file: string, name: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${name}=`))
    ?.slice(name.length + 1);

describe('scripts/observability.sh', () => {
  it('check aponta, em português, exatamente o que falta', () => {
    const file = tempEnv('AUTH_SECRET=segredo-com-tamanho-suficiente\nMETRICS_TOKEN=curto\n');
    const r = run('check', file);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /AUTH_SECRET definido/);
    assert.match(r.out, /METRICS_TOKEN curto demais/);
    assert.match(r.out, /GRAFANA_ADMIN_PASSWORD não definido/);
    assert.match(r.out, /scripts\/observability\.sh init/);
  });

  it('init gera só o que falta, sem tocar no que já existe', () => {
    const original = 'segredo-que-ja-existia-0123456789';
    const file = tempEnv(`AUTH_SECRET=${original}\nTELEGRAM_CHAT_ID=123\nMETRICS_TOKEN=\n`);
    const r = run('init', file);
    assert.equal(r.code, 0);
    assert.equal(value(file, 'AUTH_SECRET'), original);
    assert.equal(value(file, 'TELEGRAM_CHAT_ID'), '123');
    assert.match(value(file, 'METRICS_TOKEN') ?? '', /^[0-9a-f]{64}$/);
    assert.ok((value(file, 'GRAFANA_ADMIN_PASSWORD') ?? '').length >= 16);
    // a linha vazia foi preenchida, não duplicada
    assert.equal(readFileSync(file, 'utf8').match(/^METRICS_TOKEN=/gm)?.length, 1);
  });

  it('init é idempotente: rodar de novo não muda nenhum valor', () => {
    const file = tempEnv('');
    run('init', file);
    const before = readFileSync(file, 'utf8');
    run('init', file);
    assert.equal(readFileSync(file, 'utf8'), before);
  });

  it('init deixa o .env legível só pelo dono (600)', () => {
    const file = tempEnv('');
    run('init', file);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it('depois do init, as variáveis passam no check', () => {
    const file = tempEnv('');
    run('init', file);
    const r = run('check', file);
    for (const v of ['AUTH_SECRET', 'METRICS_TOKEN', 'GRAFANA_ADMIN_PASSWORD'])
      assert.match(r.out, new RegExp(`${v} definido`));
  });

  it('não executa o conteúdo do .env (lê como texto)', () => {
    const marker = path.join(tmpdir(), `uivo-nao-executar-${Date.now()}`);
    const file = tempEnv(`AUTH_SECRET=$(touch ${marker})-0123456789abcdef\n`);
    run('check', file);
    assert.throws(() => statSync(marker));
  });

  it('sem comando, mostra a ajuda', () => {
    const r = run('', tempEnv(''));
    assert.equal(r.code, 2);
    assert.match(r.out, /scripts\/observability\.sh up/);
  });
});
