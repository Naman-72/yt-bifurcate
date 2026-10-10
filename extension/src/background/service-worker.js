// Service worker: owns the OpenRouter key, fetches per-video metadata, calls JEV,
// caches verdicts, and answers the content script.
//
// Key handling: the key lives in chrome.storage.local on this machine only.
// It is never written into source, never logged, and never sent anywhere but OpenRouter.

import {
  DEFAULT_SETTINGS, MODEL,
  buildQuestions, verdict, strip
} from '../shared/defaults.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/alpha/decisions';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- settings

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  s.surfaces = { ...DEFAULT_SETTINGS.surfaces, ...(s.surfaces || {}) };
  if (!Array.isArray(s.topics) || !s.topics.length) s.topics = DEFAULT_SETTINGS.topics;
  return s;
}

async function bumpStats(patch) {
  const { stats } = await chrome.storage.local.get('stats');
  const next = { scanned: 0, hidden: 0, review: 0, calls: 0, inputTokens: 0, cost: 0, ...(stats || {}) };
  for (const [k, v] of Object.entries(patch)) {
    next[k] = typeof v === 'number' && typeof next[k] === 'number' ? next[k] + v : v;
  }
  await chrome.storage.local.set({ stats: next });
  return next;
}

// ---------------------------------------------------------------- cache

async function getCache() {
  const { verdictCache } = await chrome.storage.local.get('verdictCache');
  return verdictCache || {};
}

async function putCache(entries) {
  const cache = await getCache();
  const now = Date.now();
  for (const [id, val] of Object.entries(entries)) cache[id] = { ...val, ts: now };
  // prune anything past TTL so local storage does not grow without bound
  for (const [id, val] of Object.entries(cache)) {
    if (!val || !val.ts || now - val.ts > CACHE_TTL_MS) delete cache[id];
  }
  await chrome.storage.local.set({ verdictCache: cache });
}

// ---------------------------------------------------------------- enrichment
// Verified working fields: title, author, channelId, lengthSeconds, viewCount,
// keywords, category, publishDate, shortDescription.
// NOT obtainable: captions/transcripts. YouTube requires a BotGuard proof-of-origin
// token; the timedtext URL carries no `pot` param and returns 0 bytes.

function extractJsonObject(text, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  throw new Error('unbalanced JSON in page');
}

async function enrich(videoId, descChars) {
  const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
    credentials: 'omit'
  });
  if (!res.ok) throw new Error(`watch page HTTP ${res.status}`);
  const html = await res.text();

  const m = html.match(/ytInitialPlayerResponse\s*=\s*/);
  if (!m) throw new Error('no player response (consent wall, bot check, or unavailable)');

  const pr = JSON.parse(extractJsonObject(html, m.index + m[0].length));
  const status = pr?.playabilityStatus?.status;
  if (status && status !== 'OK' && status !== 'LIVE_STREAM_OFFLINE') {
    throw new Error(`playability=${status}`);
  }

  const vd = pr.videoDetails || {};
  const mf = pr?.microformat?.playerMicroformatRenderer || {};
  const desc = (vd.shortDescription || '').replace(/\s+/g, ' ').trim();

  return {
    title: vd.title,
    channel: vd.author,
    channelId: vd.channelId,
    lengthSeconds: vd.lengthSeconds,
    viewCount: vd.viewCount,
    category: mf.category,
    publishDate: (mf.publishDate || '').slice(0, 10),
    keywords: (vd.keywords || []).slice(0, 15),
    description: desc.slice(0, descChars)
  };
}

// ---------------------------------------------------------------- JEV call

async function callJev(payload, apiKey, attempts = 4) {
  let lastErr = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res;
    try {
      res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://localhost/youtube-topic-filter',
          'X-Title': 'YouTube Topic Filter'
        },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      lastErr = `${e.name}: ${e.message}`;
      continue;
    }

    if (res.ok) return { data: await res.json(), error: null };

    const text = await res.text().catch(() => '');
    lastErr = `HTTP ${res.status}: ${text.slice(0, 300)}`;
    // retry only the transient ones; 401/422 are our fault and will not fix themselves
    if ((res.status === 429 || res.status === 529) && attempt < attempts - 1) {
      await new Promise(r => setTimeout(r, 2 ** attempt * 1000 + Math.random() * 750));
      continue;
    }
    return { data: null, error: lastErr };
  }
  return { data: null, error: lastErr };
}

// ---------------------------------------------------------------- classify

