// Gamification runtime: XP, personal bests, badges, level-ups and daily goals, turned into bus events and small
// notifications, plus the header level indicator. The maths lives in progress.js; this file only wires it up.
//
// The top half is pure (node-tested in test/profile.test.js): PB keys and detection, the streak calendar and the
// replay timeline. The bottom half needs a DOM and starts itself when imported in a browser.
import { xpForResult, xpForGame, levelFor, BADGES, earnedBadges, summarize, dailyGoals, dayKey } from "./progress.js";
import store from "./store.js";
import bus from "./bus.js";
import auth from "./auth.js";

// ── Personal bests (pure) ───────────────────────────────────────────────────

// What a typing PB is "per": mode, target, language and word source (list, quotes, code...).
export function pbKey(r) {
  return [r.mode, r.target, r.lang || "en", r.source || r.list || ""].join("|");
}

export function pbLabel(r) {
  const src = r.source || r.list;
  return `${r.mode} ${r.target}` + ((r.lang || "en") !== "en" ? ` · ${r.lang}` : "") + (src ? ` · ${src}` : "");
}

// Is r a new typing PB against prior (results that do not include r)? The first run of a kind is not a PB:
// with nothing to beat there is nothing to celebrate.
export function isTypingPb(prior, r) {
  const k = pbKey(r);
  let best = -1;
  for (const p of prior || []) if (p && pbKey(p) === k && p !== r && p.ts !== r.ts) best = Math.max(best, Number(p.wpm) || 0);
  return best >= 0 && (Number(r.wpm) || 0) > best;
}

const scoreOf = (e) => (typeof e === "number" ? e : Number(e && e.score) || 0);
const ascOf = (e, meta) => (meta && meta.order === "asc") || (e && e.meta && e.meta.order === "asc");

// Is score a new best against prior game entries? meta.order === "asc" means lower is better (times).
export function isGamePb(prior, score, meta) {
  const list = (prior || []).filter((e) => e != null);
  if (!list.length) return false;
  const asc = ascOf(null, meta) || list.some((e) => ascOf(e));
  const s = scoreOf(score);
  const best = asc ? Math.min(...list.map(scoreOf)) : Math.max(...list.map(scoreOf));
  return asc ? s < best : s > best;
}

// Best typing result per pbKey, newest-first by nothing in particular: sorted by mode, then target.
export function personalBests(results) {
  const map = new Map();
  for (const r of results || []) {
    const k = pbKey(r);
    const cur = map.get(k);
    if (!cur || r.wpm > cur.wpm) map.set(k, r);
  }
  const order = { time: 0, words: 1, text: 2 };
  return [...map.entries()]
    .map(([key, r]) => ({ key, label: pbLabel(r), r, count: (results || []).filter((x) => pbKey(x) === key).length }))
    .sort((a, b) => (order[a.r.mode] ?? 9) - (order[b.r.mode] ?? 9) || a.r.target - b.r.target || a.key.localeCompare(b.key));
}

// { game: [entries] } → { game: { best, plays, ts (of the best), asc } }
export function gameBests(byGame) {
  const out = {};
  for (const [game, list] of Object.entries(byGame || {})) {
    const xs = (list || []).filter((e) => e != null);
    if (!xs.length) continue;
    const asc = xs.some((e) => ascOf(e));
    let best = xs[0];
    for (const e of xs) if (asc ? scoreOf(e) < scoreOf(best) : scoreOf(e) > scoreOf(best)) best = e;
    out[game] = { best: scoreOf(best), plays: xs.length, ts: best.ts, asc };
  }
  return out;
}

// ── Streak calendar (pure) ──────────────────────────────────────────────────

