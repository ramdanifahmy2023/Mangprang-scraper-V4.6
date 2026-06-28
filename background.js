try { importScripts('normalizer.js'); } catch (e) { console.warn(e); }

const DEFAULT_API = 'https://scraper.fahmyid.com';
const QUEUE = 'mpr_queue_v2';
const CFG = 'mpr_cfg_v2';
const BATCH = 'mpr_batch_v2';
const MAX_QUEUE = 1000;
let running = false;
let syncRunning = false;

async function getCfg() {
  const d = await chrome.storage.local.get({ [CFG]: { apiBase: DEFAULT_API, token: '', groupId: '', groupName: '', groups: [] } });
  return d[CFG];
}
async function setCfg(cfg) { await chrome.storage.local.set({ [CFG]: cfg }); }
async function qget() { return (await chrome.storage.local.get({ [QUEUE]: [] }))[QUEUE] || []; }
function trimQueue(q) {
  const list = Array.isArray(q) ? q.slice() : [];
  if (list.length <= MAX_QUEUE) return list;
  const keep = [];
  const pushMany = (items) => {
    for (const item of items) {
      if (keep.length >= MAX_QUEUE) break;
      keep.push(item);
    }
  };
  pushMany(list.filter((x) => x && x.status !== 'synced'));
  pushMany(list.filter((x) => x && x.status === 'synced'));
  return keep;
}
async function qset(q) { await chrome.storage.local.set({ [QUEUE]: trimQueue(q) }); }
async function batchGet() { return (await chrome.storage.local.get({ [BATCH]: null }))[BATCH]; }
async function batchSet(batch) { await chrome.storage.local.set({ [BATCH]: batch }); }
function blankBatch(total = 0) {
  return { running: false, total, current: 0, success: 0, failed: 0, captcha: 0, skipped: 0, current_url: '', last_error: '', last_reason: '', updated_at: new Date().toISOString() };
}

async function enqueue(product) {
  const cfg = await getCfg();
  const groupId = parseInt(cfg.groupId || product.group_id || 0, 10);
  if (!groupId) throw new Error('Pilih Target Group dulu di extension.');
  product.group_id = groupId;
  product.group_name = cfg.groupName || product.group_name || '';
  const q = await qget();
  const key = `${groupId}:${product.shop_id}:${product.item_id}:${product.product_url}`;
  const filtered = q.filter((x) => x.key !== key);
  filtered.unshift({ key, product, group_id: groupId, group_name: product.group_name, status: 'pending', tries: 0, created_at: new Date().toISOString() });
  await qset(filtered);
  syncQueue();
  return true;
}

