import { firebaseConfig } from "./firebase-config.js";
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
function fmtTime(obj) { return h(obj.start) + "–" + h(obj.end) + (obj.end <= obj.start ? " (+1 день)" : ""); }
function person(id) { return state.members.find((m) => m.id === id); }
function nameOf(id) { return person(id)?.nick || "Стример"; }
function profileLinks(member) {
  const links = [];
  const twitch = safeUrl(member?.twitch);
  const steam = safeUrl(member?.steam);
  if (twitch) links.push('<a href="' + twitch + '" target="_blank" rel="noopener noreferrer">Twitch ↗</a>');
  if (steam) links.push('<a href="' + steam + '" target="_blank" rel="noopener noreferrer">Steam ↗</a>');
  return links.join("");
}
function typeName(type) {
  return ({ stream: "Стрим", busy: "Недоступна", maybe: "Под вопросом", free: "Свободна", collab: "Коллаб" })[type] || "Событие";
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
function availability(memberId, request) {
  const problems = [];
  for (const item of state.slots) {
    if (item.ownerUid !== memberId || item.type === "free") continue;
    if (overlaps(item, request)) problems.push(item.type === "maybe" ? "maybe" : "busy");
  }
  for (const item of state.locks) {
    if (item.fromUid !== memberId && item.toUid !== memberId) continue;
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
    dayButtons += '<button type="button" class="' + classes.join(" ") + '" data-action="select-day" data-date="' + date + '"><span class="day-number">' + Number(date.slice(8)) + '</span><span class="dots">' +
      items.slice(0, 5).map((item) => '<span class="dot ' + h(item.type) + '"></span>').join("") + '</span>' +
      (items.length > 0 ? '<span class="day-count">' + items.length + " событий</span>" : "") + '</button>';
  }
  const events = myItems(state.date).map((item) => {
    const isLock = item.kind === "lock";
    const title = isLock ? ("Коллаб: " + item.game) : (item.type === "stream" ? (item.title || "Без названия") : typeName(item.type));
    const other = isLock ? (' · с ' + nameOf(item.fromUid === state.uid ? item.toUid : item.fromUid)) : "";
    const controls = isLock ? "" : '<button class="button button-ghost tiny" data-action="edit-event" data-id="' + h(item.id) + '">Изменить</button>';
    return '<div class="event"><div><div class="event-title">' + h(title) + '</div><div class="event-when">' + fmtTime(item) + h(other) + '</div>' +
      '<div style="margin-top:7px"><span class="tag ' + h(item.type) + '">' + typeName(item.type) + '</span>' +
      (!isLock && item.public === true ? ' <span class="tag free">Публично</span>' : "") + '</div></div><div>' + controls + '</div></div>';
  }).join("");
  screen.innerHTML = '<div class="hero"><div><p class="eyebrow">Личный планировщик</p><h1>Твой календарь</h1><p class="sub">Добавляй стримы, закрывай неудобные дни и отмечай сомнительные окна. Остальное считается свободным для коллаба.</p></div><div class="button-row"><button class="button button-ghost" data-action="refresh">↻ Обновить</button><button class="button" data-action="new-event">+ Добавить событие</button></div></div>' +
    '<div class="split"><section class="panel"><div class="section-bar"><h2 class="calendar-heading">' +
    new Date(year, month - 1, 1).toLocaleDateString("ru-RU", { month: "long", year: "numeric" }) +
    '</h2><div class="button-row"><button class="button button-ghost small" data-action="previous-month">←</button><button class="button button-ghost small" data-action="current-month">Сегодня</button><button class="button button-ghost small" data-action="next-month">→</button></div></div><div class="calendar-week">' +
    ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((x) => "<span>" + x + "</span>").join("") +
    '</div><div class="calendar-grid">' + dayButtons + '</div><p class="tiny-note" style="margin:15px 0 0">Розовый — стрим / занято · жёлтый — под вопросом · зелёный — доступно · синий — подтверждённый коллаб.</p></section>' +
    '<section class="panel"><div class="section-bar"><h2 style="text-transform:capitalize">' + h(dateLabel(state.date)) + '</h2><button class="button button-ghost small" data-action="new-event">+ Событие</button></div>' +
    (events || '<div class="empty"><strong>Планов нет</strong>В этот день ты свободна для предложений.</div>') +
    '<div class="mini-spacer"></div><div class="notice info">Подтверждённые коллабы появляются здесь автоматически. Личные отметки видны только участникам комнаты.</div></section></div>';
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
    return '<article class="invite"><div class="invite-top"><div><div class="invite-title">' + h(p.game) + '</div><div class="invite-detail">' + (inbound ? 'От ' : 'Для ') + h(someone) + ' · ' + h(dateLabel(p.date)) + ' · ' + fmtTime(p) + '</div></div><span class="tag status-' + h(p.status) + '">' + h(statusNames[p.status] || p.status) + '</span></div>' +
      (p.message ? '<div class="invite-message">' + h(p.message) + '</div>' : "") +
      '<div class="button-row">' + controls.join("") + '</div></article>';
  }).join("");
  screen.innerHTML = '<div class="hero"><div><p class="eyebrow">Центр согласований</p><h1>Приглашения</h1><p class="sub">Предложения появятся здесь без перезагрузки страницы. Принятая коллаба сразу займёт окно у обеих участниц.</p></div></div>' +
    '<div class="panel"><div class="tabs-mini"><button class="' + (state.inboxFilter === "pending" ? "active" : "") + '" data-action="inbox-pending">Ожидают ответа (' + pending.length + ')</button><button class="' + (state.inboxFilter === "all" ? "active" : "") + '" data-action="inbox-all">Вся история (' + all.length + ')</button></div>' +
    (rows || '<div class="empty"><strong>Приглашений пока нет</strong>Загляни в «Собрать коллаб», чтобы позвать подруг поиграть.</div>') +
    '</div>';
}
function publicLink(uid) { return location.origin + location.pathname + "#/s/" + encodeURIComponent(uid); }
function renderProfile() {
  const m = state.member || {};
  screen.innerHTML = '<div class="hero"><div><p class="eyebrow">Твои настройки</p><h1>Профиль стримера</h1><p class="sub">Ник и ссылки видны другим участницам. Почта, пароль и личные отметки не отображаются в публичном расписании.</p></div></div>' +
    '<div class="two"><section class="panel"><h2>О себе</h2><form data-form="profile" class="form-grid">' +
    '<div class="field full"><label for="nick">Никнейм *</label><input id="nick" name="nick" maxlength="40" required value="' + h(m.nick || state.nick) + '"></div>' +
    '<div class="field full"><label for="twitch">Ссылка на Twitch</label><input id="twitch" name="twitch" type="url" placeholder="https://www.twitch.tv/..." value="' + h(m.twitch || "") + '"></div>' +
    '<div class="field full"><label for="steam">Ссылка на Steam</label><input id="steam" name="steam" type="url" placeholder="https://steamcommunity.com/..." value="' + h(m.steam || "") + '"></div>' +
    '<div class="field"><label for="weekdays">Обычно в будни (МСК)</label><input id="weekdays" name="weekdays" maxlength="80" placeholder="20:00–02:00" value="' + h(m.weekdays || "") + '"></div>' +
    '<div class="field"><label for="weekend">Обычно в выходные (МСК)</label><input id="weekend" name="weekend" maxlength="80" placeholder="15:00–00:00" value="' + h(m.weekend || "") + '"></div>' +
    '<div class="full"><p class="tiny-note">Обычное время — справочная подсказка. Фактическая занятость определяется отметками в календаре.</p></div>' +
    '<div class="full"><button class="button" type="submit">Сохранить профиль</button></div></form></section>' +
    '<section class="panel"><h2>Ссылка для зрителей</h2><p class="muted">Зрители смогут увидеть только события с отметкой «Показывать в публичном расписании».</p><div class="profile-link">' + h(publicLink(state.uid)) + '</div>' +
    '<div class="button-row"><button class="button" data-action="copy-public">Копировать ссылку</button><a class="button button-ghost" href="' + h(publicLink(state.uid)) + '" target="_blank" rel="noopener noreferrer">Посмотреть ↗</a></div>' +
    '<div class="notice info">Дни «недоступна» и «под вопросом», переписка и приглашения не попадут в ссылку для сообщества.</div>' +
    '<h3>Доступ в комнату</h3><p class="tiny-note">Новых участниц добавляет владелица Firebase: создаёт учётную запись и разрешает UID в коллекции allowedUsers. Публичной регистрации здесь нет.</p>' +
    '<p class="tiny-note">Твой UID для настройки доступа: <code>' + h(state.uid) + '</code></p></section></div>';
}
function eventModal(id) {
  const item = state.slots.find((x) => x.id === id && x.ownerUid === state.uid);
  const source = item || { date: state.date, start: "20:00", end: "23:00", type: "stream", title: "", public: false };
  const option = (value, label) => '<option value="' + value + '"' + (source.type === value ? ' selected' : "") + '>' + label + '</option>';
  modalOpen('<h2 id="modalTitle">' + (item ? "Редактировать событие" : "Новое событие") + '</h2><p class="muted">Дату и часы вводим по Москве. Пустой день считается свободным.</p>' +
    '<form data-form="event" data-id="' + h(id || "") + '" class="form-grid"><div class="field full"><label>Тип отметки</label><select name="type">' +
    option("stream", "Стрим / запланированная игра") + option("busy", "Не могу коллабиться") + option("maybe", "Под вопросом") + option("free", "Точно свободна") + '</select></div>' +
    '<div class="field full"><label>Игра / название стрима (для типа «Стрим»)</label><input name="title" maxlength="90" value="' + h(source.title || "") + '" placeholder="Far Far West"></div>' +
    '<div class="field"><label>Дата</label><input type="date" name="date" value="' + h(source.date) + '" required></div>' +
    '<div class="field"><label>Начало, МСК</label><input type="time" name="start" value="' + h(source.start) + '" required></div>' +
    '<div class="field"><label>Конец, МСК</label><input type="time" name="end" value="' + h(source.end) + '" required></div>' +
    '<label class="check-line" style="align-self:end;padding-bottom:9px"><input name="public" type="checkbox" ' + (source.public ? "checked" : "") + '>Показать зрителям</label>' +
    '<p class="tiny-note full">Публичная галочка действует только на тип «Стрим». Коллабы по приглашению остаются внутренними.</p>' +
    '<div class="form-actions full">' + (item ? '<button type="button" class="button button-subtle" data-action="delete-event" data-id="' + h(id) + '">Удалить</button>' : "") +
    '<button type="button" class="button button-ghost" data-action="close-modal">Закрыть</button><button type="submit" class="button">Сохранить</button></div></form>');
}
function inviteModal(uid) {
  const member = person(uid);
  if (!member) return;
  modalOpen('<h2 id="modalTitle">Пригласить ' + h(member.nick) + '</h2><p class="muted">Отправь предложение. После принятия обе участницы увидят коллаб в календаре.</p>' +
    '<form data-form="invite" data-uid="' + h(uid) + '" class="form-grid">' +
    '<div class="field full"><label>Игра или формат</label><input name="game" maxlength="90" required value="' + h(state.search.game) + '"></div>' +
    '<div class="field"><label>Дата</label><input type="date" name="date" required value="' + h(state.search.date) + '"></div>' +
    '<div class="field"><label>Начало, МСК</label><input type="time" name="start" required value="' + h(state.search.start) + '"></div>' +
    '<div class="field"><label>Конец, МСК</label><input type="time" name="end" required value="' + h(state.search.end) + '"></div>' +
    '<div class="field full"><label>Сообщение (необязательно)</label><textarea name="message" maxlength="500" placeholder="Давай попробуем пройти эту игру вместе?"></textarea></div>' +
    '<div class="form-actions full"><button type="button" class="button button-ghost" data-action="close-modal">Закрыть</button><button type="submit" class="button">Отправить приглашение</button></div></form>');
}
async function publishPublicSchedule() {
  if (!state.uid) return;
  const own = await getDocs(query(collection(db, "slots"), where("ownerUid", "==", state.uid)));
  const cutoff = addDays(mskToday(), -30);
  const maxDate = addDays(mskToday(), 365);
  const events = own.docs.map((d) => d.data())
    .filter((e) => e.type === "stream" && e.public === true && e.date >= cutoff && e.date <= maxDate)
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
    .slice(0, 300)
    .map((e) => ({ date: e.date, start: e.start, end: e.end, title: String(e.title || "").slice(0, 90) }));
  const memberSnap = await getDoc(doc(db, "members", state.uid));
  const m = memberSnap.data() || {};
  await setDoc(doc(db, "publicSchedules", state.uid), {
    nick: m.nick || state.nick, twitch: m.twitch || "", events, updatedAt: serverTimestamp()
  });
}
async function saveEvent(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  if (!isDate(data.date) || !isTime(data.start) || !isTime(data.end) || data.start === data.end) throw new Error("Укажи корректную дату и разные часы начала и конца.");
  const validTypes = ["stream", "busy", "maybe", "free"];
  if (!validTypes.includes(data.type)) throw new Error("Неизвестный тип отметки.");
  const record = {
    ownerUid: state.uid, date: data.date, start: data.start, end: data.end,
    type: data.type, title: data.type === "stream" ? (data.title || "Стрим").trim().slice(0, 90) : "",
    public: data.type === "stream" && data.public === "on",
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
  for (const key of ["twitch", "steam"]) if (data[key] && !safeUrl(data[key])) throw new Error("Для ссылок нужен полный адрес https://...");
  const member = {
    nick, twitch: String(data.twitch || "").trim().slice(0, 300),
    steam: String(data.steam || "").trim().slice(0, 300),
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
  if (availability(uid, request) === "busy") throw new Error("Это окно уже занято. Выбери другое время.");
  if (availability(state.uid, request) === "busy") throw new Error("В твоём расписании уже занято это время.");
  const exists = proposals().some((p) => p.fromUid === state.uid && p.toUid === uid && p.status === "pending" && p.date === data.date && overlaps(p, request));
  if (exists) throw new Error("Похожее приглашение уже ожидает ответа.");
  await addDoc(collection(db, "proposals"), {
    fromUid: state.uid, toUid: uid, fromName: state.nick, toName: member.nick,
    date: data.date, start: data.start, end: data.end, game,
    message: String(data.message || "").trim().slice(0, 500),
    status: "pending", createdAt: serverTimestamp(), respondedAt: null
  });
  modalClose();
  state.tab = "inbox";
  state.inboxFilter = "all";
  render();
  flashMessage("Приглашение отправлено " + member.nick + ".");
}
async function respond(id, answer) {
  const p = proposals().find((entry) => entry.id === id);
  if (!p) throw new Error("Приглашение не найдено.");
  if (!["accepted", "declined", "cancelled"].includes(answer)) throw new Error("Неизвестный ответ.");
  if (answer === "accepted" && (p.toUid !== state.uid || p.status !== "pending")) throw new Error("Принять приглашение может только получатель.");
  if (answer === "declined" && (p.toUid !== state.uid || p.status !== "pending")) throw new Error("Отклонить приглашение может только получатель.");
  if (answer === "cancelled" && p.status !== "pending" && p.status !== "accepted") throw new Error("Это предложение уже завершено.");
  if (answer === "accepted") {
    const mine = availability(state.uid, p);
    const theirs = availability(p.fromUid, p);
    if (mine === "busy" || theirs === "busy") throw new Error("В это время уже есть занятое окно. Освободи время или попроси другое приглашение.");
  }
  const batch = writeBatch(db);
  batch.update(doc(db, "proposals", id), { status: answer, respondedAt: serverTimestamp() });
  const lockRef = doc(db, "collabLocks", id);
  if (answer === "accepted") {
    batch.set(lockRef, { fromUid: p.fromUid, toUid: p.toUid, date: p.date, start: p.start, end: p.end, game: p.game });
  } else if (p.status === "accepted") {
    batch.delete(lockRef);
  }
  await batch.commit();
  flashMessage(answer === "accepted" ? "Коллаб подтверждён и добавлен в оба календаря." : answer === "declined" ? "Приглашение отклонено." : "Коллаб отменён.");
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
async function publicScreen(uid) {
  nav.hidden = true;
  $("logout").hidden = true;
  $("identity").textContent = "Просмотр для зрителей";
  screen.innerHTML = '<div class="empty">Загружаем публичное расписание…</div>';
  try {
    const snap = await getDoc(doc(db, "publicSchedules", uid));
    if (!snap.exists()) {
      screen.innerHTML = '<section class="public-page"><div class="empty"><strong>Расписание пока не опубликовано</strong>Автор ещё не создал публичных событий или ссылка неверна.</div><p><a href="./">← Войти в комнату</a></p></section>';
      return;
    }
    const data = snap.data();
    const events = Array.isArray(data.events) ? data.events.filter((e) => e.date >= addDays(mskToday(), -30)).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)) : [];
    const cards = events.map((e) => '<div class="public-event"><div><div class="public-date">' + h(dateLabel(e.date)) + '</div><div class="public-title">' + h(e.title) + '</div></div><div class="tag stream">' + fmtTime(e) + ' МСК</div></div>').join("");
    const link = safeUrl(data.twitch);
    screen.innerHTML = '<section class="public-page"><p class="eyebrow">Публичное расписание</p><h1>Стримы ' + h(data.nick || "стримера") + '</h1><p class="sub">Здесь только события, которые автор захотел показать сообществу. Время указано по Москве (МСК).</p>' +
      '<div class="button-row" style="margin-bottom:18px">' + (link ? '<a class="button" href="' + link + '" target="_blank" rel="noopener noreferrer">Открыть Twitch ↗</a>' : "") + '<a class="button button-ghost" href="./">Войти в комнату</a></div>' +
      '<div class="panel">' + (cards || '<div class="empty">Публичных стримов на ближайшее время нет.</div>') + '</div><p class="tiny-note" style="margin-top:18px">Внутренние отметки и приглашения на этой странице никогда не показываются.</p></section>';
  } catch (error) {
    screen.innerHTML = '<div class="notice bad">Не удалось открыть расписание: ' + h(readableError(error)) + '</div>';
  }
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
async function checkAccess(user) {
  state.uid = user.uid;
  const snap = await getDoc(doc(db, "allowedUsers", user.uid));
  state.authorized = snap.exists() && snap.data().enabled === true;
  if (!state.authorized) { cleanup(); deniedScreen(); return; }
  const memberRef = doc(db, "members", user.uid);
  const old = await getDoc(memberRef);
  if (!old.exists()) {
    await setDoc(memberRef, {
      nick: ((user.email || "Новая участница").split("@")[0].length >= 2 ? (user.email || "").split("@")[0] : "Новая участница").slice(0, 40),
      twitch: "", steam: "", weekdays: "", weekend: "", updatedAt: serverTimestamp()
    });
  }
  const fresh = await getDoc(memberRef);
  state.member = fresh.data() || {};
  state.nick = state.member.nick || "Участница";
  listen();
  render();
  const publicDoc = await getDoc(doc(db, "publicSchedules", user.uid));
  if (!publicDoc.exists()) await publishPublicSchedule();
}
async function boot() {
  if (!firebaseConfig?.apiKey || firebaseConfig.apiKey.includes("PASTE_")) { setupScreen(); return; }
  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    const match = location.hash.match(/^#\/s\/([A-Za-z0-9_-]{12,128})$/);
    if (match) { await publicScreen(match[1]); return; }
    onAuthStateChanged(auth, async (user) => {
      cleanup();
      state.authorized = false;
      if (!user) { state.uid = null; loginScreen(); return; }
      screen.innerHTML = '<div class="empty">Проверяем доступ в комнату…</div>';
      try { await checkAccess(user); }
      catch (error) {
        flashMessage(readableError(error), true);
        screen.innerHTML = '<div class="notice bad">Не удалось проверить доступ: ' + h(readableError(error)) + '</div>';
      }
    });
  } catch (error) {
    screen.innerHTML = '<div class="notice bad">Ошибка подключения Firebase: ' + h(readableError(error)) + '</div>';
  }
}
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
    if (action === "check-access") { await checkAccess(auth.currentUser); return; }
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
    if (action === "edit-event") { eventModal(target.dataset.id); return; }
    if (action === "invite") { inviteModal(target.dataset.uid); return; }
    if (action === "inbox-pending" || action === "inbox-all") {
      state.inboxFilter = action === "inbox-all" ? "all" : "pending"; render(); return;
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
      try { await respond(target.dataset.id, target.dataset.answer); }
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
    if (type === "login") {
      const data = Object.fromEntries(new FormData(form).entries());
      await signInWithEmailAndPassword(auth, String(data.email || "").trim(), String(data.password || ""));
    } else if (type === "search") {
      const data = Object.fromEntries(new FormData(form).entries());
      if (!isDate(data.date) || !isTime(data.start) || !isTime(data.end) || data.start === data.end) throw new Error("Проверь дату и часы.");
      state.search = { date: data.date, start: data.start, end: data.end, game: String(data.game || "").trim().slice(0, 90) };
      render();
    } else if (state.authorized && type === "event") await saveEvent(form);
    else if (state.authorized && type === "profile") await saveProfile(form);
    else if (state.authorized && type === "invite") await sendInvite(form);
  } catch (error) { flashMessage(readableError(error), true); console.error(error); }
  finally { state.busy = false; if (button?.isConnected) button.disabled = false; }
});
$("logout").addEventListener("click", async () => {
  if (auth) await signOut(auth);
  location.hash = "";
});
window.addEventListener("hashchange", () => location.reload());
boot();