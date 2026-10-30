import { getDb, K, ONLINE_WINDOW_MS } from '../lib/db.js';
import { json, handle } from '../lib/http.js';

export default handle(async (req, res) => {
  const db = getDb();
  const [total, online] = await Promise.all([
    db.zcard(K.all),
    db.zcount(K.seen, Date.now() - ONLINE_WINDOW_MS, '+inf'),
  ]);
  json(res, 200, { total, online }, { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' });
});
