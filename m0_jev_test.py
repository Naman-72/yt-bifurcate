#!/usr/bin/env python3
"""
M0 harness for the YouTube topic-filter extension.

Tests the JEV decisions endpoint against a batch of videos, so we can measure
  - accuracy   (do the verdicts match your labels?)
  - latency    (is it fast enough to hide cards while scrolling?)
  - cost       (input tokens are the only billed unit; output is free)
  - batching   (one request for N videos vs N requests) <- the key question

Reads the API key from .env (never printed, never sent anywhere but OpenRouter).

Usage
  python3 m0_jev_test.py --dry-run                 # print the payload, spend nothing
  python3 m0_jev_test.py                           # one batched call for the whole feed batch
  python3 m0_jev_test.py --mode single             # one call per video, for comparison
  python3 m0_jev_test.py --topics politics,music,movies,comedy --threshold 0.5
"""

import argparse
import csv
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request

ENDPOINT = "https://openrouter.ai/api/alpha/decisions"
MODEL = "typesafe/jev-1.13"          # pinned on purpose: the ~latest alias moves and breaks tuned thresholds
HERE = os.path.dirname(os.path.abspath(__file__))

# Default criteria text. Better descriptions -> better calibration.
# These do real work: they are the model's entire definition of each category.
TOPIC_DESCRIPTIONS = {
    "politics": "Government, elections, political parties, policy, political commentary, "
                "political debate or political news coverage",
    "music": "Songs, music videos, albums, artists, bands, concerts, music production, "
             "instrumentals or music reviews",
    "movies": "Films, cinema, movie trailers, movie reviews, actors, directors, TV series, "
              "anime or streaming shows",
    "comedy": "Stand-up comedy, sketches, pranks, funny compilations, memes, roasts or "
              "humorous entertainment",
}
NONE_DESCRIPTION = "Does not clearly belong to any of the listed categories."


def load_env(path):
    """Minimal .env parser. Returns a dict; never logs values."""
    env = {}
    if not os.path.exists(path):
        return env
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def describe_fields(videos):
    """Phrase the instruction around whatever metadata we actually have."""
    v = videos[0] if videos else {}
    names = []
    if v.get("title"):       names.append("title")
    if v.get("channel"):     names.append("channel name")
    if v.get("category"):    names.append("YouTube's own category label")
    if v.get("keywords"):    names.append("keywords")
    if v.get("description"): names.append("description")
    if not names:
        return "title and channel name"
    if len(names) == 1:
        return names[0]
    return ", ".join(names[:-1]) + " and " + names[-1]


def build_questions(topics, n_videos, fields="title and channel name"):
    """One choice question per video, each pinned to its own state path."""
    criteria = {t: TOPIC_DESCRIPTIONS.get(t, f"Content primarily about {t}") for t in topics}
    criteria["none"] = NONE_DESCRIPTION

    questions = {}
    for i in range(n_videos):
        questions[f"v{i}"] = {
            "type": "choice",
            "instructions": (
                f"Consider only `videos[{i}]` in the state. "
                f"Which single category best describes that YouTube video, judged from its {fields}? "
                "If it does not clearly belong to any listed category, choose none. "
                "Do not let the other videos in the state influence this answer."
            ),
            "criteria": criteria,
        }
    return questions


def sanitize(videos):
    """Drop bookkeeping keys (leading underscore) so they never reach the model."""
    return [{k: v for k, v in vid.items() if not k.startswith("_")} for vid in videos]


def build_payload_batch(videos, topics, session_id):
    return {
        "model": MODEL,
        "session_id": session_id,
        "state": {"videos": sanitize(videos)},
        "questions": build_questions(topics, len(videos), describe_fields(videos)),
    }


def build_payload_single(videos, topics, session_id):
    return {  # caller sends one of these per video, with its own state
        "model": MODEL,
        "session_id": session_id,
        "state": {"videos": sanitize(videos)},
        "questions": build_questions(topics, 1, describe_fields(videos)),
    }


