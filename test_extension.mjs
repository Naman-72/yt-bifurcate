// Tests the SHIPPED extension code, not a reimplementation.
//
//   node test_extension.mjs
//
// Pure logic is imported from shared/defaults.js. The browser-only functions are sliced out of
// the real service worker and eval'd, so the extraction path and brace matcher under test are
// literally the ones Chrome runs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, 'extension');
const SW = fs.readFileSync(path.join(EXT, 'src/background/service-worker.js'), 'utf8');

// defaults.js is an ES module with no browser dependencies, so import it directly.
const { verdict, buildQuestions, strip, describeFields } =
  await import(path.join(EXT, 'src/shared/defaults.js').replace(/\\/g, '/'));

// Slice the enrichment code (throttle helpers + brace matcher + enrich) out of the service worker.
const a = SW.indexOf('const BLOCK_COOLDOWN_MS');
const b = SW.indexOf('// ---------------------------------------------------------------- JEV call');
if (a < 0 || b < 0) { console.error('could not locate the enrichment block in service-worker.js'); process.exit(1); }
const { extractJsonObject, enrich } = new Function(SW.slice(a, b) + '; return { extractJsonObject, enrich };')();

let pass = 0, fail = 0;
const chk = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const T = [{ name: 'politics' }, { name: 'music' }, { name: 'movies' }, { name: 'comedy' }];

console.log('--- verdict rule ---');
chk('clear politics hides', verdict({ type: 'choice', choice: 'politics', confidence: .99,
  probabilities: { politics: .97, music: 0, movies: 0, comedy: 0, none: .03 } }, T, .55, .15).decision === 'hide');
chk('mid-range becomes review', verdict({ type: 'choice', choice: 'music', confidence: .3,
  probabilities: { politics: .10, music: .45, movies: .20, comedy: .15, none: .10 } }, T, .55, .15).decision === 'review');
chk('none shows', verdict({ type: 'choice', choice: 'none', confidence: .8,
  probabilities: { politics: .05, music: .10, movies: .05, comedy: .05, none: .75 } }, T, .55, .15).decision === 'show');
chk('wrong answer type fails open', verdict({ type: 'noul', noul: .9 }, T, .55, .15).decision === 'show');
chk('missing probabilities fails open', verdict({ type: 'choice', choice: 'music' }, T, .55, .15).decision === 'show');
chk('undefined answer fails open', verdict(undefined, T, .55, .15).decision === 'show');
chk('picks the max topic', verdict({ type: 'choice', confidence: .5,
  probabilities: { politics: .2, music: .1, movies: .8, comedy: .1, none: .1 } }, T, .55, .15).topic === 'movies');
chk('review band boundary is inclusive', verdict({ type: 'choice', confidence: .5,
  probabilities: { politics: .40, music: 0, movies: 0, comedy: 0, none: .60 } }, T, .55, .15).decision === 'review');

console.log('--- payload shape ---');
const items = [{ videoId: 'x', title: 't', channel: 'c', category: 'Music', keywords: ['k'], description: 'd', _fetch_ms: 12 }];
const q = buildQuestions(items, T);
chk('one question per video', Object.keys(q).length === 1 && q.v0.type === 'choice');
chk('criteria include a none option', 'none' in q.v0.criteria);
chk('criteria cover every topic', T.every(t => t.name in q.v0.criteria));
chk('instruction pins the path', q.v0.instructions.includes('`videos[0]`'));
chk('instruction names the real fields', describeFields(items).includes('category'));
chk('union: later video keywords still counted',
  describeFields([{ title: 'a' }, { title: 'b', keywords: ['x'] }]).includes('keywords'));
chk('strip drops bookkeeping keys', !('_fetch_ms' in strip(items[0])));
chk('3 videos -> v0/v1/v2', Object.keys(buildQuestions([items[0], items[0], items[0]], T)).join() === 'v0,v1,v2');

console.log('--- brace matcher (the risky bit) ---');
const o = extractJsonObject('xx = {"a":{"b":"}not the end{"},"c":[1,2]} ; trailing', 5);
chk('respects braces inside strings', JSON.parse(o).c.length === 2, o);
chk('handles escaped quotes', JSON.parse(extractJsonObject('{"a":"he said \\"hi\\"","b":1}', 0)).a === 'he said "hi"');
try { extractJsonObject('{"a":1', 0); chk('throws on unbalanced', false); }
catch { chk('throws on unbalanced', true); }

console.log('--- live enrichment against real YouTube (skips gracefully offline) ---');
let live = 0;
for (const vid of ['dQw4w9WgXcQ', 'aircAruvnKk']) {
  try {
    const t0 = Date.now();
    const m = await enrich(vid, 600);
    console.log(`  ${vid} ${Date.now() - t0}ms  category=${m.category}  title=${String(m.title).slice(0, 44)}`);
    chk(`${vid} title`, !!m.title);
    chk(`${vid} channel`, !!m.channel);
    chk(`${vid} category`, !!m.category);
    chk(`${vid} keywords is an array`, Array.isArray(m.keywords));
    chk(`${vid} description <= 600ch`, (m.description || '').length <= 600);
    live++;
  } catch (e) {
    console.log(`  SKIP ${vid}: ${String(e.message).slice(0, 70)}`);
  }
}
if (!live) console.log('  (no live checks ran — offline, or YouTube is blocking this IP)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
