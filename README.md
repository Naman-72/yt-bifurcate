# YT-Improve

Reads each video's metadata from your YouTube feed, sidebar and search results, asks
[JEV](https://openrouter.ai/typesafe/jev-1.13) (a typed decision model, served through
OpenRouter) which of **your** topics the video belongs to, and removes the matches.

You define the topics. You supply the OpenRouter key. Nothing else is needed.

---

## Layout

```
OpenRouter-Project/
  extension/                     <- load THIS folder into Chrome
    manifest.json
    src/background/service-worker.js   JEV client, enrichment, cache, queue
    src/content/youtube.js             card scraping, removal, review badges
    src/content/youtube.css
    src/options/options.html|js|css    topics, key, thresholds, stats
    src/popup/popup.html|js            on/off, counters, reveal
    src/shared/defaults.js             defaults + question builder + verdict rule

  m0_jev_test.py                 offline harness: classify a batch, measure latency/cost
  yt_enrich.py                   Python reference for the enrichment the extension does
  feed_batch.json                your test batch (videoId/title/channel)
  enriched_batch.json            the same batch with category/keywords/description
  m0_results_*.csv               harness output, incl. an empty `my_label` column
```

---

## Install (Chrome / Edge / Brave)

There is no "upload" step for personal use, and none is needed. You load the folder
directly, unpacked.

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder — the one containing `manifest.json`

It appears as **YT-Improve** with a puzzle-piece icon.
No icons ship with it, so Chrome uses its default; that is expected.

Then click the extension's **Details → Extension options** (or right-click the toolbar
icon → Options) and continue below.

### If you ever want it in the Chrome Web Store
That is a different path with a one-time $5 developer fee and a review queue. It is not
required, and it is not recommended for this build: the extension fetches watch pages in
bulk, which is a grey area, and store review may object. Load unpacked is the right call.

---

## First run

1. **OpenRouter key** — paste your `sk-or-...` key into section 1 and hit **Test connection**.
   It makes one real call and reports `ok — choice=... conf=...`.
   The key is stored in `chrome.storage.local`: this browser profile only, not synced to
   your Google account, never in the source, never logged, sent only to openrouter.ai.
2. **Topics** — one row per topic, each with a description. The description *is* the
   model's definition of the category, so it does real work. Vague in, vague out.
3. **Thresholds** — default hides at probability ≥ 0.55 and shows a badge between 0.40 and 0.55.
   Calibrate these from the `m0_results_*.csv` file, not from a round number.
4. **Where to run** — home feed / watch sidebar / search results.
5. **Save**, then **reload your YouTube tab**. Content scripts only attach on page load.

Open the toolbar popup for the master on/off switch, the counters, and
**Reveal hidden videos**.

---

## Why the threshold should be low

A missed hide means you see one video you did not want. A wrong hide means a video you
wanted silently disappeared. Those are not equally bad, and JEV's own docs are explicit
that `confidence` "describes the distribution of the alternatives, not whether the
workflow is safe to run" — so pick thresholds from the cost of each mistake. The review
band exists so uncertain cases are visible and flagged rather than silently guessed at.

---

## Measuring before trusting it

`m0_jev_test.py` runs the same decision on a batch of videos, outside the browser:

```bash
cp sample_batch.json feed_batch.json       # then replace with your own ~9 videos
python3 yt_enrich.py --batch-file feed_batch.json --out enriched_batch.json
python3 m0_jev_test.py --batch-file enriched_batch.json --dry-run   # prints the payload, costs nothing
python3 m0_jev_test.py --batch-file enriched_batch.json --yes       # real calls
python3 m0_jev_test.py --batch-file enriched_batch.json --yes --mode single   # 1 call/video, to compare
```

It retries only 429/529, fails open to "show" on any malformed or failed batch, and writes
`m0_results_<mode>.csv` with every probability and an empty `my_label` column. Fill that
column in by hand, and you have a labelled set for tuning.

The API key is read from `.env` (`OPENROUTER_API_KEY=sk-or-...`), never echoed.

---

## Measured behaviour

Cost is a non-issue; latency and bandwidth are the real constraints.

| | per video | 9-video screenful |
|---|---|---|
| state, title+channel | ~31 tokens | ~299 tokens |
| state, enriched | ~234 tokens | ~2,410 tokens |
| JEV call | 1 request per screenful | ~$0.0001 |
| watch-page fetch | ~1.4 MB, 0.6–1.1 s | ~13 MB, ~3 s at concurrency 3 |

Batching saves round trips, **not** tokens: the criteria block is ~136 tokens and repeats
inside every question, while a video of metadata is only ~31. Use one question per video and
eat the ~7%; the alternative (one question per topic) saves ~42% but can only ever return one
video per topic, which is wrong for a filter that needs recall.

---

## Known limits, honestly

- **Transcripts are not available.** YouTube requires a BotGuard proof-of-origin token;
  the caption URL it hands out carries no `pot` param and returns HTTP 200 with 0 bytes
  across every format and every video tried. The InnerTube `/player` endpoint with the
  ANDROID and IOS clients returns HTTP 400, and the embedded TV client returns
  `playability=ERROR`. Unlocking transcripts means minting a poToken in-extension — a
  separate project.
- **Enrichment is per-viewport, not per-feed.** Each video costs one ~1.4 MB watch-page
  fetch. Results are cached by videoId for 7 days, so repeat views are free.
- **Bulk watch-page fetches are a grey area** with YouTube's terms. Cached, viewport-gated
  and concurrency-capped keeps it modest, but it is not invisible.
- **Selectors will break.** YouTube changes its DOM regularly. All of them live in
  `CARD_SEL` and `cardInfo()` in `src/content/youtube.js`.
- **Removing cards is re-applied, not one-shot.** The feed is virtualized and recycles
  renderers, so a bare `.remove()` leaks the card back on the next render. Hidden ids are
  kept in a Set and re-removed on every mutation tick instead.
- **Shorts are skipped** unless the card exposes a real title.

---

## Troubleshooting

| symptom | cause |
|---|---|
| Nothing happens at all | Tab was open before install — reload it. Check the popup says filtering is on. |
| `no API key set` in the console | Save the key in options, then reload the tab. |
| `Test connection` fails with 401 | Key is wrong or revoked. |
| Everything is hidden | Threshold too low, or topic descriptions too broad. Raise it and tighten the wording. |
| Nothing is hidden | Check the cards are being seen: `chrome://extensions` → Details → **service worker** → console. |
| Cards flash then come back | MutationObserver re-apply is racing the feed; raise the debounce in `scheduleScan`. |

Debugging: `chrome://extensions` → Details → **service worker** (background logs) and
**Errors**, plus the normal DevTools console on the YouTube tab (content script logs).
