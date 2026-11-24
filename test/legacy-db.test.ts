import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { adoptLegacyDb, openDb } from '../src/server/db.ts';

const fresh = () => mkdtempSync(path.join(tmpdir(), 'uivo-legacy-'));

describe('banco de antes da troca de nome (uptrue.db)', () => {
  it('adota uptrue.db como uivo.db, com os dados', () => {
    const dir = fresh();
    const old = openDb(path.join(dir, 'uptrue.db'));
    old.prepare("INSERT INTO sites (name, url, created_at) VALUES ('Loja', 'https://loja.com.br', 1)").run();
    old.close();

    assert.equal(adoptLegacyDb(dir), true);
    assert.equal(existsSync(path.join(dir, 'uptrue.db')), false);
    const db = openDb(path.join(dir, 'uivo.db'));
    assert.equal((db.prepare('SELECT name FROM sites').get() as { name: string }).name, 'Loja');
    db.close();
  });

  it('leva junto o WAL (gravações ainda não consolidadas no arquivo principal)', () => {
    const dir = fresh();
    writeFileSync(path.join(dir, 'uptrue.db'), 'principal');
    writeFileSync(path.join(dir, 'uptrue.db-wal'), 'wal');
    writeFileSync(path.join(dir, 'uptrue.db-shm'), 'shm');
    adoptLegacyDb(dir);
    for (const s of ['', '-wal', '-shm']) {
      assert.equal(existsSync(path.join(dir, `uivo.db${s}`)), true, `uivo.db${s}`);
      assert.equal(existsSync(path.join(dir, `uptrue.db${s}`)), false, `uptrue.db${s}`);
    }
  });

  it('retoma uma adoção interrompida no meio (WAL já movido, principal não)', () => {
    const dir = fresh();
    writeFileSync(path.join(dir, 'uptrue.db'), 'principal');
    writeFileSync(path.join(dir, 'uivo.db-wal'), 'wal');
    assert.equal(adoptLegacyDb(dir), true);
    assert.equal(existsSync(path.join(dir, 'uivo.db')), true);
  });

  it('não mexe em nada se uivo.db já existe ou se não há banco antigo', () => {
    const dir = fresh();
    assert.equal(adoptLegacyDb(dir), false);
    writeFileSync(path.join(dir, 'uivo.db'), 'novo');
    writeFileSync(path.join(dir, 'uptrue.db'), 'antigo');
    assert.equal(adoptLegacyDb(dir), false);
    assert.equal(existsSync(path.join(dir, 'uptrue.db')), true);
  });
});
