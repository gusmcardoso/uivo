import { mkdirSync } from 'node:fs';
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
CREATE TABLE IF NOT EXISTS notices (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, kind, threshold)
);
`;

export function openDb(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

export function getSite(db: DatabaseSync, id: number): Site | undefined {
  return db.prepare('SELECT * FROM sites WHERE id = ?').get(id) as unknown as Site | undefined;
}
