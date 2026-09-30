// localStorage wrapper. Every access is try/catch'd so blocked or full storage never breaks the site.
import { emit } from "./bus.js";

const NS = "typetrack.";
const RESULTS_KEY = "typetrack.results.v1"; // keep compatible with v1 data
const MODES = new Set(["time", "words", "text"]);

function storage() {
  try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; }
}

function readRaw(fullKey, fallback) {
  try {
    const s = storage();
    if (!s) return fallback;
    const v = JSON.parse(s.getItem(fullKey));
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function writeRaw(fullKey, value) {
  try {
    const s = storage();
    if (s) s.setItem(fullKey, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function isResult(r) {
  return !!r && typeof r.ts === "number" && typeof r.wpm === "number" && typeof r.acc === "number" &&
    MODES.has(r.mode) && typeof r.target === "number";
}

export function get(key, fallback) {
  return readRaw(NS + key, fallback);
}

export function set(key, value) {
  return writeRaw(NS + key, value);
}

export function remove(key) {
  try { const s = storage(); if (s) s.removeItem(NS + key); } catch { /* ignore */ }
}

export function results() {
  const list = readRaw(RESULTS_KEY, []);
  return Array.isArray(list) ? list.filter(isResult) : [];
}

export function addResult(r) {
  if (typeof r.ts !== "number") r.ts = Date.now();
  const list = results();
  list.push(r);
  writeRaw(RESULTS_KEY, list);
  emit("result:saved", r);
  return r;
}

// Replace the whole result list (import, clear). Invalid entries are dropped. Not in the contract; additive.
export function replaceResults(list) {
  const clean = (Array.isArray(list) ? list : []).filter(isResult).sort((a, b) => a.ts - b.ts);
  writeRaw(RESULTS_KEY, clean);
  return clean;
}

export function gameScores(game) {
  const list = get("games." + game, []);
  return Array.isArray(list) ? list : [];
}

export function addGameScore(game, score, meta) {
  const entry = { score, meta: meta || {}, ts: Date.now() };
  const list = gameScores(game);
  list.push(entry);
  set("games." + game, list.slice(-500));
  emit("game:finished", { game, score, meta: entry.meta });
  return entry;
}

/**
 * What survives signing out: this device's preferences, not anybody's history. Everything else under "typetrack."
 * (results, xp, badges, game scores, training progress, custom text, reading places, anything added later) is the
 * person's, and the next person on a shared computer must not see it. An allowlist, so a new key is cleared by
 * default. The sync queue stays: it only ever posts for the user it was queued for, and holds their unsent scores.
 */
export const DEVICE_KEYS = ["settings.v1", "config.v1", "lb.game", "code-golf.lang", "sync.queue", "sync.offered"];

/** Sign-out: remove every personal key from this browser. Returns how many were removed. */
export function clearPersonal() {
  const s = storage();
  if (!s) return 0;
  const keep = new Set(DEVICE_KEYS.map((k) => NS + k));
  const drop = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(NS) && !keep.has(k)) drop.push(k);
    }
    for (const k of drop) s.removeItem(k);
  } catch { /* storage blocked: nothing we can do */ }
  emit("store:cleared", { removed: drop.length });
  return drop.length;
}

export const store = { get, set, remove, results, addResult, replaceResults, gameScores, addGameScore, isResult, clearPersonal };
export default store;