// weeks columns of 7 days (Monday first) ending with the week that holds today. Each cell:
// { key: "YYYY-MM-DD", seconds, tests, level 0..4, future }. level is relative to the busiest day shown, in
// quarters, so a light week still reads; any practice at all is at least level 1.
export function calendar(results, today, weeks = 26) {
  const now = today == null ? new Date() : new Date(typeof today === "string" ? today + "T12:00:00" : today);
  const todayKey = dayKey(now);
  const byDay = new Map();
  for (const r of results || []) {
    if (r == null || r.ts == null) continue;
    const k = dayKey(r.ts);
    const d = byDay.get(k) || { seconds: 0, tests: 0 };
    d.seconds += Number(r.duration) || 0;
    d.tests++;
    byDay.set(k, d);
  }
  // Monday of this week, local time, at noon (DST-safe day steps)
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const dow = (end.getDay() + 6) % 7;
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - dow - (weeks - 1) * 7, 12);
  const cols = [];
  let max = 0;
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + i, 12);
      const key = dayKey(d);
      const v = byDay.get(key) || { seconds: 0, tests: 0 };
      max = Math.max(max, v.seconds);
      col.push({ key, seconds: v.seconds, tests: v.tests, level: 0, future: key > todayKey });
    }
    cols.push(col);
  }
  for (const col of cols) for (const c of col) c.level = c.seconds > 0 ? Math.max(1, Math.ceil((c.seconds / max) * 4)) : 0;
  return cols;
}

// ── Replay timeline (pure; Engine passed in so node tests can use require("engine.js")) ──

// Correct characters the engine would count at this point: every finished correct word plus its space, and the
// correct prefix of the current one.
function correctChars(words, typed, index, timed) {
  let n = 0;
  for (let i = 0; i < index; i++) if (typed[i] === words[i]) n += words[i].length + 1;
  const w = words[index] || "", t = typed[index] || "";
  let p = 0;
  while (p < t.length && p < w.length && t[p] === w[p]) p++;
  return n + p + (!timed && t === w && w ? 1 : 0); // the engine's words/text-mode finishing space
}

// timeline(E, run) → { words, frames: [{ t, index, typed (of words[index]), cc (correct chars) }], end (ms),
// errors: [t...] (mistyped keystrokes, from Engine.trace) }. run = { words, log, mode, target, accents, noBackspace }.
export function timeline(E, run) {
  const words = run.words || [];
  const log = run.log || [];
  const s = E.createTest({ mode: "words", ordered: true, words, wordCount: words.length, seed: 0, accents: run.accents, noBackspace: run.noBackspace });
  const frames = [];
  for (const [t, k] of log) {
    if (k === "\b") E.backspace(s, t);
    else if (k === " ") E.space(s, t);
    else E.input(s, k, t);
    frames.push({ t, index: s.index, typed: s.typed[s.index], cc: correctChars(words, s.typed, s.index, run.mode === "time") });
  }
  const last = log.length ? log[log.length - 1][0] : 0;
  const end = run.mode === "time" && run.target ? Math.max(last, run.target * 1000) : last;
  let errors = [];
  try { errors = E.trace(Object.assign({}, run, { mode: "words", target: words.length })).filter((e) => !e.ok && e.k !== "\b").map((e) => e.t); } catch { /* old engine */ }
  return { words, frames, end, errors };
}

// Index of the last frame at or before t (-1 before the first keystroke).
export function frameAt(tl, t) {
  let lo = 0, hi = tl.frames.length - 1, at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tl.frames[mid].t <= t) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return at;
}

// Typed text of every word up to the caret at frame j (what the screen shows at that moment).
export function typedAt(tl, j) {
  const typed = [];
  for (let i = 0; i <= j; i++) {
    const f = tl.frames[i];
    typed.length = f.index + 1; // backing into a previous word drops everything after it
    typed[f.index] = f.typed;
  }
  for (let i = 0; i < typed.length; i++) if (typed[i] == null) typed[i] = "";
  return typed;
}

// Live wpm at t: correct chars so far over elapsed time (null in the first half second, where it is noise).
export function wpmAt(tl, t) {
  const j = frameAt(tl, t);
  if (j < 0 || t < 500) return null;
  return tl.frames[j].cc / 5 / (t / 60000);
}

// Correct characters at t; past the end of a finished run it carries on at the run's average pace, so a run
// that finished first is not overtaken by one that simply had more text to type.
export function charsAt(tl, t) {
  const j = frameAt(tl, t);
  const cc = j < 0 ? 0 : tl.frames[j].cc;
  return tl.end > 0 && t > tl.end ? Math.round((cc * t) / tl.end) : cc;
}

// Who was ahead at t between two timelines, in correct characters: > 0 means a leads.
export function gapAt(a, b, t) {
  return charsAt(a, t) - charsAt(b, t);
}

// ── Browser runtime ─────────────────────────────────────────────────────────

