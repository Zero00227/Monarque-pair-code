// Appelé par le bot au démarrage : récupère les credentials (usage unique) à partir du Session ID.
import { getDb, K, rateLimit } from '../lib/db.js';
import { json, handle, clientIp, SESSION_RE } from '../lib/http.js';

export default handle(async (req, res) => {
  const id = String(req.query?.id || '');
  if (!SESSION_RE.test(id)) return json(res, 400, { error: 'Session ID invalide.' });
  const db = getDb();
  if (!(await rateLimit(db, K.rl('sess', clientIp(req)), 30, 600)))
    return json(res, 429, { error: 'Trop de requêtes.' });

  const keep = process.env.KEEP_SESSIONS === '1';
  const rec = keep ? await db.get(K.sess(id)) : await db.getdel(K.sess(id));
  if (!rec) return json(res, 404, { error: 'Session introuvable, expirée ou déjà utilisée. Refaites un pairing sur le site.' });
  json(res, 200, { creds: rec.creds, number: rec.number });
});
