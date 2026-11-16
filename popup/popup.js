/* FicTrans 弹窗 */
const $ = s => document.querySelector(s);

function send(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, r => { void chrome.runtime.lastError; resolve(r); }));
}
function sendToTab(tabId, msg) {
  return new Promise(resolve => chrome.tabs.sendMessage(tabId, msg, r => { void chrome.runtime.lastError; resolve(r); }));
}

let activeTab = null;

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;
  const flags = await send({ type: 'FT_GET_FLAGS' });
  const notReady = $('#notReady');
  const ready = flags && flags.keySet && flags.ackConfirmed;
  notReady.classList.toggle('hidden', !!ready);
  $('#btnStart').textContent = ready ? '翻译本页' : '先完成配置';

  if (tab) {
    const st = await sendToTab(tab.id, { type: 'FT_STATE' });
    if (st) {
      $('#stateLine').textContent = st.running
        ? '状态：翻译中 ' + Math.min(st.done, st.total) + '/' + st.total
        : (st.done ? '状态：已完成 ' + st.done + ' 段（已完成的会走缓存）' : '状态：空闲');
      $('#btnToggle').textContent = { bi: '切换显示：双语', zh: '切换显示：仅中文', ko: '切换显示：仅韩文' }[st.mode || 'bi'];
    } else {
      $('#stateLine').textContent = '状态：当前页无法注入（chrome:// 或商店页）';
    }
  }
}

$('#btnStart').onclick = async () => {
  const flags = await send({ type: 'FT_GET_FLAGS' });
  if (!flags || !flags.keySet || !flags.ackConfirmed) {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (activeTab) await sendToTab(activeTab.id, { type: 'FT_START' });
  setTimeout(refresh, 400);
};
$('#btnStop').onclick = async () => {
  if (activeTab) await sendToTab(activeTab.id, { type: 'FT_STOP' });
  refresh();
};
$('#btnToggle').onclick = async () => {
  if (activeTab) await sendToTab(activeTab.id, { type: 'FT_TOGGLE' });
  refresh();
};
$('#btnOptions').onclick = () => chrome.runtime.openOptionsPage();
$('#btnExport').onclick = async () => {
  if (activeTab) await sendToTab(activeTab.id, { type: 'FT_EXPORT' });
};

refresh();
