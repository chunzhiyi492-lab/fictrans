/* FicTrans Service Worker：唯一持有 API Key、调用 DeepSeek、管理缓存。 */
importScripts('shared.js');
const FT = self.FicTrans;

const DB_NAME = 'fictrans-cache';
const STORE = 'cache';

/* ---------- IndexedDB 缓存 ---------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) {
        r.result.createObjectStore(STORE, { keyPath: 'k' });
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function idbReq(mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const rq = fn(tx.objectStore(STORE));
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  }));
}
const cacheGet = k => idbReq('readonly', s => s.get(k));
function cachePut(v) {
  return idbReq('readwrite', s => s.put(v)).then(() => pruneIfNeeded());
}
function cacheClear() { return idbReq('readwrite', s => s.clear()); }
function cacheCount() { return idbReq('readonly', s => s.count()); }
let pruning = false;
function pruneIfNeeded() {
  if (pruning) return;
  pruning = true;
  cacheCount().then(n => {
    if (n > 30000) {
      // 粗略淘汰：直接清空一半（按主键顺序前 15000 条删除）
      openDB().then(db => {
        const tx = db.transaction(STORE, 'readwrite');
        const st = tx.objectStore(STORE);
        const cur = st.openCursor();
        let deleted = 0;
        cur.onsuccess = e => {
          const c = e.target.result;
          if (c && deleted < 15000) { c.delete(); deleted++; c.continue(); }
        };
      }).catch(() => {});
    }
  }).catch(() => {}).finally(() => { pruning = false; });
}

/* ---------- 工具 ---------- */
async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(null, all => {
      const s = Object.assign({}, FT.DEFAULTS, all);
      resolve(s);
    });
  });
}

/* ---------- 每个标签页的中止控制器（同页可并发多批） ---------- */
const controllers = new Map(); // tabId -> Set<AbortController>
function abortForTab(tabId) {
  const set = controllers.get(tabId);
  if (set) { set.forEach(c => { try { c.abort(); } catch (e) {} }); controllers.delete(tabId); }
}
function trackController(tabId, ac) {
  if (!controllers.has(tabId)) controllers.set(tabId, new Set());
  controllers.get(tabId).add(ac);
}
function untrackController(tabId, ac) {
  const set = controllers.get(tabId);
  if (set) { set.delete(ac); if (!set.size) controllers.delete(tabId); }
}

