// Signal de vie envoyé par chaque bot : alimente le compteur « en ligne ».
import { getDb, K, rateLimit } from '../lib/db.js';
import { json, handle, SESSION_RE } from '../lib/http.js';

export default handle(async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Méthode non autorisée.' });
  const sid = String(req.body?.sid || '');
  if (!SESSION_RE.test(sid)) return json(res, 400, { error: 'Session ID invalide.' });
  const db = getDb();
  if (!(await rateLimit(db, K.rl('hb', sid), 12, 600))) return json(res, 429, { error: 'Trop de requêtes.' });

  const rec = await db.get(K.sid(sid));
  if (!rec) return json(res, 404, { error: 'Session inconnue.' });

  if (req.body?.event === 'logout') await db.zrem(K.seen, rec.n);
  else await db.zadd(K.seen, { score: Date.now(), member: rec.n });
  json(res, 200, { ok: true });
});
