// Sign-out leaves nothing of the signed-in player on the browser (the Board, 2026-09-30: "it's like I stay logged in,
// I can still see my profile as though I am, I see my level"). The server already ended the session (server.test.js,
// "register -> login -> me -> logout": /api/me answers 401 after it). What stayed was this browser's copy of the
// player: results, xp, badges, game scores, training progress, read by the header and every page, and by the next
// person at a shared computer. Signed out, the site must read as signed out, not as an empty level-1 account.
import test from "node:test";
import assert from "node:assert/strict";

// a browser's localStorage, and a fetch that answers the logout
class FakeStorage {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
globalThis.localStorage = new FakeStorage();
const calls = [];
globalThis.fetch = async (url, opts) => { calls.push(`${opts.method} ${url}`); return { ok: true, status: 200, statusText: "OK", text: async () => '{"ok":true}' }; };

const { clearPersonal, DEVICE_KEYS, results } = await import("../public/js/core/store.js");
const auth = (await import("../public/js/core/auth.js")).default;
const bus = (await import("../public/js/core/bus.js")).default;
const { levelVisible } = await import("../public/js/core/gamify.js");
const { profileState } = await import("../public/js/views/profile.js");

const PLAYER = {
  "typetrack.results.v1": JSON.stringify([{ ts: 1, wpm: 180, acc: 99, mode: "time", target: 30 }]),
  "typetrack.xp": "4200",
  "typetrack.badges": JSON.stringify(["first-test", "hundred"]),
  "typetrack.games.word-bomb": JSON.stringify([{ score: 40, meta: {}, ts: 2 }]),
  "typetrack.train.pairs": JSON.stringify({ th: 3 }),
  "typetrack.gauntlet.days": JSON.stringify(["2026-09-29"]),
  "typetrack.custom.v1": JSON.stringify("my private notes"),
  "typetrack.books.v1": JSON.stringify({ b1: { para: 4 } }),
  "typetrack.sync.uploaded": JSON.stringify({ 7: [1] }),
  "typetrack.some-future-key": JSON.stringify("added later"),
};
const DEVICE = { "typetrack.settings.v1": '{"theme":"dark"}', "typetrack.config.v1": '{"mode":"time"}', "typetrack.lb.game": '"word-bomb"', "typetrack.code-golf.lang": '"js"', "typetrack.sync.queue": "[]", "typetrack.sync.offered": "[7]" };
const OTHER = { "someone-elses-app": "untouched" };
function seed() {
  localStorage.m.clear();
  for (const [k, v] of Object.entries({ ...PLAYER, ...DEVICE, ...OTHER })) localStorage.setItem(k, v);
}

test("clearPersonal removes every personal key, a future one too, and keeps this device's preferences", () => {
  seed();
  assert.equal(clearPersonal(), Object.keys(PLAYER).length);
  for (const k of Object.keys(PLAYER)) assert.equal(localStorage.getItem(k), null, `${k} is still there`);
  for (const [k, v] of Object.entries(DEVICE)) assert.equal(localStorage.getItem(k), v, `${k} was a device preference`);
  assert.equal(localStorage.getItem("someone-elses-app"), "untouched", "only typetrack's own keys");
  assert.deepEqual(DEVICE_KEYS.map((k) => "typetrack." + k).sort(), Object.keys(DEVICE).sort());
});

test("signing out ends the session on the server and clears the browser before any view hears of it", async () => {
  seed();
  let seenAtChange = null;
  const off = bus.on("auth:changed", () => { seenAtChange = { results: results().length, xp: localStorage.getItem("typetrack.xp") }; });
  // a signed-in player, as refresh() would leave it
  globalThis.fetch = async (url, opts) => { calls.push(`${opts.method} ${url}`); return { ok: true, status: 200, statusText: "OK", text: async () => (url === "/api/me" ? '{"user":{"id":7,"name":"board"}}' : '{"ok":true}') }; };
  await auth.refresh();
  assert.equal(auth.user.name, "board");
  seenAtChange = null;
  await auth.logout();
  off?.();
  assert.ok(calls.includes("POST /api/logout"), "the server is told");
  assert.equal(auth.user, null);
  assert.deepEqual(seenAtChange, { results: 0, xp: null }, "views redraw from an empty browser, not the last player");
  assert.equal(localStorage.getItem("typetrack.settings.v1"), DEVICE["typetrack.settings.v1"]);
});

test("the header shows a level only for a signed-in player, or where there are no accounts at all", () => {
  assert.equal(levelVisible({ id: 7, name: "board" }, true), true);
  assert.equal(levelVisible(null, true), false, "signed out on typetrack.ca: no level beside 'sign in'");
  assert.equal(levelVisible(null, null), false, "not yet known: none, rather than a flash of someone's level");
  assert.equal(levelVisible(null, false), true, "no API (a static copy): this browser's progress is all there is");
});

test("#/profile signed out with nothing here says signed out, not a level-1 player; a guest who typed sees theirs", () => {
  assert.equal(profileState(null, true, { tests: 0, games: 0, xp: 0 }), "signed-out");
  assert.equal(profileState(null, true, { tests: 3, games: 0, xp: 60 }), "guest");
  assert.equal(profileState(null, true, { tests: 0, games: 2, xp: 0 }), "guest");
  assert.equal(profileState({ id: 7, name: "board" }, true, {}), "player");
  assert.equal(profileState(null, false, {}), "guest", "no accounts at all: the guest profile is the only one");
});