/* ---------- 核心：翻译一批 ---------- */
async function translateBatch(msg, sender) {
  const tabId = sender.tab && sender.tab.id != null ? sender.tab.id : -1;
  const settings = await getSettings();
  if (!settings.apiKey) return { ok: false, error: 'NO_KEY' };
  if (!settings.ackConfirmed) return { ok: false, error: 'NOT_CONFIRMED' };

  const items = msg.items || [];
  if (!items.length) return { ok: true, results: [] };

  const version = String(settings.profileVersion || 0);
  const model = settings.model || FT.DEFAULTS.model;

  // 1) 查缓存
  const results = [];
  const misses = [];
  for (const it of items) {
    const ck = await sha256(model + '|' + version + '|' + it.text);
    const hit = await cacheGet(ck);
    if (hit && hit.zh) results.push({ id: it.id, zh: hit.zh, fromCache: true });
    else misses.push({ id: it.id, text: it.text, ck: ck });
  }
  if (!misses.length) return { ok: true, results: results };

  // 2) 组装提示词（只挑与本批相关的术语/例句）
  const batchText = misses.map(m => m.text).join('\n');
  const glossary = FT.pickGlossary(settings.glossary || [], batchText);
  const examples = FT.pickExamples(settings.examples || [], batchText, 3);
  const system = FT.buildSystemPrompt({ glossary: glossary, examples: examples });
  const userPayload = {
    context: msg.title ? ('页面氛围：' + msg.title) : '',
    paragraphs: misses.map(m => ({ id: m.id, text: m.text }))
  };
  const user =
    '请把下面 JSON 数组中的每个段落分别翻译为简体中文（韩文/英文→中文）。\n' +
    (userPayload.context ? userPayload.context + '\n' : '') +
    '输入：\n' + JSON.stringify(userPayload.paragraphs, null, 0);

  // 3) 调用接口（可中止）
  const endpoint = FT.normalizeEndpoint(settings.baseUrl);
  const ac = new AbortController();
  trackController(tabId, ac);
  const timeout = setTimeout(() => ac.abort(), 90000);
  let resp, data;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + settings.apiKey
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature: Number(settings.temperature) || 0.3,
        stream: false
      })
    });
  } catch (e) {
    clearTimeout(timeout);
    untrackController(tabId, ac);
    if (e.name === 'AbortError') return { ok: false, error: 'ABORTED' };
    return { ok: false, error: 'NETWORK: ' + FT.sanitizeError(e.message || e) };
  }
  clearTimeout(timeout);
  untrackController(tabId, ac);

  const rawText = await resp.text();
  if (!resp.ok) {
    let detail = rawText.slice(0, 300);
    try { const j = JSON.parse(rawText); if (j && j.error && j.error.message) detail = j.error.message; } catch (e) {}
    return { ok: false, error: 'HTTP ' + resp.status + ': ' + FT.sanitizeError(detail) };
  }
  try { data = JSON.parse(rawText); }
  catch (e) { return { ok: false, error: 'BAD_RESPONSE' }; }

  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) return { ok: false, error: 'EMPTY_CONTENT' };

  const map = FT.parseResultJSON(content);
  const usage = data.usage || {};

  // 4) 写缓存 + 记账
  await Promise.all(misses.map(async m => {
    const zh = map[m.id];
    if (zh) {
      results.push({ id: m.id, zh: zh, fromCache: false });
      try { await cachePut({ k: m.ck, zh: zh, at: Date.now() }); } catch (e) {}
    }
  }));

  const old = await new Promise(r => chrome.storage.local.get('usage', all => r(all.usage || { hit: 0, miss: 0, out: 0, req: 0 })));
  const hitT = usage.prompt_cache_hit_tokens || 0;
  old.hit += hitT;
  old.miss += Math.max(0, (usage.prompt_tokens || 0) - hitT);
  old.out += usage.completion_tokens || 0;
  old.req += 1;
  await new Promise(r => chrome.storage.local.set({ usage: old }, r));

  return { ok: true, results: results, usage: usage };
}

/* ---------- 连通性测试 ---------- */
async function testConnection(s) {
  if (!s.apiKey) throw new Error('NO_KEY');
  const endpoint = FT.normalizeEndpoint(s.baseUrl);
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.apiKey },
      body: JSON.stringify({
        model: s.model || FT.DEFAULTS.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5,
        stream: false
      })
    });
    const text = await resp.text();
    if (!resp.ok) {
      let detail = text.slice(0, 200);
      try { const j = JSON.parse(text); if (j.error && j.error.message) detail = j.error.message; } catch (e) {}
      return { ok: false, error: 'HTTP ' + resp.status + ': ' + FT.sanitizeError(detail) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'NETWORK: ' + FT.sanitizeError(e.message || e) };
  }
}

/* ---------- 消息路由 ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'FT_TRANSLATE':
          sendResponse(await translateBatch(msg, sender));
          break;
        case 'FT_STOP':
          if (sender.tab) abortForTab(sender.tab.id);
          sendResponse({ ok: true });
          break;
        case 'FT_TEST':
          sendResponse(await testConnection(msg.settings || {}));
          break;
        case 'FT_CLEAR_CACHE':
          await cacheClear();
          sendResponse({ ok: true });
          break;
        case 'FT_CLEAR_ALL':
          await cacheClear();
          await new Promise(r => chrome.storage.local.clear(r));
          sendResponse({ ok: true });
          break;
        case 'FT_USAGE_RESET':
          await new Promise(r => chrome.storage.local.set({ usage: { hit: 0, miss: 0, out: 0, req: 0 } }, r));
          sendResponse({ ok: true });
          break;
        case 'FT_CACHE_INFO':
          sendResponse({ ok: true, count: await cacheCount() });
          break;
        case 'FT_GET_FLAGS': {
          const s = await getSettings();
          sendResponse({
            keySet: !!s.apiKey,
            ackConfirmed: !!s.ackConfirmed,
            model: s.model,
            baseUrl: s.baseUrl
          });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'UNKNOWN' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: FT.sanitizeError(e.message || e) });
    }
  })();
  return true; // 异步响应
});