async function api(path, body) {
  const cfg = await getCfg();
  if (!cfg.token) throw new Error('Token belum diisi');
  const base = (cfg.apiBase || DEFAULT_API).replace(/\/$/, '');
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.token}` },
    body: JSON.stringify(body || {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function syncQueue() {
  if (syncRunning) return { ok: true, sent: 0, failed: 0, queue: await qget(), skipped: 'sync_running' };
  syncRunning = true;
  try {
  const q = await qget();
  let changed = false;
  let sent = 0, failed = 0;
  const now = Date.now();
  for (const item of q) {
    if (item.status === 'synced') continue;
    if (item.next_retry_at && Date.parse(item.next_retry_at) > now) continue;
    try {
      item.status = 'sending';
      item.last_try_at = new Date().toISOString();
      await api('/api/extension/scrape_ingest.php', item.product);
      item.status = 'synced';
      item.synced_at = new Date().toISOString();
      item.error = '';
      sent++;
      changed = true;
    } catch (e) {
      item.status = 'failed';
      item.error = e.message || 'Gagal kirim';
      item.tries = (item.tries || 0) + 1;
      const delayMin = Math.min(60, Math.max(2, item.tries * item.tries * 2));
      item.next_retry_at = new Date(Date.now() + delayMin * 60000).toISOString();
      failed++;
      changed = true;
      continue;
    }
  }
  if (changed) await qset(q);
  return { ok: true, sent, failed, queue: q };
  } finally {
    syncRunning = false;
  }
}

function looksLikeCaptchaText(text) {
  return /captcha|verification|verify|robot|unusual traffic|security check|challenge|please try again|akses ditolak|aktivitas mencurigakan|verifikasi/i.test(String(text || ''));
}

async function scrapeTab(url) {
  return new Promise((resolve) => {
    const bgUrl = url + (url.includes('?') ? '&' : '?') + 'mangprang_bg=1';
    chrome.tabs.create({ url: bgUrl, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab?.id) {
        resolve({ ok: false, reason: 'tab_error', data: { error: chrome.runtime.lastError?.message || 'Gagal buka tab background' } });
        return;
      }
      const tid = tab.id;
      let done = false;
      const finish = (ok, data) => {
        if (done) return;
        done = true;
        try { chrome.runtime.onMessage.removeListener(listener); } catch (_) {}
        chrome.tabs.remove(tid).catch(() => {});
        resolve({ ok, reason: data?.reason || (ok ? (data?.source || 'api_payload') : 'unknown_error'), data });
      };
      const finishError = (message) => finish(false, { error: message });
      const listener = (msg, sender) => {
        if (sender.tab?.id !== tid) return;
        if (msg.type === 'SHOPEE_API_PAYLOAD') {
          const p = self.MangprangNormalizer.normalizeShopeePayload(msg.data);
          enqueue(p).then(() => finish(true, p)).catch((e) => finishError(e.message || 'Gagal simpan antrean'));
        }
      };
      chrome.runtime.onMessage.addListener(listener);
      setTimeout(() => {
        if (done) return;
        chrome.tabs.sendMessage(tid, { type: 'DOM_FALLBACK' }, async (resp) => {
          if (done) return;
          const fallback = resp && !chrome.runtime.lastError ? resp : null;
          const hasIds = !!(fallback?.shopId && fallback?.itemId);
          if (fallback?.isCaptcha || looksLikeCaptchaText(`${fallback?.title || ''} ${fallback?.description || ''}`)) {
            finish(false, { reason: 'captcha', error: 'Shopee captcha/anti-bot terdeteksi. Batch dihentikan agar tidak makin diblokir.' });
            return;
          }
          if (fallback && hasIds) {
            try {
              if (fallback.initialStatePayload?.payload) {
                const normalizedFromState = self.MangprangNormalizer.normalizeShopeePayload({ payload: fallback.initialStatePayload.payload, pageUrl: fallback.productUrl, source_endpoint: fallback.initialStatePayload.source || 'initial_state' });
                if (normalizedFromState?.weight > 0 || normalizedFromState?.item_id) {
                  await enqueue({ ...normalizedFromState, source: fallback.initialStatePayload.source || 'initial_state' });
                  finish(true, { ...normalizedFromState, source: fallback.initialStatePayload.source || 'initial_state' });
                  return;
                }
              }
              const hasSafeContent = String(fallback.title || '').trim().length >= 8 && (fallback.images || []).length > 0;
              if (!hasSafeContent) throw new Error('Fallback DOM tidak cukup valid; produk dilewati agar data tidak salah.');
              const normalized = self.MangprangNormalizer.normalizeDomFallback(fallback);
              await enqueue(normalized);
              finish(true, { ...normalized, source: 'dom_fallback' });
              return;
            } catch (e) {
              finishError(e.message || 'Gagal simpan fallback DOM');
              return;
            }
          }
          finishError('Data API Shopee tidak tertangkap dan fallback DOM kosong. Produk dilewati agar data tidak salah.');
        });
      }, 15000);
    });
  });
}

async function runBatch(links) {
  if (running) return;
  const clean = Array.from(new Set(links || [])).filter(Boolean);
  running = true;
  const batch = blankBatch(clean.length);
  batch.running = true;
  batch.started_at = new Date().toISOString();
  await batchSet(batch);
  try {
    for (const link of clean) {
      batch.current += 1;
      batch.current_url = link;
      batch.last_error = '';
      batch.last_reason = '';
      batch.updated_at = new Date().toISOString();
      await batchSet(batch);
      const result = await scrapeTab(link);
      if (result.ok) batch.success += 1;
      else {
        const reason = result.reason || result.data?.reason || 'failed';
        if (reason === 'captcha') batch.captcha += 1;
        else batch.failed += 1;
        batch.last_reason = reason;
        batch.last_error = result.data?.error || 'Scrape gagal';
        if (reason === 'captcha') break;
      }
      batch.updated_at = new Date().toISOString();
      await batchSet(batch);
      await new Promise((r) => setTimeout(r, 2800 + Math.random() * 5200));
    }
  } finally {
    running = false;
    batch.running = false;
    batch.finished_at = new Date().toISOString();
    batch.updated_at = batch.finished_at;
    await batchSet(batch);
    syncQueue();
  }
}

async function openDashboard() {
  const cfg = await getCfg();
  const base = (cfg.apiBase || DEFAULT_API).trim().replace(/\/+$/, '') || DEFAULT_API;
  const url = /^https?:\/\//i.test(base) ? base : `https://${base}`;
  const tab = await chrome.tabs.create({ url });
  return { ok: true, tabId: tab?.id || null, url };
}

