import tls from 'node:tls';

export interface SslResult {
  expiresAt: number | null;
  issuer: string | null;
  valid: boolean;
  error: string | null;
}

/** Lê o certificado do servidor (sem rejeitar inválidos, para conseguir reportá-los). */
export function checkSsl(url: string, timeoutMs = 10_000): Promise<SslResult> {
  const u = new URL(url);
  if (u.protocol !== 'https:') {
    return Promise.resolve({ expiresAt: null, issuer: null, valid: false, error: 'Site sem HTTPS' });
  }
  return new Promise((resolve) => {
    const fail = (error: string) => resolve({ expiresAt: null, issuer: null, valid: false, error });
    const socket = tls.connect(
      {
        host: u.hostname,
        port: Number(u.port) || 443,
        servername: u.hostname,
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      () => {
        const cert = socket.getPeerCertificate();
        const valid = socket.authorized;
        const reason = socket.authorizationError ? String(socket.authorizationError) : 'Certificado inválido';
        socket.end();
        const issuer = cert?.issuer?.O ?? cert?.issuer?.CN;
        resolve({
          expiresAt: cert?.valid_to ? Date.parse(cert.valid_to) || null : null,
          issuer: issuer ? String(issuer) : null,
          valid,
          error: valid ? null : reason,
        });
      },
    );
    socket.on('timeout', () => {
      socket.destroy();
      fail('Tempo esgotado ao ler o certificado');
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      const known: Record<string, string> = {
        ENOTFOUND: 'Domínio não encontrado (DNS)',
        EAI_AGAIN: 'Falha temporária de DNS',
        ECONNREFUSED: 'Conexão recusada na porta 443',
      };
      fail((err.code && known[err.code]) ?? err.message);
    });
  });
}
