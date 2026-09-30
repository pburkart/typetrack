// Profile: #/profile (this browser's history) and #/profile/<name> (a player, from /api/profile/<name>).
// Level and XP, personal bests with replay and ghost links, badges, daily goals, streak and its calendar,
// totals and games. The signed-in player's own name shows the local profile (it has the replays).
import { loadCss } from "../core/css.js";
import { h, esc, fmtDuration } from "../core/ui.js";
import { levelFor, BADGES, earnedBadges, summarize, dailyGoals } from "../core/progress.js";
import { totalXp, personalBests, gameBests, calendar } from "../core/gamify.js";

let offs = [];

const fmtDate = (ts) => new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const n = (x) => Math.round(Number(x) || 0).toLocaleString();
const pct = (a, b) => Math.max(0, Math.min(100, b ? (a / b) * 100 : 0)).toFixed(1) + "%";

function allGameScores(store) {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("typetrack.games.")) out[k.slice(16)] = store.gameScores(k.slice(16));
    }
  } catch { /* storage blocked */ }
  return out;
}

async function gameNames() {
  try {
    const m = await import("./games.js");
    const list = await m.loadGames();
    return Object.fromEntries(list.map((g) => [g.id, g.name || g.id]));
  } catch {
    return {};
  }
}

/**
 * Which profile #/profile shows: the signed-in player's, a guest's (signed out, but this browser has history), or
 * "signed out" (signed out on a site with accounts, and nothing here): this browser's tests, games played and xp.
 */
export function profileState(user, online, { tests = 0, games = 0, xp = 0 } = {}) {
  if (user) return "player";
  const empty = !(tests > 0) && !(games > 0) && !(xp > 0);
  return empty && online !== false ? "signed-out" : "guest";
}

function levelBlock(name, sub, xp) {
  const l = levelFor(xp);
  return h("section", { class: "pf-head" },
    h("div", { class: "pf-level" }, h("span", { class: "pf-lv-label" }, "level"), h("span", { class: "pf-lv-num" }, l.level)),
    h("div", { class: "pf-who" },
      h("div", { class: "pf-name" }, name),
      sub ? h("div", { class: "pf-sub" }, sub) : null,
      h("div", { class: "pf-xpbar", title: `${n(l.into)} / ${n(l.next)} xp` }, h("i", { style: { width: pct(l.into, l.next) } })),
      h("div", { class: "pf-xptext" }, `${n(l.into)} / ${n(l.next)} xp to level ${l.level + 1}`, h("span", {}, ` · ${n(xp)} xp total`))));
}

function tiles(list) {
  return h("div", { class: "tiles pf-tiles" }, list.map(([label, value, small]) =>
    h("div", { class: "tile" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value, small ? h("small", {}, small) : null))));
}

function section(title, ...body) {
  return h("section", { class: "pf-section" }, h("h2", { class: "pf-h" }, title), ...body);
}

function goalsBlock(goals) {
  return h("div", { class: "pf-goals" }, goals.map((g) => {
    const shown = g.id === "minutes" ? `${fmtDuration(g.progress)} / ${fmtDuration(g.target)}` : `${n(g.progress)} / ${n(g.target)}`;
    return h("div", { class: "pf-goal" + (g.done ? " done" : "") },
      h("div", { class: "pf-goal-top" }, h("span", {}, (g.done ? "✓ " : "") + g.title), h("span", { class: "pf-goal-num" }, shown)),
      h("div", { class: "pf-meter" }, h("i", { style: { width: pct(g.progress, g.target) } })));
  }));
}

