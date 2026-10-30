import { getDb, K, dayKey, rateLimit, ONLINE_WINDOW_MS } from '../lib/db.js';
import { json, handle, clientIp, maskNumber } from '../lib/http.js';
import { adminConfigured, checkPassword, sessionCookie, clearCookie, isAdmin } from '../lib/auth.js';

export default handle(async (req, res) => {
  if (!adminConfigured()) return json(res, 503, { error: 'ADMIN_PASSWORD n\'est pas défini dans les variables d\'environnement Vercel.' });
  const db = getDb();

  if (req.method === 'POST') {
    const action = req.body?.action;
    if (action === 'logout') return json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
    if (action !== 'login') return json(res, 400, { error: 'Action inconnue.' });
    if (!(await rateLimit(db, K.rl('admin', clientIp(req)), 8, 900)))
      return json(res, 429, { error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
    if (!checkPassword(req.body?.password ?? '')) return json(res, 401, { error: 'Mot de passe incorrect.' });
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie() });
  }

  if (req.method !== 'GET') return json(res, 405, { error: 'Méthode non autorisée.' });
  if (!isAdmin(req)) return json(res, 401, { error: 'Non connecté.' });

  const now = Date.now();
  const dates = Array.from({ length: 14 }, (_, i) => dayKey(now - (13 - i) * 86400e3));
  const [total, online, okRaw, attRaw, numbers] = await Promise.all([
    db.zcard(K.all),
    db.zcount(K.seen, now - ONLINE_WINDOW_MS, '+inf'),
    db.mget(...dates.map(K.ok)),
    db.mget(...dates.map(K.att)),
    db.zrange(K.all, 0, 49, { rev: true }),
  ]);
  const days = dates.map((date, i) => ({ date, ok: Number(okRaw[i] || 0), attempts: Number(attRaw[i] || 0) }));
  const seen = await Promise.all(numbers.map((n) => db.zscore(K.seen, n)));
  const devs = await db.mget(...numbers.map(K.dev));

  json(res, 200, {
    total, online,
    today: days[13].ok,
    week: days.slice(7).reduce((s, d) => s + d.ok, 0),
    attemptsToday: days[13].attempts,
    days,
    devices: numbers.map((n, i) => ({
      masked: maskNumber(String(n)), full: String(n),
      firstPaired: devs[i]?.firstPaired ?? null,
      lastSeen: seen[i] ? Number(seen[i]) : null,
      online: Boolean(seen[i] && now - Number(seen[i]) <= ONLINE_WINDOW_MS),
    })),
  });
});
                          