const hasDom = typeof document !== "undefined" && typeof window !== "undefined";

function allGameScores() {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("typetrack.games.")) {
        const id = k.slice("typetrack.games.".length);
        out[id] = store.gameScores(id);
      }
    }
  } catch { /* storage blocked */ }
  return out;
}

let gameIds = null; // every registered game id, for the "play every game" badge; loaded lazily
function loadGameIds() {
  if (gameIds) return;
  gameIds = [];
  import("../views/games.js").then((m) => m.loadGames()).then((gs) => { gameIds = gs.map((g) => g.id); }).catch(() => {});
}

export function totalXp() {
  const xp = store.get("xp", null);
  return typeof xp === "number" ? xp : 0;
}

// First run on this browser: take XP and badges from existing history silently, so a v1 user with 300 results
// gets their level, not thirty toasts.
function backfill() {
  if (typeof store.get("xp", null) === "number") return;
  const rs = store.results(), gs = allGameScores();
  const s = summarize(rs, gs);
  store.set("xp", s.xp);
  store.set("badges", earnedBadges(s));
}

function currentSummary(xp) {
  return summarize(store.results(), allGameScores(), { xp, games: gameIds && gameIds.length ? gameIds : undefined });
}

// ── notifications: queued, shown only when no test is running ──
const queue = [];
let flushTimer = null;
function typing() { return document.body.classList.contains("typing-active"); }
function notify(fn) {
  queue.push(fn);
  schedule();
}
function schedule() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 60); // after the result screen has been drawn
}
function flush() {
  if (typing()) return; // the body observer calls schedule() again when the test ends
  let delay = 0;
  while (queue.length) {
    const fn = queue.shift();
    setTimeout(fn, delay);
    delay += 350;
  }
}

let stack = null;
function stackEl() {
  if (!stack || !stack.isConnected) {
    stack = document.createElement("div");
    stack.className = "gz-stack";
    stack.setAttribute("role", "status");
    stack.setAttribute("aria-live", "polite");
    document.body.appendChild(stack);
  }
  return stack;
}

function card(kind, icon, title, sub, ms = 4200) {
  const el = document.createElement("div");
  el.className = "gz-card gz-" + kind;
  const i = document.createElement("span");
  i.className = "gz-icon";
  i.textContent = icon;
  const body = document.createElement("div");
  const t = document.createElement("div");
  t.className = "gz-title";
  t.textContent = title;
  body.appendChild(t);
  if (sub) {
    const s = document.createElement("div");
    s.className = "gz-sub";
    s.textContent = sub;
    body.appendChild(s);
  }
  el.append(i, body);
  stackEl().appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 400); }, ms);
}

function xpPill(gained) {
  const lvl = document.querySelector(".gz-level");
  if (!lvl) return;
  const p = document.createElement("span");
  p.className = "gz-pill";
  p.textContent = `+${gained} xp`;
  lvl.appendChild(p);
  requestAnimationFrame(() => p.classList.add("show"));
  setTimeout(() => p.remove(), 2400);
}

function pbBanner(label, value, unit) {
  const b = document.createElement("div");
  b.className = "gz-pb";
  b.innerHTML = `<span class="gz-pb-kicker">new personal best</span><span class="gz-pb-value"></span>`;
  b.querySelector(".gz-pb-value").textContent = `${value}${unit ? " " + unit : ""} · ${label}`;
  document.body.appendChild(b);
  // crimson glow on the result screen's big number, when there is one
  const big = document.querySelector("#app .result:not([hidden]) .big .value");
  if (big) { big.classList.add("gz-glow"); setTimeout(() => big.classList.remove("gz-glow"), 3600); }
  requestAnimationFrame(() => b.classList.add("show"));
  setTimeout(() => { b.classList.remove("show"); setTimeout(() => b.remove(), 500); }, 3400);
}

// ── header level indicator ──
/**
 * Whether the header shows a level: for a signed-in player, and on a site with no account server (online false),
 * where this browser's progress is all there is. Signed out on a site with accounts it shows none: a level beside
 * "sign in" read as still signed in, and an empty one as a level-1 account.
 */
export const levelVisible = (user, online) => !!user || online === false;

