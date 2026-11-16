// Mode « bot hébergé » : les credentials des utilisateurs sont stockés (chiffrés) pour que VOTRE bot
// les démarre lui-même. Actif dès que HOST_TOKEN est défini (HOSTED_MODE=0 pour revenir au Session ID).
import crypto from 'node:crypto';

const token = () => String(process.env.HOST_TOKEN || '');
export const hostedMode = () => process.env.HOSTED_MODE !== '0' && token().length >= 16;
export const hostCapacity = () => Number(process.env.MAX_HOSTED) || 0;   // 0 = illimité côté site

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const aesKey = () => crypto.createHash('sha256').update(`mq-hosted:${token()}`).digest();

/** Authentification du bot : en-tête « Authorization: Bearer <HOST_TOKEN> ». */
export function hostAuthOk(req) {
  if (!token()) return false;
  const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
  return Boolean(m) && crypto.timingSafeEqual(sha(m[1]), sha(token()));
}

/** AES-256-GCM : un export de la base ne livre pas les sessions WhatsApp en clair. */
export function encryptCreds(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', aesKey(), iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}
