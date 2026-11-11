import { firebaseConfig } from "./firebase-config.js";
import { twitchPanelHtml, refreshTwitch, startTwitchAuthorization } from "./twitch-panel.js";
import { startPublicView } from "./views.js";
import { startModeratorV3 } from "./moderator-v3.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, sendPasswordResetEmail, signOut } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, collection, query, where, setDoc, addDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp, writeBatch } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const screen = $("screen");
const nav = $("nav");
const flash = $("flash");
const modal = $("modal");
let auth = null, db = null;
const state = {
  uid: null, nick: "", member: null, authorized: false, busy: false,
  members: [], slots: [], locks: [], sent: [], received: [],
  unsubs: [], tab: "calendar", inboxFilter: "pending",
  date: mskToday(), month: mskToday().slice(0, 7),
  search: { date: mskToday(), start: "20:00", end: "23:00", game: "" }
};

function h(value) {
  return String(value === undefined || value === null ? "" : value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function safeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? h(url.href) : "";
  } catch { return ""; }
}
function mskToday() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return get("year") + "-" + get("month") + "-" + get("day");
}
function addDays(iso, days) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function dateLabel(iso, style = "long") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) return "—";
  return new Date(iso + "T12:00:00Z").toLocaleDateString("ru-RU",
    style === "short" ? { day: "2-digit", month: "2-digit" } : { weekday: "long", day: "numeric", month: "long" });
}
function isDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value || "") && !Number.isNaN(Date.parse(value + "T12:00:00Z")); }
function isTime(value) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(value || ""); }
function interval(event) {
  if (!isDate(event.date) || !isTime(event.start) || !isTime(event.end)) return [0, 0];
  const a = Date.parse(event.date + "T" + event.start + ":00+03:00");
  let b = Date.parse(event.date + "T" + event.end + ":00+03:00");
  if (b <= a) b += 86400000; // Время окончания меньше начала = следующий день.
  return [a, b];
}
function overlaps(a, b) {
  const x = interval(a), y = interval(b);
  return x[0] < y[1] && y[0] < x[1];
}
function flashMessage(message, error = false) {
  flash.textContent = message;
  flash.className = error ? "flash bad" : "flash";
  flash.hidden = false;
  clearTimeout(flash._timer);
  flash._timer = setTimeout(() => { flash.hidden = true; }, 6500);
}
function readableError(error) {
  const code = error?.code || "";
  if (code.includes("permission-denied")) return "Нет прав для этого действия. Проверь допуск в allowedUsers и опубликованные Firestore Rules.";
  if (code.includes("auth/invalid-credential") || code.includes("auth/wrong-password") || code.includes("auth/user-not-found")) return "Почта или пароль не подошли.";
  if (code.includes("auth/too-many-requests")) return "Слишком много попыток входа. Попробуй позже.";
  if (code.includes("auth/invalid-email")) return "Неверный адрес электронной почты.";
  if (code.includes("unavailable")) return "Firebase временно недоступен. Проверь подключение к сети.";
  return error?.message || "Неизвестная ошибка";
}
function modalOpen(content) {
  $("modalContent").innerHTML = content;
  modal.hidden = false;
  setTimeout(() => modal.querySelector("input,textarea,select,button")?.focus(), 20);
}
function modalClose() {
  modal.hidden = true;
  $("modalContent").innerHTML = "";
}
function fmtTime(obj) { return obj.start === "00:00" && obj.end === "00:00" ? "Весь день" : h(obj.start) + "–" + h(obj.end) + (obj.end <= obj.start ? " (+1 день)" : ""); }
function person(id) { return state.members.find((m) => m.id === id); }
function nameOf(id) { return person(id)?.nick || "Стример"; }
function profileLinks(member) {
  const links = [];
  const dm = safeUrl(member?.telegramDM);
  if (dm) links.push('<a href="' + dm + '" target="_blank" rel="noopener noreferrer">✉ Написать в Telegram ↗</a>');
  const twitch = safeUrl(member?.twitch);
  const steam = safeUrl(member?.steam);
  if (twitch) links.push('<a href="' + twitch + '" target="_blank" rel="noopener noreferrer">Twitch ↗</a>');
  if (steam) links.push('<a href="' + steam + '" target="_blank" rel="noopener noreferrer">Steam ↗</a>');
  return links.join("");
}
function typeName(type) {
  return ({ stream: "Стрим", off: "Выходной", busy: "Недоступна", maybe: "Под вопросом", free: "Свободна", collab: "Коллаб" })[type] || "Событие";
}
function proposals() {
  const map = new Map([...state.sent, ...state.received].map((p) => [p.id, p]));
  return [...map.values()].sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
}
function myItems(date) {
  const slots = state.slots.filter((item) => item.ownerUid === state.uid && item.date === date)
    .map((item) => ({ ...item, kind: "slot" }));
  const locks = state.locks.filter((item) => (item.fromUid === state.uid || item.toUid === state.uid) && item.date === date)
    .map((item) => ({ ...item, id: item.id, type: "collab", kind: "lock" }));
  return [...slots, ...locks].sort((a, b) => a.start.localeCompare(b.start));
}
function availability(memberId, request, ignoreLockId = "") {
  const problems = [];
  for (const item of state.slots) {
    if (item.ownerUid !== memberId || item.type === "free") continue;
    if (overlaps(item, request)) problems.push(item.type === "maybe" ? "maybe" : "busy");
  }
  for (const item of state.locks) {
    if (item.id === ignoreLockId || (item.fromUid !== memberId && item.toUid !== memberId)) continue;
    if (overlaps(item, request)) problems.push("busy");
  }
  if (problems.includes("busy")) return "busy";
  if (problems.includes("maybe")) return "maybe";
  return "free"; // Если ничего не отмечено, можно предложить коллаб.
}
function countPending() {
  return state.received.filter((p) => p.status === "pending").length;
}
function render() {
  if (!state.authorized) return;
  nav.hidden = false;
  $("logout").hidden = false;
  $("identity").textContent = state.nick;
  $("pendingCount").textContent = countPending() ? String(countPending()) : "";
  for (const button of nav.querySelectorAll("[data-tab]")) button.classList.toggle("active", button.dataset.tab === state.tab);
  if (state.tab === "search") renderSearch();
  else if (state.tab === "inbox") renderInbox();
  else if (state.tab === "profile") renderProfile();
  else renderCalendar();
}
function renderCalendar() {
  const [year, month] = state.month.split("-").map(Number);
  const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const begin = addDays(state.month + "-01", -firstWeekday);
  const lastDate = new Date(year, month, 0).getDate();
  const count = firstWeekday + lastDate <= 35 ? 35 : 42;
  let dayButtons = "";
  for (let i = 0; i < count; i++) {
    const date = addDays(begin, i);
    const items = myItems(date);
    const classes = ["day"];
    if (date.slice(0, 7) !== state.month) classes.push("outside");
    if (date === state.date) classes.push("selected");
    if (date === mskToday()) classes.push("today");
    const shortName = (item) => item.type === "stream" ? "Стрим" : item.type === "off" ? "Выходной"
      : item.type === "collab" ? "Коллаба" : item.type === "maybe" ? "Под вопросом" : item.type === "busy" ? "Занято" : "Свободно";
    dayButtons += '<button type="button" class="' + classes.join(" ") + '" data-action="select-day" data-date="' + date + '"><span class="day-number">' + Number(date.slice(8)) + '</span>' +
      '<span class="calendar-day-labels">' + items.slice(0, 3).map((item) =>
        '<span class="calendar-day-label ' + h(item.type) + '" title="' + h(item.type === "stream" ? (item.title || "Стрим") : item.type === "collab" ? (item.game || "Коллаба") : shortName(item)) + '">' +
        h(shortName(item)) + '</span>').join("") +
      (items.length > 3 ? '<span class="calendar-more">+' + (items.length - 3) + '</span>' : "") +
      '</span></button>';
  }
  const events = myItems(state.date).map((item) => {
    const isLock = item.kind === "lock";
    const title = isLock ? ("Коллаб: " + item.game) : (item.type === "stream" ? (item.title || "Без названия") : typeName(item.type));
    const other = isLock ? (' · с ' + nameOf(item.fromUid === state.uid ? item.toUid : item.fromUid)) : "";
    const controls = isLock
      ? '<div class="event-actions"><button class="button button-ghost tiny" data-action="visibility-collab" data-id="' + h(item.id) + '">Зрителям</button><button class="button button-ghost tiny" data-action="move-collab" data-id="' + h(item.id) + '">Перенести</button><button class="button button-subtle tiny" data-action="cancel-collab" data-id="' + h(item.id) + '">Отменить</button></div>'
      : '<div class="event-actions"><button class="button button-ghost tiny" data-action="edit-event" data-id="' + h(item.id) + '">Изменить</button><button class="button button-subtle tiny" data-action="delete-event" data-id="' + h(item.id) + '">Удалить</button></div>';
    return '<div class="event"><div><div class="event-title">' + h(title) + '</div><div class="event-when">' + fmtTime(item) + h(other) + '</div>' +
      '<div style="margin-top:7px"><span class="tag ' + h(item.type) + '">' + typeName(item.type) + '</span>' +
      (!isLock && item.public === true ? ' <span class="tag free">Публично</span>' : "") + '</div></div><div>' + controls + '</div></div>';
  }).join("");
  screen.innerHTML = '<div class="hero"><div><p class="eyebrow">Личный планировщик</p><h1>Твой календарь</h1><p class="sub">Планируй стримы и выходные, а через «Хочу коллабу» отправляй одной заявкой несколько вариантов времени выбранным участницам.</p></div><div class="button-row"><button class="button button-ghost" data-action="refresh">↻ Обновить</button><button class="button button-ghost" data-action="new-wish">✦ Хочу коллабу</button><button class="button" data-action="new-event">+ Добавить событие</button></div></div>' +
    twitchPanelHtml(state.members) + '<div class="split"><section class="panel"><div class="section-bar"><h2 class="calendar-heading">' +
    new Date(year, month - 1, 1).toLocaleDateString("ru-RU", { month: "long", year: "numeric" }) +
    '</h2><div class="button-row"><button class="button button-ghost small" data-action="previous-month">←</button><button class="button button-ghost small" data-action="current-month">Сегодня</button><button class="button button-ghost small" data-action="next-month">→</button></div></div><div class="calendar-week">' +
    ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((x) => "<span>" + x + "</span>").join("") +
    '</div><div class="calendar-grid">' + dayButtons + '</div><p class="tiny-note" style="margin:15px 0 0">Розовый — стрим · серо-синий — выходной · синий — коллаба. Открой день, чтобы увидеть подробности.</p></section>' +
    '<section class="panel"><div class="section-bar"><h2 style="text-transform:capitalize">' + h(dateLabel(state.date)) + '</h2><button class="button button-ghost small" data-action="new-event">+ Событие</button></div>' +
    (events || '<div class="empty"><strong>Планов нет</strong>В этот день ты свободна для предложений.</div>') +
    '<div class="mini-spacer"></div><div class="notice info">Подтверждённые коллабы появляются здесь автоматически. Личные отметки видны только участникам комнаты.</div></section></div>';
  refreshTwitch(state.members, () => { if (state.authorized && state.tab === "calendar") renderCalendar(); });
}
function renderSearch() {
  const request = state.search;
  const sorted = state.members.filter((m) => m.id !== state.uid).map((m) => ({ ...m, status: availability(m.id, request) }));
  const order = { free: 0, maybe: 1, busy: 2 };
  sorted.sort((a, b) => (order[a.status] - order[b.status]) || a.nick.localeCompare(b.nick, "ru"));
  const results = sorted.map((m) => {
    const statusLabel = m.status === "free" ? "Свободна" : m.status === "maybe" ? "Под вопросом" : "Занята";
    const extra = [m.weekdays ? "Будни: " + m.weekdays : "", m.weekend ? "Выходные: " + m.weekend : ""].filter(Boolean).join(" · ");
    return '<div class="search-result"><div class="person"><span class="avatar">' + h((m.nick || "?")[0].toUpperCase()) + '</span><div><div class="person-title">' + h(m.nick) + '</div><div class="person-meta">' + h(extra || "Окна уточняются в личной переписке") + '</div><div class="links" style="margin-top:7px">' + profileLinks(m) + '</div></div></div><div class="result-right"><span class="tag ' + m.status + '">' + statusLabel + '</span><button class="button small" data-action="invite" data-uid="' + h(m.id) + '"' + (m.status === "busy" ? " disabled" : "") + '>Пригласить →</button></div></div>';
  }).join("");
  screen.innerHTML = '<div class="hero"><div><p class="eyebrow">Поиск свободных окон</p><h1>Собрать коллаб</h1><p class="sub">Укажи игру, дату и время — увидишь доступность каждой участницы. Время фиксируется по Москве.</p></div></div>' +
    '<div class="panel"><form data-form="search" class="form-grid"><div class="field"><label for="findDate">Дата</label><input id="findDate" type="date" name="date" value="' + h(request.date) + '" required></div>' +
    '<div class="field"><label for="findGame">Игра или идея</label><input id="findGame" type="text" name="game" maxlength="90" placeholder="Например, The Forest" value="' + h(request.game) + '" required></div>' +
    '<div class="field"><label for="findStart">Начало, МСК</label><input id="findStart" type="time" name="start" value="' + h(request.start) + '" required></div>' +
    '<div class="field"><label for="findEnd">Конец, МСК</label><input id="findEnd" type="time" name="end" value="' + h(request.end) + '" required></div>' +
    '<div class="full button-row"><button class="button" type="submit">Найти участников</button><span class="tiny-note">Если конец раньше начала, считаем, что коллаб закончится на следующий день.</span></div></form></div>' +
    '<div class="section-bar" style="margin-top:25px"><h2>Кого можно пригласить</h2><span class="tiny-note">' + sorted.filter((p) => p.status === "free").length + " свободны · " + sorted.filter((p) => p.status === "maybe").length + " под вопросом</span></div>" +
    '<div>' + (results || '<div class="empty">Пока в комнате нет других участниц. Добавь их через Firebase Authentication и allowedUsers.</div>') + '</div>' +
    '<div class="notice info">Поиск учитывает отмеченные стримы, блокировки, сомнительные окна и принятые коллабы. Это предварительная проверка: окончательное согласие даёт сама участница.</div>';
}
function renderInbox() {
  const all = proposals();
  const pending = all.filter((p) => p.status === "pending");
  const shown = state.inboxFilter === "pending" ? pending : all;
  const statusNames = { pending: "Ожидает ответа", accepted: "Принято", declined: "Отклонено", cancelled: "Отменено" };
  const rows = shown.map((p) => {
    const inbound = p.toUid === state.uid;
    const someone = inbound ? nameOf(p.fromUid) : nameOf(p.toUid);
    const controls = [];
    if (inbound && p.status === "pending") {
      controls.push('<button class="button small" data-action="respond" data-answer="accepted" data-id="' + h(p.id) + '">Принять</button>');
      controls.push('<button class="button button-ghost small" data-action="respond" data-answer="declined" data-id="' + h(p.id) + '">Отклонить</button>');
    }
    if ((p.status === "pending" && !inbound) || p.status === "accepted") controls.push('<button class="button button-subtle small" data-action="respond" data-answer="cancelled" data-id="' + h(p.id) + '">Отменить</button>');
    const choices = Array.isArray(p.timeOptions) && p.timeOptions.length ? p.timeOptions : null;
    const chooser = choices && p.status === "pending"
      ? (inbound ? '<div class="field" style="margin:12px 0"><label>Выбери подходящее время</label><select data-proposal-choice="' + h(p.id) + '">' +
        choices.map((t, i) => '<option value="' + i + '">' + h(dateLabel(t.date)) + ' · ' + fmtTime(t) + ' МСК</option>').join("") +
        '</select></div>'
        : '<p class="tiny-note" style="margin:9px 0">Предложено ' + choices.length + ' вариантов. Получатель выберет подходящий.</p>')
      : "";
    return '<article class="invite"><div class="invite-top"><div><div class="invite-title">' + (p.replacesId ? '↪ Перенос · ' : '') + h(p.game) + '</div><div class="invite-detail">' + (inbound ? 'От ' : 'Для ') + h(someone) + ' · ' + h(dateLabel(p.date)) + ' · ' + fmtTime(p) + '</div></div><span class="tag status-' + h(p.status) + '">' + h(statusNames[p.status] || p.status) + '</span></div>' +
      chooser +
      (p.message ? '<div class="invite-message">' + h(p.message) + '</div>' : "") +
      '<div class="button-row">' + controls.join("") + '</div></article>';
  }).join("");
  screen.innerHTML = '<div class="hero"><div><p class="eyebrow">Центр согласований</p><h1>Приглашения</h1><p class="sub">Предложения появятся здесь без перезагрузки страницы. Принятая коллаба сразу займёт окно у обеих участниц.</p></div></div>' +
    '<div class="panel"><div class="tabs-mini"><button class="' + (state.inboxFilter === "pending" ? "active" : "") + '" data-action="inbox-pending">Ожидают ответа (' + pending.length + ')</button><button class="' + (state.inboxFilter === "all" ? "active" : "") + '" data-action="inbox-all">Вся история (' + all.length + ')</button></div>' +
    (rows || '<div class="empty"><strong>Приглашений пока нет</strong>Загляни в «Собрать коллаб», чтобы позвать подруг поиграть.</div>') +
    '</div>';
}
function publicLink(uid) { return location.origin + location.pathname + "#/s/" + encodeURIComponent(uid); }
function moderatorLink(uid) { return location.origin + location.pathname + "#/mod/" + encodeURIComponent(uid); }
function renderProfile() {
  const m = state.member || {};
  screen.innerHTML = '<div class="hero"><div><p class="eyebrow">Твои настройки</p><h1>Профиль стримера</h1><p class="sub">Ник и ссылки видны другим участницам. Почта, пароль и личные отметки не отображаются в публичном расписании.</p></div></div>' +
    '<div class="two"><section class="panel"><h2>О себе</h2><form data-form="profile" class="form-grid">' +
    '<div class="field full"><label for="nick">Никнейм *</label><input id="nick" name="nick" maxlength="40" required value="' + h(m.nick || state.nick) + '"></div>' +
    '<div class="field full"><label for="twitch">Ссылка на Twitch</label><input id="twitch" name="twitch" type="url" placeholder="https://www.twitch.tv/..." value="' + h(m.twitch || "") + '"></div>' +
    '<div class="field full"><label for="steam">Ссылка на Steam</label><input id="steam" name="steam" type="url" placeholder="https://steamcommunity.com/..." value="' + h(m.steam || "") + '"></div>' +
    '<div class="field"><label for="telegram">Telegram</label><input id="telegram" name="telegram" type="url" placeholder="https://t.me/..." value="' + h(m.telegram || "") + '"></div>' +
    '<div class="field full"><label for="telegramDM">Личный Telegram для связи со стримерами (не виден зрителям)</label><input id="telegramDM" name="telegramDM" type="url" placeholder="https://t.me/your_username" value="' + h(m.telegramDM || "") + '"></div>' +
    '<div class="field"><label for="youtube">YouTube</label><input id="youtube" name="youtube" type="url" placeholder="https://www.youtube.com/..." value="' + h(m.youtube || "") + '"></div>' +
    '<div class="field"><label for="tiktok">TikTok</label><input id="tiktok" name="tiktok" type="url" placeholder="https://www.tiktok.com/@..." value="' + h(m.tiktok || "") + '"></div>' +
    '<div class="field"><label for="discord">Discord</label><input id="discord" name="discord" type="url" placeholder="https://discord.gg/..." value="' + h(m.discord || "") + '"></div>' +
    '<div class="field"><label for="weekdays">Обычно в будни (МСК)</label><input id="weekdays" name="weekdays" maxlength="80" placeholder="20:00–02:00" value="' + h(m.weekdays || "") + '"></div>' +
    '<div class="field"><label for="weekend">Обычно в выходные (МСК)</label><input id="weekend" name="weekend" maxlength="80" placeholder="15:00–00:00" value="' + h(m.weekend || "") + '"></div>' +
    '<div class="full"><p class="tiny-note">Обычное время — справочная подсказка. Фактическая занятость определяется отметками в календаре.</p></div>' +
    '<div class="full"><button class="button" type="submit">Сохранить профиль</button></div></form></section>' +
    '<section class="panel"><h2>Ссылка для зрителей</h2><p class="muted">Зрители смогут увидеть только события с отметкой «Не показывать зрителям».</p><div class="profile-link">' + h(publicLink(state.uid)) + '</div>' +
    '<div class="button-row"><button class="button" data-action="copy-public">Копировать ссылку</button><a class="button button-ghost" href="' + h(publicLink(state.uid)) + '" target="_blank" rel="noopener noreferrer">Посмотреть ↗</a></div>' +
    '<div class="notice info">Дни «недоступна» и «под вопросом», переписка и приглашения не попадут в ссылку для сообщества.</div>' +
    '<h3 style="margin-top:26px">Ссылка для модераторов</h3><p class="muted">Месяц и детали подтверждённых коллабов. Доступ есть только у тех, кому разрешение выдано в Firebase.</p>' +
    '<div class="profile-link">' + h(moderatorLink(state.uid)) + '</div>' +
    '<div class="button-row"><button class="button button-ghost small" data-action="copy-moderator">Копировать ссылку для модератора</button></div>' +
    '<p class="tiny-note">Создай в Firebase moderatorAccess / ' + h(state.uid) + ' / users / UID_МОДЕРАТОРА с полем enabled = true (boolean). Сама ссылка прав не даёт.</p>' +
    '<h3 style="margin-top:26px">Доступ в комнату</h3><p class="tiny-note">Новых участниц добавляет владелица Firebase: создаёт учётную запись и разрешает UID в коллекции allowedUsers. Публичной регистрации здесь нет.</p>' +
    '<p class="tiny-note">Твой UID для настройки доступа: <code>' + h(state.uid) + '</code></p></section></div>';
}
function eventModal(id) {
  const item = state.slots.find((x) => x.id === id && x.ownerUid === state.uid);
  const source = item || { date: state.date, start: "20:00", end: "23:00", type: "stream", title: "", public: true };
  const option = (value, label) => '<option value="' + value + '"' + (source.type === value ? ' selected' : "") + '>' + label + '</option>';
  modalOpen('<h2 id="modalTitle">' + (item ? "Редактировать событие" : "Новое событие") + '</h2><p class="muted">Дату и часы вводим по Москве. Пустой день считается свободным.</p>' +
    '<form data-form="event" data-id="' + h(id || "") + '" class="form-grid"><div class="field full"><label>Тип отметки</label><select name="type">' +
    option("stream", "Стрим / запланированная игра") + option("off", "Выходной") + (!item ? option("wish", "✦ Хочу коллабу") : "") + '</select></div>' +
    '<div class="field full"><label>Игра / название стрима (для типа «Стрим»)</label><input name="title" maxlength="90" value="' + h(source.title || "") + '" placeholder="Far Far West"></div>' +
    '<div class="field full"><label>Примечания для участниц и модераторов (не видны зрителям)</label><textarea name="details" maxlength="500" placeholder="Например, гости, план или примечания">' + h(source.details || "") + '</textarea></div>' +
    '<div class="field"><label>Дата</label><input type="date" name="date" value="' + h(source.date) + '" required></div>' +
    '<div class="field"><label>Начало, МСК</label><input type="time" name="start" value="' + h(source.start) + '" required></div>' +
    '<div class="field"><label>Конец, МСК</label><input type="time" name="end" value="' + h(source.end) + '" required></div>' +
    '<div class="full"><button type="button" class="button button-ghost small" data-action="whole-day">Отметить весь день (00:00–00:00)</button></div>' +
    '<label class="check-line" style="align-self:end;padding-bottom:9px"><input name="hidePublic" type="checkbox" ' + (source.public === false ? "checked" : "") + '>Не показывать зрителям</label>' +
    '<p class="tiny-note full">Стримы и выходные публикуются автоматически. Галочка скрывает событие. У коллабов отдельные настройки видимости.</p>' +
    '<div class="form-actions full">' + (item ? '<button type="button" class="button button-subtle" data-action="delete-event" data-id="' + h(id) + '">Удалить</button>' : "") +
    '<button type="button" class="button button-ghost" data-action="close-modal">Закрыть</button><button type="submit" class="button">Сохранить</button></div></form>');
}
function wishTimeRow(index, date = state.date, start = "20:00", end = "23:00") {
  return '<div class="wish-time-row" data-wish-row><span class="wish-number">Вариант ' + (index + 1) + '</span>' +
    '<div class="field"><label>Дата</label><input type="date" name="wishDate" value="' + h(date) + '" required></div>' +
    '<div class="field"><label>Начало, МСК</label><input type="time" name="wishStart" value="' + h(start) + '" required></div>' +
    '<div class="field"><label>Конец, МСК</label><input type="time" name="wishEnd" value="' + h(end) + '" required></div>' +
    '<button type="button" class="button button-ghost tiny" data-action="remove-wish-row" aria-label="Удалить вариант">×</button></div>';
}
function wishModal() {
  const others = state.members.filter((member) => member.id !== state.uid).sort((a, b) => a.nick.localeCompare(b.nick, "ru"));
  const people = others.map((member) => {
    const text = "Доступность каждого варианта проверится при отправке";
    const dm = safeUrl(member.telegramDM);
    return '<div class="wish-person-wrap"><label class="wish-person"><input type="checkbox" name="wishRecipient" value="' + h(member.id) + '">' +
      '<span class="wish-person-details"><strong>' + h(member.nick || "Участница") + '</strong>' +
      '<small>' + h(text) + '</small></span></label>' +
      (dm ? '<a class="wish-contact" href="' + dm + '" target="_blank" rel="noopener noreferrer">ЛС ↗</a>' : "") + '</div>';
  }).join("");
  modalOpen('<h2 id="modalTitle">✦ Хочу коллабу</h2><p class="muted">Укажи игру и до пяти вариантов времени. Выбери участниц галочками — каждая получит одно приглашение и сама выберет подходящий вариант.</p>' +
    '<form data-form="wish"><div class="field"><label>Игра или идея *</label><input type="text" name="game" maxlength="90" placeholder="Например, The Forest" required></div>' +
    '<div class="section-bar" style="margin:18px 0 9px"><h3>Варианты даты и времени</h3><button class="button button-ghost small" type="button" data-action="add-wish-row">+ Ещё вариант</button></div>' +
    '<div id="wishRows" class="wish-rows">' + wishTimeRow(0) + '</div>' +
    '<div class="section-bar" style="margin:22px 0 9px"><h3>Кого пригласить</h3><span class="tiny-note">До 10 участниц</span></div>' +
    (people ? '<div class="wish-people">' + people + '</div>' : '<div class="notice info">В комнате пока нет других участниц.</div>') +
    '<div class="field" style="margin-top:17px"><label>Сообщение (необязательно)</label><textarea name="message" maxlength="500" placeholder="Девочки, кто за совместный забег?"></textarea></div>' +
    '<p class="tiny-note" style="margin:12px 0">Приглашения отправятся выбранным участницам после нажатия кнопки. Ожидающие ответы не блокируют время.</p>' +
    '<div class="form-actions"><button type="button" class="button button-ghost" data-action="close-modal">Отмена</button>' +
    '<button type="submit" class="button">Отправить приглашения</button></div></form>');
}
async function sendWish(form) {
  const game = String(form.elements.game.value || "").trim().slice(0, 90);
  if (!game) throw new Error("Укажи игру или идею коллаба.");
  const rows = [...form.querySelectorAll("[data-wish-row]")];
  if (!rows.length || rows.length > 5) throw new Error("Можно выбрать от одного до пяти вариантов времени.");
  const options = rows.map((row) => ({
    date: row.querySelector('[name="wishDate"]').value,
    start: row.querySelector('[name="wishStart"]').value,
    end: row.querySelector('[name="wishEnd"]').value
  }));
  for (const option of options) {
    if (!isDate(option.date) || !isTime(option.start) || !isTime(option.end) || option.start === option.end)
      throw new Error("В каждом варианте должны быть правильная дата и разные часы начала и конца.");
    if (option.date < mskToday()) throw new Error("Вариант не может быть в прошлом.");
  }
  if (new Set(options.map((o) => o.date + o.start + o.end)).size !== options.length)
    throw new Error("Убери повторяющиеся варианты даты и времени.");
  const selected = [...form.querySelectorAll('[name="wishRecipient"]:checked')].map((x) => x.value);
  if (!selected.length) throw new Error("Выбери хотя бы одну участницу.");
  if (selected.length > 10) throw new Error("За один раз можно пригласить максимум 10 участниц.");
  if (!options.some((o) => availability(state.uid, o) !== "busy"))
    throw new Error("Все выбранные варианты заняты в твоём календаре.");
  const message = String(form.elements.message.value || "").trim().slice(0, 500);
  const success = [], failed = [];
  for (const uid of selected) {
    const member = person(uid);
    if (!member || uid === state.uid) { failed.push("Неизвестная участница"); continue; }
    if (!options.some((o) => availability(uid, o) !== "busy" && availability(state.uid, o) !== "busy")) {
      failed.push(member.nick + ": выбранные окна заняты"); continue;
    }
    if (proposals().some((p) => p.status === "pending" && p.fromUid === state.uid && p.toUid === uid &&
      p.game === game && p.date === options[0].date)) {
      failed.push(member.nick + ": похожее приглашение уже отправлено"); continue;
    }
    const ref = doc(collection(db, "proposals"));
    const first = options[0];
    const preview = { fromUid: state.uid, toUid: uid, fromName: state.nick, toName: member.nick,
      date: first.date, start: first.start, end: first.end, game };
    const batch = writeBatch(db);
    batch.set(ref, { ...preview, timeOptions: options, message, status: "pending",
      createdAt: serverTimestamp(), respondedAt: null, replacesId: "" });
    batch.set(doc(db, "moderatorPending", state.uid, "items", ref.id), preview);
    batch.set(doc(db, "moderatorPending", uid, "items", ref.id), preview);
    try { await batch.commit(); success.push(member.nick); }
    catch (error) { failed.push(member.nick + ": " + readableError(error)); }
  }
  if (success.length) {
    modalClose();
    state.tab = "inbox"; state.inboxFilter = "all";
    render();
    flashMessage("Приглашения отправлены: " + success.join(", ") + "." +
      (failed.length ? " Не отправлены: " + failed.join("; ") : ""), failed.length > 0);
  } else throw new Error("Ни одно приглашение не отправлено. " + failed.join("; "));
}

