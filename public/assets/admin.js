const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('fr-FR');
let data = null, timer = null;

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return 'à l\'instant';
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}
const dateFr = (ts) => new Date(ts).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function drawChart(days) {
  const W = 640, H = 200, pad = { l: 28, b: 24, t: 8 }, bw = (W - pad.l) / days.length;
  const max = Math.max(4, ...days.map((d) => d.attempts), ...days.map((d) => d.ok));
  const y = (v) => H - pad.b - (v / max) * (H - pad.b - pad.t);
  let g = '';
  for (const t of [0, Math.round(max / 2), max]) g += `<line x1="${pad.l}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="#183070"/><text x="0" y="${y(t) + 4}" fill="#8fa3d6" font-size="11">${t}</text>`;
  days.forEach((d, i) => {
    const x = pad.l + i * bw + bw * 0.18, w = bw * 0.64;
    g += `<g><title>${d.date} : ${d.ok} lié(s) sur ${d.attempts} demande(s)</title>` +
      `<rect x="${x}" y="${y(d.attempts)}" width="${w}" height="${H - pad.b - y(d.attempts)}" rx="3" fill="#183070"/>` +
      `<rect x="${x + w * 0.2}" y="${y(d.ok)}" width="${w * 0.6}" height="${H - pad.b - y(d.ok)}" rx="3" fill="#35d6ff"/>` +
      `<text x="${x + w / 2}" y="${H - 6}" fill="#8fa3d6" font-size="11" text-anchor="middle">${d.date.slice(8)}</text></g>`;
  });
  $('chart').innerHTML = g;
}

function render() {
  if (!data) return;
  $('k-total').textContent = fmt(data.total);
  $('k-online').textContent = fmt(data.online);
  $('k-today').textContent = fmt(data.today);
  $('k-week').textContent = fmt(data.week);
  const att = data.days.reduce((s, d) => s + d.attempts, 0), ok = data.days.reduce((s, d) => s + d.ok, 0);
  $('rate').textContent = att ? `Taux de réussite : ${Math.round((ok / att) * 100)} %` : '';
  drawChart(data.days);
  const full = $('reveal').checked;
  $('rows').innerHTML = data.devices.map((d) => {
    const st = d.online ? '<span class="pill on"><i></i>En ligne</span>'
      : d.lastSeen ? '<span class="pill"><i></i>Hors ligne</span>'
      : '<span class="pill wait"><i></i>Bot pas encore lancé</span>';
    return `<tr><td>+${full ? d.full : d.masked}</td><td>${d.firstPaired ? dateFr(d.firstPaired) : ''}</td><td>${d.lastSeen ? ago(d.lastSeen) : 'Jamais'}</td><td>${st}</td></tr>`;
  }).join('');
  $('empty').hidden = data.devices.length > 0;
  $('upd').textContent = `Mis à jour à ${new Date().toLocaleTimeString('fr-FR')}. Un bot est « en ligne » s'il a donné signe de vie récemment.`;
}

function view(name) {
  $('login').hidden = name !== 'login'; $('dash').hidden = name !== 'dash'; $('bar').hidden = name !== 'dash';
}

async function load() {
  const r = await fetch('/api/admin'); const j = await r.json().catch(() => ({}));
  if (r.status === 401) { view('login'); return; }
  if (!r.ok) { view('login'); $('lerr').textContent = j.error || 'Erreur.'; return; }
  data = j; view('dash'); render();
  clearTimeout(timer); timer = setTimeout(load, 30000);
}

$('login').addEventListener('submit', async (e) => {
  e.preventDefault(); $('lerr').textContent = '';
  const r = await fetch('/api/admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'login', password: $('pw').value }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $('lerr').textContent = j.error || 'Erreur.'; return; }
  $('pw').value = ''; load();
});
$('logout').onclick = async () => { await fetch('/api/admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'logout' }) }); clearTimeout(timer); view('login'); };
$('refresh').onclick = load;
$('reveal').onchange = render;
load();
                            
