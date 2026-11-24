import { existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type SiteStatus = 'up' | 'down' | 'unknown';

export interface Site {
  id: number;
  name: string;
  url: string;
  interval_sec: number;
  keyword: string | null;
  enabled: number;
  check_domain: number;
  public: number;
  security_score: number | null;
  security_checked_at: number | null;
  script_hosts: string | null;
  last_timing: string | null;
  last_challenge: string | null;
  custom_headers: string | null;
  security_error: string | null;
  status: SiteStatus;
  fail_streak: number;
  last_checked_at: number | null;
  last_error: string | null;
  ssl_expires_at: number | null;
  ssl_issuer: string | null;
  ssl_error: string | null;
  ssl_checked_at: number | null;
  domain_expires_at: number | null;
  domain_error: string | null;
  domain_checked_at: number | null;
  created_at: number;
  client: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  interval_sec INTEGER NOT NULL DEFAULT 60,
  keyword TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  check_domain INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unknown',
  fail_streak INTEGER NOT NULL DEFAULT 0,
  last_checked_at INTEGER,
  last_error TEXT,
  ssl_expires_at INTEGER,
  ssl_issuer TEXT,
  ssl_error TEXT,
  ssl_checked_at INTEGER,
  domain_expires_at INTEGER,
  domain_error TEXT,
  domain_checked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  status_code INTEGER,
  response_ms INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS checks_site_at ON checks (site_id, at);
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS incidents_site ON incidents (site_id, started_at);
CREATE TABLE IF NOT EXISTS audits (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  score INTEGER NOT NULL,
  findings TEXT NOT NULL,
  passed TEXT NOT NULL,
  script_hosts TEXT NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS audits_site_at ON audits (site_id, at);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  level TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS notifications_at ON notifications (at);
CREATE TABLE IF NOT EXISTS notices (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, kind, threshold)
);
`;

/**
 * Instalações de antes da troca de nome (Uptrue → Uivo) guardam o banco em uptrue.db.
 * Renomeia para uivo.db (com o WAL) na primeira subida; o arquivo principal vai por último,
 * então uma interrupção no meio é retomada na próxima subida sem perder dados.
 */
export function adoptLegacyDb(dir: string, file = 'uivo.db', legacy = 'uptrue.db'): boolean {
  const target = path.join(dir, file);
  const old = path.join(dir, legacy);
  if (existsSync(target) || !existsSync(old)) return false;
  for (const suffix of ['-wal', '-shm', '']) {
    if (existsSync(old + suffix)) renameSync(old + suffix, target + suffix);
  }
  return true;
}

export function openDb(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function getSite(db: DatabaseSync, id: number): Site | undefined {
  return db.prepare('SELECT * FROM sites WHERE id = ?').get(id) as unknown as Site | undefined;
}

/** Migrações incrementais: colunas novas em bancos de versões anteriores. */
function migrate(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(sites)').all() as { name: string }[]).map((c) => c.name),
  );
  if (!columns.has('public')) db.exec('ALTER TABLE sites ADD COLUMN public INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('security_score')) db.exec('ALTER TABLE sites ADD COLUMN security_score INTEGER');
  if (!columns.has('security_checked_at'))
    db.exec('ALTER TABLE sites ADD COLUMN security_checked_at INTEGER');
  if (!columns.has('script_hosts')) db.exec('ALTER TABLE sites ADD COLUMN script_hosts TEXT');
  if (!columns.has('last_timing')) db.exec('ALTER TABLE sites ADD COLUMN last_timing TEXT');
  // v0.1.5: desafio anti-bot da última checagem e cabeçalhos de liberação (valores nunca saem pela API)
  if (!columns.has('last_challenge')) db.exec('ALTER TABLE sites ADD COLUMN last_challenge TEXT');
  if (!columns.has('custom_headers')) db.exec('ALTER TABLE sites ADD COLUMN custom_headers TEXT');
  if (!columns.has('security_error')) db.exec('ALTER TABLE sites ADD COLUMN security_error TEXT');
  // cliente: agrupa os sites na lista (e no relatório)
  if (!columns.has('client')) db.exec('ALTER TABLE sites ADD COLUMN client TEXT');
  const userColumns = new Set(
    (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name),
  );
  if (!userColumns.has('notifications_read_id'))
    db.exec('ALTER TABLE users ADD COLUMN notifications_read_id INTEGER NOT NULL DEFAULT 0');

  // v0.4: tempo de cada etapa por checagem (nulo nas checagens antigas)
  const checkColumns = new Set(
    (db.prepare('PRAGMA table_info(checks)').all() as { name: string }[]).map((c) => c.name),
  );
  for (const col of ['redirect_ms', 'dns_ms', 'connect_ms', 'tls_ms', 'wait_ms', 'download_ms', 'bytes']) {
    if (!checkColumns.has(col)) db.exec(`ALTER TABLE checks ADD COLUMN ${col} INTEGER`);
  }
  if (!checkColumns.has('challenge')) db.exec('ALTER TABLE checks ADD COLUMN challenge TEXT');
}

/** Cabeçalhos de liberação do site (JSON guardado no banco); objeto vazio se não houver. */
export function siteHeaders(site: Pick<Site, 'custom_headers'>): Record<string, string> {
  if (!site.custom_headers) return {};
  try {
    return JSON.parse(site.custom_headers) as Record<string, string>;
  } catch {
    return {};
  }
}
