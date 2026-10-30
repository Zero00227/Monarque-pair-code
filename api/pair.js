import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { getDb, K, dayKey, rateLimit } from '../lib/db.js';
import { json, handle, clientIp, normalizeNumber } from '../lib/http.js';
import { runPairing, patchState } from '../lib/pairing.js';

export default handle(async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Méthode non autorisée.' });
  const db = getDb();

  const number = normalizeNumber(req.body?.number);
  if (!number) return json(res, 400, { error: 'Numéro invalide. Indiquez l\'indicatif du pays, sans + ni 0 (ex : 22790123456).' });

  // Anti-abus : chaque demande déclenche une notification sur le téléphone ciblé.
  if (!(await rateLimit(db, K.rl('pair-ip', clientIp(req)), 6, 600)))
    return json(res, 429, { error: 'Trop de tentatives. Patientez quelques minutes.' });
  if (!(await rateLimit(db, K.rl('pair-num', number), 4, 3600)))
    return json(res, 429, { error: 'Trop de demandes pour ce numéro. Réessayez dans une heure.' });
  if (!(await db.set(K.lock(number), 1, { nx: true, ex: 150 })))
    return json(res, 409, { error: 'Une demande est déjà en cours pour ce numéro. Patientez 2 minutes.' });

  const dk = K.att(dayKey());
  if ((await db.incr(dk)) === 1) await db.expire(dk, 60 * 24 * 3600);

  const rid = crypto.randomBytes(16).toString('hex');
  await db.set(K.pair(rid), { state: 'starting', number, createdAt: Date.now() }, { ex: 900 });

  let resolveFirst;
  const first = new Promise((r) => (resolveFirst = r));
  // La liaison continue en arrière-plan après la réponse HTTP (Fluid Compute).
  waitUntil(runPairing({ rid, number, onCode: resolveFirst }));

  const r = await Promise.race([first, new Promise((ok) => setTimeout(() => ok({ error: 'WhatsApp met trop de temps à répondre. Réessayez.' }), 25_000))]);
  if (r.error) {
    await patchState(rid, { state: 'failed', error: r.error }).catch(() => {});
    return json(res, 502, { error: r.error });
  }
  json(res, 200, { rid, code: r.code, expiresIn: 120 });
});
