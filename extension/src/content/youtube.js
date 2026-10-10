// Content script: finds video cards, reads their metadata, asks the service worker
// for a verdict, and removes the ones you asked to filter out.
//
// Content scripts cannot use ES modules, so everything here is self-contained and
// settings arrive over messaging.

(() => {
  'use strict';

  // Shown on the page. If you cannot see this strip, this script is not running.
  const VERSION = '0.2.0';

  const CARD_SEL = [
    'ytd-rich-item-renderer',        // home feed
    'ytd-video-renderer',            // search results
    'ytd-compact-video-renderer',    // watch-page sidebar
    'ytd-grid-video-renderer',       // legacy grid
    'ytd-rich-grid-media',           // inner media wrapper on the home grid
    'ytd-playlist-video-renderer',   // playlist pages
    'yt-lockup-view-model'           // newer YouTube lockup component
  ].join(', ');

  // Used only when CARD_SEL matches nothing at all.
  const FALLBACK_CONTAINER =
    'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ' +
    'ytd-rich-grid-media, yt-lockup-view-model, ytd-playlist-video-renderer, yt-lockup-metadata-view-model';

  const seen = new Set();        // videoIds already sent for classification
  const hidden = new Set();      // videoId -> decided hide
  const reviewed = new Map();    // videoId -> topic
  let settings = null;
  let queue = [];
  let flushTimer = null;
  let scanTimer = null;
  let warnedNoKey = false;
  let firstScanDone = false;
  let lastCardCount = 0;
  let lastDiagSig = '';
  let emptyScans = 0;
  let probeDone = false;

  // ------------------------------------------------------------ metadata

  // YouTube ships two card layouts: the older Polymer one (#video-title) and the newer
  // lockup view model (.yt-lockup-metadata-view-model__title). Try both, then fall back to
  // the link's own accessible text and finally the thumbnail's alt attribute, which YouTube
  // sets to the video title.
  function titleOf(el) {
    const direct = el.querySelector(
      '#video-title-link, #video-title, ' +
      '.yt-lockup-metadata-view-model__title, .yt-lockup-metadata-view-model-wiz__title, ' +
      'a.yt-lockup-metadata-view-model__title, h3'
    );
    const t = direct ? (direct.textContent || '').trim() : '';
    if (t) return t;

    const a = el.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');
    if (a) {
      const attr = (a.getAttribute('title') || a.getAttribute('aria-label') || '').trim();
      if (attr) return attr;
      const txt = (a.textContent || '').trim();
      if (txt) return txt;
    }
    const img = el.querySelector('img[alt]');
    const alt = img ? (img.getAttribute('alt') || '').trim() : '';
    return alt.length > 1 ? alt : '';
  }

  function channelOf(el) {
    const c = el.querySelector(
      'ytd-channel-name #text, ytd-channel-name a, #channel-name #text, #channel-name a, ' +
      'a[href^="/@"], a[href*="/channel/"], yt-content-metadata-view-model span'
    );
    return c ? (c.textContent || '').trim() : '';
  }

  function cardInfo(el) {
    const a = el.querySelector('a#thumbnail[href]')
           || el.querySelector('a[href*="/watch?v="]')
           || el.querySelector('a[href*="/shorts/"]');
    if (!a) return null;
    const href = a.getAttribute('href') || '';
    const m = href.match(/[?&]v=([A-Za-z0-9_-]{11})/) || href.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
    if (!m) return null;

    const title = titleOf(el);
    if (!title) return null;

    return { videoId: m[1], title, channel: channelOf(el), node: el };
  }

  function activeSurface() {
    const p = location.pathname;
    if (p === '/watch') return 'watchSidebar';
    if (p.startsWith('/results') || p.startsWith('/@')) return 'search';
    if (p === '/' || p.startsWith('/feed')) return 'home';
    return null;
  }

  function keywordHit(info, kws) {
    if (!kws || !kws.length) return null;
    const hay = `${info.title} ${info.channel}`.toLowerCase();
    for (const kw of kws) if (hay.includes(kw)) return kw;
    return null;
  }

  // ------------------------------------------------------------ actions

  function removeCard(el, id, reason) {
    el.style.display = 'none';
    el.setAttribute('data-tv-hidden', reason || 'topic');
    // YouTube's feed is virtualized and recycles renderers, so a plain .remove() leaks
    // the card back on the next render. Keep the id and re-apply on every scan instead.
    if (el.parentNode) el.remove();
  }

  function applyReviewBadge(el, id) {
    if (el.querySelector('.tv-badge')) return;
    const topic = reviewed.get(id);
    if (!topic) return;
    const badge = document.createElement('div');
    badge.className = 'tv-badge';
    badge.textContent = `possibly ${topic}`;
    badge.title = 'Topic Filter: uncertain match, not hidden';
    (el.querySelector('#dismissible') || el).prepend(badge);
  }

  function markHidden(id, topic) {
    if (hidden.has(id)) return;
    hidden.add(id);
    console.info(`[TopicFilter] removed ${id} (${topic || 'keyword'})`);
    chrome.runtime.sendMessage({ type: 'RECORD_HIDDEN', n: 1 }).catch(() => {});
  }

  function revealAll() {
    hidden.clear();
    reviewed.clear();
    seen.clear();
    document.querySelectorAll('[data-tv-hidden]').forEach(el => {
      el.style.display = '';
      el.removeAttribute('data-tv-hidden');
    });
    document.querySelectorAll('.tv-badge').forEach(b => b.remove());
    queue = [];
  }
  window.addEventListener('tv-reveal', revealAll);

  // ------------------------------------------------------------ diagnostics

  function discoverCards() {
    const direct = [...document.querySelectorAll(CARD_SEL)];
    if (direct.length) {
      // Some card selectors nest inside others, so the same video would be counted twice.
      // Keep the outermost element of any nested pair.
      const set = new Set(direct);
      const outer = direct.filter(el => {
        for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
        return true;
      });
      return { cards: outer, mode: 'selector' };
    }
    // YouTube ships DOM redesigns often. Walk up from any watch link instead.
    const seen = new Set(), out = [];
    for (const a of document.querySelectorAll('a[href*="/watch?v="], a[href*="/shorts/"]')) {
      const c = a.closest(FALLBACK_CONTAINER);
      if (c && !seen.has(c)) { seen.add(c); out.push(c); }
    }
    return { cards: out, mode: out.length ? 'fallback' : 'none' };
  }

  // Reports which part of cardInfo() rejects an element, for the first-scan sample.
  function explainCard(el) {
    const a = el.querySelector('a#thumbnail[href]')
           || el.querySelector('a[href*="/watch?v="]')
           || el.querySelector('a[href*="/shorts/"]');
    const href = a ? (a.getAttribute('href') || '') : '';
    const vid = href.match(/[?&]v=([A-Za-z0-9_-]{11})/) || href.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
    const title = titleOf(el);
    return {
      tag: el.tagName.toLowerCase(),
      link: a ? (href.slice(0, 42) || 'EMPTY HREF') : 'NO LINK',
      vid: vid ? 'ok' : 'NO VIDEOID',
      title: title ? title.slice(0, 42) : 'NO TITLE FOUND'
    };
  }

  // "What did YouTube actually serve me?" - a tally of every custom element on the page.
  function domProbe() {
    const counts = {};
    for (const el of document.querySelectorAll('*')) {
      const t = el.tagName.toLowerCase();
      if (t.includes('-')) counts[t] = (counts[t] || 0) + 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14)
      .map(([t, n]) => `${t}:${n}`)
      .join(' ');
  }

  function paintChip(extra) {
    let chip = document.getElementById('tv-chip');
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'tv-chip';
      (document.body || document.documentElement).appendChild(chip);
    }
    const why = (extra && extra.reason) ? ` — ${extra.reason}` : '';
    chip.textContent =
      `TopicFilter v${VERSION} · ${activeSurface() || 'other page'} · ` +
      `${lastCardCount} cards · ${hidden.size} hidden${why}`;
  }

  // Written to storage so the popup can show it without DevTools.
  function reportDiag(extra) {
    const d = Object.assign({
      at: Date.now(),
      path: location.pathname,
      surface: activeSurface(),
      cards: lastCardCount,
      hidden: hidden.size,
      review: reviewed.size,
      queued: queue.length
    }, extra || {});
    const sig = JSON.stringify(Object.assign({}, d, { at: 0 }));
    paintChip(extra);
    if (sig === lastDiagSig) return;
    lastDiagSig = sig;
    try { chrome.storage.local.set({ diag: d }); } catch (_) {}
  }

  // ------------------------------------------------------------ scanning

  function scan() {
    if (!settings) return;
    if (!settings.enabled) return reportDiag({ reason: 'filtering is switched off' });
    const surf = activeSurface();
    if (!surf) return reportDiag({ reason: `unsupported page: ${location.pathname}` });
    if (!settings.surfaces[surf]) return reportDiag({ reason: `surface "${surf}" is unticked in options` });
    if (!settings.apiKey && !warnedNoKey) {
      warnedNoKey = true;
      console.warn('[TopicFilter] no OpenRouter API key set — open the extension options');
    }

    const kws = (settings.localKeywords || '')
      .split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);

    const { cards, mode } = discoverCards();
    lastCardCount = cards.length;
    if (cards.length) {
      emptyScans = 0;
      if (!firstScanDone) {
        firstScanDone = true;
        console.warn(`[TopicFilter] card discovery on ${surf}: ${cards.length} element(s) via ${mode}`);
        const sample = cards.slice(0, 3).map(explainCard);
        console.warn('[TopicFilter] first cards look like:', sample);
        reportDiag({ sample: JSON.stringify(sample) });
      }
    } else {
      // The feed renders asynchronously, so an empty FIRST scan is normal, not a failure.
      // Only complain after several attempts, and then report what the DOM really holds.
      emptyScans++;
      if (emptyScans === 5 && !probeDone) {
        probeDone = true;
        const probe = domProbe();
        console.warn(`[TopicFilter] no video cards after ${emptyScans} scans on ${surf}`);
        console.warn('[TopicFilter] custom elements present in the DOM:', probe);
        console.warn('[TopicFilter] CARD_SEL =', CARD_SEL);
        reportDiag({ reason: 'no video cards found — selectors may be stale', probe, mode });
      }
    }

    const batch = [];
    for (const el of cards) {
      const info = cardInfo(el);
      if (!info) continue;

      // already decided: re-apply, because the DOM may have re-rendered
      if (hidden.has(info.videoId)) { removeCard(el, info.videoId); continue; }
      if (reviewed.has(info.videoId)) { applyReviewBadge(el, info.videoId); continue; }
      if (seen.has(info.videoId)) continue;

      // free instant path: local keywords never touch the API
      const hit = keywordHit(info, kws);
      if (hit) {
        markHidden(info.videoId, hit);
        removeCard(el, info.videoId, 'keyword');
        continue;
      }

      seen.add(info.videoId);
      el.setAttribute('data-tv-id', info.videoId);
      batch.push({ videoId: info.videoId, title: info.title, channel: info.channel });
    }

    if (batch.length) {
      console.warn(`[TopicFilter] ${batch.length} new video(s) queued from ${surf}`);
      queue.push(...batch);
      scheduleFlush();
    }
    reportDiag({ mode, batch: batch.length });
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 500);
  }

  async function flush() {
    flushTimer = null;
    if (!queue.length || !settings || !settings.apiKey) {
      if (queue.length && settings && !settings.apiKey) {
        console.warn(`[TopicFilter] dropping ${queue.length} video(s): no API key saved in options`);
      }
      queue = [];
      return;
    }
    const batch = queue.splice(0, queue.length);

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'CLASSIFY', items: batch });
    } catch (e) {
      console.warn('[TopicFilter] classify failed', e);
      return;
    }
    if (!resp || !resp.results) return;

    let nReview = 0;
    for (const [videoId, v] of Object.entries(resp.results)) {
      if (v.error) { console.warn('[TopicFilter]', videoId, v.error); continue; }
      if (v.decision === 'hide') {
        markHidden(videoId, v.topic);
        document.querySelectorAll(`[data-tv-id="${videoId}"]`).forEach(el => removeCard(el, videoId));
      } else if (v.decision === 'review') {
        reviewed.set(videoId, v.topic);
        nReview++;
        document.querySelectorAll(`[data-tv-id="${videoId}"]`).forEach(el => applyReviewBadge(el, videoId));
      }
    }
    if (nReview) chrome.runtime.sendMessage({ type: 'RECORD_REVIEW', n: nReview }).catch(() => {});
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 400);
  }

  // ------------------------------------------------------------ lifecycle

  // React to settings changes and reveal requests without needing the tabs permission:
  // the popup and options page just write to storage and everyone else notices.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.revealRequest) { revealAll(); return; }
    if (changes.settings) {
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }).then(r => {
        settings = r.settings;
        scheduleScan();
      }).catch(() => {});
    }
  });

  (async function start() {
    console.warn('[TopicFilter] content script injected at', location.pathname);
    try {
      const r = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      settings = r.settings;
    } catch (e) {
      console.error('[TopicFilter] could not reach the service worker — is the extension enabled?', e);
      return;
    }
    console.warn('[TopicFilter] settings', {
      enabled: settings.enabled,
      hasKey: !!settings.apiKey,
      topics: (settings.topics || []).map(t => t.name),
      surfaces: settings.surfaces,
      threshold: settings.threshold,
      enrich: settings.enrich
    });

    scan();
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true, subtree: true
    });
    // YouTube is a single-page app: re-scan when the route settles
    document.addEventListener('yt-navigate-finish', () => { seen.clear(); scheduleScan(); });
    window.addEventListener('yt-page-data-updated', scheduleScan);
  })();
})();
