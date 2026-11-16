/* FicTrans 内容脚本：扫描正文段落、排队翻译、在原文下方插入译文。 */
(function () {
  'use strict';
  if (window.__ficTransLoaded) return;   // 防止重复注入导致同段重复翻译
  window.__ficTransLoaded = true;

  const FT = self.FicTrans;

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT',
    'BUTTON', 'OPTION', 'CODE', 'PRE', 'KBD', 'SAMP', 'IFRAME', 'SVG', 'MATH',
    'CANVAS', 'TEMPLATE', 'VIDEO', 'AUDIO', 'LABEL', 'FORM']);
  const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE',
    'LI', 'TD', 'TH', 'TR', 'DT', 'DD', 'FIGCAPTION', 'CAPTION', 'DIV', 'SECTION',
    'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'DETAILS', 'SUMMARY', 'TABLE']);
  const BATCH_CHAR = 3500;
  const BATCH_ITEMS = 20;
  const CONCURRENCY = 2;

  const state = {
    running: false,
    runId: 0,
    mode: 'bi',          // 'bi' 双语 | 'zh' 只看译文 | 'ko' 只看原文
    root: null,
    widget: null,
    queue: [],
    pidMap: new Map(),
    hostMap: new Map(),
    claimed: new WeakSet(),   // 扫描阶段就登记，防止请求在途时被重复排队
    inserted: new WeakSet(),  // 已插入译文的 host，防止重复插入
    active: 0,
    done: 0,
    total: 0,
    observer: null,
    lastHref: location.href,
    hidCounter: 0,
    scanTimer: null
  };

  function sendMsg(msg) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(msg, resp => {
          void chrome.runtime.lastError;
          resolve(resp);
        });
      } catch (e) { resolve(null); }
    });
  }

  /* ---------- DOM 扫描 ---------- */
  function findRoot() {
    const sels = ['.xe_content', 'article.work-body', '.work-body .read_body', '.read_body',
      '.work-body', 'article', 'main', '[role="main"]', '#container', 'body'];
    const cands = [];
    sels.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        if (el.closest('.fcot-widget')) return;
        const txt = el.innerText || '';
        const score = (txt.match(/[가-힣]/g) || []).length;
        cands.push({ el: el, score: score, len: txt.length });
      });
    });
    if (!cands.length) return document.body;
    cands.sort((a, b) => b.score - a.score);
    const max = cands[0].score;
    if (max < 20) return document.body;
    const good = cands.filter(c => c.score >= max * 0.95);
    good.sort((a, b) => a.len - b.len);
    return good[0].el;
  }

  function blockHost(el) {
    let cur = el;
    while (cur && cur !== document.documentElement) {
      if (BLOCK_TAGS.has(cur.tagName)) return cur;
      const disp = (getComputedStyle(cur).display || 'inline');
      if (!/^(inline|ruby|run-in)/.test(disp)) return cur;
      cur = cur.parentElement;
    }
    return el;
  }

  function acceptNode(n) {
    const el = n.parentElement;
    if (!el) return NodeFilter.FILTER_REJECT;
    if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
    if (el.closest('.fcot-tr, .fcot-widget, .fcot-setup')) return NodeFilter.FILTER_REJECT;
    if (el.closest('[contenteditable=""],[contenteditable="true"],textarea,input,select')) return NodeFilter.FILTER_REJECT;
    if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
    if (el.getClientRects().length === 0) return NodeFilter.FILTER_REJECT;
    return NodeFilter.FILTER_ACCEPT;
  }

  function scanNew() {
    if (!state.root || !document.body.contains(state.root)) state.root = findRoot();
    const root = state.root;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode });
    const groups = new Map();
    let n;
    while ((n = walker.nextNode())) {
      const host = blockHost(n.parentElement);
      if (state.claimed.has(host)) continue;          // 关键：扫描到即登记，请求在途也不会重复排队
      if (!groups.has(host)) groups.set(host, []);
      groups.get(host).push(n);
    }

    groups.forEach((nodes, host) => {
      state.claimed.add(host);                          // 立刻认领
      host.classList.add('fcot-orig');
      if (host.closest('nav,aside,form,[class*="comment"],[class*="reply"]')) return;
      const source = nodes.map(v => v.nodeValue).join('').replace(/ /g, ' ');
      const dec = FT.shouldTranslateText(source);
      if (!dec.ok) return;

      const hid = 'h' + (++state.hidCounter);
      const parts = FT.splitLongText(source, 1200);
      const pids = parts.map((text, i) => {
        const pid = hid + '__' + i;
        state.pidMap.set(pid, { hid: hid, text: text, zh: null, err: null });
        return pid;
      });
      state.hostMap.set(hid, { host: host, pids: pids, inserted: false });
      state.queue.push.apply(state.queue, pids);
      state.total += pids.length;
    });
    schedule();
  }

  /* ---------- 调度 ---------- */
  function schedule() {
    while (state.running && state.active < CONCURRENCY && state.queue.length) {
      const batch = [];
      let chars = 0;
      while (state.queue.length && batch.length < BATCH_ITEMS && chars < BATCH_CHAR) {
        const pid = state.queue.shift();
        const p = state.pidMap.get(pid);
        if (!p) continue;
        batch.push({ id: pid, text: p.text });
        chars += p.text.length;
      }
      if (!batch.length) break;
      state.active++;
      updateWidget();
      sendMsg({ type: 'FT_TRANSLATE', items: batch, title: document.title }).then(resp => {
        state.active--;
        if (!resp) failBatch(batch, 'no-response');
        else if (resp.error === 'ABORTED' || resp.error === 'NO_KEY' || resp.error === 'NOT_CONFIRMED') { /* 静默 */ }
        else if (!resp.ok) failBatch(batch, resp.error || 'error');
        else {
          (resp.results || []).forEach(r => {
            const p = state.pidMap.get(r.id);
            if (p) { p.zh = r.zh; }
          });
        }
        renderReadyHosts();
        updateWidget();
        schedule();
      });
    }
  }

  function failBatch(batch, err) {
    batch.forEach(it => {
      const p = state.pidMap.get(it.id);
      if (p && !p.zh) p.err = err;
    });
    renderReadyHosts();
  }

  function renderReadyHosts() {
    state.hostMap.forEach((entry, hid) => {
      if (entry.inserted) return;
      const ps = entry.pids.map(pid => state.pidMap.get(pid));
      if (ps.some(p => !p)) return;
      const pending = ps.some(p => !p.zh && !p.err);
      if (pending) return;
      entry.inserted = true;
      state.done += ps.length;
      if (!document.body.contains(entry.host)) return;
      if (ps.every(p => p.zh)) {
        insertTranslation(entry.host, ps.map(p => p.zh).join('\n'));
      } else {
        insertError(entry.host, hid);
      }
    });
  }

  /* ---------- 插入译文 ---------- */
  function insertTranslation(host, zh) {
    if (state.inserted.has(host)) return;   // 双保险
    state.inserted.add(host);
    const div = document.createElement('div');
    div.className = 'fcot-tr';
    div.lang = 'zh-CN';
    div.textContent = zh;
    host.parentNode.insertBefore(div, host.nextSibling);
  }

  function insertError(host, hid) {
    if (state.inserted.has(host)) return;
    state.inserted.add(host);
    const div = document.createElement('div');
    div.className = 'fcot-tr fcot-err';
    div.textContent = '⚠ 本段翻译失败（未自动重试，避免产生额外费用）';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '重试';
    btn.onclick = (e) => {
      e.stopPropagation();
      div.remove();
      state.inserted.delete(host);
      entryRequeue(hid);
      ensureWidget();
      state.running = true;
      schedule();
    };
    div.appendChild(btn);
    host.parentNode.insertBefore(div, host.nextSibling);
  }

  function entryRequeue(hid) {
    const entry = state.hostMap.get(hid);
    if (!entry) return;
    entry.inserted = false;
    entry.pids.forEach(pid => {
      const p = state.pidMap.get(pid);
      if (p) { p.zh = null; p.err = null; state.queue.push(pid); }
    });
  }

  /* ---------- 导出译文 ---------- */
  function exportTranslation() {
    const trs = Array.from(document.querySelectorAll('.fcot-tr:not(.fcot-err)'));
    if (!trs.length) { toast('还没有可导出的译文', true); return; }
    const lines = trs.map(d => d.textContent.trim()).filter(Boolean);
    const text = lines.join('\n\n');
    const blob = new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = ((document.title || 'fic').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)) + '_中文.txt';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('已导出 ' + lines.length + ' 段译文');
  }

  /* ---------- 显示模式：双语 / 仅中文 / 仅韩文 ---------- */
  const MODES = [
    { id: 'bi', label: '双语' },
    { id: 'zh', label: '仅中文' },
    { id: 'ko', label: '仅韩文' }
  ];
  function applyMode() {
    const rootEl = document.documentElement;
    rootEl.classList.remove('fcot-mode-bi', 'fcot-mode-zh', 'fcot-mode-ko');
    rootEl.classList.add('fcot-mode-' + state.mode);
    syncModeButton();
  }
  function cycleMode() {
    const i = MODES.findIndex(m => m.id === state.mode);
    state.mode = MODES[(i + 1) % MODES.length].id;
    applyMode();
  }
  function syncModeButton() {
    const m = MODES.find(x => x.id === state.mode);
    if (state.widget) {
      const b = state.widget.querySelector('.fcot-toggle');
      if (b) b.textContent = '显示：' + m.label;
    }
    if (window.dispatchEvent) window.dispatchEvent(new CustomEvent('ft-mode-changed', { detail: state.mode }));
  }

  /* ---------- 状态小条 ---------- */
  function ensureWidget() {
    if (state.widget && document.body.contains(state.widget)) return state.widget;
    const w = document.createElement('div');
    w.className = 'fcot-widget';
    w.innerHTML = '<span class="fcot-prog"></span><button class="fcot-stop">停止</button><button class="fcot-toggle">显示：双语</button><button class="fcot-export">导出</button>';
    w.querySelector('.fcot-stop').onclick = () => stopRun();
    w.querySelector('.fcot-toggle').onclick = () => cycleMode();
    w.querySelector('.fcot-export').onclick = () => exportTranslation();
    document.body.appendChild(w);
    state.widget = w;
    syncModeButton();
    return w;
  }
  function updateWidget() {
    if (!state.widget) return;
    const prog = state.widget.querySelector('.fcot-prog');
    if (state.running) {
      prog.textContent = '翻译中 ' + Math.min(state.done, state.total) + '/' + state.total;
    }
  }
  function toast(text, isError) {
    const w = ensureWidget();
    w.querySelector('.fcot-prog').textContent = text;
    if (isError) w.style.outline = '1px solid rgba(220,120,120,.6)';
    setTimeout(() => { if (state.widget && !state.running && !state.stayOnScreen) { state.widget.remove(); state.widget = null; } }, 5000);
  }

  /* ---------- 启停 ---------- */
  async function startRun() {
    const flags = await sendMsg({ type: 'FT_GET_FLAGS' });
    if (!flags || !flags.keySet) { toast('请先点扩展图标 → 设置，填写 DeepSeek API Key', true); return { needSetup: true }; }
    if (!flags.ackConfirmed) { toast('请先在设置页确认模型与费用后再开始翻译', true); return { needSetup: true }; }
    state.running = true;
    state.runId++;
    ensureWidget();
    applyMode();
    scanNew();
    return { ok: true };
  }

  function stopRun() {
    state.running = false;
    state.queue.length = 0;
    sendMsg({ type: 'FT_STOP' });
    if (state.widget) {
      state.widget.querySelector('.fcot-prog').textContent = '已停止';
      setTimeout(() => { if (state.widget && !state.running) { state.widget.remove(); state.widget = null; } }, 2500);
    }
  }

  /* ---------- 动态内容 & SPA ---------- */
  function setupObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver(() => {
      if (state.scanTimer) clearTimeout(state.scanTimer);
      state.scanTimer = setTimeout(() => {
        if (!state.running) return;
        state.root = findRoot();
        scanNew();
      }, 700);
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
    setInterval(() => {
      if (location.href !== state.lastHref) {
        state.lastHref = location.href;
        state.running = false;
        state.queue.length = 0;
        state.pidMap.clear();
        state.hostMap.clear();
        state.done = 0; state.total = 0;
        document.querySelectorAll('.fcot-tr').forEach(n => n.remove());
        document.querySelectorAll('.fcot-orig').forEach(n => n.classList.remove('fcot-orig'));
        if (state.widget) { state.widget.remove(); state.widget = null; }
      }
    }, 1000);
  }
  setupObserver();
  applyMode();

  /* ---------- 来自 popup 的指令 ---------- */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      if (msg.type === 'FT_START') sendResponse(await startRun());
      else if (msg.type === 'FT_STOP') { stopRun(); sendResponse({ ok: true }); }
      else if (msg.type === 'FT_TOGGLE') { cycleMode(); sendResponse({ mode: state.mode }); }
      else if (msg.type === 'FT_EXPORT') { exportTranslation(); sendResponse({ ok: true }); }
      else if (msg.type === 'FT_STATE') {
        sendResponse({ running: state.running, mode: state.mode, done: state.done, total: state.total });
      } else sendResponse({ ok: false });
    })();
    return true;
  });
})();