async function scrapeCurrentTabMessage(m) {
  return {
    ok: false,
    error: 'Scrape produk langsung dinonaktifkan. Gunakan halaman search/list produk.'
  };
}

chrome.runtime.onMessage.addListener((m, s, send) => {
  (async () => {
    if (m.type === 'GET_STATE') { send({ ok: true, cfg: await getCfg(), queue: await qget(), batch: await batchGet(), running }); return; }
    if (m.type === 'SAVE_CFG') { await setCfg(m.cfg); send({ ok: true }); return; }
    if (m.type === 'AUTH_CHECK') {
      const cfg = await getCfg();
      const base = (cfg.apiBase || DEFAULT_API).replace(/\/$/, '');
      const res = await fetch(`${base}/api/extension/auth_check.php`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` }, body: '{}' });
      const data = await res.json();
      if (data.ok) {
        const groups = Array.isArray(data.groups) ? data.groups : [];
        let groupId = cfg.groupId || '';
        let groupName = cfg.groupName || '';
        if (groupId && !groups.some((g) => String(g.id) === String(groupId))) { groupId = ''; groupName = ''; }
        await setCfg({ ...cfg, groups, groupId, groupName });
        data.selected_group_id = groupId;
      }
      send(data);
      return;
    }
    if (m.type === 'SHOPEE_API_PAYLOAD') { await enqueue(self.MangprangNormalizer.normalizeShopeePayload(m.data)); send({ ok: true }); return; }
    if (m.type === 'SCRAPE_CURRENT_FALLBACK') { send({ ok: false, error: 'Scrape produk langsung dinonaktifkan. Gunakan halaman search/list produk.' }); return; }
    if (m.type === 'SCRAPE_CURRENT_TAB') {
      if (s.tab?.id) {
        try { chrome.tabs.sendMessage(s.tab.id, { type: 'MPR_DETAIL_SCRAPE_DISABLED' }); } catch (_) {}
      }
      send(await scrapeCurrentTabMessage(m));
      return;
    }
    if (m.type === 'OPEN_DASHBOARD') { send(await openDashboard()); return; }
    if (m.type === 'START_BATCH') { runBatch(m.links || []); send({ ok: true, count: (m.links || []).length }); return; }
    if (m.type === 'SYNC_NOW') { const result = await syncQueue(); send(result); return; }
    if (m.type === 'CLEAR_SYNCED') { const q = (await qget()).filter((x) => x.status !== 'synced'); await qset(q); send({ ok: true, queue: q }); return; }
  })().catch((e) => send({ ok: false, error: e.message }));
  return true;
});
