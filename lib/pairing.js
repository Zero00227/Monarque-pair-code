// Cœur du pairing : ouvre un socket Baileys temporaire, demande le code, attend la saisie
// dans WhatsApp, gère le redémarrage (515) imposé par WhatsApp, puis fabrique le Session ID.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, DisconnectReason, jidNormalizedUser,
} from '@whiskeysockets/baileys';
import { getDb, K, dayKey } from './db.js';

export const LINK_WINDOW_MS = 120_000;          // durée pendant laquelle le code reste utilisable
const SESSION_CLAIM_TTL = 24 * 3600;            // un Session ID non récupéré par un bot expire après 24 h
const logger = pino({ level: 'silent' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, fallback) => Promise.race([p, sleep(ms).then(() => fallback)]);

let cachedVersion;
async function waVersion() {
  if (cachedVersion) return cachedVersion;
  const r = await withTimeout(fetchLatestBaileysVersion().catch(() => null), 4000, null);
  if (r?.version) cachedVersion = r.version;
  return cachedVersion; // undefined -> version par défaut de Baileys
}

export async function patchState(rid, data) {
  const db = getDb();
  const cur = (await db.get(K.pair(rid))) || {};
  await db.set(K.pair(rid), { ...cur, ...data, updatedAt: Date.now() }, { ex: 900 });
}

const digitsOf = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');

async function storeSession({ sessionId, number, credsText }) {
  const db = getDb();
  const now = Date.now();
  await db.set(K.sess(sessionId), { creds: credsText, number, at: now }, { ex: SESSION_CLAIM_TTL });
  await db.set(K.sid(sessionId), { n: number }, { ex: 400 * 24 * 3600 });
  const prev = (await db.get(K.dev(number))) || {};
  const first = prev.firstPaired || now;
  await db.set(K.dev(number), { number, firstPaired: first, lastPaired: now, pairCount: (prev.pairCount || 0) + 1 });
  await db.zadd(K.all, { score: first, member: number });
  const dk = K.ok(dayKey(now));
  if ((await db.incr(dk)) === 1) await db.expire(dk, 60 * 24 * 3600);
}

async function sendSessionMessage(sock, jid, sessionId) {
  const text =
    `👑 *MONARQUE MD : SESSION ID*\n\n\`${sessionId}\`\n\n` +
    `1️⃣ Copiez l'ID ci-dessus\n` +
    `2️⃣ Collez-le dans la variable *SESSION_ID* de votre hébergeur (ou dans database/config.json)\n` +
    `3️⃣ Démarrez le bot\n\n` +
    `⚠️ Ne partagez cet ID avec personne : il donne accès à votre WhatsApp. ` +
    `Il n'est utilisable qu'une seule fois et expire dans 24 h.`;
  for (let i = 0; i < 3; i++) {
    try {
      await Promise.race([sock.sendMessage(jid, { text }), sleep(15000).then(() => { throw new Error('timeout'); })]);
      return true;
    }
    catch { await sleep(2500); }
  }
  return false;
}

/**
 * @param {{rid:string, number:string, onCode:(r:{code?:string,error?:string})=>void}} p
 * Résout quand tout est terminé (succès, échec ou expiration). À passer à waitUntil().
 */
export async function runPairing({ rid, number, onCode }) {
  const db = getDb();
  const dir = path.join(os.tmpdir(), `mq-pair-${rid}`);
  let sock = null, codeIssued = false, closing = false, markedLinking = false;
  let settle;
  const linked = new Promise((r) => (settle = r));

  const cleanup = async () => {
    closing = true;
    try { sock?.end(undefined); } catch { /* déjà fermé */ }   // end() et non logout() : l'appareil reste lié
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await db.del(K.lock(number)).catch(() => {});
  };

  try {
    await fs.mkdir(dir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const version = await waVersion();

    const connect = () => {
      sock = makeWASocket({
        auth: state,
        ...(version ? { version } : {}),
        logger,
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
      });

      sock.ev.on('creds.update', async () => {
        await saveCreds();
        if (state.creds.registered && !markedLinking) {
          markedLinking = true;
          patchState(rid, { state: 'linking' }).catch(() => {});
        }
      });

      sock.ev.on('connection.update', async (u) => {
        if (closing) return;
        const { connection, lastDisconnect, qr } = u;

        // L'événement `qr` signifie que WhatsApp est prêt : c'est le bon moment pour demander le code.
        if (qr && !codeIssued && !state.creds.registered) {
          codeIssued = true;
          try {
            const raw = await sock.requestPairingCode(number);
            const code = raw.match(/.{1,4}/g).join('-');
            await patchState(rid, { state: 'code', code, codeAt: Date.now() });
            onCode({ code });
          } catch (e) {
            console.error('[PAIR] requestPairingCode', e?.message);
            const error = 'Impossible de générer le code. Vérifiez le numéro puis réessayez.';
            onCode({ error });
            settle({ ok: false, error });
          }
        }

        if (connection === 'open') settle({ ok: true });

        if (connection === 'close') {
          const status = lastDisconnect?.error?.output?.statusCode;
          if (status === DisconnectReason.restartRequired) {
            // Normal : WhatsApp impose un redémarrage juste après la saisie du code.
            setTimeout(() => { if (!closing) connect(); }, 500);
          } else {
            settle({ ok: false, error: 'La connexion avec WhatsApp a été interrompue. Réessayez.' });
          }
        }
      });
    };

    connect();

    const noCode = setTimeout(() => {
      if (!codeIssued) settle({ ok: false, error: 'WhatsApp ne répond pas pour le moment. Réessayez dans un instant.' });
    }, 20_000);

    const result = await withTimeout(linked, LINK_WINDOW_MS, {
      ok: false, expired: true, error: 'Le code a expiré. Générez-en un nouveau.',
    });
    clearTimeout(noCode);

    if (!result.ok) {
      onCode({ error: result.error });
      await patchState(rid, { state: result.expired ? 'expired' : 'failed', error: result.error });
      return;
    }

    // ---- Appareil lié : on finalise ----
    await patchState(rid, { state: 'linked' });
    await sleep(5000); // laisse WhatsApp terminer l'échange de clés avant de figer les credentials
    await saveCreds();
    const credsText = await fs.readFile(path.join(dir, 'creds.json'), 'utf8');
    const creds = JSON.parse(credsText);
    if (!creds?.me?.id || !creds.registered) throw new Error('credentials incomplets');

    const realNumber = digitsOf(creds.me.id) || number;
    const sessionId = 'MONARQUE~' + crypto.randomBytes(18).toString('base64url');
    await storeSession({ sessionId, number: realNumber, credsText });
    const sent = await sendSessionMessage(sock, jidNormalizedUser(creds.me.id), sessionId);
    await patchState(rid, { state: 'done', sessionId, sent });
    await sleep(2500); // laisse partir le message avant de fermer
  } catch (e) {
    console.error('[PAIR ERROR]', e);
    const error = 'Une erreur est survenue pendant la liaison. Réessayez.';
    onCode({ error });
    await patchState(rid, { state: 'failed', error }).catch(() => {});
  } finally {
    await cleanup();
  }
    }
            
