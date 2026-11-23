import path from 'node:path';

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const production = process.env.NODE_ENV === 'production';
const authSecret = process.env.AUTH_SECRET ?? (production ? '' : 'dev-secret-only-for-local-use');
if (authSecret.length < 16) {
  throw new Error('AUTH_SECRET é obrigatório e precisa ter ao menos 16 caracteres.');
}

export const config = {
  production,
  port: num(process.env.PORT, 3000),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR ?? 'data'),
  authSecret,
  adminEmail: process.env.ADMIN_EMAIL,
  adminPassword: process.env.ADMIN_PASSWORD,
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  retentionDays: num(process.env.RETENTION_DAYS, 90),
  concurrency: num(process.env.CHECK_CONCURRENCY, 10),
};

export type Config = typeof config;
