export type Notifier = (text: string) => Promise<void>;

interface Log {
  info: (msg: string) => void;
  error: (msg: string) => void;
}

/** Alertas pelo Telegram; sem token/chat configurados, apenas registra no log. */
export function telegramNotifier(token: string | undefined, chatId: string | undefined, log: Log): Notifier {
  if (!token || !chatId) {
    return async (text) => log.info(`[alerta] ${text.replace(/<[^>]+>/g, '')}`);
  }
  return async (text) => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) log.error(`Telegram respondeu ${res.status}`);
    } catch (err) {
      log.error(`Falha ao enviar alerta no Telegram: ${(err as Error).message}`);
    }
  };
}
