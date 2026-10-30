// Accès base de données : Upstash Redis (Vercel Marketplace) en production,
// mémoire locale en développement (vercel dev / node) si aucune base n'est configurée.
import { Redis } from '@upstash/redis';

export class DbMissingError extends Error {
  constructor() {
    super('Base de données non configurée (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).');
    this.code = 'DB_MISSING';
  }
}

const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

// ---------- Mémoire locale (dev uniquement) ----------
function memoryDb() {
  const kv = new Map();   // clé -> { v, exp }
  const zs = new Map();   // clé -> Map(member -> score)
  const live = (k) => {
    const e = kv.get(k);
    if (!e) return null;
    if (e.exp && e.exp < Date.now()) { kv.delete(k); return null; }
    return e;
  };
  const zset = (k) => { if (!zs.has(k)) zs.set(k, new Map()); return zs.get(k); };
  const bound = (b, d) => (b === '-inf' ? -Infinity : b === '+inf' ? Infinity : Number(b ?? d));
  return {
    async get(k) { const e = live(k); return e ? structuredClone(e.v) : null; },
    async mget(...ks) { return Promise.all(ks.map((k) => this.get(k))); },
    async set(k, v, o = {}) {
      if (o.nx && live(k)) return null;
      kv.set(k, { v: structuredClone(v), exp: o.ex ? Date.now() + o.ex * 1000 : 0 });
      return 'OK';
    },
    async getdel(k) { const v = await this.get(k); kv.delete(k); return v; },
    async del(k) { return kv.delete(k) ? 1 : 0; },
    async incr(k) { const e = live(k); const n = (e?.v || 0) + 1; kv.set(k, { v: n, exp: e?.exp || 0 }); return n; },
    async expire(k, s) { const e = live(k); if (e) e.exp = Date.now() + s * 1000; return e ? 1 : 0; },
    async zadd(k, { score, member }) { zset(k).set(String(member), score); return 1; },
    async zrem(k, member) { return zset(k).delete(String(member)) ? 1 : 0; },
    async zscore(k, member) { const s = zset(k).get(String(member)); return s === undefined ? null : s; },
    async zcard(k) { return zset(k).size; },
    async zcount(k, min, max) {
      const lo = bound(min, -Infinity), hi = bound(max, Infinity);
      return [...zset(k).values()].filter((s) => s >= lo && s <= hi).length;
    },
    async zrange(k, start, stop, o = {}) {
      const arr = [...zset(k).entries()].sort((a, b) => (o.rev ? b[1] - a[1] : a[1] - b[1]));
      return arr.slice(start, stop < 0 ? undefined : stop + 1).map(([m]) => m);
    },
  };
}

let instance = null;
export function getDb() {
  if (instance) return instance;
  if (url && token) instance = new Redis({ url, token });
  else if (!process.env.VERCEL) instance = memoryDb();
  else throw new DbMissingError();
  return instance;
}

// ---------- Clés ----------
export const K = {
  pair: (rid) => `mq:pair:${rid}`,
  lock: (n) => `mq:lock:${n}`,
  sess: (sid) => `mq:sess:${sid}`,     // credentials en attente de récupération (usage unique)
  sid: (sid) => `mq:sid:${sid}`,       // Session ID -> numéro (sert à authentifier les heartbeats)
  dev: (n) => `mq:dev:${n}`,           // fiche appareil
  all: 'mq:devices:all',               // zset : numéro -> date du premier pairing
  seen: 'mq:devices:seen',             // zset : numéro -> dernier heartbeat
  ok: (d) => `mq:ok:${d}`,             // pairings réussis du jour
  att: (d) => `mq:att:${d}`,           // tentatives du jour
  rl: (name, id) => `mq:rl:${name}:${id}`,
};

// ---------- Utilitaires ----------
const OFFSET_H = Number(process.env.STATS_UTC_OFFSET ?? 1); // Niamey / Cotonou / Lagos = UTC+1
export const dayKey = (ts = Date.now()) => new Date(ts + OFFSET_H * 3600e3).toISOString().slice(0, 10);
export const ONLINE_WINDOW_MS = Number(process.env.ONLINE_WINDOW_MIN || 25) * 60e3;

/** Limiteur simple : true si la demande est autorisée. */
export async function rateLimit(db, key, limit, windowSec) {
  const n = await db.incr(key);
  if (n === 1) await db.expire(key, windowSec);
  return n <= limit;
    }
    
