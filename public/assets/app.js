const $ = (id) => document.getElementById(id);
const views = ['form', 'code', 'done', 'fail'];
const show = (v) => views.forEach((n) => ($('v-' + n).hidden = n !== v));

// [ISO, nom, indicatif] : Afrique francophone en premier, puis les autres pays par ordre alphabétique
const AF = [['NE','Niger','227'],['BJ','Bénin','229'],['BF','Burkina Faso','226'],['ML','Mali','223'],['SN','Sénégal','221'],['CI','Côte d\'Ivoire','225'],['TG','Togo','228'],['GN','Guinée','224'],['CM','Cameroun','237'],['GA','Gabon','241'],['CG','Congo','242'],['CD','RD Congo','243'],['TD','Tchad','235'],['CF','Centrafrique','236'],['MR','Mauritanie','222'],['MG','Madagascar','261'],['KM','Comores','269'],['DJ','Djibouti','253'],['BI','Burundi','257'],['RW','Rwanda','250'],['MA','Maroc','212'],['DZ','Algérie','213'],['TN','Tunisie','216']];
const OTHERS = [['NG','Nigeria','234'],['GH','Ghana','233'],['GM','Gambie','220'],['SL','Sierra Leone','232'],['LR','Liberia','231'],['GW','Guinée-Bissau','245'],['CV','Cap-Vert','238'],['ST','Sao Tomé-et-Principe','239'],['GQ','Guinée équatoriale','240'],['KE','Kenya','254'],['TZ','Tanzanie','255'],['UG','Ouganda','256'],['ET','Éthiopie','251'],['ZA','Afrique du Sud','27'],['EG','Égypte','20'],['AO','Angola','244'],['MZ','Mozambique','258'],['MU','Maurice','230'],['FR','France','33'],['BE','Belgique','32'],['CH','Suisse','41'],['LU','Luxembourg','352'],['CA','Canada','1'],['US','États-Unis','1'],['GB','Royaume-Uni','44'],['DE','Allemagne','49'],['ES','Espagne','34'],['IT','Italie','39'],['PT','Portugal','351'],['NL','Pays-Bas','31'],['BR','Brésil','55'],['IN','Inde','91'],['PK','Pakistan','92'],['ID','Indonésie','62'],['TR','Turquie','90'],['SA','Arabie saoudite','966'],['AE','Émirats arabes unis','971'],['HT','Haïti','509'],['RE','La Réunion','262'],['GP','Guadeloupe','590'],['MQ','Martinique','596'],['GF','Guyane','594'],['NC','Nouvelle-Calédonie','687'],['PF','Polynésie française','689']].sort((a, b) => a[1].localeCompare(b[1], 'fr'));
const ALL = [...AF, ...OTHERS];
const KEEP_ZERO = new Set(['BJ', 'CI']); // le 0 de début fait partie du numéro international
const opt = (c) => `<option value="${c[0]}">${c[1]} (+${c[2]})</option>`;
$('cty').innerHTML = '<option value="">Choisir un pays</option><optgroup label="Afrique francophone">' + AF.map(opt).join('') + '</optgroup><optgroup label="Autres pays">' + OTHERS.map(opt).join('') + '</optgroup>';
const dialOf = () => (ALL.find((c) => c[0] === $('cty').value) || [])[2] || '';
function syncDial() {
  $('dial').textContent = '+' + dialOf();
  $('hint').textContent = KEEP_ZERO.has($('cty').value) ? 'Sans l\'indicatif. Gardez le 0 du début (ex : 01 97 12 34 56).' : 'Sans l\'indicatif ni le 0 initial.'; try { localStorage.setItem('mq_cty', $('cty').value); } catch {} }
$('cty').addEventListener('change', syncDial);
(function initCountry() {
  let iso = ''; try { iso = localStorage.getItem('mq_cty') || ''; } catch {}
  if (!iso) iso = ((navigator.language || '').split('-')[1] || '').toUpperCase();
  if (ALL.some((c) => c[0] === iso)) $('cty').value = iso;
  syncDial();
})();

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
  const dial = dialOf();
  const iso = $('cty').value;
  let local = $('num').value.replace(/\D/g, '');
  if (!KEEP_ZERO.has(iso)) local = local.replace(/^0+/, '');          // cas général : on retire le 0 national
  else if (iso === 'BJ' && local.length === 8) local = '01' + local;  // Bénin : le préfixe 01 fait partie du numéro
  const number = dial + local;
  $('err').textContent = '';
  if (!dial) { $('err').textContent = 'Choisissez votre pays.'; return; }
  if (local.length < 5 || number.length > 15) {
    $('err').textContent = 'Numéro invalide : entrez-le sans l\'indicatif ni le 0 initial.'; return;
  }
  $('go').disabled = true; $('go').textContent = 'Génération du code...';
  const { ok, data } = await api('/api/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number }),
  }).catch(() => ({ ok: false, data: { error: 'Connexion impossible. Vérifiez votre réseau.' } }));
  $('go').disabled = false; $('go').textContent = 'Connecter WhatsApp';
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

// Compteur public (pastille)
api('/api/stats').then(({ ok, data }) => {
  const n = (x) => Number(x).toLocaleString('fr-FR');
  if (!ok) { $('pillTxt').textContent = 'Service actif'; return; }
  $('pillTxt').textContent = `${n(data.total)} appareil${data.total > 1 ? 's' : ''} lié${data.total > 1 ? 's' : ''}`;
  if (data.online > 0) $('onlineTxt').innerHTML = `<b>${n(data.online)}</b> en ligne en ce moment`;
}).catch(() => { $('pillTxt').textContent = 'Service actif'; });
    
