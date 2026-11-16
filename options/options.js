/* FicTrans 设置页逻辑 */
const $ = s => document.querySelector(s);
const FT = self.FicTrans;

const KEYS = ['baseUrl', 'model', 'apiKey', 'priceInMiss', 'priceInHit', 'priceOut',
  'ackConfirmed', 'glossary', 'examples', 'usage', 'profileVersion'];

function loadSettings() {
  return new Promise(resolve => chrome.storage.local.get(KEYS, all => {
    const s = Object.assign({}, FT.DEFAULTS, all);
    s.glossary = Array.isArray(s.glossary) ? s.glossary : [];
    s.examples = Array.isArray(s.examples) ? s.examples : [];
    s.usage = s.usage || { hit: 0, miss: 0, out: 0, req: 0 };
    resolve(s);
  }));
}
function save(patch) {
  return new Promise(resolve => chrome.storage.local.set(patch, resolve));
}
function send(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, r => { void chrome.runtime.lastError; resolve(r); }));
}

let state = { glossary: [], examples: [] };

/* ---------- 基础设置 ---------- */
async function refreshAll() {
  const s = await loadSettings();
  $('#baseUrl').value = s.baseUrl;
  $('#model').value = s.model;
  $('#priceInMiss').value = s.priceInMiss;
  $('#priceInHit').value = s.priceInHit;
  $('#priceOut').value = s.priceOut;
  $('#ackConfirm').checked = !!s.ackConfirmed;
  $('#ackStatus').textContent = s.ackConfirmed ? '已确认' : '未确认';
  $('#ackStatus').className = 'pill ' + (s.ackConfirmed ? 'ok' : 'err');
  $('#keyStatus').textContent = s.apiKey ? ('已设置：' + maskKey(s.apiKey)) : '未设置';
  state.glossary = s.glossary;
  state.examples = s.examples;
  renderGloss(); renderEx(); renderUsage(s.usage, s);
  const info = await send({ type: 'FT_CACHE_INFO' });
  $('#cacheCount').textContent = info && typeof info.count === 'number' ? info.count : '…';
}
function maskKey(k) {
  k = String(k);
  if (k.length <= 8) return '••••';
  return k.slice(0, 4) + '••••' + k.slice(-4);
}
function renderUsage(u, s) {
  const cost = FT.estimateCost(
    { prompt_tokens: u.miss + u.hit, prompt_cache_hit_tokens: u.hit, completion_tokens: u.out },
    s || {}
  );
  $('#usageLine').textContent =
    '累计用量：输入 ' + (u.hit + u.miss) + '（命中缓存 ' + u.hit + '）/ 输出 ' + u.out +
    ' tokens · 请求 ' + u.req + ' 次 · 估算费用 ≈ ¥' + cost.toFixed(3);
}

/* ---------- Key ---------- */
$('#btnSaveKey').onclick = async () => {
  const v = $('#apiKey').value.trim();
  if (!v) { alert('请先粘贴 API Key'); return; }
  await save({ apiKey: v });
  $('#apiKey').value = '';
  $('#keyStatus').textContent = '已设置：' + maskKey(v);
};
$('#btnDeleteKey').onclick = async () => {
  if (!confirm('确定删除本机保存的 API Key？')) return;
  await save({ apiKey: '', ackConfirmed: false });
  refreshAll();
};
$('#btnShow').onclick = () => {
  const el = $('#apiKey');
  el.type = el.type === 'password' ? 'text' : 'password';
};
$('#btnTest').onclick = async () => {
  const out = $('#testResult');
  out.textContent = '测试中…'; out.className = '';
  const s = await loadSettings();
  const res = await send({
    type: 'FT_TEST',
    settings: {
      apiKey: $('#apiKey').value.trim() || s.apiKey,
      baseUrl: $('#baseUrl').value.trim() || s.baseUrl,
      model: $('#model').value.trim() || s.model
    }
  });
  if (res && res.ok) { out.textContent = '✓ 连接成功'; out.className = 'ok'; }
  else { out.textContent = '✗ ' + (res && res.error ? res.error : '连接失败'); out.className = 'err'; }
};

/* ---------- 通用设置保存 ---------- */
$('#btnConfirm').onclick = async () => {
  const ack = $('#ackConfirm').checked;
  await save({
    baseUrl: $('#baseUrl').value.trim() || FT.DEFAULTS.baseUrl,
    model: $('#model').value.trim() || FT.DEFAULTS.model,
    priceInMiss: Number($('#priceInMiss').value) || 1,
    priceInHit: Number($('#priceInHit').value) || 0.02,
    priceOut: Number($('#priceOut').value) || 4,
    ackConfirmed: ack
  });
  refreshAll();
};
$('#btnResetUsage').onclick = async () => { await send({ type: 'FT_USAGE_RESET' }); refreshAll(); };

