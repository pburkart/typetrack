// Pure typing-test engine. No DOM, no timers, no storage.
// Loaded as a plain script in the browser (window.Engine) and via require() in tests.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Deterministic PRNG so a seed reproduces a word sequence (handy in tests).
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pickWords(pool, count, rand) {
    const out = [];
    let last = null;
    while (out.length < count) {
      const w = pool[Math.floor(rand() * pool.length)];
      if (w === last && pool.length > 1 && out.length < count * 4) continue; // no immediate repeats
      out.push(w);
      last = w;
    }
    return out;
  }

  // Repeat an ordered list until it has n entries (drills, quotes, replays).
  function cycle(list, n, from) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(list[(i + (from || 0)) % list.length]);
    return out;
  }

  // Base letter of an accented character ("é" -> "e", "ñ" -> "n", "ç" -> "c").
  // Only single-character NFD decompositions count: "ß", "ø", "æ" have none.
  function baseChar(c) {
    const d = c.normalize("NFD");
    return d.length > 1 && /^[\u0300-\u036f]+$/.test(d.slice(1)) ? d[0] : c;
  }

  // opts:
  //   mode: "time" (duration seconds, endless words) | "words" (fixed wordCount) | "text" (a fixed text)
  //   words: the pool to draw from; with ordered:true (or mode "text"), the exact list, used in order
  //   text: for mode "text", a string split on whitespace
  //   ordered: use opts.words in order (drills, quotes, replays) instead of shuffling
  //   accents: "strict" (default) | "lenient" (a typed base letter matches its accented target: e for é)
  //   noBackspace: backspace is ignored
  //   lang: recorded on the result (default "en")
  function createTest(opts) {
    const rand = opts.rand || mulberry32(opts.seed == null ? Date.now() : opts.seed);
    const mode = opts.mode === "words" || opts.mode === "text" ? opts.mode : "time";
    let list = opts.words;
    if (mode === "text") {
      list = opts.text != null ? String(opts.text).split(/\s+/).filter(Boolean) : (opts.words || []).slice();
      if (!list.length) throw new Error("text mode needs a non-empty text");
    }
    const ordered = mode === "text" || opts.ordered === true;
    const duration = mode === "time" ? Number(opts.duration) || 30 : 0;
    const wordCount =
      mode === "text" ? list.length : mode === "words" ? Number(opts.wordCount) || (ordered ? list.length : 50) : 0;
    // Time mode starts with a generous buffer and tops itself up as you go.
    const initial = mode === "time" ? 100 : wordCount;
    return {
      mode,
      duration,
      wordCount,
      pool: list,
      ordered,
      rand,
      lang: opts.lang || "en",
      accents: opts.accents === "lenient" ? "lenient" : "strict",
      noBackspace: !!opts.noBackspace,
      words: ordered ? cycle(list, initial) : pickWords(list, initial, rand),
      typed: [""], // typed[i] is what has been typed for words[i]
      index: 0, // current word
      maxIndex: 0, // furthest word reached
      startedAt: null,
      finishedAt: null,
      // keystroke tally, monkeytype-style
      correct: 0,
      incorrect: 0,
      extra: 0,
      missed: 0,
      events: [], // {t, ok} per character keystroke, t = ms since start
      log: [], // [t, key] per effective keystroke: key is a character, " " or "\b"
      keyHits: {}, // expected char -> times it was attempted
      keyMiss: {}, // expected char -> times it was mistyped
      swaps: {}, // "expected>typed" -> count
    };
  }

  function isRunning(s) {
    return s.startedAt !== null && s.finishedAt === null;
  }

  function ensureBuffer(s) {
    if (s.mode === "time" && s.words.length - s.index < 40) {
      if (s.ordered) s.words.push(...cycle(s.pool, 60, s.words.length));
      else s.words.push(...pickWords(s.pool, 60, s.rand));
    }
  }

  function start(s, now) {
    if (s.startedAt === null) s.startedAt = now;
  }

  function input(s, ch, now) {
    if (s.finishedAt !== null) return s;
    start(s, now);
    const word = s.words[s.index];
    const typed = s.typed[s.index];
    const pos = typed.length;
    const key = ch;
    // Lenient accents: store the accented target so every later comparison just works.
    if (s.accents === "lenient" && pos < word.length && ch !== word[pos] && baseChar(word[pos]) === ch) ch = word[pos];
    const ok = pos < word.length && word[pos] === ch;
    if (pos < word.length) {
      const exp = word[pos].toLowerCase();
      s.keyHits[exp] = (s.keyHits[exp] || 0) + 1;
      if (ok) s.correct++;
      else {
        s.incorrect++;
        s.keyMiss[exp] = (s.keyMiss[exp] || 0) + 1;
        const k = exp + ">" + key;
        s.swaps[k] = (s.swaps[k] || 0) + 1;
      }
    } else {
      if (pos - word.length >= 10) return s; // cap runaway extras
      s.extra++;
    }
    s.typed[s.index] = typed + ch;
    s.events.push({ t: now - s.startedAt, ok });
    logKey(s, now, key);
    // Words and text mode end on the final character of the final word if it is all correct.
    if (s.mode !== "time" && s.index === s.words.length - 1 && s.typed[s.index] === word) {
      finish(s, now);
    }
    return s;
  }

  function logKey(s, now, key) {
    const last = s.log.length ? s.log[s.log.length - 1][0] : 0;
    const t = now == null ? last : Math.max(last, Math.round(now - s.startedAt));
    s.log.push([t, key]);
  }

  // now is optional (older callers); without it the backspace is logged at the previous keystroke's time.
  function backspace(s, now) {
    if (s.finishedAt !== null || s.noBackspace) return s;
    const typed = s.typed[s.index];
    if (typed.length > 0) {
      s.typed[s.index] = typed.slice(0, -1);
    } else if (s.index > 0 && s.typed[s.index - 1] !== s.words[s.index - 1]) {
      // Allow backing into a previous word only if it was wrong (monkeytype behaviour).
      s.typed.pop();
      s.index--;
    } else return s;
    if (s.startedAt !== null) logKey(s, now, "\b");
    return s;
  }

  function space(s, now) {
    if (s.finishedAt !== null) return s;
    const typed = s.typed[s.index];
    if (typed.length === 0) return s; // ignore leading spaces
    start(s, now);
    const word = s.words[s.index];
    if (typed === word) s.correct++; // the space itself counts as a correct char
    else s.missed += Math.max(0, word.length - typed.length);
    s.events.push({ t: now - s.startedAt, ok: typed === word });
    logKey(s, now, " ");
    if (s.mode !== "time" && s.index === s.words.length - 1) {
      finish(s, now);
      return s;
    }
    s.index++;
    if (s.index > s.maxIndex) s.maxIndex = s.index;
    s.typed.push("");
    ensureBuffer(s);
    return s;
  }

  // Call regularly; ends a time-mode test when the clock runs out.
  function tick(s, now) {
    if (!isRunning(s)) return s;
    if (s.mode === "time" && now - s.startedAt >= s.duration * 1000) {
      // Count the unfinished tail of the current word as missed.
      const word = s.words[s.index];
      const typed = s.typed[s.index];
      s.missed += Math.max(0, word.length - typed.length);
      finish(s, s.startedAt + s.duration * 1000);
    }
    return s;
  }

  function finish(s, now) {
    if (s.finishedAt === null) s.finishedAt = now;
  }

  function elapsedMs(s, now) {
    if (s.startedAt === null) return 0;
    return (s.finishedAt !== null ? s.finishedAt : now) - s.startedAt;
  }

  // WPM the way monkeytype defines it: correct characters (including the space
  // after each fully correct word) / 5, per minute. Raw counts every keystroke.
  function results(s) {
    const ms = Math.max(1, elapsedMs(s, s.finishedAt));
    const minutes = ms / 60000;
    let correctChars = 0;
    for (let i = 0; i < s.typed.length; i++) {
      const w = s.words[i];
      const t = s.typed[i];
      if (i < s.index) {
        if (t === w) correctChars += w.length + 1;
      } else {
        // current word: correct prefix only
        let n = 0;
        while (n < t.length && n < w.length && t[n] === w[n]) n++;
        correctChars += n;
        if (s.mode !== "time" && t === w) correctChars += 1;
      }
    }
    // Raw counts the same implied final space as correctChars: a completed last word in a non-time mode ends the run
    // without a space typed, and without it a clean run showed raw below wpm.
    const last = s.typed.length - 1;
    const finalSpace = s.mode !== "time" && last >= 0 && last === s.index && s.typed[last] === s.words[last] ? 1 : 0;
    const rawChars = s.typed.reduce((a, t) => a + t.length, 0) + Math.max(0, s.typed.length - 1) + finalSpace;
    const keystrokes = s.correct + s.incorrect + s.extra;
    return {
      mode: s.mode,
      duration: Math.round(ms / 1000),
      target: s.mode === "time" ? s.duration : s.wordCount,
      wpm: round1(correctChars / 5 / minutes),
      raw: round1(rawChars / 5 / minutes),
      acc: keystrokes ? round1((s.correct / keystrokes) * 100) : 0,
      chars: { correct: s.correct, incorrect: s.incorrect, extra: s.extra, missed: s.missed },
      errors: {
        perSecond: errorsPerSecond(s, ms),
        keyHits: Object.assign({}, s.keyHits),
        keyMiss: Object.assign({}, s.keyMiss),
        swaps: Object.assign({}, s.swaps),
        words: wrongWords(s),
      },
      // cumulative wpm sampled once per second, for the results chart
      perSecond: perSecond(s, ms),
      // everything needed to replay the run (Engine.replay / verify / stateAt)
      lang: s.lang,
      accents: s.accents,
      noBackspace: s.noBackspace,
      words: s.words.slice(0, s.maxIndex + 1),
      log: s.log.map((e) => e.slice()),
    };
  }

  function perSecond(s, ms) {
    const secs = Math.max(1, Math.ceil(ms / 1000));
    const out = [];
    let good = 0;
    let idx = 0;
    for (let sec = 1; sec <= secs; sec++) {
      while (idx < s.events.length && s.events[idx].t <= sec * 1000) {
        if (s.events[idx].ok) good++;
        idx++;
      }
      out.push(round1(good / 5 / (sec / 60)));
    }
    return out;
  }

  // errors (bad keystrokes, including a space ending a wrong word) in each second
  function errorsPerSecond(s, ms) {
    const secs = Math.max(1, Math.ceil(ms / 1000));
    const out = new Array(secs).fill(0);
    for (const e of s.events) if (!e.ok) out[Math.min(secs - 1, Math.max(0, Math.ceil(e.t / 1000) - 1))]++;
    return out;
  }

  // committed words that did not match: [{word, typed}]
  function wrongWords(s) {
    const out = [];
    for (let i = 0; i < s.typed.length; i++) {
      const committed = i < s.index || s.finishedAt !== null;
      if (committed && s.typed[i] && s.typed[i] !== s.words[i]) out.push({ word: s.words[i], typed: s.typed[i] });
    }
    return out;
  }

  // Merge error data across stored results. Results saved before error
  // tracking existed contribute nothing. Returns keys sorted worst first.
  function errorProfile(rs) {
    const hits = {}, miss = {}, swaps = {}, words = {};
    let errs = 0, tests = 0;
    for (const r of rs) {
      if (r.chars) errs += (r.chars.incorrect || 0) + (r.chars.extra || 0) + (r.chars.missed || 0);
      if (!r.errors) continue;
      tests++;
      for (const [k, v] of Object.entries(r.errors.keyHits || {})) hits[k] = (hits[k] || 0) + v;
      for (const [k, v] of Object.entries(r.errors.keyMiss || {})) miss[k] = (miss[k] || 0) + v;
      for (const [k, v] of Object.entries(r.errors.swaps || {})) swaps[k] = (swaps[k] || 0) + v;
      for (const w of r.errors.words || []) words[w.word] = (words[w.word] || 0) + 1;
    }
    const keys = Object.keys(hits)
      .map((k) => ({ key: k, hits: hits[k], miss: miss[k] || 0, rate: round1(((miss[k] || 0) / hits[k]) * 100) }))
      .filter((k) => k.miss > 0)
      .sort((a, b) => b.rate - a.rate || b.miss - a.miss);
    const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, n }));
    return {
      avgErrors: rs.length ? round1(errs / rs.length) : 0,
      tracked: tests,
      keys,
      swaps: top(swaps),
      words: top(words),
    };
  }

  function round1(x) {
    return Math.round(x * 10) / 10;
  }

  // ── Replay ────────────────────────────────────────────────────────────────

  // createTest options that reproduce a run. opts is a result (or anything with mode, target|duration|wordCount,
  // words|text, accents, noBackspace, lang). The words are always used in order.
  function replayOpts(opts) {
    const mode = opts.mode === "words" || opts.mode === "text" ? opts.mode : "time";
    const o = {
      mode,
      ordered: true,
      words: opts.words,
      text: opts.words ? undefined : opts.text,
      accents: opts.accents,
      noBackspace: opts.noBackspace,
      lang: opts.lang,
      seed: 0,
    };
    if (mode === "time") o.duration = opts.target || opts.duration;
    if (mode === "words") o.wordCount = opts.target || opts.wordCount || (opts.words || []).length;
    return o;
  }

  function feed(s, t, k) {
    if (k === "\b") backspace(s, t);
    else if (k === " ") space(s, t);
    else input(s, k, t);
  }

  // replay(opts, log) or replay(words, log, opts) → a test state rebuilt by feeding the log.
  // A time test is ticked to its end; words and text tests finish on their own.
  function replay(a, b, c) {
    const opts = Array.isArray(a) ? Object.assign({}, c || {}, { words: a }) : a || {};
    const log = b || opts.log || [];
    const s = createTest(replayOpts(opts));
    for (const e of log) feed(s, e[0], e[1]);
    if (s.mode === "time" && s.startedAt !== null) tick(s, s.startedAt + s.duration * 1000);
    return s;
  }

  // Snapshots after every keystroke, cached per log array so stateAt is a binary search per frame.
  const stateCache = typeof WeakMap === "function" ? new WeakMap() : null;
  function snapshots(words, log, opts) {
    const hit = stateCache && stateCache.get(log);
    if (hit && hit.words === words) return hit;
    const s = createTest(
      Object.assign({}, opts || {}, { mode: "words", ordered: true, words, wordCount: words.length, seed: 0 })
    );
    const n = log.length;
    const snap = { words, t: new Float64Array(n), index: new Int32Array(n), typed: new Array(n) };
    for (let i = 0; i < n; i++) {
      feed(s, log[i][0], log[i][1]);
      snap.t[i] = log[i][0];
      snap.index[i] = s.index;
      snap.typed[i] = s.typed[s.index];
    }
    if (stateCache) stateCache.set(log, snap);
    return snap;
  }

  // Where a recorded run was at time t (ms since its first keystroke): { index, typed } where typed is what had
  // been typed of words[index]. Used to draw a ghost caret; cheap enough to call every animation frame.
  // opts (optional): { accents, noBackspace } of the recorded run.
  function stateAt(words, log, t, opts) {
    const snap = snapshots(words, log, opts);
    let lo = 0, hi = snap.t.length - 1, at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (snap.t[mid] <= t) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return at < 0 ? { index: 0, typed: "" } : { index: snap.index[at], typed: snap.typed[at] };
  }

  // Anti-cheat: recompute wpm/acc/raw from result.words + result.log + mode/target. ok when the run is complete,
  // the log is well formed and every claimed value is within ±1 of the recomputed one.
  function verify(r) {
    const fail = { ok: false, wpm: 0, acc: 0, raw: 0 };
    if (!r || !Array.isArray(r.log) || !r.log.length || !Array.isArray(r.words) || !r.words.length) return fail;
    if (!r.words.every((w) => typeof w === "string" && w.length > 0)) return fail;
    let prev = 0;
    for (const e of r.log) {
      if (!Array.isArray(e) || typeof e[0] !== "number" || !isFinite(e[0]) || e[0] < prev) return fail;
      if (typeof e[1] !== "string" || Array.from(e[1]).length !== 1) return fail;
      prev = e[0];
    }
    if (r.log[0][0] !== 0) return fail;
    let s;
    try {
      s = replay(r, r.log);
    } catch (err) {
      return fail;
    }
    // A time run may take a keystroke just after the clock ends (before the next tick), never seconds after.
    if (s.mode === "time" && prev > s.duration * 1000 + 1000) return fail;
    const x = results(s);
    const near = (a, b) => typeof b === "number" && Math.abs(a - b) <= 1;
    const ok =
      s.finishedAt !== null &&
      x.mode === r.mode &&
      x.target === Number(r.target) &&
      near(x.wpm, r.wpm) &&
      near(x.acc, r.acc) &&
      near(x.raw, r.raw);
    return { ok, wpm: x.wpm, acc: x.acc, raw: x.raw };
  }

  // ── Timing analytics (pure, on results that carry words + log) ─────────────
  // Built for 130-200 wpm typists at ~100% accuracy: errors are rare, so these look at time, not mistakes.
  // "wpm" from an interval is 12000 / ms per keystroke (one keystroke = 1/5 of a word).

  // One entry per log keystroke: { t, k, index (word), pos (in word, before the key), word, ok }.
  // ok: a character typed correctly, or a space ending a correct word. Backspaces are never ok.
  const traceCache = typeof WeakMap === "function" ? new WeakMap() : null;
  function trace(r) {
    if (!r || !Array.isArray(r.log) || !Array.isArray(r.words) || !r.words.length) return [];
    const hit = traceCache && traceCache.get(r.log);
    if (hit) return hit;
    const s = createTest(replayOpts(r));
    const out = [];
    for (const [t, k] of r.log) {
      const index = s.index;
      const word = s.words[index];
      const before = s.typed[index];
      const pos = before.length;
      let ok = false;
      if (k === " ") ok = before === word;
      if (k !== "\b" && k !== " ") ok = pos < word.length;
      feed(s, t, k);
      if (k !== "\b" && k !== " ") ok = ok && s.typed[index].length > pos && s.typed[index][pos] === word[pos];
      out.push({ t, k, index, pos, word, ok });
    }
    if (traceCache) traceCache.set(r.log, out);
    return out;
  }

  function asList(rs) {
    return Array.isArray(rs) ? rs : rs ? [rs] : [];
  }

  function median(xs) {
    if (!xs.length) return 0;
    const a = xs.slice().sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function quantile(xs, q) {
    if (!xs.length) return 0;
    const a = xs.slice().sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(q * a.length))];
  }

  // Words typed cleanly in one go (every key right, no backspace, complete): { word, ms, keys, index }.
  // ms runs from the word's first key to its last, over keys = length - 1 intervals.
  function cleanWords(r) {
    const tr = trace(r);
    const out = [];
    let seg = [];
    let dirty = false;
    const close = () => {
      if (!dirty && seg.length >= 2 && seg.length === seg[0].word.length && seg[0].pos === 0) {
        out.push({ word: seg[0].word, ms: seg[seg.length - 1].t - seg[0].t, keys: seg.length - 1, index: seg[0].index });
      }
      seg = [];
      dirty = false;
    };
    for (const e of tr) {
      if (e.k === " ") close();
      else if (e.k === "\b") dirty = true;
      else {
        if (!e.ok) dirty = true;
        seg.push(e);
      }
    }
    close();
    return out;
  }

  // Slowest letter pairs: consecutive correct keystrokes inside one word, lower-cased.
  // → [{ pair, n, avgMs, medianMs }] slowest (median, then mean) first, pairs seen fewer than minSamples times dropped.
  function pairTimes(rs, minSamples) {
    const min = minSamples == null ? 3 : minSamples;
    const gaps = {};
    for (const r of asList(rs)) {
      const tr = trace(r);
      for (let i = 1; i < tr.length; i++) {
        const a = tr[i - 1], b = tr[i];
        if (!a.ok || !b.ok || a.k === " " || b.k === " " || a.index !== b.index || b.pos !== a.pos + 1) continue;
        const pair = (a.word[a.pos] + b.word[b.pos]).toLowerCase();
        (gaps[pair] = gaps[pair] || []).push(b.t - a.t);
      }
    }
    return Object.keys(gaps)
      .filter((p) => gaps[p].length >= min)
      .map((p) => {
        const g = gaps[p];
        return { pair: p, n: g.length, avgMs: round1(g.reduce((x, y) => x + y, 0) / g.length), medianMs: round1(median(g)) };
      })
      .sort((a, b) => b.medianMs - a.medianMs || b.avgMs - a.avgMs);
  }

  // Slowest words among those typed cleanly: → [{ word, n, wpm, medianMs }] slowest first.
  // wpm = 12000 × intervals / ms, pooled over every clean sample of the word (first key to last key).
  function wordTimes(rs, minSamples) {
    const min = minSamples == null ? 2 : minSamples;
    const acc = {};
    for (const r of asList(rs)) {
      for (const w of cleanWords(r)) {
        if (w.ms <= 0) continue;
        const a = (acc[w.word] = acc[w.word] || { ms: 0, keys: 0, all: [] });
        a.ms += w.ms;
        a.keys += w.keys;
        a.all.push(w.ms);
      }
    }
    return Object.keys(acc)
      .filter((w) => acc[w].all.length >= min)
      .map((w) => ({ word: w, n: acc[w].all.length, wpm: round1((12000 * acc[w].keys) / acc[w].ms), medianMs: median(acc[w].all) }))
      .sort((a, b) => a.wpm - b.wpm);
  }

  // Gaps between consecutive keystrokes, leaving out any gap that touches a backspace (corrections are not rhythm).
  function intervals(r) {
    const tr = trace(r);
    const out = [];
    for (let i = 1; i < tr.length; i++) {
      if (tr[i].k === "\b" || tr[i - 1].k === "\b") continue;
      out.push({ i, gap: tr[i].t - tr[i - 1].t, e: tr[i] });
    }
    return out;
  }

  // Inter-key interval histogram: bins[i] counts gaps in [i×bucket, (i+1)×bucket) up to max; over counts the rest.
  // → { bucket, max, bins, over, count, median, p90, mean }  (ms)
  function rhythm(r, bucket, max) {
    const b = bucket || 10;
    const m = max || 500;
    const gaps = intervals(r).map((x) => x.gap);
    const bins = new Array(Math.ceil(m / b)).fill(0);
    let over = 0;
    for (const g of gaps) {
      if (g >= m) over++;
      else bins[Math.floor(g / b)]++;
    }
    const mean = gaps.length ? gaps.reduce((x, y) => x + y, 0) / gaps.length : 0;
    return { bucket: b, max: m, bins, over, count: gaps.length, median: median(gaps), p90: quantile(gaps, 0.9), mean: round1(mean) };
  }

  // Pauses longer than factor × the median gap. → { median, threshold, items: [{ i (log index), t, gap, index,
  // word, pos }] } where index/word/pos locate the keystroke that ended the pause (mark it on the text).
  function hesitations(r, factor) {
    const f = factor || 2.5;
    const iv = intervals(r);
    const med = median(iv.map((x) => x.gap));
    const threshold = med * f;
    const items = iv
      .filter((x) => med > 0 && x.gap > threshold)
      .map((x) => ({ i: x.i, t: x.e.t, gap: x.gap, index: x.e.index, word: x.e.word, pos: x.e.pos }));
    return { median: med, threshold: round1(threshold), items };
  }

  function elapsedOf(r, tr) {
    const last = tr.length ? tr[tr.length - 1].t : 0;
    return Math.max(1, r.mode === "time" && r.target ? r.target * 1000 : last || (r.duration || 0) * 1000);
  }

  // Burst vs sustained. → { word: {word, wpm}|null (fastest clean word of 3+ letters), window (best 5 s wpm on
  // correct keystrokes), overall (result wpm), ratio (window / overall) }
  function burst(r, windowMs) {
    const win = windowMs || 5000;
    let best = null;
    for (const w of cleanWords(r)) {
      if (w.word.length < 3 || w.ms <= 0) continue;
      const wpm = round1((12000 * w.keys) / w.ms);
      if (!best || wpm > best.wpm) best = { word: w.word, wpm };
    }
    const tr = trace(r);
    const ts = tr.filter((e) => e.ok).map((e) => e.t);
    const span = Math.min(win, elapsedOf(r, tr));
    let most = 0;
    for (let i = 0, j = 0; i < ts.length; i++) {
      while (ts[i] - ts[j] > span) j++;
      if (i - j + 1 > most) most = i - j + 1;
    }
    const window = round1(most / 5 / (span / 60000));
    const overall = r.wpm || 0;
    return { word: best, window, overall, ratio: overall ? Math.round((window / overall) * 100) / 100 : 0 };
  }

  // Per-second raw wpm over the full seconds of the run (every character and space keystroke, backspaces excluded).
  function rawPerSecond(r) {
    const tr = trace(r);
    const secs = Math.max(1, Math.floor(elapsedOf(r, tr) / 1000));
    const n = new Array(secs).fill(0);
    for (const e of tr) {
      if (e.k === "\b") continue;
      const sec = Math.floor(e.t / 1000);
      if (sec < secs) n[sec]++;
    }
    return n.map((c) => c * 12);
  }

  // Consistency 0-100, monkeytype-like: score = clamp(100 - 100 × cv, 0, 100) where cv = population standard
  // deviation / mean of the per-second raw wpm (rawPerSecond). Steady typing → 100; a run that alternates
  // bursts and pauses as large as its mean → 0.
  function consistency(r) {
    const xs = rawPerSecond(r);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    if (!mean) return 0;
    const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) * (x - mean), 0) / xs.length);
    return round1(Math.max(0, Math.min(100, 100 - (sd / mean) * 100)));
  }

  // Stamina: typing rate in the first, middle and last third of the run (by time), and the % drop first → last
  // (negative = sped up). A third's rate is 12000 × intervals / ms between its first and last correct keystroke,
  // so a steady typist reads 0% whatever the key spacing (counting keys per third would jitter by one key).
  // → { first, middle, last, drop }
  function staminaDrop(r) {
    const tr = trace(r);
    const E3 = elapsedOf(r, tr) / 3;
    const parts = [[], [], []];
    for (const e of tr) if (e.ok) parts[Math.min(2, Math.floor(e.t / E3))].push(e.t);
    const [first, middle, last] = parts.map((ts) =>
      ts.length > 1 && ts[ts.length - 1] > ts[0] ? round1((12000 * (ts.length - 1)) / (ts[ts.length - 1] - ts[0])) : 0
    );
    return { first, middle, last, drop: first ? round1(((first - last) / first) * 100) : 0 };
  }

  // Words from pool weighted by how often they contain the needles (bigrams or keys); no immediate repeats.
  // Falls back to plain random words when nothing in the pool matches.
  function drillWords(pool, needles, count, rand) {
    const r = rand || Math.random;
    const n = count || 50;
    const ns = (needles || []).map((x) => String(typeof x === "string" ? x : x.pair || x.key || "").toLowerCase()).filter(Boolean);
    const scored = [];
    let total = 0;
    for (const w of pool) {
      const lw = w.toLowerCase();
      let score = 0;
      for (const x of ns) for (let i = lw.indexOf(x); i >= 0; i = lw.indexOf(x, i + 1)) score++;
      if (score > 0) {
        scored.push([w, score]);
        total += score;
      }
    }
    if (!scored.length) return pickWords(pool, n, r);
    const out = [];
    let last = null;
    let guard = 0;
    while (out.length < n) {
      let x = r() * total;
      let k = 0;
      while (k < scored.length - 1 && x >= scored[k][1]) x -= scored[k++][1];
      const w = scored[k][0];
      if (w === last && scored.length > 1 && guard++ < n * 4) continue;
      out.push(w);
      last = w;
    }
    return out;
  }

  // pairs: ["th", ...] or pairTimes() rows; keys: ["é", "q", ...] or [{key}].
  function pairDrillWords(pool, pairs, count, rand) {
    return drillWords(pool, pairs, count, rand);
  }
  function keyDrillWords(pool, keys, count, rand) {
    return drillWords(pool, keys, count, rand);
  }

  // ── Stats over stored results ─────────────────────────────────────────────
  // A stored result is results() plus { ts: epoch ms }.

  function modeKey(r) {
    return r.mode + " " + r.target;
  }

  function filterResults(all, key) {
    if (!key || key === "all") return all.slice();
    return all.filter((r) => modeKey(r) === key);
  }

  function movingAverage(values, n) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= n) sum -= values[i - n];
      out.push(round1(sum / Math.min(n, i + 1)));
    }
    return out;
  }

  function summarize(rs) {
    if (rs.length === 0) return { count: 0, best: 0, avgRecent: 0, avgAll: 0, acc: 0, seconds: 0, trend: 0 };
    const wpms = rs.map((r) => r.wpm);
    const recent = wpms.slice(-10);
    const prev = wpms.slice(-20, -10);
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    return {
      count: rs.length,
      best: Math.max(...wpms),
      avgRecent: round1(mean(recent)),
      avgAll: round1(mean(wpms)),
      acc: round1(mean(rs.map((r) => r.acc))),
      seconds: rs.reduce((a, r) => a + r.duration, 0),
      trend: prev.length ? round1(mean(recent) - mean(prev)) : 0,
    };
  }

  return {
    mulberry32,
    createTest,
    input,
    backspace,
    space,
    tick,
    finish,
    isRunning,
    elapsedMs,
    results,
    modeKey,
    filterResults,
    movingAverage,
    summarize,
    errorProfile,
    baseChar,
    replay,
    stateAt,
    verify,
    trace,
    pairTimes,
    wordTimes,
    rhythm,
    hesitations,
    burst,
    consistency,
    rawPerSecond,
    staminaDrop,
    pairDrillWords,
    keyDrillWords,
  };
});
