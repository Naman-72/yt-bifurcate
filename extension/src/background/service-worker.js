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

// ---------------------------------------------------------------- enrichment throttle + breaker
// Bulk watch-page fetches are indistinguishable from a scraper. So: fetch serially, keep a gap
// between requests, and stop the whole lane for a cooldown the moment YouTube bounces us to its
// captcha page. Without this, every card in the viewport fires a request at once and Google
// starts serving /sorry/index to every one of them.

const BLOCK_COOLDOWN_MS = 6 * 60 * 60 * 1000;
let lastEnrichAt = 0;
let blockCache = { at: 0, until: 0 };

async function getBlockedUntil() {
  if (Date.now() - blockCache.at < 30000) return blockCache.until;
  const { enrichBlockedUntil } = await chrome.storage.local.get('enrichBlockedUntil');
  blockCache = { at: Date.now(), until: enrichBlockedUntil || 0 };
  return blockCache.until;
}

async function tripBreaker(reason) {
  const until = Date.now() + BLOCK_COOLDOWN_MS;
  blockCache = { at: Date.now(), until };
  await chrome.storage.local.set({ enrichBlockedUntil: until, enrichBlockedReason: reason });
  await bumpStats({ enrichPaused: true, lastError: 'enrichment paused: ' + reason });
}

async function throttleEnrich() {
  const gap = 900 + Math.random() * 500;
  const wait = Math.max(0, lastEnrichAt + gap - Date.now());
  lastEnrichAt = Date.now() + wait;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
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
  // redirect:'manual' surfaces YouTube's captcha bounce as a detectable opaqueredirect
  // instead of an opaque CORS failure, so we can back off rather than retry it.
  const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
    credentials: 'omit',
    redirect: 'manual'
  });
  if (res.type === 'opaqueredirect' || res.status === 0) {
    await tripBreaker('YouTube returned a captcha redirect');
    throw new Error('blocked by YouTube (captcha redirect)');
  }
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
          'HTTP-Referer': 'https://localhost/yt-improve',
          'X-Title': 'YT-Improve'
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

  // Serialised, gapped, and interruptible. Off-screen cards and anything the breaker cuts off
  // still get classified — just on the title and channel the listing already gave us.
  const enriched = [];
  for (const it of todo) {
    const base = { ...it };
    const skip = !settings.enrich || it.inView === false || Date.now() < (await getBlockedUntil());
    if (skip) { enriched.push(base); continue; }
    try {
      await throttleEnrich();
      const meta = await enrich(it.videoId, settings.enrichChars);
      enriched.push({ ...base, ...meta, _enriched: true });
    } catch (e) {
      enriched.push({ ...base, _enrichError: String(e.message || e) });
    }
  }

  // one request per batch: every question shares the same state
  const size = Math.max(1, settings.maxPerBatch);
  for (let i = 0; i < enriched.length; i += size) {
    const chunk = enriched.slice(i, i + size);
    const payload = {
      model: settings.model || MODEL,
      session_id: `ytimprove-${Date.now()}`,
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

console.info('[YT-Improve] service worker started');

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
            console.info('[YT-Improve] filtering is switched off; ignoring', items.length, 'item(s)');
            return sendResponse({ results: {} });
          }
          const results = await classifyItems(items, settings);
          await bumpStats({ scanned: items.length });
          const nHide = Object.values(results).filter(r => r.decision === 'hide').length;
          console.info(`[YT-Improve] ${items.length} classified, ${nHide} to block`,
                       settings.enrich ? '(metadata fetch on)' : '(title + channel only)');
          const until = await getBlockedUntil();
          return sendResponse({ results, enrichPausedUntil: until > Date.now() ? until : 0 });
        }

        case 'TEST': {
          const probe = { videoId: 'probe', title: 'Rick Astley - Never Gonna Give You Up (Official Video)', channel: 'Rick Astley' };
          const { data, error } = await callJev({
            model: settings.model || MODEL,
            session_id: `ytimprove-test-${Date.now()}`,
            state: { videos: [probe] },
            questions: buildQuestions([probe], settings.topics)
          }, settings.apiKey);
          if (error) return sendResponse({ ok: false, error });
          return sendResponse({ ok: true, answer: data.answers?.v0, usage: data.usage, model: data.model });
        }

        case 'GET_STATS':
          return sendResponse({ stats: await bumpStats({}) });

        case 'CLEAR_BLOCK':
          blockCache = { at: Date.now(), until: 0 };
          await chrome.storage.local.remove(['enrichBlockedUntil', 'enrichBlockedReason']);
          return sendResponse({ ok: true });

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
