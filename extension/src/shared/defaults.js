// Shared defaults. Imported by the service worker, options page and popup.
// The content script cannot use ES modules, so it receives settings over messaging.

export const MODEL = 'typesafe/jev-1.13';   // pinned: the ~latest alias moves and breaks tuned thresholds

export const DEFAULT_TOPICS = [
  { name: 'politics', description: 'Government, elections, political parties, policy, political commentary, political debate or political news coverage' },
  { name: 'music',    description: 'Songs, music videos, albums, artists, bands, concerts, music production, instrumentals or music reviews' },
  { name: 'movies',   description: 'Films, cinema, movie trailers, movie reviews, actors, directors, TV series, anime or streaming shows' },
  { name: 'comedy',   description: 'Stand-up comedy, sketches, pranks, funny compilations, memes, roasts or humorous entertainment' }
];

export const NONE_DESCRIPTION = 'Does not clearly belong to any of the listed categories.';

export const DEFAULT_SETTINGS = {
  enabled: true,
  apiKey: '',
  model: MODEL,
  topics: DEFAULT_TOPICS,
  threshold: 0.55,      // at or above -> hide
  reviewBand: 0.15,     // within this below the threshold -> badge, do not hide
  surfaces: { home: true, watchSidebar: true, search: true },
  enrich: true,         // fetch each video's watch page for category/keywords/description
  enrichChars: 600,     // description characters kept in state
  maxPerBatch: 8,       // videos per JEV request
  concurrency: 3,       // parallel watch-page fetches
  localKeywords: ''     // one per line; matched against title+channel, hides instantly with no API call
};

export function describeFields(items) {
  const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
  const names = [];
  if (list.some(v => v.title)) names.push('title');
  if (list.some(v => v.channel)) names.push('channel name');
  if (list.some(v => v.category)) names.push("YouTube's own category label");
  if (list.some(v => v.keywords && v.keywords.length)) names.push('keywords');
  if (list.some(v => v.description)) names.push('description');
  if (!names.length) return 'title and channel name';
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

export function strip(item) {
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    if (!k.startsWith('_')) out[k] = v;
  }
  return out;
}

// One `choice` question per video, each pinned to its own path in the shared state.
// Questions are evaluated independently and in parallel, so the other videos in the
// state must be explicitly excluded in the instructions.
export function buildQuestions(items, topics) {
  const criteria = {};
  for (const t of topics) {
    if (!t || !t.name) continue;
    criteria[t.name] = t.description || `Content primarily about ${t.name}`;
  }
  criteria.none = NONE_DESCRIPTION;

  const fields = describeFields(items);
  const questions = {};
  items.forEach((_, i) => {
    questions[`v${i}`] = {
      type: 'choice',
      instructions:
        `Consider only \`videos[${i}]\` in the state. Which single category best describes that ` +
        `YouTube video, judged from its ${fields}? If it does not clearly belong to any listed ` +
        `category, choose none. Do not let the other videos in the state influence this answer.`,
      criteria
    };
  });
  return questions;
}

// Decision rule, kept in code. A malformed or unexpected answer fails open to "show":
// showing a video you did not want is recoverable, hiding one you wanted is not.
export function verdict(answer, topics, threshold, reviewBand) {
  if (!answer || answer.type !== 'choice') {
    return { decision: 'show', topic: null, prob: 0, confidence: 0 };
  }
  const probs = answer.probabilities || {};
  const confidence = typeof answer.confidence === 'number' ? answer.confidence : 0;

  let topic = null, prob = 0;
  for (const t of topics) {
    if (!t || !t.name) continue;
    const p = Number(probs[t.name] || 0);
    if (p > prob) { prob = p; topic = t.name; }
  }

  let decision = 'show';
  if (prob >= threshold) decision = 'hide';
  else if (prob >= threshold - reviewBand) decision = 'review';
  return { decision, topic, prob, confidence };
}
