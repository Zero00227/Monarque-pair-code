import { DbMissingError } from './db.js';

export function json(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export const clientIp = (req) =>
  String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim();

/** Numéro international : 8 à 15 chiffres, sans 0 initial. */
export function normalizeNumber(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length >= 8 && d.length <= 15 && d[0] !== '0' ? d : null;
}

export const maskNumber = (n) =>
  n.length <= 7 ? n : `${n.slice(0, 3)}${'•'.repeat(n.length - 7)}${n.slice(-4)}`;

export const SESSION_RE = /^MONARQUE~[A-Za-z0-9_-]{24}$/;
export const RID_RE = /^[a-f0-9]{32}$/;

/** Enveloppe d'API : erreurs propres, jamais de stack trace côté client. */
export const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof DbMissingError) return json(res, 503, { error: e.message });
    console.error('[API ERROR]', req.url, e);
    if (!res.headersSent) json(res, 500, { error: 'Erreur interne du serveur.' });
  }
};
