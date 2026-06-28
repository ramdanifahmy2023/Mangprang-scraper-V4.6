const $ = (id) => document.getElementById(id);

function say(text, ok = true) {
  const el = $('msg');
  el.textContent = text;
  el.style.color = ok ? '#bbf7d0' : '#fecaca';
}
function cleanBase(v) {
  v = String(v || '').trim().replace(/\/+$/, '');
  if (!v) return 'https://scraper.fahmyid.com';
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  return v;
}
function cleanToken(v) { return String(v || '').trim(); }
function groupNameFromSelect() { const opt = $('groupId').selectedOptions[0]; return opt ? opt.textContent.replace(/\s+\(.*?\)$/, '').trim() : ''; }

function renderGroups(cfg) {
  const select = $('groupId');
  const groups = Array.isArray(cfg.groups) ? cfg.groups : [];
  select.innerHTML = '<option value="">-- pilih Group dulu --</option>';
  for (const g of groups) {
    const opt = document.createElement('option');
    opt.value = String(g.id);
    opt.textContent = `${g.group_name}${g.target_store ? ' (' + g.target_store + ')' : ''}`;
    if (String(cfg.groupId || '') === String(g.id)) opt.selected = true;
    select.appendChild(opt);
  }
  $('groupHint').textContent = groups.length ? 'Group ini akan dipakai untuk semua scrape berikutnya.' : 'Belum ada Group aktif. Buat Group di dashboard dulu.';
}

async function saveCfg() {
  const old = (await chrome.runtime.sendMessage({ type: 'GET_STATE' })).cfg || {};
  const apiBase = cleanBase($('apiBase').value);
  const token = cleanToken($('token').value);
  const groupId = $('groupId').value || '';
  const groupName = groupId ? groupNameFromSelect() : '';
  const cfg = { ...old, apiBase, token, groupId, groupName, groups: old.groups || [] };
  $('apiBase').value = apiBase;
  $('token').value = token;
  await chrome.runtime.sendMessage({ type: 'SAVE_CFG', cfg });
  return cfg;
}

async function load() {
  const r = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  $('apiBase').value = r.cfg.apiBase;
  $('token').value = r.cfg.token;
  renderGroups(r.cfg);
  const q = r.queue || [];
  $('pending').textContent = q.filter((x) => ['pending', 'sending'].includes(x.status)).length;
  $('synced').textContent = q.filter((x) => x.status === 'synced').length;
  $('failed').textContent = q.filter((x) => x.status === 'failed').length;
  const b = r.batch || {};
  $('batch').textContent = b.total ? `${b.running ? 'Jalan' : 'Selesai'} ${b.current || 0}/${b.total} · OK ${b.success || 0} · gagal ${b.failed || 0}${b.captcha ? ' · captcha ' + b.captcha : ''}` : 'Belum ada batch berjalan.';
  $('batch').style.color = b.captcha ? '#fecaca' : '#cbd5e1';
}

$('save').onclick = async () => {
  const cfg = await saveCfg();
  if (!cfg.token || cfg.token.length < 12) return say('Kode akses terlalu pendek. Cek lagi dari dashboard.', false);
  if (!cfg.groupId) return say('Tersimpan, tapi Target Group belum dipilih. Scrape akan ditolak sampai Group dipilih.', false);
  say(`Tersimpan. Target Group: ${cfg.groupName}.`);
};

$('test').onclick = async () => {
  const cfg = await saveCfg();
  if (!cfg.token || cfg.token.length < 12) return say('Kode akses belum benar. Copy ulang dari dashboard.', false);
  const r = await chrome.runtime.sendMessage({ type: 'AUTH_CHECK' });
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  renderGroups(state.cfg);
  if (!r.ok) return say(`Koneksi gagal: ${r.error || 'cek kode akses'}`, false);
  if (!state.cfg.groups || !state.cfg.groups.length) return say(`Koneksi OK, ${r.user.name}. Tapi belum ada Group aktif. Buat Group di dashboard dulu.`, false);
  say(`Koneksi OK, ${r.user.name}. Pilih Target Group sebelum scrape.`);
};

$('groupId').onchange = async () => {
  const cfg = await saveCfg();
  if (cfg.groupId) say(`Target Group aktif: ${cfg.groupName}.`);
  else say('Target Group kosong. Scrape akan ditolak.', false);
};

$('sync').onclick = async () => {
  const cfg = await saveCfg();
  if (!cfg.groupId) return say('Pilih Target Group dulu sebelum kirim antrean.', false);
  const r = await chrome.runtime.sendMessage({ type: 'SYNC_NOW' });
  if (r.ok) say(`Kirim selesai. Terkirim ${r.sent || 0}, gagal ${r.failed || 0}.`);
  else say(`Gagal kirim: ${r.error || 'cek koneksi'}`, false);
  load();
};

$('clear').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_SYNCED' });
  say('Produk yang sudah terkirim dibersihkan dari antrean lokal.');
  load();
};
$('open').onclick = async () => {
  await saveCfg();
  const r = await chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
  say(r.ok ? 'Dashboard dibuka.' : `Gagal buka dashboard: ${r.error || 'cek alamat'}`, !!r.ok);
};
load();
