import type { DatabaseSync } from 'node:sqlite';
import { DAY } from './util.ts';

/*
 * Avisos do próprio painel: queda, volta, instabilidade, firewall e vencimentos. Ficam no banco
 * (o painel mostra em popup e na central do sino) e são apagados depois de 90 dias.
 */

export type NotificationKind = 'down' | 'up' | 'unstable' | 'challenge' | 'expiry';
export type NotificationLevel = 'bad' | 'warn' | 'good' | 'info';

export interface Notification {
  id: number;
  site_id: number | null;
  site_name: string | null;
  at: number;
  kind: NotificationKind;
  level: NotificationLevel;
  title: string;
  detail: string | null;
}

const KEEP = 90 * DAY;

export function addNotification(
  db: DatabaseSync,
  n: {
    siteId: number;
    kind: NotificationKind;
    level: NotificationLevel;
    title: string;
    detail?: string | null;
    at: number;
  },
): void {
  db.prepare(
    'INSERT INTO notifications (site_id, at, kind, level, title, detail) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(n.siteId, n.at, n.kind, n.level, n.title.slice(0, 200), n.detail?.slice(0, 500) ?? null);
  db.prepare('DELETE FROM notifications WHERE at < ?').run(n.at - KEEP);
}

const SELECT = `SELECT n.id, n.site_id, s.name AS site_name, n.at, n.kind, n.level, n.title, n.detail
  FROM notifications n LEFT JOIN sites s ON s.id = n.site_id`;

/** Mais recentes primeiro; com `after`, só as posteriores a esse id (em ordem de chegada). */
export function listNotifications(
  db: DatabaseSync,
  options: { after?: number; limit?: number },
): Notification[] {
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  if (options.after !== undefined)
    return db
      .prepare(`${SELECT} WHERE n.id > ? ORDER BY n.id ASC LIMIT ?`)
      .all(options.after, limit) as unknown as Notification[];
  return db.prepare(`${SELECT} ORDER BY n.id DESC LIMIT ?`).all(limit) as unknown as Notification[];
}

export function unreadCount(db: DatabaseSync, userId: number): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM notifications WHERE id > (SELECT notifications_read_id FROM users WHERE id = ?)',
    )
    .get(userId) as { n: number };
  return row.n;
}

/** Marca como lidas até `upTo` (ou todas). Nunca volta para trás nem passa do último aviso. */
export function markRead(db: DatabaseSync, userId: number, upTo?: number): void {
  const last = (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM notifications').get() as { id: number })
    .id;
  const target = Math.min(upTo ?? last, last);
  db.prepare('UPDATE users SET notifications_read_id = MAX(notifications_read_id, ?) WHERE id = ?').run(
    target,
    userId,
  );
}
