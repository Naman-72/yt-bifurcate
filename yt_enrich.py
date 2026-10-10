#!/usr/bin/env python3
"""
Fetches per-video metadata from a YouTube watch page for use as JEV `state`.

Verified working fields (no poToken needed): title, author, channelId, lengthSeconds,
viewCount, keywords, category, publishDate, shortDescription.

NOT obtainable this way: transcripts/captions. YouTube requires a BotGuard proof-of-origin
token; the timedtext URL it hands out has no `pot` param and returns 0 bytes. See notes.md.

This is the Python reference for the same logic the extension runs in its service worker.
"""

import argparse, json, os, re, sys, time, gzip, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_PATH = os.path.join(HERE, ".enrich_cache.json")


def _get(url, timeout=25):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return raw.decode("utf-8", "replace")


def enrich(video_id, desc_chars=600, keyword_cap=15):
    """Return a metadata dict for one video, or {'error': ...}."""
    out = {"videoId": video_id}
    try:
        t0 = time.perf_counter()
        html = _get(f"https://www.youtube.com/watch?v={video_id}")
        m = re.search(r"ytInitialPlayerResponse\s*=\s*", html)
        if not m:
            return {"videoId": video_id, "error": "no player response (consent wall or unavailable)"}
        pr, _ = json.JSONDecoder().raw_decode(html[m.end():])
    except urllib.error.HTTPError as e:
        return {"videoId": video_id, "error": f"HTTP {e.code}"}
    except Exception as e:
        return {"videoId": video_id, "error": f"{type(e).__name__}: {e}"}

    vd = pr.get("videoDetails") or {}
    mf = (pr.get("microformat") or {}).get("playerMicroformatRenderer") or {}
    status = (pr.get("playabilityStatus") or {}).get("status")

    if status and status not in ("OK", "LIVE_STREAM_OFFLINE"):
        return {"videoId": video_id, "error": f"playability={status}"}

    desc = (vd.get("shortDescription") or "").replace("\n", " ").strip()
    out.update({
        "title":        vd.get("title"),
        "channel":      vd.get("author"),
        "channelId":    vd.get("channelId"),
        "lengthSeconds": vd.get("lengthSeconds"),
        "viewCount":    vd.get("viewCount"),
        "category":     mf.get("category"),          # YouTube's own label: Music / Comedy / News & Politics / ...
        "publishDate":  (mf.get("publishDate") or "")[:10],
        "keywords":     (vd.get("keywords") or [])[:keyword_cap],
        "description":  desc[:desc_chars],
    })
    out["_desc_total_chars"] = len(desc)
    out["_fetch_ms"] = round((time.perf_counter() - t0) * 1000)
    return out


def _fallback(vid, originals):
    """Enrichment failed -> fall back to what the feed card already gave us."""
    card = (originals or {}).get(vid) or {}
    out = {"videoId": vid, "_enrich_error": True}
    for k in ("title", "channel"):
        if card.get(k):
            out[k] = card[k]
    return out


def enrich_many(ids, workers=3, desc_chars=600, keyword_cap=15, use_cache=True, originals=None):
    cache = {}
    if use_cache and os.path.exists(CACHE_PATH):
        try:
            cache = json.load(open(CACHE_PATH, encoding="utf-8"))
        except Exception:
            cache = {}

    todo = [i for i in ids if i not in cache]
    results = {i: cache[i] for i in ids if i in cache}
    print(f"cache hits: {len(ids)-len(todo)}/{len(ids)}   fetching: {len(todo)}")

    if todo:
        t0 = time.perf_counter()
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = {ex.submit(enrich, i, desc_chars, keyword_cap): i for i in todo}
            for n, f in enumerate(as_completed(futs), 1):
                vid = futs[f]
                try:
                    results[vid] = f.result()
                except Exception as e:
                    results[vid] = {"videoId": vid, "error": f"{type(e).__name__}: {e}"}
                r = results[vid]
                mark = "ERR " if r.get("error") else "ok  "
                print(f"  [{n}/{len(todo)}] {mark}{vid}  {str(r.get('category') or r.get('error'))[:28]:28s} "
                      f"{str(r.get('title'))[:44]}")
        print(f"fetch wall clock: {(time.perf_counter()-t0)*1000:.0f} ms for {len(todo)} videos "
              f"(concurrency {workers})")
        if use_cache:
            cache.update({k: v for k, v in results.items() if not v.get("error")})
            json.dump(cache, open(CACHE_PATH, "w", encoding="utf-8"), indent=1)

    # never hand the model an error stub; degrade to the card's own title/channel instead
    final = []
    for i in ids:
        r = results[i]
        if r.get("error") or r.get("_enrich_error"):
            fb = _fallback(i, originals)
            fb["_enrich_error_detail"] = r.get("error")
            final.append(fb)
        else:
            final.append(r)
    return final


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", help="comma-separated videoIds")
    ap.add_argument("--batch-file", help="JSON list of {videoId:...} to enrich in place")
    ap.add_argument("--out", default=os.path.join(HERE, "enriched_batch.json"))
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--desc-chars", type=int, default=600)
    a = ap.parse_args()

    originals = None
    if a.batch_file:
        items = json.load(open(a.batch_file, encoding="utf-8"))
        ids = [i["videoId"] for i in items]
        originals = {i["videoId"]: i for i in items}
    elif a.ids:
        ids = [i.strip() for i in a.ids.split(",") if i.strip()]
    else:
        print("need --ids or --batch-file"); return 1

    full = enrich_many(ids, workers=a.workers, desc_chars=a.desc_chars, originals=originals)
    json.dump(full, open(a.out, "w", encoding="utf-8"), indent=2, ensure_ascii=False)

    clean = [f for f in full if not f.get("error") and not f.get("_enrich_error")]
    fell  = [f for f in full if f.get("_enrich_error")]
    print(f"\nwrote {a.out}: {len(clean)} enriched, {len(fell)} fell back to card title/channel, "
          f"{len(full)-len(clean)-len(fell)} hard-failed")
    if clean:
        tot = sum(len(json.dumps(f, ensure_ascii=False)) for f in clean) / 4
        print(f"state cost: ~{tot/len(clean):.0f} tokens/video  (~{tot:.0f} tokens for {len(clean)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
