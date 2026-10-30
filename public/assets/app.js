const $ = (id) => document.getElementById(id);
const views = ['form', 'code', 'done', 'fail'];
const show = (v) => views.forEach((n) => ($('v-' + n).hidden = n !== v));
const WINDOW = 120; // secondes de validité affichées
let rid = sessionStorage.getItem('mq_rid');
let poll = null, tick = null, codeAt = 0, currentCode = '';

async function api(path, opts) {
  const r = await fetch(path, opts);
  let data = {}; try { data = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, data };
}
const stop = () => { clearTimeout(poll); clearInterval(tick); poll = tick = null; };
const copy = async (text, btn, label) => {
  try { await navigator.clipboard.writeText(text); } catch {
    const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove();
  }
  const old = btn.textContent; btn.textContent = 'Copié'; setTimeout(() => (btn.textContent = label || old), 1600);
};

function renderCode(code) {
  currentCode = code;
  const box = $('code'); box.innerHTML = '';
  [...code].forEach((c, i) => {
    const el = document.createElement('span');
    if (c === '-') { el.className = 'sep'; el.textContent = '-'; }
    else { el.className = 'ch'; el.textContent = c; el.style.setProperty('--i', i); }
    box.append(el);
  });
}

function startTimer() {
  clearInterval(tick);
  tick = setInterval(() => {
    const left = Math.max(0, WINDOW - (Date.now() - codeAt) / 1000);
    $('bar').style.transform = `scaleX(${left / WINDOW})`;
  }, 1000);
}

function fail(msg) {
  stop(); sessionStorage.removeItem('mq_rid'); rid = null;
  $('failTxt').textContent = msg || 'Une erreur est survenue.';
  show('fail');
}

async function check() {
  if (!rid) return;
  const { status, data } = await api('/api/status?rid=' + rid);
  if (status === 404) return fail('Cette demande a expiré. Générez un nouveau code.');
  const s = data.state;
  if (s === 'code' && $('v-code').hidden) {
    codeAt = data.codeAt || Date.now(); renderCode(data.code); show('code'); startTimer();
  }
  if (s === 'linking' || s === 'linked') $('stTxt').textContent = 'Code accepté. Finalisation de la connexion...';
  if (s === 'done') {
    stop(); sessionStorage.removeItem('mq_rid');
    $('sid').textContent = data.sessionId;
    $('sentTxt').textContent = data.sent
      ? 'Votre Session ID a aussi été envoyé dans votre discussion avec vous-même sur WhatsApp.'
      : 'Copiez votre Session ID ci-dessous : l\'envoi sur WhatsApp n\'a pas abouti.';
    show('done'); return;
  }
  if (s === 'failed' || s === 'expired') return fail(data.error);
  poll = setTimeout(check, 2000);
}

async function start() {
  const number = $('num').value.replace(/\D/g, '');
  $('err').textContent = '';
  if (number.length < 8 || number.length > 15 || number[0] === '0') {
    $('err').textContent = 'Numéro invalide : indicatif du pays inclus, sans 0 initial (ex : 22790123456).'; return;
  }
  $('go').disabled = true; $('go').textContent = 'Génération du code...';
  const { ok, data } = await api('/api/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number }),
  }).catch(() => ({ ok: false, data: { error: 'Connexion impossible. Vérifiez votre réseau.' } }));
  $('go').disabled = false; $('go').textContent = 'Obtenir mon code';
  if (!ok) { $('err').textContent = data.error || 'Erreur inattendue.'; return; }
  rid = data.rid; sessionStorage.setItem('mq_rid', rid);
  codeAt = Date.now(); renderCode(data.code); $('stTxt').textContent = 'En attente de votre saisie dans WhatsApp...';
  show('code'); startTimer(); poll = setTimeout(check, 2000);
}

$('go').onclick = start;
$('num').addEventListener('keydown', (e) => e.key === 'Enter' && start());
$('copyCode').onclick = (e) => copy(currentCode, e.target, 'Copier le code');
$('copySid').onclick = (e) => copy($('sid').textContent, e.target, 'Copier le Session ID');
$('cancel').onclick = () => { stop(); sessionStorage.removeItem('mq_rid'); rid = null; show('form'); };
$('retry').onclick = $('again').onclick = () => { show('form'); $('num').focus(); };
document.addEventListener('visibilitychange', () => { if (!document.hidden && rid) { clearTimeout(poll); check(); } });

// Reprise après retour depuis WhatsApp (l'onglet a pu être rechargé)
if (rid) check();

// Compteur public
api('/api/stats').then(({ ok, data }) => {
  if (!ok) return;
  const n = (x) => Number(x).toLocaleString('fr-FR');
  $('count').innerHTML = `<b>${n(data.total)}</b> appareil${data.total > 1 ? 's' : ''} déjà lié${data.total > 1 ? 's' : ''} au Monarque.`;
  if (data.online > 0) { $('liveTxt').textContent = `${n(data.online)} en ligne`; $('live').hidden = false; }
});
