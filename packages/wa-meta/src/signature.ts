import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Validação do X-Hub-Signature-256 (HMAC-SHA256 do corpo BRUTO com o app secret).
 * Comparação em tempo constante; qualquer formato inesperado ⇒ inválida.
 */
export function verifySignature(
  rawBody: string | Buffer,
  appSecret: string,
  header: string | undefined,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const esperado = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const recebido = header.slice('sha256='.length);
  if (recebido.length !== esperado.length) return false;
  return timingSafeEqual(Buffer.from(recebido, 'utf-8'), Buffer.from(esperado, 'utf-8'));
}

/** Assina um corpo como a Meta faria (útil para testes e simulador). */
export function signBody(rawBody: string | Buffer, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}