/* ---------- 术语表 ---------- */
function renderGloss() {
  const tb = $('#glossTable tbody');
  tb.innerHTML = '';
  state.glossary.forEach((t, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><input data-i="' + i + '" data-k="source" value=""></td>' +
      '<td><input data-i="' + i + '" data-k="target" value=""></td>' +
      '<td><input data-i="' + i + '" data-k="note" value=""></td>' +
      '<td><button class="secondary" data-del="' + i + '">删</button></td>';
    tr.querySelectorAll('input').forEach(inp => {
      inp.value = t[inp.dataset.k] || '';
      inp.onchange = () => { state.glossary[inp.dataset.i][inp.dataset.k] = inp.value; persistGloss(); };
    });
    tr.querySelector('[data-del]').onclick = () => { state.glossary.splice(i, 1); persistGloss(); renderGloss(); };
    tb.appendChild(tr);
  });
}
async function persistGloss() {
  await save({ glossary: state.glossary, profileVersion: Date.now() });
}
$('#btnAddGloss').onclick = () => { state.glossary.push({ source: '', target: '', note: '' }); renderGloss(); };
$('#btnBulkGloss').onclick = () => {
  const lines = $('#glossBulk').value.split('\n').map(l => l.trim()).filter(Boolean);
  let n = 0;
  lines.forEach(line => {
    const parts = line.split(/[=\t]/);
    if (parts.length >= 2 && parts[0] && parts[1]) {
      state.glossary.push({ source: parts[0].trim(), target: parts[1].trim(), note: (parts[2] || '').trim() });
      n++;
    }
  });
  $('#glossBulk').value = '';
  persistGloss(); renderGloss();
  alert('已导入 ' + n + ' 条术语');
};
$('#btnExportGloss').onclick = () => {
  const blob = new Blob([JSON.stringify(state.glossary, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'fictrans-glossary.json';
  a.click();
};
$('#btnImportGloss').onclick = () => $('#glossFile').click();
$('#glossFile').onchange = e => {
  const f = e.target.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const arr = JSON.parse(rd.result);
      if (Array.isArray(arr)) { state.glossary = state.glossary.concat(arr.filter(x => x && x.source)); persistGloss(); renderGloss(); }
    } catch (err) { alert('JSON 解析失败'); }
  };
  rd.readAsText(f);
};

/* ---------- 例句库 ---------- */
function renderEx() {
  const tb = $('#exTable tbody');
  tb.innerHTML = '';
  state.examples.forEach((ex, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><input data-i="' + i + '" data-k="src" value=""></td>' +
      '<td><input data-i="' + i + '" data-k="tgt" value=""></td>' +
      '<td style="text-align:center"><input type="checkbox" data-i="' + i + '" data-k="pin"></td>' +
      '<td><button class="secondary" data-del="' + i + '">删</button></td>';
    tr.querySelector('[data-k="src"]').value = ex.src || '';
    tr.querySelector('[data-k="tgt"]').value = ex.tgt || '';
    tr.querySelector('[data-k="pin"]').checked = !!ex.pin;
    tr.querySelectorAll('input[data-k]').forEach(inp => {
      if (inp.type === 'checkbox') inp.onchange = () => { state.examples[inp.dataset.i].pin = inp.checked; persistEx(); };
      else inp.onchange = () => { state.examples[inp.dataset.i][inp.dataset.k] = inp.value; persistEx(); };
    });
    tr.querySelector('[data-del]').onclick = () => { state.examples.splice(i, 1); persistEx(); renderEx(); };
    tb.appendChild(tr);
  });
}
async function persistEx() { await save({ examples: state.examples, profileVersion: Date.now() }); }
$('#btnAddEx').onclick = () => { state.examples.push({ src: '', tgt: '', pin: false }); renderEx(); };

/* ---------- 数据 ---------- */
$('#btnClearCache').onclick = async () => {
  if (!confirm('清空全部译文缓存？下次翻译会重新请求（产生费用）。')) return;
  await send({ type: 'FT_CLEAR_CACHE' });
  refreshAll();
};
$('#btnWipe').onclick = async () => {
  if (!confirm('将删除 Key、术语表、例句、缓存和用量统计，且不可恢复。继续？')) return;
  await send({ type: 'FT_CLEAR_ALL' });
  refreshAll();
};

refreshAll();
