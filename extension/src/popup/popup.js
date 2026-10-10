const $ = (id) => document.getElementById(id);

async function load() {
  const { settings } = await chrome.storage.local.get('settings');
  const enabled = !settings || settings.enabled !== false;
  $('enabled').checked = enabled;
  $('warn').style.display = (settings && settings.apiKey) ? 'none' : 'block';

  const { stats } = await chrome.runtime.sendMessage({ type: 'GET_STATS' }).catch(() => ({ stats: null }));
  const s = stats || {};
  $('stats').innerHTML =
    `<b>${s.scanned || 0}</b> seen &nbsp; <b>${s.hidden || 0}</b> removed<br>` +
    `<b>${s.calls || 0}</b> calls &nbsp; $${Number(s.cost || 0).toFixed(6)}`;

  const { diag } = await chrome.storage.local.get('diag');
  if (!diag) {
    $('diag').innerHTML =
      '<b>not running on this tab.</b><br>Reload the YouTube tab — content scripts only attach on load.';
  } else {
    const age = Math.max(0, Math.round((Date.now() - diag.at) / 1000));
    $('diag').innerHTML =
      `page <b>${diag.surface || diag.path}</b> &middot; ${diag.cards || 0} cards found &middot; ${age}s ago<br>` +
      (diag.reason
        ? `<b>${diag.reason}</b>`
        : `<b>${diag.hidden || 0}</b> hidden &middot; ${diag.queued || 0} queued &middot; via ${diag.mode}`);
    $('diag').innerHTML += `<br><b>${diag.batch || 0}</b> picked up this scan`;
    if (diag.probe) {
      $('diag').innerHTML += '<br><span style="opacity:.65;font-size:10px;word-break:break-all">'
                           + diag.probe + '</span>';
    }
    if (diag.sample) {
      $('diag').innerHTML += '<br><span style="opacity:.65;font-size:10px;word-break:break-all">'
                           + String(diag.sample).replace(/[{}"]/g, '') + '</span>';
    }
  }
}

$('enabled').onchange = async () => {
  const { settings } = await chrome.storage.local.get('settings');
  const next = { ...(settings || {}), enabled: $('enabled').checked };
  // writing to storage is enough: the content script listens for the change
  await chrome.storage.local.set({ settings: next });
};

$('reveal').onclick = async () => {
  await chrome.storage.local.set({ revealRequest: Date.now() });
  window.close();
};

$('options').onclick = () => chrome.runtime.openOptionsPage();

load();
