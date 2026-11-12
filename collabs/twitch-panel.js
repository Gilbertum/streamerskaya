// Load the entire Collab Room module graph from the same fresh revision on every page visit.
const moduleTag = new URL(import.meta.url).search || "?load=" + Date.now();
const { twitchClientId } = await import("./firebase-config.js" + moduleTag);

// Twitch Helix: the browser uses an optional user OAuth token (no scopes).
// No Client Secret is ever stored on GitHub or in Firebase.
const AUTH_KEY = "collab-room-twitch-session-v1";
const STATE_KEY = "collab-room-twitch-state-v1";
const items = new Map();
let refreshedAt = 0, lastKey = "", loading = false, errorText = "", validatedAt = 0;
const enc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const validImage = (s) => {
  try { const u = new URL(String(s || "")); return u.protocol === "https:" ? enc(u.href) : ""; }
  catch { return ""; }
};
export function twitchLogin(link) {
  try {
    const u = new URL(String(link || ""));
    if (u.protocol !== "https:" || !["twitch.tv", "www.twitch.tv", "m.twitch.tv"].includes(u.hostname.toLowerCase())) return "";
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length !== 1 || !/^[a-zA-Z0-9_]{3,25}$/.test(parts[0])) return "";
    if (["videos", "clips", "directory", "settings", "downloads", "subscriptions", "drops", "turbo"].includes(parts[0].toLowerCase())) return "";
    return parts[0].toLowerCase();
  } catch { return ""; }
}
export function participants(members) {
  const byLogin = new Map();
  for (const member of members) {
    const login = twitchLogin(member.twitch);
    if (login && !byLogin.has(login)) byLogin.set(login, { login, nick: member.nick || login });
  }
  return [...byLogin.values()].sort((a, b) => a.nick.localeCompare(b.nick, "ru"));
}
export function twitchProfile(login) { return login ? items.get(login) || null : null; }
export function twitchEnabled() { return typeof twitchClientId === "string" && /^[a-z0-9]{12,40}$/i.test(twitchClientId.trim()); }
function access() {
  try {
    const auth = JSON.parse(sessionStorage.getItem(AUTH_KEY) || "null");
    if (!auth || !auth.token || auth.clientId !== twitchClientId || auth.expiresAt <= Date.now() + 30000) return "";
    return auth.token;
  } catch { return ""; }
}
export function hasTwitchToken() { return !!access(); }
// Scope-free Helix read access. Never store or publish this token in Firestore.
export function twitchScheduleHeaders() {
  const token = access();
  if (!twitchEnabled() || !token) return null;
  return { "Client-Id": twitchClientId, Authorization: "Bearer " + token };
}
export function startTwitchAuthorization(scopes = "", returnTab = "streamers") {
  if (!twitchEnabled()) throw new Error("Сначала нужно указать Twitch Client ID в firebase-config.js.");
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const state = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  sessionStorage.setItem(STATE_KEY, state);
  sessionStorage.setItem("collab-room-twitch-return-v1",returnTab==="calendar"?"calendar":"streamers");
  // Some privacy modes discard sessionStorage during external OAuth redirects.
  // Keep only a short-lived, one-time CSRF state backup (never the access token).
  try { localStorage.setItem("collab-room-twitch-state-backup-v2", JSON.stringify({ state, createdAt: Date.now() })); } catch {}
  const url = new URL("https://id.twitch.tv/oauth2/authorize");
  url.searchParams.set("response_type", "token");
  url.searchParams.set("client_id", twitchClientId);
  url.searchParams.set("redirect_uri", new URL("./twitch-callback.html", window.location.href).href);
  url.searchParams.set("scope", scopes);
  url.searchParams.set("state", state);
  window.location.assign(url.href);
}
export function twitchPanelHtml(members) {
  const people = participants(members);
  if (!people.length) return '<section class="panel twitch-panel"><div class="section-bar"><h3>Кто сейчас на Twitch</h3></div><p class="tiny-note">Панель появится, когда участницы добавят ссылки Twitch в профили.</p></section>';
  const enabled = twitchEnabled(), connected = hasTwitchToken();
  // Only live channels in the compact panel. The directory below lists everyone.
  const sorted = people.filter(p => items.get(p.login)?.online === true && connected && !errorText && Date.now()-refreshedAt<300000)
    .sort((a,b)=>a.nick.localeCompare(b.nick,"ru"));
  const channels = sorted.map((p) => {
    const meta = items.get(p.login);
    const known = !!meta && connected && !errorText && Date.now() - refreshedAt < 300000;
    const status = known ? (meta.online ? '<span class="twitch-status live">● В эфире</span>' : '<span class="twitch-status offline">● Не в эфире</span>')
      : '<span class="twitch-status unknown">● Статус не проверен</span>';
    const avatar = validImage(meta?.avatar);
    const avatarHtml = avatar ? '<img src="' + avatar + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
      : enc(p.nick.slice(0,1).toUpperCase());
    return '<div class="twitch-person"><span class="twitch-avatar">' + avatarHtml + '</span>' +
      '<div class="twitch-person-text"><strong title="' + enc(p.nick) + '">' + enc(p.nick) + '</strong>' + status + '</div>' +
      (known && meta.online
        ? '<a class="button small" target="_blank" rel="noopener noreferrer" href="https://www.twitch.tv/' + p.login + '">Смотреть трансляцию ↗</a>'
        : '<a class="button button-ghost small" target="_blank" rel="noopener noreferrer" href="https://www.twitch.tv/' + p.login + '">Открыть канал ↗</a>') +
      '</div>';
  }).join("");
  const note = !enabled ? '<span class="tiny-note">Для автоматической проверки статуса владелице нужно подключить Twitch Client ID.</span>' :
    !connected ? '<span class="tiny-note">Подключи свой Twitch-аккаунт, чтобы увидеть настоящие аватарки и статус онлайн.</span>' :
    errorText ? '<span class="tiny-note">' + enc(errorText) + '</span>' :
    refreshedAt ? '<span class="tiny-note">Данные Twitch обновляются примерно раз в 2 минуты, когда открыт календарь.</span>' :
    '<span class="tiny-note">Загружаем данные Twitch…</span>';
  const connect = enabled && !connected ? '<button class="button button-ghost small" data-action="connect-twitch" type="button">Подключить Twitch</button>' : '';
  const refresh = enabled && connected ? '<button class="button button-ghost small" data-action="refresh-twitch" type="button">↻ Проверить</button>' : '';
  return '<section class="panel twitch-panel"><div class="section-bar"><div><h3>Кто сейчас на Twitch</h3>' +
    '<p class="tiny-note" style="margin:0">Участницы Collab Room с заполненным Twitch-профилем</p></div><div class="button-row">' +
    connect + refresh + '</div></div><div class="twitch-people">' +
    (channels || '<div class="twitch-empty"><strong>Пока никто не стримит</strong><span>Когда кто-то из участниц запустит трансляцию, она появится здесь автоматически.</span></div>') +
    '</div><div class="twitch-help">' + note + '</div></section>';
}
export async function refreshTwitch(members, onUpdate, force = false) {
  if (!twitchEnabled() || !hasTwitchToken() || loading) return;
  const users = participants(members).slice(0, 100);
  const key = users.map((x) => x.login).join("|");
  if (!users.length) return;
  if (!force && key === lastKey && Date.now() - refreshedAt < 120000) return;
  loading = true; errorText = "";
  const token = access();
  try {
    // Twitch requires validating user tokens at startup and at least hourly.
    if (Date.now() - validatedAt >= 3600000) {
      const validation = await fetch("https://id.twitch.tv/oauth2/validate", {
        headers: { "Authorization": "OAuth " + token }, cache: "no-store"
      });
      if (!validation.ok) {
        sessionStorage.removeItem(AUTH_KEY);
        throw new Error("Авторизация Twitch истекла. Подключи Twitch повторно.");
      }
      const details = await validation.json();
      if (details.client_id !== twitchClientId) {
        sessionStorage.removeItem(AUTH_KEY);
        throw new Error("Twitch вернул токен другого приложения.");
      }
      validatedAt = Date.now();
    }
    const headers = { "Client-Id": twitchClientId, "Authorization": "Bearer " + token };
    const get = async (endpoint) => {
      const params = new URLSearchParams();
      for (const user of users) params.append("login", user.login);
      const path = endpoint === "streams" ? [...params.entries()].map(([k,v])=>["user_login",v]) : [...params.entries()];
      const q = new URLSearchParams();
      for (const [k,v] of path) q.append(k,v);
      const res = await fetch("https://api.twitch.tv/helix/" + endpoint + "?" + q.toString(), { headers, cache: "no-store" });
      if (res.status === 401) { sessionStorage.removeItem(AUTH_KEY); throw new Error("Сессия Twitch истекла. Подключи Twitch повторно."); }
      if (!res.ok) throw new Error("Twitch API: HTTP " + res.status);
      return (await res.json()).data || [];
    };
    const [userData, streams] = await Promise.all([get("users"), get("streams")]);
    const live = new Set(streams.map((p) => String(p.user_login || "").toLowerCase()));
    const profile = new Map(userData.map((p) => [String(p.login || "").toLowerCase(), p]));
    items.clear();
    for (const user of users) {
      const found = profile.get(user.login);
      if (!found) continue;
      items.set(user.login, { online: live.has(user.login), avatar: found.profile_image_url || "", displayName: found.display_name || user.nick });
    }
    lastKey = key; refreshedAt = Date.now();
  } catch (error) {
    errorText = error?.message || "Не удалось проверить Twitch.";
    // Prevent a rerender → immediate retry loop after transient API errors.
    refreshedAt = Date.now(); lastKey = key;
  } finally {
    loading = false;
    onUpdate?.();
  }
}
