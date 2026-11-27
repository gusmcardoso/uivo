import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { telegramNotifier } from './alerts/telegram.ts';
import { buildApp } from './app.ts';
import { hashPassword } from './auth.ts';
import { config } from './config.ts';
import { adoptLegacyDb, openDb } from './db.ts';
import { startScheduler } from './monitor.ts';
import { vercelClient } from './vercel.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const adoptedLegacyDb = adoptLegacyDb(config.dataDir);
const db = openDb(path.join(config.dataDir, 'uivo.db'));

// Administrador inicial por variável de ambiente (opcional: sem ela, o painel pede o cadastro).
if (config.adminEmail && config.adminPassword) {
  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(config.adminEmail.toLowerCase());
  if (!exists) {
    db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)').run(
      config.adminEmail.toLowerCase(),
      hashPassword(config.adminPassword),
      Date.now(),
    );
  }
}

let runNow: (id: number) => Promise<void> = async () => {};
let runAudit: (id: number) => Promise<void> = async () => {};
const app = await buildApp({
  db,
  authSecret: config.authSecret,
  runNow: (id) => runNow(id),
  runAudit: (id) => runAudit(id),
  webDir: path.join(root, 'dist', 'web'),
  metricsToken: config.metricsToken,
  statusTitle: config.statusTitle,
  reportAuthor: config.reportAuthor,
  vercel: vercelClient({ token: config.vercelToken }),
  logger: true,
});

const notify = telegramNotifier(config.telegramToken, config.telegramChatId, {
  info: (msg) => app.log.info(msg),
  error: (msg) => app.log.error(msg),
});
const scheduler = startScheduler({
  db,
  notify,
  concurrency: config.concurrency,
  retentionDays: config.retentionDays,
  log: { error: (err) => app.log.error(err) },
  // Eventos em JSON no log do container: prontos para Grafana Alloy/Promtail → Loki
  event: (name, data) => app.log.info({ event: name, ...data }, name),
});
runNow = scheduler.runNow;
runAudit = scheduler.runAudit;

if (adoptedLegacyDb) app.log.info('Banco do Uptrue (uptrue.db) adotado como uivo.db: dados preservados.');
if (!config.telegramToken) app.log.warn('Telegram não configurado: alertas só aparecem no log.');

await app.listen({ port: config.port, host: config.host });

const shutdown = async (signal: string) => {
  app.log.info(`${signal} recebido, encerrando...`);
  scheduler.stop();
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