def post(payload, api_key, attempts=4):
    """POST with retry on 429/529 only. 401/422 are our fault and are never retried."""
    body = json.dumps(payload).encode("utf-8")
    last = None
    for attempt in range(attempts):
        req = urllib.request.Request(
            ENDPOINT,
            data=body,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                # optional but recommended by OpenRouter for attribution/rankings
                "HTTP-Referer": "https://localhost/youtube-topic-filter",
                "X-Title": "YouTube Topic Filter",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8")), None
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            last = f"HTTP {e.code}: {detail[:500]}"
            if e.code in (429, 529) and attempt < attempts - 1:
                backoff = (2 ** attempt) + random.uniform(0, 0.75)
                time.sleep(backoff)
                continue
            return None, last
        except Exception as e:                                   # network / timeout
            last = f"{type(e).__name__}: {e}"
            if attempt < attempts - 1:
                time.sleep((2 ** attempt) + random.uniform(0, 0.75))
                continue
            return None, last
    return None, last


def verdict_from_answer(answer, topics, threshold):
    """Return (decision, topic, max_prob, confidence). Decision is hide|review|show."""
    if not isinstance(answer, dict) or answer.get("type") != "choice":
        return "show", None, 0.0, 0.0                      # unexpected shape -> fail open
    probs = answer.get("probabilities") or {}
    conf = answer.get("confidence")
    conf = float(conf) if isinstance(conf, (int, float)) else 0.0
    if not probs:
        return "show", None, 0.0, conf

    best_topic, best_p = None, 0.0
    for t in topics:
        p = float(probs.get(t, 0) or 0)
        if p > best_p:
            best_topic, best_p = t, p

    if best_p >= threshold:
        decision = "hide"
    elif best_p >= threshold - 0.15:
        decision = "review"                                # uncertain band, do not guess
    else:
        decision = "show"
    return decision, best_topic, best_p, conf


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch-file", default=os.path.join(HERE, "feed_batch.json"))
    ap.add_argument("--env-file", default=os.path.join(HERE, ".env"))
    ap.add_argument("--mode", choices=["batch", "single"], default="batch")
    ap.add_argument("--threshold", type=float, default=0.55)
    ap.add_argument("--limit", type=int, default=9, help="videos per request (batch mode)")
    ap.add_argument("--topics", default="politics,music,movies,comedy")
    ap.add_argument("--dry-run", action="store_true", help="print the payload and exit (no API call)")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation prompt for real calls")
    args = ap.parse_args()

    topics = [t.strip() for t in args.topics.split(",") if t.strip()]

    if not os.path.exists(args.batch_file):
        print(f"ERROR: no batch file at {args.batch_file}")
        print("Expected a JSON list like: [{\"videoId\":\"...\",\"title\":\"...\",\"channel\":\"...\"}, ...]")
        return 1
    with open(args.batch_file, encoding="utf-8") as fh:
        videos = json.load(fh)
    if not isinstance(videos, list) or not videos:
        print("ERROR: batch file must be a non-empty JSON list")
        return 1
    videos = videos[: args.limit]
    usable = [v for v in videos if not v.get("error")]
    if len(usable) < len(videos):
        print(f"WARNING: dropping {len(videos)-len(usable)} video(s) with no usable metadata "
              f"(fail open -> show)")
        for v in videos:
            if v.get("error"):
                print(f"   - {v.get('videoId')}: {v['error']}")
    videos = usable
    if not videos:
        print("ERROR: nothing usable to classify")
        return 1
    print(f"loaded {len(videos)} usable videos from {os.path.basename(args.batch_file)}")
    print(f"topics: {', '.join(topics)}   threshold: {args.threshold}   mode: {args.mode}")

    if args.dry_run:
        payload = (build_payload_batch(videos, topics, "dry-run") if args.mode == "batch"
                   else build_payload_single(videos[:1], topics, "dry-run"))
        print("\n--- payload (nothing sent) ---")
        print(json.dumps(payload, indent=2)[:4000])
        print(f"\n--- payload size: {len(json.dumps(payload))} chars, "
              f"~{len(json.dumps(payload))//4} tokens ---")
        return 0

    env = load_env(args.env_file)
    api_key = env.get("OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        print(f"ERROR: OPENROUTER_API_KEY not found in {args.env_file} or the environment.")
        print("Create the file with one line:  OPENROUTER_API_KEY=sk-or-...")
        return 1
    print(f"key loaded: {len(api_key)} chars, starts with {api_key[:7]}... (not printed in full)")

    if not args.yes:
        print("\nAbout to make REAL billed calls. Re-run with --yes to proceed.")
        return 0

    rows, total_cost, total_in = [], 0.0, 0
    t0 = time.perf_counter()

    if args.mode == "batch":
        payload = build_payload_batch(videos, topics, f"m0-batch-{int(time.time())}")
        t_call = time.perf_counter()
        resp, err = post(payload, api_key)
        lat = (time.perf_counter() - t_call) * 1000
        if err:
            print(f"REQUEST FAILED: {err}")
            print("Batch failure loses every answer in it -> safe default is 'show' + re-split smaller.")
            return 2
        usage = resp.get("usage") or {}
        total_cost = float(usage.get("cost", 0) or 0)
        total_in = int(usage.get("input_tokens", 0) or 0)
        print(f"\nsingle batched call served {len(videos)} videos in {lat:.0f} ms, "
              f"{total_in} input tokens, ${total_cost:.8f}   (model: {resp.get('model')})")
        answers = resp.get("answers") or {}
        for i, v in enumerate(videos):
            ans = answers.get(f"v{i}") or {}
            dec, topic, prob, conf = verdict_from_answer(ans, topics, args.threshold)
            probs = (ans.get("probabilities") or {}) if isinstance(ans, dict) else {}
            rows.append({
                "videoId": v.get("videoId", ""), "title": v.get("title", ""),
                "channel": v.get("channel", ""), "mode": "batch",
                "choice": ans.get("choice", "") if isinstance(ans, dict) else "",
                "confidence": round(conf, 4), "max_topic_prob": round(prob, 4),
                "matched_topic": topic or "", "decision": dec,
                **{f"p_{t}": round(float(probs.get(t, 0) or 0), 4) for t in topics},
                "p_none": round(float(probs.get("none", 0) or 0), 4),
                "latency_ms": round(lat, 1),
                "my_label": "",              # <- you fill this in by hand, then we calibrate
                "correct": "",
            })
    else:
        for i, v in enumerate(videos):
            payload = build_payload_single([v], topics, f"m0-single-{i}-{int(time.time())}")
            t_call = time.perf_counter()
            resp, err = post(payload, api_key)
            lat = (time.perf_counter() - t_call) * 1000
            if err:
                print(f"[{i}] FAILED: {err}")
                rows.append({"videoId": v.get("videoId", ""), "title": v.get("title", ""),
                             "channel": v.get("channel", ""), "mode": "single",
                             "decision": "show", "error": err[:120], "latency_ms": round(lat, 1)})
                continue
            usage = resp.get("usage") or {}
            total_cost += float(usage.get("cost", 0) or 0)
            total_in += int(usage.get("input_tokens", 0) or 0)
            ans = (resp.get("answers") or {}).get("v0") or {}
            dec, topic, prob, conf = verdict_from_answer(ans, topics, args.threshold)
            probs = (ans.get("probabilities") or {}) if isinstance(ans, dict) else {}
            rows.append({
                "videoId": v.get("videoId", ""), "title": v.get("title", ""),
                "channel": v.get("channel", ""), "mode": "single",
                "choice": ans.get("choice", "") if isinstance(ans, dict) else "",
                "confidence": round(conf, 4), "max_topic_prob": round(prob, 4),
                "matched_topic": topic or "", "decision": dec,
                **{f"p_{t}": round(float(probs.get(t, 0) or 0), 4) for t in topics},
                "p_none": round(float(probs.get("none", 0) or 0), 4),
                "latency_ms": round(lat, 1), "my_label": "", "correct": "",
            })
            print(f"[{i}] {lat:6.0f} ms  {dec:6s} {topic or '-':9s} p={prob:.2f}  {v.get('title','')[:58]}")

    elapsed = (time.perf_counter() - t0) * 1000

    print("\n--- results ---")
    for r in rows:
        print(f"  {r.get('decision','?'):6s} {str(r.get('matched_topic') or '-'):9s} "
              f"p={r.get('max_topic_prob', 0):.2f} c={r.get('confidence', 0):.2f} "
              f"| {str(r.get('channel',''))[:20]:20s} | {str(r.get('title',''))[:52]}")

    out = os.path.join(HERE, f"m0_results_{args.mode}.csv")
    fieldnames = []
    for r in rows:
        for k in r:
            if k not in fieldnames:
                fieldnames.append(k)
    with open(out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)

    n_hide = sum(1 for r in rows if r.get("decision") == "hide")
    n_rev = sum(1 for r in rows if r.get("decision") == "review")
    print(f"\nvideos: {len(rows)}   hide: {n_hide}   review: {n_rev}   show: {len(rows)-n_hide-n_rev}")
    print(f"total input tokens: {total_in}   total cost: ${total_cost:.8f}   wall clock: {elapsed:.0f} ms")
    print(f"wrote {out}")
    print("\nNext: open that CSV, fill the 'my_label' column with the truth per video,")
    print("then we tune the threshold from real mistakes instead of guessing at a round number.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