function calendarBlock(results) {
  const cols = calendar(results, new Date(), 26);
  const tip = h("div", { class: "tooltip pf-cal-tip", hidden: true });
  const grid = h("div", { class: "pf-cal" });
  let lastMonth = -1;
  const months = h("div", { class: "pf-cal-months" });
  cols.forEach((col) => {
    const m = new Date(col[0].key + "T12:00:00").getMonth();
    months.appendChild(h("span", {}, m !== lastMonth ? new Date(col[0].key + "T12:00:00").toLocaleDateString(undefined, { month: "short" }) : ""));
    lastMonth = m;
    grid.appendChild(h("div", { class: "pf-cal-col" }, col.map((c) => h("span", {
      class: `pf-cell l${c.level}` + (c.future ? " future" : ""),
      dataset: { key: c.key, s: c.seconds, t: c.tests },
    }))));
  });
  grid.addEventListener("mouseover", (e) => {
    const c = e.target.closest(".pf-cell");
    if (!c || c.classList.contains("future")) { tip.hidden = true; return; }
    const d = new Date(c.dataset.key + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    const s = Number(c.dataset.s);
    tip.innerHTML = s ? `<b>${esc(fmtDuration(s))}</b> typed · ${c.dataset.t} test${c.dataset.t === "1" ? "" : "s"} · ${esc(d)}` : `no practice · ${esc(d)}`;
    tip.hidden = false;
    const box = wrap.getBoundingClientRect(), r = c.getBoundingClientRect();
    tip.style.left = r.left - box.left + r.width / 2 + "px";
    tip.style.top = r.top - box.top - 4 + "px";
  });
  grid.addEventListener("mouseleave", () => { tip.hidden = true; });
  const legend = h("div", { class: "pf-cal-legend" }, "less", [0, 1, 2, 3, 4].map((l) => h("span", { class: "pf-cell l" + l })), "more");
  const wrap = h("div", { class: "pf-cal-wrap" }, months, grid, legend, tip);
  return wrap;
}

function badgesBlock(earned) {
  const have = new Set(earned);
  const count = BADGES.filter((b) => have.has(b.id)).length;
  return [
    h("div", { class: "pf-note" }, `${count} of ${BADGES.length} earned`),
    h("div", { class: "pf-badges" }, BADGES.map((b) =>
      h("div", { class: "pf-badge" + (have.has(b.id) ? " on" : ""), title: b.desc },
        h("span", { class: "pf-badge-icon" }, b.icon),
        h("span", { class: "pf-badge-name" }, b.name),
        h("span", { class: "pf-badge-desc" }, b.desc)))),
  ];
}

function pbTable(rows) {
  if (!rows.length) return h("p", { class: "pf-empty" }, "no results yet — ", h("a", { href: "#/test" }, "take a test"));
  return h("table", { class: "recent pf-pbs" },
    h("thead", {}, h("tr", {}, ["mode", "wpm", "acc", "date", "runs", ""].map((x, i) => h("th", { class: i && i < 3 || i === 4 ? "num" : "" }, x)))),
    h("tbody", {}, rows.map((p) => h("tr", {},
      h("td", {}, p.label),
      h("td", { class: "num wpm" }, Math.round(p.wpm)),
      h("td", { class: "num" }, Math.round(p.acc) + "%"),
      h("td", {}, fmtDate(p.ts)),
      h("td", { class: "num" }, p.count == null ? "" : p.count),
      h("td", { class: "pf-links" },
        p.replay ? h("a", { href: p.replay }, "replay") : h("span", { class: "pf-dim", title: "this run has no keystroke log" }, "replay"),
        p.ghost ? h("a", { href: "#/games/ghost-race" }, "race ghost") : null)))));
}

function gamesBlock(bests, names) {
  const ids = Object.keys(bests);
  if (!ids.length) return h("p", { class: "pf-empty" }, "no games played yet — ", h("a", { href: "#/games" }, "play one"));
  return h("table", { class: "recent pf-games" },
    h("thead", {}, h("tr", {}, h("th", {}, "game"), h("th", { class: "num" }, "best"), h("th", { class: "num" }, "plays"), h("th", {}, "date"))),
    h("tbody", {}, ids.sort((a, b) => (bests[b].plays || 0) - (bests[a].plays || 0)).map((id) => {
      const g = bests[id];
      return h("tr", {},
        h("td", {}, h("a", { href: "#/games/" + encodeURIComponent(id) }, names[id] || id.replace(/-/g, " "))),
        h("td", { class: "num wpm" }, Number.isInteger(g.best) ? n(g.best) : g.best.toFixed(1), g.asc ? h("small", { class: "pf-dim" }, " lowest") : null),
        h("td", { class: "num" }, g.plays == null ? "" : g.plays),
        h("td", {}, g.ts ? fmtDate(g.ts) : ""));
    })));
}

function renderLocal(root, ctx, names) {
  const { store, auth } = ctx;
  const results = store.results();
  const games = allGameScores(store);
  const xp = totalXp();
  const s = summarize(results, games, { xp });
  const earned = [...new Set([...(store.get("badges", []) || []), ...earnedBadges(s)])];
  const pbs = personalBests(results).map((p) => ({
    label: p.label, wpm: p.r.wpm, acc: p.r.acc, ts: p.r.ts, count: p.count,
    replay: Array.isArray(p.r.log) && p.r.log.length ? `#/replay/${p.r.ts}` : null,
    ghost: Array.isArray(p.r.log) && p.r.log.length > 0,
  }));
  const user = auth.user;
  // Signed out with nothing on this browser (as after signing out, which clears it): say so, rather than draw an
  // empty level-1 player that reads as somebody's account. A guest who has typed here still sees their history.
  if (profileState(user, auth.online, { tests: s.tests, games: s.gamesDistinct, xp }) === "signed-out") {
    root.replaceChildren(h("div", { class: "view view-profile" }, h("div", { class: "notice pf-signed-out" },
      h("div", { class: "notice-title" }, "you are signed out"),
      h("p", {}, "sign in to see your profile, level and history."),
      h("p", {}, h("a", { href: "#/login" }, "sign in"), " · ", h("a", { href: "#/register" }, "create an account"), " · ", h("a", { href: "#/test" }, "take a test as a guest")))));
    return;
  }
  const sub = user ? `signed in · results sync to your account` : h("span", {}, "guest · not signed in · this browser only · ", h("a", { href: "#/login" }, "sign in"), " to keep it");
  root.replaceChildren(h("div", { class: "view view-profile" },
    levelBlock(user ? user.name : "guest", sub, xp),
    tiles([
      ["tests", n(s.tests)],
      ["time typed", fmtDuration(s.secondsTyped)],
      ["characters", n(s.charsTyped)],
      ["best wpm", n(s.bestWpm)],
      ["streak", s.streak.current, s.streak.current === 1 ? "day" : "days"],
      ["best streak", s.streak.best, s.streak.best === 1 ? "day" : "days"],
    ]),
    section("daily goals", goalsBlock(dailyGoals(results, games))),
    section("streak", calendarBlock(results)),
    section("personal bests", pbTable(pbs)),
    section("badges", ...badgesBlock(earned)),
    section("games", gamesBlock(gameBests(games), names)),
  ));
}

function renderRemote(root, p, names) {
  const earned = (p.badges || []).map((b) => (typeof b === "string" ? b : b.id));
  const pbs = (p.pbs || []).map((x) => ({
    label: `${x.mode} ${x.target}` + (x.lang && x.lang !== "en" ? ` · ${x.lang}` : ""),
    wpm: x.wpm, acc: x.acc, ts: x.ts, count: null,
    replay: x.resultId != null ? `#/replay/s${x.resultId}` : null, ghost: false,
  }));
  const games = {};
  for (const [id, best] of Object.entries(p.games || {})) games[id] = { best: Number(best) || 0, plays: null, ts: null, asc: false };
  const best = Math.max(0, ...(p.pbs || []).map((x) => x.wpm || 0));
  root.replaceChildren(h("div", { class: "view view-profile" },
    levelBlock(p.name, p.joined ? `joined ${fmtDate(p.joined)}` : null, p.xp || 0),
    tiles([["tests", n(p.tests)], ["time typed", fmtDuration(p.seconds || 0)], ["best wpm", n(best)]]),
    section("personal bests", pbTable(pbs)),
    section("badges", ...badgesBlock(earned)),
    section("games", gamesBlock(games, names)),
  ));
}

function notice(root, title, text) {
  root.replaceChildren(h("div", { class: "notice" }, h("div", { class: "notice-title" }, title), h("p", {}, text),
    h("a", { href: "#/profile" }, "your profile on this browser")));
}

async function mount(root, ctx) {
  await Promise.all([loadCss("css/profile.css"), loadCss("css/gamify.css")]);
  const names = await gameNames();
  const name = ctx.params.name;
  const me = ctx.auth.user;
  if (!name || (me && me.name === name)) {
    const draw = () => renderLocal(root, ctx, names);
    draw();
    offs.push(ctx.bus.on("xp", draw), ctx.bus.on("auth:changed", draw));
    return;
  }
  root.replaceChildren(h("p", { class: "pf-empty" }, "loading " + name + "…"));
  try {
    const p = await ctx.api.get("/api/profile/" + encodeURIComponent(name));
    if (!root.isConnected) return;
    renderRemote(root, p, names);
  } catch (err) {
    if (ctx.auth.online == null) await ctx.auth.refresh(); // a static server 404s /api too; only a live API means "no such player"
    if (!root.isConnected) return;
    if (err && err.status === 404 && ctx.auth.online) notice(root, "no such player", `there is no player called “${name}”.`);
    else notice(root, "profiles are offline", `${name}'s profile lives on the server, which isn't reachable right now. your own profile works offline.`);
  }
}

function unmount() {
  offs.forEach((f) => f());
  offs = [];
}

export default { mount, unmount };
