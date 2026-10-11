import { DEFAULT_SETTINGS, DEFAULT_TOPICS, MODEL } from '../shared/defaults.js';

const $ = (id) => document.getElementById(id);
let topics = [];

function topicRow(t = { name: '', description: '' }) {
  const row = document.createElement('div');
  row.className = 'topic';
  row.innerHTML = `
    <input class="t-name" placeholder="topic name" value="${(t.name || '').replace(/"/g, '&quot;')}">
    <input class="t-desc" placeholder="what belongs in this topic" value="${(t.description || '').replace(/"/g, '&quot;')}">
    <button type="button" class="rm" title="remove">×</button>`;
  row.querySelector('.rm').onclick = () => { row.remove(); readTopics(); };
  $('topics').appendChild(row);
}

function readTopics() {
  topics = [...document.querySelectorAll('.topic')].map(r => ({
    name: (r.querySelector('.t-name').value || '').trim().toLowerCase().replace(/\s+/g, '_'),
    description: (r.querySelector('.t-desc').value || '').trim()
  })).filter(t => t.name);
}

function paintThresholds() {
  $('thresholdOut').textContent = Number($('threshold').value).toFixed(2);
  $('bandOut').textContent = Number($('reviewBand').value).toFixed(2);
}

async function load() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  s.surfaces = { ...DEFAULT_SETTINGS.surfaces, ...(s.surfaces || {}) };

  $('apiKey').value = s.apiKey || '';
  $('threshold').value = s.threshold;
  $('reviewBand').value = s.reviewBand;
  $('s-home').checked = !!s.surfaces.home;
  $('s-watchSidebar').checked = !!s.surfaces.watchSidebar;
  $('s-search').checked = !!s.surfaces.search;
  $('enrich').checked = !!s.enrich;
  $('enrichChars').value = s.enrichChars;
  $('maxPerBatch').value = s.maxPerBatch;
  $('localKeywords').value = s.localKeywords || '';

  $('topics').innerHTML = '';
  for (const t of (s.topics && s.topics.length ? s.topics : DEFAULT_TOPICS)) topicRow(t);
  paintThresholds();
  refreshStats();
  refreshDiag();
}

async function save() {
  readTopics();
  if (!topics.length) {
    $('saveStatus').textContent = 'add at least one topic';
    $('saveStatus').className = 'status bad';
    return;
  }
  const settings = {
    enabled: (await currentEnabled()),
    apiKey: $('apiKey').value.trim(),
    model: MODEL,
    topics,
    threshold: Number($('threshold').value),
    reviewBand: Number($('reviewBand').value),
    surfaces: {
      home: $('s-home').checked,
      watchSidebar: $('s-watchSidebar').checked,
      search: $('s-search').checked
    },
    enrich: $('enrich').checked,
    enrichChars: Number($('enrichChars').value) || 600,
    maxPerBatch: Number($('maxPerBatch').value) || 8,
    localKeywords: $('localKeywords').value
  };
  await chrome.storage.local.set({ settings });
  $('saveStatus').textContent = 'saved — reload your YouTube tab';
  $('saveStatus').className = 'status good';
  setTimeout(() => { $('saveStatus').textContent = ''; }, 4000);
}

async function currentEnabled() {
  const { settings } = await chrome.storage.local.get('settings');
  return settings && typeof settings.enabled === 'boolean' ? settings.enabled : true;
}

async function refreshStats() {
  const { stats } = await chrome.runtime.sendMessage({ type: 'GET_STATS' }).catch(() => ({ stats: null }));
  if (!stats) { $('stats').textContent = 'unavailable'; return; }
  const s = stats;
  $('stats').innerHTML = `
    <div><b>${s.scanned || 0}</b> videos seen</div>
    <div><b>${s.hidden || 0}</b> removed</div>
    <div><b>${s.review || 0}</b> flagged for review</div>
    <div><b>${s.calls || 0}</b> API calls</div>
    <div><b>${s.inputTokens || 0}</b> input tokens</div>
    <div><b>$${Number(s.cost || 0).toFixed(6)}</b> spent</div>
    ${s.lastError ? `<div class="bad">last error: ${String(s.lastError).slice(0, 160)}</div>` : ''}`;
}

async function refreshDiag() {
  const { diag } = await chrome.storage.local.get('diag');
  const h = $('health'), d = $('diag');
  if (!diag) {
    h.className = 'health';
    h.textContent = 'idle';
    d.innerHTML = '<div class="wide">Nothing recorded yet. Open youtube.com and reload the tab.</div>';
    return;
  }
  const age = Math.max(0, Math.round((Date.now() - diag.at) / 1000));
  const fresh = age < 120;
  h.className = 'health' + (fresh ? ' ok' : '');
  h.textContent = fresh ? 'active' : 'idle ' + age + 's';
  d.innerHTML =
    '<div><b>' + (diag.surface || diag.path || '\u2014') + '</b>page</div>' +
    '<div><b>' + (diag.cards || 0) + '</b>cards found</div>' +
    '<div><b>' + (diag.batch || 0) + '</b>picked up</div>' +
    '<div><b>' + (diag.hidden || 0) + '</b>hidden</div>' +
    '<div><b>' + age + 's</b>ago</div>' +
    (diag.reason ? '<div class="bad wide">' + diag.reason + '</div>' : '') +
    (diag.sample ? '<div class="bad wide">' + String(diag.sample).slice(0, 320) + '</div>' : '');
}

$('addTopic').onclick = () => { readTopics(); topicRow(); $('topics').lastChild.querySelector('.t-name').focus(); };
$('threshold').oninput = paintThresholds;
$('reviewBand').oninput = paintThresholds;
$('save').onclick = save;

$('test').onclick = async () => {
  const st = $('testStatus');
  st.textContent = 'testing…'; st.className = 'status';
  await save();                                  // test with what is on screen
  const r = await chrome.runtime.sendMessage({ type: 'TEST' }).catch(e => ({ ok: false, error: String(e) }));
  if (r && r.ok) {
    const a = r.answer || {};
    st.textContent = `ok — choice=${a.choice ?? '?'} conf=${a.confidence ?? '?'} (${r.model || ''})`;
    st.className = 'status good';
  } else {
    st.textContent = `failed — ${(r && r.error) || 'unknown error'}`;
    st.className = 'status bad';
  }
};

$('resume').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_BLOCK' }).catch(() => {});
  $('saveStatus').textContent = 'metadata fetching resumed';
  $('saveStatus').className = 'status good';
  setTimeout(() => { $('saveStatus').textContent = ''; }, 4000);
};

$('clear').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
  refreshStats();
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.diag || changes.stats) { refreshDiag(); refreshStats(); }
});

load();
setInterval(refreshDiag, 5000);
