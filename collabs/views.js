import { doc, getDoc, getDocs, collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

import { signOut } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";

const h = (x) => String(x === undefined || x === null ? "" : x).replace(/[&<>"']/g, (s) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[s]);
function url(x) { try { const u = new URL(String(x || "")); return u.protocol === "https:" ? h(u.href) : ""; } catch { return ""; } }
function todayMsk() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (x) => parts.find((p) => p.type === x).value;
  return get("year") + "-" + get("month") + "-" + get("day");
}
function day(iso, offset) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
function weekStart(iso) {
  const wd = (new Date(iso + "T12:00:00Z").getUTCDay() + 6) % 7;
  return day(iso, -wd);
}
function readable(iso, opts) {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("ru-RU", opts || { day: "numeric", month: "long" });
}
function span(e) {
  if (!e.start || !e.end) return "Время неизвестно";
  if (e.start === "00:00" && e.end === "00:00") return "Весь день";
  return h(e.start) + "–" + h(e.end) ;
}
function socials(data) {
  const names = [
    ["twitch", "Twitch"], ["telegram", "Telegram"], ["youtube", "YouTube"],
    ["tiktok", "TikTok"], ["discord", "Discord"]
  ];
  return names.map(([key, name]) => {
    const to = url(data[key]);
    return to ? '<a class="social-button social-' + key + '" target="_blank" rel="noopener noreferrer" href="' + to + '">' + name + ' ↗</a>' : "";
  }).join("");
}
function publicCard(e) {
  if (e.type === "off") return '<div class="community-event off"><strong>Выходной</strong><small>Сегодня отдыхаем ✦</small></div>';
  if (e.type === "collab") return '<div class="community-event collab"><strong>' + h(e.game || "Коллаба") + '</strong><small>' + span(e) + ' МСК' + (e.partner ? ' · с ' + h(e.partner) + (e.someHidden ? ' (остальные скрыты)' : '') : ' · участники скрыты') + '</small></div>';
  return '<div class="community-event stream"><strong>' + h(e.title || "Неизвестно") + '</strong><small>' + span(e) + ' МСК</small></div>';
}
// Multiple accepted invitations for the same collaboration have separate
// privacy-safe Firestore markers. Show ONE public entry, never expose a name
// from a marker where the owner did not explicitly opt to disclose it.
function mergePublicCollabs(items) {
  const merged = new Map();
  for (const event of items) {
    const key = [event.date,event.start,event.end,event.type].join("|");
    if (!merged.has(key)) {
      merged.set(key,{...event,_partners:event.partner?[event.partner]:[],
        _hidden:event.partner?0:1});
      continue;
    }
    const row = merged.get(key);
    if (!row.game && event.game) row.game = event.game;
    if (event.partner && !row._partners.includes(event.partner)) row._partners.push(event.partner);
    if (!event.partner) row._hidden += 1;
  }
  return [...merged.values()].map(({_partners,_hidden,...event})=>({
    ...event,partner:_partners.join(", "),someHidden:!!_hidden && !!_partners.length
  }));
}

export async function startPublicView({ db, uid, screen, identity }) {
  identity.textContent = "Просмотр для зрителей";
  screen.innerHTML = '<div class="empty">Открываем расписание…</div>';
  const [profileDoc, collabsDoc, groupDoc] = await Promise.all([
    getDoc(doc(db, "publicSchedules", uid)),
    getDocs(collection(db, "publicCollabs", uid, "items")).catch(() => ({ docs: [] })),
    // Public projection contains only generic booked slots, never invitation messages.
    getDocs(collection(db, "publicGroupCollabs", uid, "items")).catch(() => ({ docs: [] }))
  ]);
  const data = profileDoc.exists() ? profileDoc.data() : { nick: "Стримера", events: [] };
  const collabs = collabsDoc.docs.map((d) => ({ ...d.data(), type: "collab" }));
  const groupCollabs = groupDoc.docs.map((d)=>({...d.data(),type:"collab"}));
  const events = [
    ...(Array.isArray(data.events) ? data.events.map((e) => ({ ...e, type: e.type || "stream" })) : []),
    ...mergePublicCollabs([...collabs,...groupCollabs])
  ];
  let monday = weekStart(todayMsk());
  const render = () => {
    const end = day(monday, 6);
    const cards = Array.from({ length: 7 }, (_, i) => {
      const date = day(monday, i);
      const onDate = events.filter((e) => e.date === date);
      const off = onDate.find((e) => e.type === "off");
      const weekday = readable(date, { weekday: "long" });
      const known = off ? [off] : onDate.sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")));
      const body = known.length ? known.map(publicCard).join("") : '<div class="community-event unknown"><strong>Неизвестно</strong><small>Планы ещё не объявлены</small></div>';
      return '<article class="week-card' + (date === todayMsk() ? ' current' : '') + '"><div class="week-date"><span>' + h(weekday) + '</span><b>' + readable(date, { day: "numeric", month: "short" }) + '</b></div><div class="week-content">' + body + '</div></article>';
    }).join("");
    screen.innerHTML = '<section class="community-page"><p class="eyebrow">Публичное расписание</p>' +
      '<div class="community-heading"><div><h1>Неделя ' + h(data.nick || "стримера") + '</h1><p class="sub">Планы на стримы с понедельника по воскресенье. Всё время — МСК (UTC+3). Игра и участники коллабов отображаются только с разрешения стримера.</p></div>' +
      '<div class="socials">' + socials(data) + '</div></div>' +
      '<div class="panel week-panel"><div class="section-bar week-top"><div><h2>План на неделю</h2><p class="tiny-note">' + h(readable(monday)) + ' — ' + h(readable(end)) + '</p></div>' +
      '<div class="button-row"><button class="button button-ghost small" data-community-week="-1" aria-label="Прошлая неделя">←</button><button class="button button-ghost small" data-community-week="0">Эта неделя</button><button class="button button-ghost small" data-community-week="1" aria-label="Следующая неделя">→</button></div></div>' +
      '<div class="week-board">' + cards + '</div></div>' +
      '<p class="tiny-note" style="margin:18px 0">«Неизвестно» означает, что стример ещё не опубликовал планы. Внутренние статусы недоступности и скрытые подробности коллабов здесь не отображаются.</p></section>';
  };
  const handler = (event) => {
    const b = event.target.closest("[data-community-week]");
    if (!b) return;
    const n = Number(b.dataset.communityWeek);
    monday = n === 0 ? weekStart(todayMsk()) : day(monday, n * 7);
    render();
  };
  screen.addEventListener("click", handler);
  render();
  return () => screen.removeEventListener("click", handler);
}
function personLabel(lock, ownerUid) {
  const name = lock.fromUid === ownerUid ? lock.toName : lock.fromName;
  return name ? h(name) : "Участница коллаба";
}
function moderatorLogin(screen) {
  screen.innerHTML = '<section class="auth"><div class="panel"><p class="eyebrow">Закрытый доступ</p><h1>Календарь модератора</h1>' +
    '<p class="sub">Войти можно только через персональный Firebase-аккаунт, которому владелица расписания разрешила доступ.</p>' +
    '<form data-form="mod-login"><div class="field"><label>Email</label><input type="email" name="email" autocomplete="username" required></div>' +
    '<div class="field"><label>Пароль</label><input type="password" name="password" autocomplete="current-password" required></div>' +
    '<button class="button" type="submit">Войти как модератор</button></form>' +
    '<p class="tiny-note" style="margin-top:18px">Если пароль не установлен, введи email и выбери восстановление ниже.</p>' +
    '<button class="button button-ghost small" data-action="reset-password">Восстановить пароль</button></div></section>';
}
export async function startModeratorView({ db, auth, uid, screen, identity, user }) {
  identity.textContent = "Модераторский раздел";
  if (!user) { moderatorLogin(screen); return () => {}; }
  screen.innerHTML = '<div class="empty">Проверяем права модератора…</div>';
  const access = await getDoc(doc(db, "moderatorAccess", uid, "users", user.uid));
  if (!access.exists() || access.data().enabled !== true) {
    screen.innerHTML = '<section class="auth"><div class="panel"><p class="eyebrow">Доступ закрыт</p><h1>Нет разрешения модератора</h1>' +
      '<p class="sub">Владелица должна разрешить твоему аккаунту просмотр именно этого расписания в Firebase.</p>' +
      '<div class="profile-link">UID модератора: ' + h(user.uid) + '</div>' +
      '<button class="button button-ghost" data-mod-logout="true">Выйти из аккаунта</button></div></section>';
    const handler = (e) => { if (e.target.closest("[data-mod-logout]")) signOut(auth); };
    screen.addEventListener("click", handler);
    return () => screen.removeEventListener("click", handler);
  }
  const m = await getDoc(doc(db, "members", uid));
  const owner = m.exists() ? m.data() : {};
  let month = todayMsk().slice(0, 7), slots = [], incoming = [], outgoing = [];
  const errors = [];
  const subs = [];
  function render() {
    const [year, mo] = month.split("-").map(Number);
    const firstWeekday = (new Date(year, mo - 1, 1).getDay() + 6) % 7;
    const begin = day(month + "-01", -firstWeekday);
    const days = firstWeekday + new Date(year, mo, 0).getDate() <= 35 ? 35 : 42;
    const lockMap = new Map([...incoming, ...outgoing].map((l) => [l.id, l]));
    const locks = [...lockMap.values()];
    const monthName = readable(month + "-01", { month: "long", year: "numeric" });
    let cells = "";
    for (let i = 0; i < days; i++) {
      const date = day(begin, i);
      const onDay = slots.filter((s) => s.date === date);
      const onLocks = locks.filter((l) => l.date === date);
      const previews = [
        ...onDay.slice(0, 2).map((s) => '<div class="mod-chip ' + h(s.type) + '">' + h(s.type === "off" ? "Выходной" : s.type === "stream" ? (s.title || "Стрим") : s.type === "busy" ? "Недоступна" : s.type === "maybe" ? "Под вопросом" : "Свободна") + '</div>'),
        ...onLocks.slice(0, 2).map(() => '<div class="mod-chip collab">Коллаба</div>')
      ].join("");
      cells += '<div class="mod-day' + (date.slice(0, 7) !== month ? " outside" : "") + (date === todayMsk() ? " today" : "") + '">' +
        '<span class="mod-day-number">' + Number(date.slice(8)) + '</span>' + previews + '</div>';
    }
    const monthLocks = locks.filter((l) => l.date.slice(0, 7) === month).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    const monthEvents = slots.filter((s) => s.date.slice(0, 7) === month).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    const detailed = monthLocks.map((l) => '<div class="mod-detail"><span class="tag collab">Коллаба</span>' +
      '<div><strong>' + h(l.game || "Игра не указана") + '</strong><div class="tiny-note">С ' + personLabel(l, uid) + ' · ' + h(readable(l.date)) + ' · ' + span(l) + ' МСК</div></div></div>').join("");
    const schedule = monthEvents.map((s) => '<div class="mod-detail"><span class="tag ' + h(s.type) + '">' +
      h(({ stream: "Стрим", off: "Выходной", busy: "Занята", maybe: "Под вопросом", free: "Свободна" })[s.type] || "План") +
      '</span><div><strong>' + h(s.type === "stream" ? (s.title || "Игра неизвестна") : s.type === "off" ? "Выходной" : "Личная отметка") +
      '</strong><div class="tiny-note">' + h(readable(s.date)) + ' · ' + span(s) + ' МСК</div></div></div>').join("");
    screen.innerHTML = '<section class="moderator-page"><p class="eyebrow">Только для авторизованных модераторов</p>' +
      '<div class="hero"><div><h1>Расписание ' + h(owner.nick || "стримера") + '</h1><p class="sub">Полный месяц и подтверждённые коллабы с играми и участниками. Только просмотр, время по Москве.</p></div>' +
      '<button class="button button-ghost small" data-mod-logout="true">Выйти</button></div>' +
      (errors.length ? '<div class="notice bad">' + h(errors.join(" · ")) + '</div>' : "") +
      '<div class="panel"><div class="section-bar"><div><h2 style="text-transform:capitalize">' + h(monthName) + '</h2><p class="tiny-note">Пн · Вт · Ср · Чт · Пт · Сб · Вс</p></div><div class="button-row">' +
      '<button class="button button-ghost small" data-mod-month="-1">←</button><button class="button button-ghost small" data-mod-month="0">Текущий месяц</button><button class="button button-ghost small" data-mod-month="1">→</button></div></div>' +
      '<div class="calendar-week">' + ["Пн","Вт","Ср","Чт","Пт","Сб","Вс"].map((x) => '<span>' + x + '</span>').join("") + '</div>' +
      '<div class="mod-month-grid">' + cells + '</div></div>' +
      '<div class="two" style="margin-top:19px"><section class="panel"><h2>Подтверждённые коллабы (' + monthLocks.length + ')</h2>' +
      (detailed || '<div class="empty">В этом месяце коллабов пока нет.</div>') + '</section><section class="panel"><h2>События месяца (' + monthEvents.length + ')</h2>' +
      (schedule || '<div class="empty">Запланированных событий пока нет.</div>') + '</section></div>' +
      '<p class="tiny-note" style="margin:18px 0">Модераторы не могут менять расписание, принимать приглашения или видеть личные сообщения в предложениях.</p></section>';
  }
  function watch(q, setter) {
    subs.push(onSnapshot(q, (snapshot) => {
      setter(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
      render();
    }, (error) => {
      errors.push(error?.message || "Ошибка чтения данных");
      render();
    }));
  }
  const handler = (event) => {
    if (event.target.closest("[data-mod-logout]")) { signOut(auth); return; }
    const button = event.target.closest("[data-mod-month]");
    if (!button) return;
    const d = Number(button.dataset.modMonth);
    if (d === 0) month = todayMsk().slice(0, 7);
    else {
      const [year, mo] = month.split("-").map(Number);
      const next = new Date(Date.UTC(year, mo - 1 + d, 1));
      month = next.toISOString().slice(0, 7);
    }
    render();
  };
  screen.addEventListener("click", handler);
  render();
  watch(query(collection(db, "slots"), where("ownerUid", "==", uid)), (rows) => { slots = rows; });
  watch(query(collection(db, "collabLocks"), where("fromUid", "==", uid)), (rows) => { outgoing = rows; });
  watch(query(collection(db, "collabLocks"), where("toUid", "==", uid)), (rows) => { incoming = rows; });
  return () => { for (const unsubscribe of subs) unsubscribe(); screen.removeEventListener("click", handler); };
}
