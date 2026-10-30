// Authentification admin : mot de passe (ADMIN_PASSWORD) -> cookie signé HMAC, valable 7 jours.
import crypto from 'node:crypto';

const COOKIE = 'mq_admin';
const TTL_MS = 7 * 24 * 3600e3;

export const adminConfigured = () => Boolean(process.env.ADMIN_PASSWORD);
const secret = () => process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD || '';
const hmac = (s) => crypto.createHmac('sha256', secret()).update(s).digest('base64url');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

export const checkPassword = (input) =>
  adminConfigured() && crypto.timingSafeEqual(sha(input), sha(process.env.ADMIN_PASSWORD));

export function sessionCookie() {
  const exp = Date.now() + TTL_MS;
  const secure = process.env.VERCEL ? '; Secure' : '';
  return `${COOKIE}=${exp}.${hmac(`adm.${exp}`)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL_MS / 1000}${secure}`;
}
export const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

export function isAdmin(req) {
  if (!adminConfigured()) return false;
  const raw = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return false;
  const [exp, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = hmac(`adm.${exp}`);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