let levelEl = null;
function renderLevel() {
  const slot = document.getElementById("auth-slot");
  if (!slot) return;
  if (!levelVisible(auth.user, auth.online)) { if (levelEl) { levelEl.remove(); levelEl = null; } return; }
  if (!levelEl || !levelEl.isConnected) {
    levelEl = document.createElement("a");
    levelEl.className = "gz-level";
    levelEl.href = "#/profile";
    levelEl.innerHTML = `<span class="gz-lv">lv <b></b></span><span class="gz-bar"><i></i></span>`;
    slot.parentNode.insertBefore(levelEl, slot);
  }
  const xp = totalXp();
  const l = levelFor(xp);
  levelEl.querySelector("b").textContent = l.level;
  levelEl.querySelector("i").style.width = Math.round((l.into / l.next) * 100) + "%";
  levelEl.title = `level ${l.level} · ${Math.round(l.into)} / ${l.next} xp to level ${l.level + 1}`;
}

function award(gained, pbs) {
  const before = totalXp();
  const total = before + gained;
  store.set("xp", total);
  const lb = levelFor(before).level, la = levelFor(total).level;
  bus.emit("xp", { gained, total, levelUp: la > lb ? la : null });
  notify(() => { renderLevel(); xpPill(gained); });
  for (const p of pbs) {
    bus.emit("pb", { kind: p.kind, key: p.key, value: p.value });
    notify(() => pbBanner(p.label, p.value, p.unit));
  }
  if (la > lb) notify(() => card("lvlup", "▲", `level ${la}`, `${levelFor(total).next} xp to level ${la + 1}`));
  // badges
  const have = new Set(store.get("badges", []));
  const now = earnedBadges(currentSummary(total));
  const fresh = now.filter((id) => !have.has(id));
  if (fresh.length) {
    store.set("badges", [...have, ...fresh]);
    for (const id of fresh) {
      const b = BADGES.find((x) => x.id === id);
      bus.emit("badge", { id });
      if (b) notify(() => card("badge", b.icon, `badge unlocked: ${b.name}`, b.desc, 5200));
    }
  }
}

function goalsDone(prevResults, prevGames) {
  const before = new Set(dailyGoals(prevResults, prevGames).filter((g) => g.done).map((g) => g.id));
  for (const g of dailyGoals(store.results(), allGameScores())) {
    if (g.done && !before.has(g.id)) notify(() => card("goal", "✓", "daily goal done", g.title));
  }
}

function onResult(r) {
  if (!r || typeof r.wpm !== "number") return;
  const all = store.results();
  const prior = all.filter((x) => x.ts !== r.ts);
  const pb = isTypingPb(prior, r);
  const gained = xpForResult(r, { pb });
  award(gained, pb ? [{ kind: "typing", key: pbKey(r), value: Math.round(r.wpm), unit: "wpm", label: pbLabel(r) }] : []);
  goalsDone(prior, allGameScores());
}

function onGame(g) {
  if (!g || !g.game) return;
  const list = store.gameScores(g.game);
  const prior = list.slice(0, -1); // addGameScore pushed this one last
  const pb = isGamePb(prior, g.score, g.meta);
  const gained = xpForGame(g.game, g.score, g.meta);
  const name = String(g.game).replace(/-/g, " ");
  award(gained, pb ? [{ kind: "game", key: g.game, value: scoreOf(g.score), unit: g.meta && g.meta.unit ? g.meta.unit : "", label: name }] : []);
  const gs = allGameScores();
  gs[g.game] = prior;
  goalsDone(store.results(), gs);
}

export function init() {
  if (!hasDom || init.done) return;
  init.done = true;
  backfill();
  loadGameIds();
  renderLevel();
  bus.on("result:saved", onResult);
  bus.on("game:finished", onGame);
  bus.on("auth:changed", () => setTimeout(renderLevel, 0)); // app.js re-renders the auth slot; keep our place
  new MutationObserver(() => { if (!typing() && queue.length) schedule(); })
    .observe(document.body, { attributes: true, attributeFilter: ["class"] });
  import("./css.js").then((m) => m.loadCss("css/gamify.css"));
}

if (hasDom) init();

export default { init, totalXp, pbKey, pbLabel, isTypingPb, isGamePb, personalBests, gameBests, calendar, timeline, frameAt, typedAt, wpmAt, charsAt, gapAt };