async function classifyItems(items, settings) {
  const results = {};
  const cache = await getCache();
  const now = Date.now();

  const todo = [];
  for (const it of items) {
    const hit = cache[it.videoId];
    if (hit && now - hit.ts < CACHE_TTL_MS) results[it.videoId] = { ...hit, cached: true };
    else todo.push(it);
  }

  if (!todo.length) return results;
  if (!settings.apiKey) {
    for (const it of todo) results[it.videoId] = { decision: 'show', topic: null, prob: 0, confidence: 0, error: 'no API key set' };
    return results;
  }

  // enrich in bounded parallel batches, degrading to title+channel on any failure
  const enriched = [];
  for (let i = 0; i < todo.length; i += settings.concurrency) {
    const slice = todo.slice(i, i + settings.concurrency);
    const done = await Promise.all(slice.map(async (it) => {
      if (!settings.enrich) return { ...it };
      try {
        const meta = await enrich(it.videoId, settings.enrichChars);
        return { ...it, ...meta, _enriched: true };
      } catch (e) {
        // keep going with what the feed card gave us
        return { ...it, _enrichError: String(e.message || e) };
      }
    }));
    enriched.push(...done);
  }

  // one request per batch: every question shares the same state
  const size = Math.max(1, settings.maxPerBatch);
  for (let i = 0; i < enriched.length; i += size) {
    const chunk = enriched.slice(i, i + size);
    const payload = {
      model: settings.model || MODEL,
      session_id: `ytfilter-${Date.now()}`,
      state: { videos: chunk.map(strip) },
      questions: buildQuestions(chunk, settings.topics)
    };

    const { data, error } = await callJev(payload, settings.apiKey);
    if (error) {
      for (const it of chunk) {
        results[it.videoId] = { decision: 'show', topic: null, prob: 0, confidence: 0, error };
      }
      await bumpStats({ calls: 1, lastError: error });
      continue;
    }

    const usage = data.usage || {};
    await bumpStats({
      calls: 1,
      inputTokens: Number(usage.input_tokens || 0),
      cost: Number(usage.cost || 0),
      lastError: null
    });

    const answers = data.answers || {};
    const toCache = {};
    chunk.forEach((it, idx) => {
      const v = verdict(answers[`v${idx}`], settings.topics, settings.threshold, settings.reviewBand);
      results[it.videoId] = { ...v, enriched: !!it._enriched, enrichError: it._enrichError || null };
      toCache[it.videoId] = v;
    });
    await putCache(toCache);
  }
  return results;
}

// ---------------------------------------------------------------- messaging

console.info('[TopicFilter] service worker started');

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const settings = await getSettings();
      switch (msg.type) {
        case 'GET_SETTINGS':
          return sendResponse({ settings, hasKey: !!settings.apiKey });

        case 'CLASSIFY': {
          const items = (msg.items || []).filter(x => x && x.videoId);
          if (!settings.enabled) {
            console.info('[TopicFilter] filtering is switched off; ignoring', items.length, 'item(s)');
            return sendResponse({ results: {} });
          }
          console.info(`[TopicFilter] classifying ${items.length} video(s)`,
                       { enrich: settings.enrich, batchSize: settings.maxPerBatch });
          const results = await classifyItems(items, settings);
          console.info('[TopicFilter] decisions', results);
          await bumpStats({ scanned: items.length });
          return sendResponse({ results });
        }

        case 'TEST': {
          const probe = { videoId: 'probe', title: 'Rick Astley - Never Gonna Give You Up (Official Video)', channel: 'Rick Astley' };
          const { data, error } = await callJev({
            model: settings.model || MODEL,
            session_id: `ytfilter-test-${Date.now()}`,
            state: { videos: [probe] },
            questions: buildQuestions([probe], settings.topics)
          }, settings.apiKey);
          if (error) return sendResponse({ ok: false, error });
          return sendResponse({ ok: true, answer: data.answers?.v0, usage: data.usage, model: data.model });
        }

        case 'GET_STATS':
          return sendResponse({ stats: await bumpStats({}) });

        case 'CLEAR_CACHE':
          await chrome.storage.local.set({ verdictCache: {} });
          await chrome.storage.local.set({ stats: { scanned: 0, hidden: 0, review: 0, calls: 0, inputTokens: 0, cost: 0 } });
          return sendResponse({ ok: true });

        case 'RECORD_HIDDEN':
          return sendResponse({ stats: await bumpStats({ hidden: msg.n || 0 }) });

        case 'RECORD_REVIEW':
          return sendResponse({ stats: await bumpStats({ review: msg.n || 0 }) });

        default:
          return sendResponse({ error: `unknown message ${msg.type}` });
      }
    } catch (e) {
      sendResponse({ error: String(e && e.message || e) });
    }
  })();
  return true;   // keep the message channel open for the async response
});
