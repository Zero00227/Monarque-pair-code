// C艙ur du pairing : ouvre un socket Baileys temporaire, demande le code, attend la saisie
// dans WhatsApp, g猫re le red茅marrage (515) impos茅 par WhatsApp, puis fabrique le Session ID.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, DisconnectReason, jidNormalizedUser,
} from '@whiskeysockets/baileys';
import { getDb, K, dayKey } from './db.js';
import { hostedMode, encryptCreds } from './host.js';

export const LINK_WINDOW_MS = 120_000;          // dur茅e pendant laquelle le code reste utilisable
const SESSION_CLAIM_TTL = 24 * 3600;            // un Session ID non r茅cup茅r茅 par un bot expire apr猫s 24 h
const logger = pino({ level: 'silent' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, fallback) => Promise.race([p, sleep(ms).then(() => fallback)]);

let cachedVersion;
async function waVersion() {
  if (cachedVersion) return cachedVersion;
  const r = await withTimeout(fetchLatestBaileysVersion().catch(() => null), 4000, null);
  if (r?.version) cachedVersion = r.version;
  return cachedVersion; // undefined -> version par d茅faut de Baileys
}

export async function patchState(rid, data) {
  const db = getDb();
  const cur = (await db.get(K.pair(rid))) || {};
  await db.set(K.pair(rid), { ...cur, ...data, updatedAt: Date.now() }, { ex: 900 });
}

const digitsOf = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');

async function recordDevice(number, now) {
  const db = getDb();
  const prev = (await db.get(K.dev(number))) || {};
  const first = prev.firstPaired || now;
  await db.set(K.dev(number), { number, firstPaired: first, lastPaired: now, pairCount: (prev.pairCount || 0) + 1 });
  await db.zadd(K.all, { score: first, member: number });
  const dk = K.ok(dayKey(now));
  if ((await db.incr(dk)) === 1) await db.expire(dk, 60 * 24 * 3600);
}

async function storeSession({ sessionId, number, credsText }) {
  const db = getDb();
  const now = Date.now();
  await db.set(K.sess(sessionId), { creds: credsText, number, at: now }, { ex: SESSION_CLAIM_TTL });
  await db.set(K.sid(sessionId), { n: number }, { ex: 400 * 24 * 3600 });
  await recordDevice(number, now);
}

/** Mode h茅berg茅 : credentials chiffr茅s, sans expiration. Une nouvelle liaison du m锚me num茅ro remplace l'ancienne (le bot red茅marre le compte). */
async function storeHosted({ number, credsText }) {
  const db = getDb();
  const now = Date.now();
  await db.set(K.host(number), { creds: encryptCreds(credsText), at: now });
  await db.zadd(K.hosted, { score: now, member: number });
  await recordDevice(number, now);
}

const HOSTED_TEXT =
  `馃憫 *饾憖猸曫潙侌潗答潙咅潗娥潗� 饾憖饾惙 : CONNECT脡*\n\n` +
  `鉁� Votre compte est li茅. Le bot d茅marre sur votre WhatsApp dans moins d'une minute.\n\n` +
  `鈻� Envoyez *.menu* (ici ou dans n'importe quelle discussion) pour voir les commandes.\n` +
  `鈻� Par d茅faut, vous seul pouvez utiliser les commandes. Tapez *.public on* pour les ouvrir aux autres.\n` +
  `鈻� Pour arr锚ter le bot : WhatsApp > Appareils connect茅s > 芦 Chrome (Ubuntu) 禄 > D茅connecter.`;

async function sendText(sock, jid, text) {
  for (let i = 0; i < 3; i++) {
    try {
      await Promise.race([sock.sendMessage(jid, { text }), sleep(15000).then(() => { throw new Error('timeout'); })]);
      return true;
    }
    catch { await sleep(2500); }
  }
  return false;
}

async function sendSessionMessage(sock, jid, sessionId) {
  const text =
    `馃憫 *饾憖猸曫潙侌潗答潙咅潗娥潗� 饾憖饾惙 : SESSION ID*\n\n\`${sessionId}\`\n\n` +
    `1锔忊儯 Copiez l'ID ci-dessus\n` +
    `2锔忊儯 Collez-le dans la variable *SESSION_ID* de votre h茅bergeur (ou dans database/config.json)\n` +
    `3锔忊儯 D茅marrez le bot\n\n` +
    `鈿狅笍 Ne partagez cet ID avec personne : il donne acc猫s 脿 votre WhatsApp. ` +
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
 * R茅sout quand tout est termin茅 (succ猫s, 茅chec ou expiration). 脌 passer 脿 waitUntil().
 */
export async function runPairing({ rid, number, onCode }) {
  const db = getDb();
  const dir = path.join(os.tmpdir(), `mq-pair-${rid}`);
  let sock = null, codeIssued = false, closing = false, markedLinking = false;
  let settle;
  const linked = new Promise((r) => (settle = r));

  const cleanup = async () => {
    closing = true;
    try { sock?.end(undefined); } catch { /* d茅j脿 ferm茅 */ }   // end() et non logout() : l'appareil reste li茅
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

        // L'茅v茅nement `qr` signifie que WhatsApp est pr锚t : c'est le bon moment pour demander le code.
        if (qr && !codeIssued && !state.creds.registered) {
          codeIssued = true;
          try {
            const raw = await sock.requestPairingCode(number);
            const code = raw.match(/.{1,4}/g).join('-');
            await patchState(rid, { state: 'code', code, codeAt: Date.now() });
            onCode({ code });
          } catch (e) {
            console.error('[PAIR] requestPairingCode', e?.message);
            const error = 'Impossible de g茅n茅rer le code. V茅rifiez le num茅ro puis r茅essayez.';
            onCode({ error });
            settle({ ok: false, error });
          }
        }

        if (connection === 'open') settle({ ok: true });

        if (connection === 'close') {
          const status = lastDisconnect?.error?.output?.statusCode;
          if (status === DisconnectReason.restartRequired) {
            // Normal : WhatsApp impose un red茅marrage juste apr猫s la saisie du code.
            setTimeout(() => { if (!closing) connect(); }, 500);
          } else {
            settle({ ok: false, error: 'La connexion avec WhatsApp a 茅t茅 interrompue. R茅essayez.' });
          }
        }
      });
    };

    connect();

    const noCode = setTimeout(() => {
      if (!codeIssued) settle({ ok: false, error: 'WhatsApp ne r茅pond pas pour le moment. R茅essayez dans un instant.' });
    }, 20_000);

    const result = await withTimeout(linked, LINK_WINDOW_MS, {
      ok: false, expired: true, error: 'Le code a expir茅. G茅n茅rez-en un nouveau.',
    });
    clearTimeout(noCode);

    if (!result.ok) {
      onCode({ error: result.error });
      await patchState(rid, { state: result.expired ? 'expired' : 'failed', error: result.error });
      return;
    }

    // ---- Appareil li茅 : on finalise ----
    await patchState(rid, { state: 'linked' });
    await sleep(5000); // laisse WhatsApp terminer l'茅change de cl茅s avant de figer les credentials
    await saveCreds();
    const credsText = await fs.readFile(path.join(dir, 'creds.json'), 'utf8');
    const creds = JSON.parse(credsText);
    if (!creds?.me?.id || !creds.registered) throw new Error('credentials incomplets');

    const realNumber = digitsOf(creds.me.id) || number;

    if (hostedMode()) {
      // Le message part d'abord, puis le socket de ce serveur se ferme AVANT de publier la session :
      // le bot h茅berg茅 ne risque jamais de se connecter en m锚me temps que lui avec les m锚mes cl茅s.
      const sent = await sendText(sock, jidNormalizedUser(creds.me.id), HOSTED_TEXT);
      await sleep(2500);
      closing = true;
      try { sock.end(undefined); } catch { /* d茅j脿 ferm茅 */ }
      await storeHosted({ number: realNumber, credsText });
      await patchState(rid, { state: 'done', hosted: true, sent });
      return;
    }

    const sessionId = 'MONARQUE~' + crypto.randomBytes(18).toString('base64url');
    await storeSession({ sessionId, number: realNumber, credsText });
    const sent = await sendSessionMessage(sock, jidNormalizedUser(creds.me.id), sessionId);
    await patchState(rid, { state: 'done', sessionId, sent });
    await sleep(2500); // laisse partir le message avant de fermer
  } catch (e) {
    console.error('[PAIR ERROR]', e);
    const error = 'Une erreur est survenue pendant la liaison. R茅essayez.';
    onCode({ error });
    await patchState(rid, { state: 'failed', error }).catch(() => {});
  } finally {
    await cleanup();
  }
}
