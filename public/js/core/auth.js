// Client auth state. Degrades silently: if /api is unreachable, user stays null and refresh() never throws.
// login/register reject with {status, error} so the forms can show the message.
import { api } from "./api.js";
import { emit } from "./bus.js";
import { clearPersonal } from "./store.js";

let current = null;
let online = null; // null unknown, true the API answered, false it did not

function setUser(u) {
  const next = u && u.id != null ? { id: u.id, name: u.name } : null;
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  current = next;
  if (changed) emit("auth:changed", current);
  return current;
}

export async function refresh() {
  try {
    const r = await api.get("/api/me");
    online = true;
    return setUser(r && r.user);
  } catch (err) {
    online = !!err && err.status === 401; // 401 = API up, signed out; anything else = no API
    return setUser(null);
  }
}

export async function login(email, password) {
  const r = await api.post("/api/login", { email, password });
  online = true;
  return setUser(r && r.user);
}

export async function register(name, email, password) {
  const r = await api.post("/api/register", { name, email, password });
  online = true;
  return r;
}

export async function logout() {
  try { await api.post("/api/logout"); } catch { /* already gone or offline */ }
  // Signing out leaves nothing of this person on the browser: their history, level and badges were readable by the
  // next person at a shared computer, and made the site look signed in with only the name gone. Cleared before the
  // views hear auth:changed, so none of them redraws from it.
  clearPersonal();
  setUser(null);
}

export const auth = {
  get user() { return current; },
  get online() { return online; },
  refresh, login, register, logout,
};
export default auth;
