import { getDb, K } from '../lib/db.js';
import { json, handle, RID_RE } from '../lib/http.js';

export default handle(async (req, res) => {
  const rid = String(req.query?.rid || '');
  if (!RID_RE.test(rid)) return json(res, 400, { error: 'Identifiant invalide.' });
  const s = await getDb().get(K.pair(rid));
  if (!s) return json(res, 404, { state: 'unknown' });
  json(res, 200, {
    state: s.state, code: s.code, codeAt: s.codeAt, error: s.error,
    sessionId: s.state === 'done' ? s.sessionId : undefined, sent: s.sent,
  });
});
