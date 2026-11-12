const moduleTag = new URL(import.meta.url).search || "?load=" + Date.now();
const { twitchLogin, twitchScheduleHeaders } = await import("./twitch-panel.js" + moduleTag);

// One-way, read-only Twitch -> Collab Room import. No Twitch manage scopes,
// Client Secret, proxy or Cloud Functions. The user confirms Firestore writes.
export const TWITCH_WINDOW_DAYS = 60;
const h = (x) => String(x ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);

export function twitchScheduleId(input) {
  const value = String(input || "").trim();
  if (/^[0-9]{4,24}$/.test(value)) return value;
  try {
    const url = new URL(value.replace(/^webcal:\/\//i,"https://"));
    if (url.protocol !== "https:" || url.hostname !== "api.twitch.tv" ||
        url.pathname !== "/helix/schedule/icalendar") return "";
    const id = url.searchParams.get("broadcaster_id") || "";
    return /^[0-9]{4,24}$/.test(id) ? id : "";
  } catch { return ""; }
}
export function scheduleStorageKey(uid) { return "collab-room:twitch-schedule:v1:" + uid; }
export function savedTwitchSchedule(uid) {
  try {
    const raw = JSON.parse(localStorage.getItem(scheduleStorageKey(uid)) || "{}");
    return {link: typeof raw.link === "string" ? raw.link : "",
      automatic: raw.automatic === true,
      checkedAt: Number(raw.checkedAt) || 0};
  } catch { return {link:"",automatic:false,checkedAt:0}; }
}
export function storeTwitchSchedule(uid, config) {
  try { localStorage.setItem(scheduleStorageKey(uid),JSON.stringify(config)); } catch { /* private browser */ }
}
export function preferredScheduleLink(member, uid) {
  const saved = savedTwitchSchedule(uid).link;
  if (saved) return saved;
  // This source was explicitly provided by Xwaran. Other accounts can paste
  // their own iCalendar URL or leave the field empty and use their Twitch link.
  return twitchLogin(member?.twitch) === "xwaran"
    ? "webcal://api.twitch.tv/helix/schedule/icalendar?broadcaster_id=1028275935" : "";
}
export function mskParts(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error("Twitch вернул некорректную дату.");
  const parts = new Intl.DateTimeFormat("en-US",{
    timeZone:"Europe/Moscow",year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",hourCycle:"h23"
  }).formatToParts(date);
  const get = type => parts.find(p=>p.type===type)?.value || "";
  return {date:get("year")+"-"+get("month")+"-"+get("day"),time:get("hour")+":"+get("minute")};
}
export function normalizeTwitchSegment(segment, today, maxDay) {
  if (!segment?.id || !segment.start_time || !segment.end_time || segment.canceled_until) return null;
  const start = mskParts(segment.start_time), end = mskParts(segment.end_time);
  if (start.date < today || start.date > maxDay || start.time === end.time) return null;
  const title = String(segment.category?.name || segment.title || "Стрим").trim().slice(0,90) || "Стрим";
  return { segmentKey:String(segment.id),date:start.date,start:start.time,end:end.time,
    title,fromTwitchTitle:String(segment.title||"").slice(0,140) };
}
export function dayPlus(iso,n) {
  const date=new Date(iso+"T12:00:00Z");
  date.setUTCDate(date.getUTCDate()+n);
  return date.toISOString().slice(0,10);
}
export function twitchOwnedId(uid,id) {return !!uid && id.startsWith("tw_"+uid+"_");}
export async function twitchDocumentId(uid, segmentKey) {
  const bytes = new TextEncoder().encode(uid+"|"+segmentKey);
  const digest = await crypto.subtle.digest("SHA-256",bytes);
  const fingerprint=Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,"0")).join("").slice(0,32);
  return "tw_"+uid+"_"+fingerprint;
}
async function helixGet(path,headers) {
  const response=await fetch("https://api.twitch.tv/helix/"+path,{headers,cache:"no-store"});
  if (response.status === 401) throw new Error("Сессия Twitch истекла. Во вкладке «Стримеры» нажми «Подключить Twitch» заново.");
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Не удалось прочитать расписание Twitch (HTTP "+response.status+").");
  return response.json();
}
export async function loadTwitchSchedule({source,twitchUrl,today}) {
  const headers=twitchScheduleHeaders();
  if (!headers) throw new Error("Для импорта сначала подключи Twitch во вкладке «Стримеры». Это чтение расписания, доступ к управлению каналом не требуется.");
  let broadcasterId=twitchScheduleId(source);
  if (String(source||"").trim() && !broadcasterId)
    throw new Error("Вставь ссылку webcal://api.twitch.tv/helix/schedule/icalendar?broadcaster_id=... или числовой ID.");
  const login=twitchLogin(twitchUrl);
  if (!broadcasterId) {
    if (!login) throw new Error("В профиле укажи Twitch-канал или вставь ссылку webcal на его расписание.");
    const user=await helixGet("users?login="+encodeURIComponent(login),headers);
    broadcasterId=String(user?.data?.[0]?.id||"");
    if (!broadcasterId) throw new Error("Не удалось получить ID Twitch-канала из профиля.");
  }
  const maxDay=dayPlus(today,TWITCH_WINDOW_DAYS);
  const startTime=new Date(today+"T00:00:00+03:00").toISOString();
  let cursor="",pages=0,broadcaster="",segments=[],hasMore=false;
  do {
    const query=new URLSearchParams({broadcaster_id:broadcasterId,start_time:startTime,first:"25"});
    if (cursor) query.set("after",cursor);
    const response=await helixGet("schedule?"+query.toString(),headers);
    if (!response) {
      if (!pages) throw new Error("На Twitch пока нет опубликованного расписания с будущими трансляциями. В Collab Room ничего не изменено.");
      break;
    }
    broadcaster=String(response.data?.broadcaster_login||"").toLowerCase();
    if(login && broadcaster && broadcaster!==login)
      throw new Error("Ссылка расписания принадлежит каналу "+broadcaster+", а в профиле указан "+login+". Проверь ссылку.");
    const items=response.data?.segments||[];
    segments.push(...items);
    pages+=1;
    cursor=String(response.pagination?.cursor||"");
    hasMore=!!cursor;
    // Segments are returned in chronological order by Twitch.
    const last=items[items.length-1];
    if (last?.start_time && mskParts(last.start_time).date>maxDay) break;
    if (items.length===0) break;
  } while(cursor && pages<12);
  if (hasMore && pages>=12) throw new Error("Расписание Twitch слишком большое для безопасного импорта. Ни одно событие не изменено.");
  const filtered=segments.map(s=>normalizeTwitchSegment(s,today,maxDay)).filter(Boolean);
  if(!filtered.length)throw new Error("На ближайшие 60 дней Twitch не вернул запланированных трансляций. Ничего не импортировано.");
  return {broadcasterId,broadcaster,segments:filtered,today,maxDay};
}
export async function prepareTwitchImport({uid,ownSlots,loaded}) {
  const newEvents=[],updated=[],removed=[],skipped=[];
  const existing=new Map(ownSlots.filter(e=>twitchOwnedId(uid,e.id)).map(e=>[e.id,e]));
  const seen=new Set();
  for (const item of loaded.segments) {
    const id=await twitchDocumentId(uid,item.segmentKey);
    if (seen.has(id)) continue;
    seen.add(id);
    const old=existing.get(id);
    const collision=ownSlots.find(e=>e.id!==id && !twitchOwnedId(uid,e.id) &&
      ((e.type==="off" && e.date===item.date) ||
      (e.type==="stream" && e.date===item.date && e.start===item.start && e.end===item.end)));
    if (!old && collision) {skipped.push({...item,reason:"Уже есть ручной стрим или выходной"});continue;}
    const data={ownerUid:uid,date:item.date,start:item.start,end:item.end,
      type:"stream",title:item.title,details:old?.details||"",public:old ? old.public!==false : true};
    if (!old) newEvents.push({id,...data});
    else if (["date","start","end","title"].some(k=>old[k]!==data[k]))
      updated.push({id,...data});
  }
  for (const item of existing.values()) {
    if(item.date>=loaded.today && item.date<=loaded.maxDay && !seen.has(item.id))
      removed.push(item);
  }
  return {newEvents,updated,removed,skipped,broadcasterId:loaded.broadcasterId,
    link:"webcal://api.twitch.tv/helix/schedule/icalendar?broadcaster_id="+loaded.broadcasterId,
    loadedCount:loaded.segments.length};
}
export function twitchPreviewHtml(plan) {
  const changed=[...plan.newEvents,...plan.updated];
  const list=changed.slice(0,12).map(e=>'<div class="tw-import-item"><strong>'+
    h(e.title)+'</strong><small>'+h(e.date)+' · '+h(e.start)+'–'+h(e.end)+' МСК</small></div>').join("");
  return '<div class="notice info">Новые стримы: <strong>'+plan.newEvents.length+'</strong> · обновления Twitch: <strong>'+plan.updated.length+
    '</strong> · совпадения с ручными планами: <strong>'+plan.skipped.length+'</strong></div>'+
    (list?'<div class="tw-import-list">'+list+'</div>':'<p class="tiny-note">Новых или изменённых стримов нет.</p>')+
    (changed.length>12?'<p class="tiny-note">И ещё '+(changed.length-12)+' событий.</p>':"")+
    (plan.removed.length?'<label class="check-line"><input name="removeMissingTwitch" type="checkbox"> Удалить '+plan.removed.length+
      ' ранее импортированных событий, которых больше нет на Twitch (необязательно)</label>':"")+
    '<p class="tiny-note">Ручные стримы, коллабы и выходные не перезаписываются. Импортированные новые стримы публикуются зрителям; скрытые ранее Twitch-события останутся скрытыми.</p>';
}