function inviteModal(uid, replacesId = "") {
  const member = person(uid);
  const previous = replacesId ? state.locks.find((x) => x.id === replacesId) : null;
  if (replacesId && !previous) { flashMessage("Исходная коллаба не найдена.", true); return; }
  if (!member) return;
  modalOpen('<h2 id="modalTitle">' + (replacesId ? "Предложить перенос: " : "Пригласить ") + h(member.nick) + '</h2><p class="muted">' + (replacesId ? "Старый подтверждённый коллаб сохранится до принятия новых даты и времени второй стороной." : "Отправь предложение. После принятия обе участницы увидят коллаб в календаре.") + '</p>' +
    '<div class="links" style="margin:12px 0 20px">' + profileLinks(member) + '</div>' +
    '<form data-form="invite" data-uid="' + h(uid) + '" data-replaces="' + h(replacesId) + '" class="form-grid">' +
    '<div class="field full"><label>Игра или формат</label><input name="game" maxlength="90" required value="' + h(previous?.game || state.search.game) + '"></div>' +
    '<div class="field"><label>Дата</label><input type="date" name="date" required value="' + h(previous ? addDays(previous.date, 1) : state.search.date) + '"></div>' +
    '<div class="field"><label>Начало, МСК</label><input type="time" name="start" required value="' + h(previous?.start || state.search.start) + '"></div>' +
    '<div class="field"><label>Конец, МСК</label><input type="time" name="end" required value="' + h(previous?.end || state.search.end) + '"></div>' +
    '<div class="field full"><label>Сообщение (необязательно)</label><textarea name="message" maxlength="500" placeholder="Давай попробуем пройти эту игру вместе?"></textarea></div>' +
    '<div class="form-actions full"><button type="button" class="button button-ghost" data-action="close-modal">Закрыть</button><button type="submit" class="button">Отправить приглашение</button></div></form>');
}
async function publishPublicSchedule() {
  if (!state.uid) return;
  const own = await getDocs(query(collection(db, "slots"), where("ownerUid", "==", state.uid)));
  const cutoff = addDays(mskToday(), -30);
  const maxDate = addDays(mskToday(), 365);
  const events = own.docs.map((d) => d.data())
    .filter((e) => (e.type === "stream" || e.type === "off") && e.public === true && e.date >= cutoff && e.date <= maxDate)
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
    .slice(0, 300)
    .map((e) => ({ date: e.date, start: e.start, end: e.end, type: e.type, title: e.type === "off" ? "" : String(e.title || "").slice(0, 90) }));
  const memberSnap = await getDoc(doc(db, "members", state.uid));
  const m = memberSnap.data() || {};
  await setDoc(doc(db, "publicSchedules", state.uid), {
    nick: m.nick || state.nick, twitch: m.twitch || "", telegram: m.telegram || "", youtube: m.youtube || "", tiktok: m.tiktok || "", discord: m.discord || "", events, updatedAt: serverTimestamp()
  });
}
async function collabVisibilityModal(id) {
  const lock = state.locks.find((x) => x.id === id && [x.fromUid, x.toUid].includes(state.uid));
  if (!lock) throw new Error("Коллаба не найдена.");
  const marker = await getDoc(doc(db, "publicCollabs", state.uid, "items", id));
  const v = marker.exists() ? marker.data() : {};
  const otherUid = lock.fromUid === state.uid ? lock.toUid : lock.fromUid;
  modalOpen('<h2 id="modalTitle">Что увидят твои зрители?</h2>' +
    '<p class="sub">Только для твоего публичного расписания. По умолчанию игра и партнёр скрыты. У второго участника настройки независимые.</p>' +
    '<div class="panel-lite" style="margin:14px 0"><strong>' + h(lock.game || "Игра не указана") + '</strong><p class="tiny-note">С ' + h(nameOf(otherUid)) + ' · ' + h(dateLabel(lock.date)) + ' · ' + fmtTime(lock) + ' МСК</p></div>' +
    '<form data-form="collab-visibility" data-id="' + h(id) + '">' +
    '<label class="check-line" style="margin:14px 0"><input name="showGame" type="checkbox"' + (v.game ? " checked" : "") + '>Показывать название игры</label>' +
    '<label class="check-line" style="margin:14px 0"><input name="showPartner" type="checkbox"' + (v.partner ? " checked" : "") + '>Показывать ник участника</label>' +
    '<p class="tiny-note">Учитывай договорённости с партнёром, прежде чем раскрывать информацию.</p>' +
    '<div class="form-actions"><button type="button" class="button button-ghost" data-action="close-modal">Отмена</button>' +
    '<button type="submit" class="button">Сохранить видимость</button></div></form>');
}
async function saveCollabVisibility(form) {
  const id = form.dataset.id;
  const lock = state.locks.find((x) => x.id === id && [x.fromUid, x.toUid].includes(state.uid));
  if (!lock) throw new Error("Коллаба уже отменена.");
  const otherUid = lock.fromUid === state.uid ? lock.toUid : lock.fromUid;
  const showGame = form.elements.showGame.checked;
  const showPartner = form.elements.showPartner.checked;
  await setDoc(doc(db, "publicCollabs", state.uid, "items", id), {
    date: lock.date, start: lock.start, end: lock.end, type: "collab",
    game: showGame ? String(lock.game || "").slice(0, 90) : "",
    partner: showPartner ? String(nameOf(otherUid)).slice(0, 40) : ""
  });
  modalClose();
  flashMessage("Видимость коллабы для твоих зрителей обновлена.");
}
async function saveEvent(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  if (!isDate(data.date) || !isTime(data.start) || !isTime(data.end) || (data.start === data.end && data.start !== "00:00")) throw new Error("Укажи корректные часы. Для полного дня используй 00:00–00:00.");
  const validTypes = ["stream", "off", "busy", "maybe", "free"];
  if (!validTypes.includes(data.type)) throw new Error("Неизвестный тип отметки.");
  const record = {
    ownerUid: state.uid, date: data.date, start: data.start, end: data.end,
    type: data.type, title: data.type === "stream" ? String(data.title || "").trim().slice(0, 90) : "",
    details: String(data.details || "").trim().slice(0, 500),
    public: ["stream", "off"].includes(data.type) && data.hidePublic !== "on",
    updatedAt: serverTimestamp()
  };
  if (form.dataset.id) await updateDoc(doc(db, "slots", form.dataset.id), record);
  else await addDoc(collection(db, "slots"), record);
  await publishPublicSchedule();
  state.date = data.date;
  state.month = data.date.slice(0, 7);
  modalClose();
  render();
  flashMessage("Событие сохранено.");
}
async function saveProfile(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const nick = String(data.nick || "").trim().slice(0, 40);
  if (nick.length < 2) throw new Error("Никнейм должен быть не короче двух символов.");
  for (const key of ["twitch", "steam", "telegram", "telegramDM", "youtube", "tiktok", "discord"]) if (data[key] && !safeUrl(data[key])) throw new Error("Для ссылок нужен полный адрес https://...");
  const member = {
    nick, twitch: String(data.twitch || "").trim().slice(0, 300),
    steam: String(data.steam || "").trim().slice(0, 300),
    telegram: String(data.telegram || "").trim().slice(0, 300),
    telegramDM: String(data.telegramDM || "").trim().slice(0, 300),
    youtube: String(data.youtube || "").trim().slice(0, 300),
    tiktok: String(data.tiktok || "").trim().slice(0, 300),
    discord: String(data.discord || "").trim().slice(0, 300),
    weekdays: String(data.weekdays || "").trim().slice(0, 80),
    weekend: String(data.weekend || "").trim().slice(0, 80),
    updatedAt: serverTimestamp()
  };
  await setDoc(doc(db, "members", state.uid), member);
  state.nick = nick;
  state.member = member;
  await publishPublicSchedule();
  render();
  flashMessage("Профиль и имя в публичном расписании обновлены.");
}
async function sendInvite(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const uid = form.dataset.uid;
  const member = person(uid);
  if (!member || uid === state.uid) throw new Error("Участница не найдена.");
  if (!isDate(data.date) || !isTime(data.start) || !isTime(data.end) || data.start === data.end) throw new Error("Проверь дату и часы коллаба.");
  if (data.date < mskToday()) throw new Error("Нельзя отправить приглашение на прошедший день.");
  const game = String(data.game || "").trim().slice(0, 90);
  if (!game) throw new Error("Укажи игру или формат.");
  const request = { date: data.date, start: data.start, end: data.end };
  const replacesId = form.dataset.replaces || "";
  if (replacesId && !state.locks.some((x) => x.id === replacesId && [x.fromUid, x.toUid].includes(uid) && [x.fromUid, x.toUid].includes(state.uid))) throw new Error("Старая коллаба уже неактуальна.");
  if (availability(uid, request, replacesId) === "busy") throw new Error("Это окно уже занято. Выбери другое время.");
  if (availability(state.uid, request, replacesId) === "busy") throw new Error("В твоём расписании уже занято это время.");
  const exists = proposals().some((p) => p.fromUid === state.uid && p.toUid === uid && p.status === "pending" && p.date === data.date && overlaps(p, request));
  if (exists) throw new Error("Похожее приглашение уже ожидает ответа.");
  const proposalRef = doc(collection(db, "proposals"));
  const preview = { fromUid: state.uid, toUid: uid, fromName: state.nick, toName: member.nick,
    date: data.date, start: data.start, end: data.end, game };
  const batch = writeBatch(db);
  batch.set(proposalRef, { ...preview, replacesId,
    message: String(data.message || "").trim().slice(0, 500),
    status: "pending", createdAt: serverTimestamp(), respondedAt: null
  });
  for (const ownerUid of [state.uid, uid]) {
    batch.set(doc(db, "moderatorPending", ownerUid, "items", proposalRef.id), preview);
  }
  await batch.commit();
  modalClose();
  state.tab = "inbox";
  state.inboxFilter = "all";
  render();
  flashMessage(replacesId ? "Предложение переноса отправлено. Старая коллаба останется в силе до согласия." : "Приглашение отправлено " + member.nick + ".");
}
async function respond(id, answer, optionIndex = 0) {
  const p = proposals().find((entry) => entry.id === id);
  if (!p) throw new Error("Приглашение не найдено.");
  if (!["accepted", "declined", "cancelled"].includes(answer)) throw new Error("Неизвестный ответ.");
  if (answer === "accepted" && (p.toUid !== state.uid || p.status !== "pending")) throw new Error("Принять приглашение может только получатель.");
  if (answer === "declined" && (p.toUid !== state.uid || p.status !== "pending")) throw new Error("Отклонить приглашение может только получатель.");
  if (answer === "cancelled" && p.status !== "pending" && p.status !== "accepted") throw new Error("Это предложение уже завершено.");
  let selected = p;
  const choices = Array.isArray(p.timeOptions) ? p.timeOptions : null;
  if (answer === "accepted" && choices) {
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= choices.length) throw new Error("Выбери предложенный вариант времени.");
    const chosen = choices[optionIndex];
    if (!isDate(chosen.date) || !isTime(chosen.start) || !isTime(chosen.end) || chosen.start === chosen.end)
      throw new Error("Этот вариант времени некорректен.");
    selected = { ...p, date: chosen.date, start: chosen.start, end: chosen.end };
  }
  const oldLock = answer === "accepted" && p.replacesId ? state.locks.find((lock) => lock.id === p.replacesId) : null;
  if (answer === "accepted" && p.replacesId && (!oldLock ||
    ![oldLock.fromUid, oldLock.toUid].includes(p.fromUid) ||
    ![oldLock.fromUid, oldLock.toUid].includes(p.toUid))) {
    throw new Error("Исходная коллаба для переноса уже отменена или недоступна.");
  }
  if (answer === "accepted") {
    const mine = availability(state.uid, selected, p.replacesId || "");
    const theirs = availability(p.fromUid, selected, p.replacesId || "");
    if (mine === "busy" || theirs === "busy") throw new Error("На новом времени есть занятость. Выберите другое окно.");
  }
  const batch = writeBatch(db);
  const change = { status: answer, respondedAt: serverTimestamp() };
  if (answer === "accepted" && choices) Object.assign(change, {
    chosenIndex: optionIndex, date: selected.date, start: selected.start, end: selected.end
  });
  batch.update(doc(db, "proposals", id), change);
  const newLock = doc(db, "collabLocks", id);
  const markers = (proposal) => [proposal.fromUid, proposal.toUid].map((uid) => doc(db, "publicCollabs", uid, "items", proposal.id));
  if (p.status === "pending" && Object.prototype.hasOwnProperty.call(p, "replacesId")) {
    for (const ownerUid of [p.fromUid, p.toUid]) {
      batch.delete(doc(db, "moderatorPending", ownerUid, "items", p.id));
    }
  }
  if (answer === "accepted") {
    batch.set(newLock, {
      fromUid: p.fromUid, toUid: p.toUid, fromName: p.fromName, toName: p.toName,
      date: selected.date, start: selected.start, end: selected.end, game: p.game
    });
    const marker = { date: selected.date, start: selected.start, end: selected.end, type: "collab", game: "", partner: "" };
    for (const ref of markers(p)) batch.set(ref, marker);
    if (oldLock) {
      batch.update(doc(db, "proposals", oldLock.id), { status: "cancelled", respondedAt: serverTimestamp() });
      batch.delete(doc(db, "collabLocks", oldLock.id));
      // Legacy confirmed invitations may have no public markers.
      const oldRefs = markers({ ...oldLock, id: oldLock.id });
      const present = await Promise.all(oldRefs.map((ref) => getDoc(ref)));
      for (let i = 0; i < oldRefs.length; i++) if (present[i].exists()) batch.delete(oldRefs[i]);
    }
  } else if (p.status === "accepted") {
    batch.delete(newLock);
    const refs = markers(p);
    const present = await Promise.all(refs.map((ref) => getDoc(ref)));
    for (let i = 0; i < refs.length; i++) if (present[i].exists()) batch.delete(refs[i]);
  }
  await batch.commit();
  const message = answer === "accepted"
    ? (oldLock ? "Перенос подтверждён: старое время освобождено, новое сохранено." : "Коллаба подтверждена и добавлена в оба календаря.")
    : answer === "declined" ? "Приглашение отклонено." : "Коллаба или приглашение отменены.";
  flashMessage(message);
}
async function refreshOwn() {
  if (!state.authorized) return;
  // onSnapshot подписки обновляются в реальном времени; это явное действие для перепубликации.
  await publishPublicSchedule();
  flashMessage("Обновлено. События синхронизированы со зрительской ссылкой.");
}
function loginScreen() {
  nav.hidden = true;
  $("logout").hidden = true;
  $("identity").textContent = "";
  screen.innerHTML = '<section class="auth"><div class="panel"><p class="eyebrow">Только для участниц</p><h1>Вход в комнату</h1><p class="sub">Каждая стримерша получает личный кабинет. Регистрация закрыта: доступ создаёт организатор через Firebase.</p>' +
    '<form data-form="login"><div class="field"><label>Почта</label><input name="email" type="email" autocomplete="username" required placeholder="you@example.com"></div>' +
    '<div class="field"><label>Пароль</label><input name="password" type="password" autocomplete="current-password" required placeholder="••••••••"></div>' +
    '<button class="button" type="submit">Войти</button></form><p class="tiny-note" style="margin-top:18px">Забыли пароль? Введите адрес почты и нажмите ниже.</p>' +
    '<button class="button button-ghost small" data-action="reset-password">Восстановить пароль</button></div></section>';
}
function deniedScreen() {
  nav.hidden = true;
  $("logout").hidden = false;
  $("identity").textContent = "Ожидает допуска";
  screen.innerHTML = '<section class="auth"><div class="panel"><p class="eyebrow">Доступ ограничен</p><h1>Аккаунт ещё не допущен</h1><p class="sub">Почта подтверждает вход, но доступ к планам есть только у участниц, внесённых организатором в <code>allowedUsers</code>.</p>' +
    '<div class="profile-link">UID: ' + h(state.uid) + '</div><p class="tiny-note">Отправь этот UID организатору. Ей нужно создать в Firestore документ allowedUsers / UID с полем enabled = true.</p>' +
    '<button class="button" data-action="check-access">Проверить доступ ещё раз</button></div></section>';
}
function setupScreen() {
  nav.hidden = true;
  $("logout").hidden = true;
  screen.innerHTML = '<section class="auth"><div class="panel"><p class="eyebrow">Подключение базы</p><h1>Сайт опубликован, Firebase ещё не подключён</h1><p class="sub">Для запуска кабинетов создай проект Firebase, включи Authentication и Firestore, вставь настройки веб-приложения в файл <code>collabs/firebase-config.js</code> на GitHub и опубликуй правила из <code>collabs/firestore.rules</code>.</p>' +
    '<div class="notice info">Весь исходный код сайта уже доступен на GitHub. Пошаговая инструкция — в файле <code>collabs/README.md</code>.</div></div></section>';
}
function cleanup() {
  for (const unsub of state.unsubs) try { unsub(); } catch { /* noop */ }
  state.unsubs = [];
  state.sent = []; state.received = []; state.slots = []; state.locks = []; state.members = [];
}
function listen() {
  cleanup();
  const update = () => { if (state.authorized) render(); };
  const error = (e) => flashMessage(readableError(e), true);
  const listenTo = (target, handler) => state.unsubs.push(onSnapshot(target, (snapshot) => {
    handler(snapshot.docs.map((d) => ({ id: d.id, ...d.data() }))); update();
  }, error));
  listenTo(collection(db, "members"), (items) => {
    state.members = items;
    const me = person(state.uid);
    if (me) { state.member = me; state.nick = me.nick; }
  });
  listenTo(collection(db, "slots"), (items) => { state.slots = items; });
  listenTo(collection(db, "collabLocks"), (items) => { state.locks = items; });
  listenTo(query(collection(db, "proposals"), where("fromUid", "==", state.uid)), (items) => { state.sent = items; });
  listenTo(query(collection(db, "proposals"), where("toUid", "==", state.uid)), (items) => { state.received = items; });
}
// Distinguish a denied access grant from errors later in first-time profile initialization.
async function accessStep(label, action) {
  try { return await action(); }
  catch (error) {
    const code = error?.code ? " [" + error.code + "]" : "";
    throw new Error(label + ": " + readableError(error) + code);
  }
}
async function checkAccess(user) {
  state.uid = user.uid;
  const snap = await accessStep("Шаг 1 — чтение allowedUsers / UID", () =>
    getDoc(doc(db, "allowedUsers", user.uid)));
  state.authorized = snap.exists() && snap.data().enabled === true;
  if (!state.authorized) { cleanup(); deniedScreen(); return; }

  const memberRef = doc(db, "members", user.uid);
  const old = await accessStep("Шаг 2 — чтение профиля members", () => getDoc(memberRef));
  if (!old.exists()) {
    await accessStep("Шаг 3 — создание нового профиля members", () => setDoc(memberRef, {
      nick: ((user.email || "Новая участница").split("@")[0].length >= 2 ? (user.email || "").split("@")[0] : "Новая участница").slice(0, 40),
      twitch: "", steam: "", telegram: "", telegramDM: "", youtube: "", tiktok: "", discord: "",
      weekdays: "", weekend: "", updatedAt: serverTimestamp()
    }));
  }
  const fresh = await accessStep("Шаг 4 — повторное чтение профиля", () => getDoc(memberRef));
  state.member = fresh.data() || {};
  state.nick = state.member.nick || "Участница";
  listen();
  render();

  // A permission issue when publishing the public schedule must not block private login.
  try {
    const publicDoc = await getDoc(doc(db, "publicSchedules", user.uid));
    if (!publicDoc.exists()) await publishPublicSchedule();
  } catch (error) {
    flashMessage("Вход успешен, но публичное расписание пока не синхронизировано: " + readableError(error), true);
  }
}
async function boot() {
  if (!firebaseConfig?.apiKey || firebaseConfig.apiKey.includes("PASTE_")) { setupScreen(); return; }
  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    const match = location.hash.match(/^#\/s\/([A-Za-z0-9_-]{12,128})$/);
    if (match) {
      nav.hidden = true; $("logout").hidden = true;
      await startPublicView({ db, uid: match[1], screen, identity: $("identity") });
      return;
    }
    const modMatch = location.hash.match(/^#\/mod\/([A-Za-z0-9_-]{12,128})$/);
    if (modMatch) {
      let dispose = () => {};
      onAuthStateChanged(auth, async (user) => {
        dispose(); dispose = () => {};
        nav.hidden = true; $("logout").hidden = true;
        try {
          dispose = await startModeratorV3({ db, auth, uid: modMatch[1], screen, identity: $("identity"), user });
        } catch (error) {
          screen.innerHTML = '<div class="notice bad">Ошибка модераторского раздела: ' + h(readableError(error)) + '</div>';
        }
      });
      return;
    }
    onAuthStateChanged(auth, async (user) => {
      cleanup();
      state.authorized = false;
      if (!user) { state.uid = null; loginScreen(); return; }
      screen.innerHTML = '<div class="empty">Проверяем доступ в комнату…</div>';
      try { await checkAccess(user); }
      catch (error) {
        flashMessage(readableError(error), true);
        screen.innerHTML = '<section class="auth"><div class="panel"><p class="eyebrow">Диагностика входа</p><h1>Не удалось завершить вход</h1>' +
          '<div class="notice bad">' + h(readableError(error)) + '</div>' +
          '<p class="tiny-note">Firebase projectId: <code>' + h(firebaseConfig.projectId) + '</code></p>' +
          '<p class="tiny-note">UID текущего аккаунта: <code>' + h(user.uid) + '</code></p>' +
          '<p class="tiny-note">Проверь, что в этом Firebase-проекте обновлены Firestore Rules и есть запись allowedUsers с таким же UID и boolean enabled = true.</p>' +
          '<div class="button-row"><button class="button" data-action="check-access">Повторить проверку</button><button class="button button-ghost" data-action="logout-diagnostic">Сменить аккаунт</button></div></div></section>';
      }
    });
  } catch (error) {
    screen.innerHTML = '<div class="notice bad">Ошибка подключения Firebase: ' + h(readableError(error)) + '</div>';
  }
}
document.addEventListener("change", (event) => {
  const select = event.target.closest('form[data-form="event"] select[name="type"]');
  if (!select) return;
  const form = select.form;
  if (select.value === "wish") { wishModal(); return; }
  if (select.value === "off") {
    form.elements.start.value = "00:00";
    form.elements.end.value = "00:00";
    form.elements.hidePublic.checked = false;
  } else if (select.value === "busy" || select.value === "maybe" || select.value === "free") {
    form.elements.hidePublic.checked = true;
  }
});
document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action],[data-tab]");
  if (!target) return;
  if (target.dataset.tab) { state.tab = target.dataset.tab; render(); return; }
  const action = target.dataset.action;
  try {
    if (action === "close-modal") { modalClose(); return; }
    if (action === "reset-password") {
      const email = document.querySelector('[name="email"]')?.value?.trim();
      if (!email) { flashMessage("Введи email в поле выше, чтобы получить письмо.", true); return; }
      await sendPasswordResetEmail(auth, email);
      flashMessage("Если адрес существует, на почту придёт письмо для смены пароля.");
      return;
    }
    if (action === "logout-diagnostic") { await signOut(auth); return; }
    if (action === "check-access") {
      if (!auth?.currentUser) { loginScreen(); return; }
      try { await checkAccess(auth.currentUser); }
      catch (error) { flashMessage(readableError(error), true); }
      return;
    }
    if (!state.authorized) return;
    if (action === "select-day") {
      state.date = target.dataset.date; state.month = state.date.slice(0, 7); render(); return;
    }
    if (action === "previous-month" || action === "next-month") {
      const [year, month] = state.month.split("-").map(Number);
      const shift = action === "previous-month" ? -1 : 1;
      const d = new Date(year, month - 1 + shift, 1);
      state.month = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      state.date = state.month + "-01"; render(); return;
    }
    if (action === "current-month") { state.date = mskToday(); state.month = state.date.slice(0, 7); render(); return; }
    if (action === "new-event") { eventModal(); return; }
    if (action === "new-wish") { wishModal(); return; }
    if (action === "add-wish-row") {
      const list = $("wishRows");
      if (!list) return;
      const count = list.querySelectorAll("[data-wish-row]").length;
      if (count >= 5) { flashMessage("Максимум пять вариантов.", true); return; }
      const last = list.lastElementChild;
      const date = last?.querySelector('[name="wishDate"]')?.value || state.date;
      const start = last?.querySelector('[name="wishStart"]')?.value || "20:00";
      const end = last?.querySelector('[name="wishEnd"]')?.value || "23:00";
      list.insertAdjacentHTML("beforeend", wishTimeRow(count, addDays(date, 1), start, end));
      return;
    }
    if (action === "remove-wish-row") {
      const rows = $("wishRows")?.querySelectorAll("[data-wish-row]");
      if (rows?.length <= 1) { flashMessage("Оставь хотя бы один вариант.", true); return; }
      target.closest("[data-wish-row]")?.remove();
      $("wishRows")?.querySelectorAll(".wish-number").forEach((span, i) => { span.textContent = "Вариант " + (i + 1); });
      return;
    }
    if (action === "connect-twitch") { startTwitchAuthorization(); return; }
    if (action === "refresh-twitch") { await refreshTwitch(state.members, () => { if (state.tab === "calendar") renderCalendar(); }, true); return; }
    if (action === "whole-day") {
      const form = modal.querySelector('form[data-form="event"]');
      if (form) { form.elements.start.value = "00:00"; form.elements.end.value = "00:00"; }
      return;
    }
    if (action === "edit-event") { eventModal(target.dataset.id); return; }
    if (action === "move-collab") {
      const lock = state.locks.find((x) => x.id === target.dataset.id && [x.fromUid, x.toUid].includes(state.uid));
      if (!lock) throw new Error("Коллаба уже недоступна.");
      const otherUid = lock.fromUid === state.uid ? lock.toUid : lock.fromUid;
      inviteModal(otherUid, lock.id);
      return;
    }
    if (action === "cancel-collab") {
      if (!confirm("Отменить подтверждённую коллабу у обоих участников?")) return;
      if (state.busy) return;
      state.busy = true;
      try { await respond(target.dataset.id, "cancelled"); }
      finally { state.busy = false; }
      return;
    }
    if (action === "visibility-collab") { await collabVisibilityModal(target.dataset.id); return; }
    if (action === "invite") { inviteModal(target.dataset.uid); return; }
    if (action === "inbox-pending" || action === "inbox-all") {
      state.inboxFilter = action === "inbox-all" ? "all" : "pending"; render(); return;
    }
    if (action === "copy-moderator") {
      try { await navigator.clipboard.writeText(moderatorLink(state.uid)); flashMessage("Ссылка для модератора скопирована."); }
      catch { flashMessage("Скопируй модераторскую ссылку из профиля.", true); }
      return;
    }
    if (action === "copy-public") {
      try { await navigator.clipboard.writeText(publicLink(state.uid)); flashMessage("Публичная ссылка скопирована."); }
      catch { flashMessage("Скопируй ссылку из поля выше.", true); }
      return;
    }
    if (action === "delete-event") {
      const item = state.slots.find((e) => e.id === target.dataset.id && e.ownerUid === state.uid);
      if (!item || !confirm("Удалить событие из расписания?")) return;
      await deleteDoc(doc(db, "slots", item.id)); await publishPublicSchedule();
      modalClose(); render(); flashMessage("Событие удалено."); return;
    }
    if (action === "respond") {
      if (state.busy) return;
      const label = target.dataset.answer === "accepted" ? "Принять" : "Подтвердить действие";
      if (target.dataset.answer === "cancelled" && !confirm("Отменить коллаб? Он исчезнет из календарей.")) return;
      state.busy = true; target.disabled = true;
      const choice = target.closest(".invite")?.querySelector("[data-proposal-choice]");
      const chosenIndex = choice ? Number(choice.value) : 0;
      try { await respond(target.dataset.id, target.dataset.answer, chosenIndex); }
      finally { state.busy = false; target.disabled = false; }
      return;
    }
    if (action === "refresh") { await refreshOwn(); return; }
  } catch (error) { flashMessage(readableError(error), true); console.error(error); }
});
document.addEventListener("submit", async (event) => {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  if (state.busy) return;
  state.busy = true;
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const type = form.dataset.form;
    if (type === "login" || type === "mod-login") {
      const data = Object.fromEntries(new FormData(form).entries());
      await signInWithEmailAndPassword(auth, String(data.email || "").trim(), String(data.password || ""));
    } else if (type === "search") {
      const data = Object.fromEntries(new FormData(form).entries());
      if (!isDate(data.date) || !isTime(data.start) || !isTime(data.end) || data.start === data.end) throw new Error("Проверь дату и часы.");
      state.search = { date: data.date, start: data.start, end: data.end, game: String(data.game || "").trim().slice(0, 90) };
      render();
    } else if (state.authorized && type === "event") await saveEvent(form);
    else if (state.authorized && type === "collab-visibility") await saveCollabVisibility(form);
    else if (state.authorized && type === "profile") await saveProfile(form);
    else if (state.authorized && type === "invite") await sendInvite(form);
    else if (state.authorized && type === "wish") await sendWish(form);
  } catch (error) { flashMessage(readableError(error), true); console.error(error); }
  finally { state.busy = false; if (button?.isConnected) button.disabled = false; }
});
$("logout").addEventListener("click", async () => {
  if (auth) await signOut(auth);
  location.hash = "";
});
window.addEventListener("hashchange", () => location.reload());
// Refresh visible Twitch status while the calendar tab is open.
setInterval(() => {
  if (state.authorized && state.tab === "calendar") {
    refreshTwitch(state.members, () => renderCalendar());
  }
}, 120000);
boot();