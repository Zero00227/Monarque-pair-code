// API réservée à VOTRE bot (jeton HOST_TOKEN). Le bot hébergé :
//   GET  /api/host                -> liste des comptes à faire tourner [{ n: numéro, at: date de liaison }]
//   GET  /api/host?number=XXXX    -> credentials chiffrés de ce compte
//   POST /api/host {action:'ping', numbers:[...]}   -> signal de vie (compteur « en ligne »)
//   POST /api/host {action:'remove', number}        -> compte déconnecté depuis WhatsApp : suppression
import { getDb, K, rateLimit } from '../lib/db.js';
import { json, handle, clientIp, normalizeNumber } from '../lib/http.js';
import { hostAuthOk } from '../lib/host.js';

export default handle(async (req, res) => {
  const db = getDb();

  if (!hostAuthOk(req)) {
    // Freine les essais de jeton
    if (!(await rateLimit(db, K.rl('host-bad', clientIp(req)), 20, 600))) return json(res, 429, { error: 'Trop de tentatives.' });
    return json(res, 401, { error: 'Non autorisé.' });
  }

  if (req.method === 'GET') {
    const number = req.query?.number ? normalizeNumber(req.query.number) : null;
    if (req.query?.number) {
      if (!number) return json(res, 400, { error: 'Numéro invalide.' });
      const rec = await db.get(K.host(number));
      if (!rec) return json(res, 404, { error: 'Compte inconnu.' });
      return json(res, 200, { number, at: rec.at, creds: rec.creds });
    }
    const flat = await db.zrange(K.hosted, 0, -1, { withScores: true });   // [membre, score, membre, score, ...]
    const sessions = [];
    for (let i = 0; i + 1 < flat.length; i += 2) sessions.push({ n: String(flat[i]), at: Number(flat[i + 1]) });
    return json(res, 200, { sessions });
  }

  if (req.method === 'POST') {
    const action = req.body?.action;
    if (action === 'ping') {
      const nums = (Array.isArray(req.body?.numbers) ? req.body.numbers : []).slice(0, 500).map(normalizeNumber).filter(Boolean);
      const now = Date.now();
      await Promise.all(nums.map((n) => db.zadd(K.seen, { score: now, member: n })));
      return json(res, 200, { ok: true, count: nums.length });
    }
    if (action === 'remove') {
      const n = normalizeNumber(req.body?.number);
      if (!n) return json(res, 400, { error: 'Numéro invalide.' });
      await db.del(K.host(n));
      await db.zrem(K.hosted, n);
      await db.zrem(K.seen, n);
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { error: 'Action inconnue.' });
  }

  json(res, 405, { error: 'Méthode non autorisée.' });
});
