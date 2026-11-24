import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

// Pasta temporária com o deploy-entry.sh real e um update.sh falso que só registra o que recebeu
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'uivo-deploy-'));
  copyFileSync('scripts/deploy-entry.sh', path.join(dir, 'deploy-entry.sh'));
  writeFileSync(path.join(dir, 'update.sh'), `#!/usr/bin/env bash\necho "$@" > "${dir}/chamado"\n`, {
    mode: 0o755,
  });
  return dir;
}

function run(dir: string, command: string | undefined) {
  const env = { ...process.env, SSH_ORIGINAL_COMMAND: command };
  if (command === undefined) delete env.SSH_ORIGINAL_COMMAND;
  const r = spawnSync('bash', [path.join(dir, 'deploy-entry.sh')], { env, encoding: 'utf8' });
  const called = path.join(dir, 'chamado');
  return {
    code: r.status,
    err: r.stderr,
    called: existsSync(called) ? readFileSync(called, 'utf8').trim() : null,
  };
}

describe('scripts/deploy-entry.sh (comando forçado da chave de deploy)', () => {
  it('aceita uma versão e repassa só ela ao update.sh', () => {
    const r = run(setup(), '0.1.7');
    assert.equal(r.code, 0);
    assert.equal(r.called, '0.1.7');
  });

  it('recusa sem comando (tentativa de abrir terminal)', () => {
    const r = run(setup(), undefined);
    assert.notEqual(r.code, 0);
    assert.equal(r.called, null);
    assert.match(r.err, /deploy recusado/);
  });

  for (const attack of [
    'bash',
    'cat /opt/uivo/.env',
    '0.1.7; rm -rf /',
    '0.1.7 && id',
    '$(id)',
    '`id`',
    '0.1.7\nid',
    '../../etc/passwd',
    'v0.1.7',
    '0.1',
    '',
  ]) {
    it(`recusa ${JSON.stringify(attack)}`, () => {
      const r = run(setup(), attack);
      assert.notEqual(r.code, 0);
      assert.equal(r.called, null, 'update.sh não pode ser chamado');
    });
  }
});
