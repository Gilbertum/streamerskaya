// Load the entire Collab Room module graph from the same fresh revision on every page visit.
const moduleTag = new URL(import.meta.url).search || "?load=" + Date.now();
const { twitchPanelHtml, twitchLogin, twitchProfile } = await import("./twitch-panel.js" + moduleTag);
const { collabParties } = await import("./collab-parties.js" + moduleTag);
const { groupGuestNames } = await import("./group-guests.js" + moduleTag);
const { formatBirthday, upcomingBirthdays, availabilityText } = await import("./member-profile.js" + moduleTag);
const h = (value) => String(value ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
const link = (value) => { try { const u = new URL(String(value || "")); return u.protocol === "https:" ? h(u.href) : ""; } catch { return ""; } };
const day = (iso,n) => { const d=new Date(iso+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10); };
const dt = (iso, opts={day:"numeric",month:"long"}) => new Date(iso+"T12:00:00Z").toLocaleDateString("ru-RU",opts);
const time = (o) => o.start==="00:00"&&o.end==="00:00"?"Весь день":h(o.start||"")+"–"+h(o.end||"");
const todayMsk=()=>{
  const fields=new Intl.DateTimeFormat("en-US",{timeZone:"Europe/Moscow",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
  const get=type=>fields.find(part=>part.type===type).value;
  return get("year")+"-"+get("month")+"-"+get("day");
};
const birthdayLabel=p=>formatBirthday(p)?'<span class="birthday-date">🎂 '+h(formatBirthday(p))+'</span>':"";
function birthdayNotice(members){
  const next=upcomingBirthdays(members,todayMsk(),7);
  if(!next.length)return "";
  const today=next.filter(n=>n.days===0),soon=next.filter(n=>n.days>0);
  return '<aside class="birthday-notice" aria-label="Ближайшие дни рождения">'+
    (today.length?'🎂 Сегодня день рождения: '+today.map(n=>h(n.nick)).join(", ")+'!':"")+
    (soon.length?(today.length?' <span class="birthday-separator"></span>':"")+
      '🎉 Скоро: '+soon.map(n=>h(n.nick)+' ('+h(dt(n.date,{day:"numeric",month:"long"}))+')').join(", "):"")+
    '</aside>';
}
const socials = (person) => [
  ["twitch","Twitch"],["telegram","Telegram"],["youtube","YouTube"],
  ["tiktok","TikTok"],["discord","Discord"],["steam","Steam"],["telegramDM","Написать в личный Telegram"]
].map(([key,label])=>{const url=link(person[key]);return url?'<a class="button button-ghost small" href="'+url+'" target="_blank" rel="noopener noreferrer">'+label+' ↗</a>':"";}).join("");
function ownDiaryEvents(uid,slots,locks,diary,members,manualGuests=[]) {
  return [
    ...slots.filter(e=>e.ownerUid===uid).map(e=>({...e,kind:"slot"})),
    ...collabParties(locks,id=>members.find(m=>m.id===id)?.nick||"",manualGuests)
      .filter(e=>e.participantUids.includes(uid)).map(e=>({...e,type:"collab",kind:"party"})),
    ...diary.filter(e=>e.status==="confirmed"&&e.participantsUids?.includes(uid)).map(e=>({...e,type:"collab",kind:"group",manualGuests:groupGuestNames(e,manualGuests)}))
  ];
}
function typeName(e){
  return e.type==="stream"?"Twitch":e.type==="boosty"?"Boosty":e.type==="off"?"Выходной":e.type==="collab"?"Коллаба":e.type==="busy"?availabilityText(null,"unavailable"):e.type==="maybe"?"Под вопросом":availabilityText(null,"free");
}
function description(e){
  if(["stream","boosty"].includes(e.type))return e.title||"Игра пока неизвестна";
  if(e.type==="collab")return e.kind==="slot" ? "Коллаба"+(e.title?": "+e.title:"") : (e.game||"Коллаба");
  return typeName(e);
}
export function streamersHtml({members,slots,locks,diary,selectedUid,month,me,manualGuests=[]}){
  const people=[...members];
  if(!selectedUid){
    const list=people.sort((a,b)=>a.nick.localeCompare(b.nick,"ru")).map(p=>{
      const meta=twitchProfile(twitchLogin(p.twitch));
      const avatar=meta?.avatar && link(meta.avatar)
        ? '<img loading="lazy" alt="" src="'+link(meta.avatar)+'">' : h((p.nick||"?").slice(0,1).toUpperCase());
      return '<button type="button" class="streamer-card" data-action="open-streamer" data-uid="'+h(p.id)+'">'+
        '<span class="streamer-card-avatar">'+avatar+'</span><span class="streamer-card-name">'+h(p.nick||"Участник")+'</span>'+
        '<span class="tiny-note">'+(p.weekdays?'Будни: '+h(p.weekdays):"Открыть профиль и расписание")+'</span>'+
        birthdayLabel(p)+
        '<span class="streamer-card-go">Профиль и календарь →</span></button>';
    }).join("");
    return '<div class="hero"><div><p class="eyebrow">Участники комнаты</p><h1>Стримеры</h1><p class="sub">Смотри, кто в эфире, открывай соцсети и месячные календари других стримеров. Личные сообщения из приглашений здесь не показываются.</p></div></div>'+
      birthdayNotice(members)+twitchPanelHtml(members) +
      '<section><div class="section-bar"><h2>Все участники ('+people.length+')</h2></div><div class="streamers-cards">'+
      (list||'<div class="empty">Другие стримеры пока не добавлены.</div>')+'</div></section>';
  }
  const person=members.find(m=>m.id===selectedUid);
  if(!person)return '<div class="empty">Участник не найден. <button class="button button-ghost" data-action="streamers-back">Назад</button></div>';
  const events=ownDiaryEvents(selectedUid,slots,locks,diary,members,manualGuests);
  const [year,mo]=month.split("-").map(Number);
  const first=(new Date(Date.UTC(year,mo-1,1)).getUTCDay()+6)%7;
  const start=day(month+"-01",-first);
  const count=(first+new Date(Date.UTC(year,mo,0)).getUTCDate()<=35)?35:42;
  let cells="";
  for(let i=0;i<count;i++){
    const date=day(start,i);
    const items=events.filter(x=>x.date===date).sort((a,b)=>a.start.localeCompare(b.start));
    const chips=items.slice(0,4).map(e=>'<span class="mod-chip '+h(e.type)+'" title="'+h(description(e))+'">'+h(description(e))+'</span>').join("");
    const birthdayHere=Number(date.slice(5,7))===person.birthMonth&&Number(date.slice(8))===person.birthDay;
    cells+='<button type="button" class="streamer-month-day'+(date.slice(0,7)!==month?' outside':'')+'" data-action="streamer-day" data-date="'+date+'">'+
      '<span class="mod-day-number">'+Number(date.slice(8))+(birthdayHere?' 🎂':'')+'</span>'+chips+
      (items.length>4?'<small>+'+(items.length-4)+'</small>':"")+'</button>';
  }
  return '<div class="hero"><div><p class="eyebrow">Карточка участника</p><h1>'+h(person.nick)+'</h1><p class="sub">Календарь на месяц (МСК). Стримы, выходные и подтверждённые коллабы; без переписки и внутренних сообщений.</p></div>'+
    '<button class="button button-ghost" data-action="streamers-back">← Ко всем стримерам</button></div>'+
    '<section class="panel" style="margin-bottom:18px"><h3>Ссылки и обычное время</h3>'+
      (birthdayLabel(person)?'<p class="birthday-profile">День рождения: '+birthdayLabel(person)+'</p>':"")+
      '<div class="button-row">'+
      (socials(person)||'<span class="tiny-note">Ссылки ещё не добавлены.</span>')+'</div>'+
      '<p class="tiny-note" style="margin-top:15px">Будни: '+h(person.weekdays||"не указано")+' · Выходные: '+h(person.weekend||"не указано")+'</p></section>'+
    '<section class="panel"><div class="section-bar"><h2 class="calendar-heading">'+h(dt(month+"-01",{month:"long",year:"numeric"}))+'</h2>'+
      '<div class="button-row"><button class="button button-ghost small" data-action="streamer-prev">←</button>'+
      '<button class="button button-ghost small" data-action="streamer-today">Этот месяц</button>'+
      '<button class="button button-ghost small" data-action="streamer-next">→</button></div></div>'+
      '<div class="calendar-week">'+["Пн","Вт","Ср","Чт","Пт","Сб","Вс"].map(w=>'<span>'+w+'</span>').join("")+'</div>'+
      '<div class="mod-month-grid">'+cells+'</div></section>';
}
export function streamerDayHtml({uid,date,slots,locks,diary,members,manualGuests=[]}){
  const person=members.find(m=>m.id===uid);
  const all=ownDiaryEvents(uid,slots,locks,diary,members,manualGuests).filter(e=>e.date===date).sort((a,b)=>a.start.localeCompare(b.start));
  const rows=all.map(e=>{
    const others=e.kind==="party"?e.participants.join(", ") :
      e.kind==="group"?[...(e.participants||[]),...(e.manualGuests||[]).map(n=>n+" (гость)")].join(", "):
      e.kind==="slot"&&e.type==="collab"?e.guestNick||"":"";
    return '<div class="mod-detail-full"><span class="tag '+h(e.type)+'">'+typeName(e)+'</span>'+
      '<h3>'+h(description(e))+'</h3><p class="tiny-note">'+time(e)+' МСК'+(others?' · состав: '+h(others):"")+'</p>'+
      (e.kind==="slot"&&e.details?'<p style="white-space:pre-wrap">'+h(e.details)+'</p>':"")+'</div>';
  }).join("");
  const isBirthday=person?.birthMonth===Number(date.slice(5,7))&&person?.birthDay===Number(date.slice(8));
  return '<h2 id="modalTitle">'+h(person?.nick||"Стример")+' · '+h(dt(date,{weekday:"long",day:"numeric",month:"long"}))+'</h2>'+
    (isBirthday?'<p class="birthday-profile">🎂 День рождения!</p>':"")+
    (rows||'<div class="empty">На этот день записей пока нет.</div>')+
    '<div class="form-actions"><button type="button" class="button button-ghost" data-action="close-modal">Закрыть</button></div>';
}
