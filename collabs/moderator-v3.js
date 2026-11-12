// Load the entire Collab Room module graph from the same fresh revision on every page visit.
const moduleTag = new URL(import.meta.url).search || "?load=" + Date.now();
import { doc, getDoc, collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
import { signOut } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
const { collabParties } = await import("./collab-parties.js" + moduleTag);

const h = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]);
function addDays(iso, n) { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0,10); }
function monthToday() { const p=new Intl.DateTimeFormat("en-US",{timeZone:"Europe/Moscow",year:"numeric",month:"2-digit"}).formatToParts(new Date()); const get=t=>p.find(x=>x.type===t).value; return get("year")+"-"+get("month"); }
function todayMsk() { const p=new Intl.DateTimeFormat("en-US",{timeZone:"Europe/Moscow",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date()); const get=t=>p.find(x=>x.type===t).value; return get("year")+"-"+get("month")+"-"+get("day"); }
function fmt(iso, opts = {day:"numeric",month:"long"}) { return new Date(iso + "T12:00:00Z").toLocaleDateString("ru-RU",opts); }
function hours(x) { if(x.start==="00:00"&&x.end==="00:00")return "Весь день";return (x.start||"??:??")+"–"+(x.end||"??:??"); }
function ownerKey(modUid) { return "collabRoom:modChannels:v3:"+modUid; }
function knownChannels(modUid) {
  try { const raw=JSON.parse(localStorage.getItem(ownerKey(modUid))||"[]");return Array.isArray(raw)?raw.filter(x=>typeof x==="string"&&/^[A-Za-z0-9_-]{12,128}$/.test(x)).slice(0,30):[]; }
  catch { return []; }
}
function remember(modUid,ownerUid) {
  try { localStorage.setItem(ownerKey(modUid),JSON.stringify([...new Set([ownerUid,...knownChannels(modUid)])].slice(0,30))); }
  catch { /* browser storage may be disabled */ }
}
function parseChannel(input) {
  const s=String(input||"").trim();
  if(/^[A-Za-z0-9_-]{12,128}$/.test(s))return s;
  const found=s.match(/#\/mod\/([A-Za-z0-9_-]{12,128})$/);
  return found?found[1]:null;
}
function tagType(type) { return ({stream:"Twitch",boosty:"Boosty",off:"Выходной",busy:"Занята",maybe:"Под вопросом",free:"Свободна",collab:"Коллаба",pending:"Ожидает подтверждения"})[type]||"Событие"; }
function slotTitle(s){return ["stream","boosty"].includes(s.type)?(s.title||"Игра неизвестна"):
  s.type==="collab"?"Коллаба: "+(s.title||"игра пока неизвестна"):
  s.type==="off"?"Выходной":tagType(s.type);}
function counterpart(lock,ownerUid){return ownerUid===lock.fromUid?(lock.toName||"Другой стример"):(lock.fromName||"Другой стример");}
function detailItem(item, kind, ownerUid) {
  let heading = kind==="slot" ? slotTitle(item) : (item.game||"Игра неизвестна");
  let tag = kind==="slot"?tagType(item.type):(kind==="pending"?"Предложение (не принято)":"Подтверждённый коллаб");
  const person = kind==="slot" ?
    (item.type==="collab"&&item.guestNick?'<p class="muted" style="margin:6px 0">С кем: '+h(item.guestNick)+' (вне сайта)</p>':"") :
    item.participants?.length?"":'<p class="muted" style="margin:6px 0">С кем: '+h(counterpart(item,ownerUid))+'</p>';
  const groupInfo=item.participants?.length?'<p class="tiny-note">Участники: '+h(item.participants.join(", ")) +'</p>':"";
  const note = kind==="slot"&&item.details?'<p style="white-space:pre-wrap">'+h(item.details)+'</p>':"";
  const status = kind==="slot" ? (item.public===false?"Скрыто от зрителей":"") : kind==="pending"?"Ожидает согласия второй стороны":"Подтверждено";
  return '<div class="mod-detail-full"><span class="tag '+h(kind==="pending"?"maybe":kind==="slot"?item.type:"collab")+'">'+h(tag)+'</span>'+
    '<h3>'+h(heading)+'</h3><p class="tiny-note">'+h(fmt(item.date))+' · '+h(hours(item))+' МСК</p>'+
    person+groupInfo+note+(status?'<p class="tiny-note">'+h(status)+'</p>':"")+'</div>';
}
function openDay(date, slots, locks, pending, ownerUid, focusId) {
  const events=[
    ...slots.filter(x=>x.date===date).map(x=>({...x,kind:"slot"})),
    ...locks.filter(x=>x.date===date).map(x=>({...x,kind:"collab"})),
    ...pending.filter(x=>x.date===date).map(x=>({...x,kind:"pending"}))
  ];
  const sorted=events.sort((a,b)=>(a.id===focusId?-1:b.id===focusId?1:a.start.localeCompare(b.start)));
  const html='<h2 id="modalTitle">События: '+h(fmt(date,{weekday:"long",day:"numeric",month:"long"}))+'</h2>'+
    (sorted.length?sorted.map(x=>detailItem(x,x.kind,ownerUid)).join(""):'<div class="empty">В этот день запланированных событий нет.</div>')+
    '<div class="form-actions"><button type="button" data-action="close-modal" class="button button-ghost">Закрыть</button></div>';
  document.getElementById("modalContent").innerHTML=html;
  document.getElementById("modal").hidden=false;
}
function noLogin(screen){
  screen.innerHTML='<section class="auth"><div class="panel"><p class="eyebrow">Вход по приглашению</p><h1>Календарь модератора</h1>'+
    '<p class="sub">Нужен отдельный Firebase-аккаунт, которому администратор канала разрешила доступ.</p>'+
    '<form data-form="mod-login"><div class="field"><label>Email</label><input type="email" name="email" autocomplete="username" required></div>'+
    '<div class="field"><label>Пароль</label><input type="password" name="password" autocomplete="current-password" required></div>'+
    '<button class="button" type="submit">Войти</button></form>'+
    '<p class="tiny-note" style="margin-top:18px">Не знаешь пароль? Введи почту и используй восстановление.</p>'+
    '<button class="button button-ghost small" data-action="reset-password">Восстановить пароль</button></div></section>';
}
export async function startModeratorV3({db,auth,uid,screen,identity,user}){
  identity.textContent="Модераторский раздел";
  if(!user){noLogin(screen);return ()=>{};}
  screen.innerHTML='<div class="empty">Проверяем разрешение на этот канал…</div>';
  const permitted=await getDoc(doc(db,"moderatorAccess",uid,"users",user.uid));
  if(!permitted.exists()||permitted.data().enabled!==true){
    screen.innerHTML='<section class="auth"><div class="panel"><p class="eyebrow">Закрытый раздел</p><h1>Нет доступа к этому каналу</h1>'+
      '<p class="sub">Уточни у стримера, добавлен ли твой UID в moderatorAccess для этого канала.</p>'+
      '<div class="profile-link">'+h(user.uid)+'</div><button class="button button-ghost" data-mod-logout="1">Выйти</button></div></section>';
    const handler=e=>{if(e.target.closest("[data-mod-logout]"))signOut(auth)};
    screen.addEventListener("click",handler);
    return ()=>screen.removeEventListener("click",handler);
  }
  remember(user.uid,uid);
  const m=await getDoc(doc(db,"members",uid));
  const owner=m.exists()?m.data():{};
  let month=monthToday(),slots=[],from=[],to=[],pending=[],groupDiary=[],channelOptions=[{uid,name:owner.nick||uid}];
  const subscriptions=[],errors=[];
  const known=knownChannels(user.uid).filter(x=>x!==uid).slice(0,20);
  // Each cached channel is checked against Firestore. The browser cache grants no privileges.
  const accessible=await Promise.all(known.map(async other=>{
    try{
      const a=await getDoc(doc(db,"moderatorAccess",other,"users",user.uid));
      if(!a.exists()||a.data().enabled!==true)return null;
      const profile=await getDoc(doc(db,"members",other));
      return {uid:other,name:profile.exists()?profile.data().nick||other:other};
    }catch{return null;}
  }));
  channelOptions.push(...accessible.filter(Boolean));
  function groupLegacy(x) {
    return { ...x,group:true,fromUid:x.organizerUid,toUid:uid,fromName:x.organizerName,
      toName:(x.participants||[]).filter(n=>n!==x.organizerName).join(", ")||"Участники" };
  }
  function monthLocks(){
    const independent = [...new Map([...from,...to].map(x=>[x.id,x])).values()];
    // Multiple accepted invitations for one organizer/game/time are ONE booking.
    return [...collabParties(independent),...groupDiary.filter(x=>x.status==="confirmed").map(groupLegacy)];
  }
  function monthPending(){return [...pending,...groupDiary.filter(x=>x.status==="collecting").map(groupLegacy)];}
  function render(){
    const [year,mo]=month.split("-").map(Number);
    const first=(new Date(Date.UTC(year,mo-1,1)).getUTCDay()+6)%7;
    const begin=addDays(month+"-01",-first),cellsCount=(first+new Date(Date.UTC(year,mo,0)).getUTCDate()<=35?35:42);
    const locks=monthLocks();
    let cells="";
    for(let i=0;i<cellsCount;i++){
      const date=addDays(begin,i);
      const daySlots=slots.filter(x=>x.date===date),dayLocks=locks.filter(x=>x.date===date),dayPending=monthPending().filter(x=>x.date===date);
      const cards=[
        ...daySlots.slice(0,3).map(x=>'<button type="button" class="mod-chip '+h(x.type)+'" data-mod-date="'+date+'" data-mod-id="'+h(x.id)+'" title="Подробнее">'+h(slotTitle(x))+'</button>'),
        ...dayLocks.slice(0,2).map(x=>'<button type="button" class="mod-chip collab" data-mod-date="'+date+'" data-mod-id="'+h(x.id)+'">✓ '+h(x.game||"Коллаба")+'</button>'),
        ...dayPending.slice(0,2).map(x=>'<button type="button" class="mod-chip maybe" data-mod-date="'+date+'" data-mod-id="'+h(x.id)+'">◷ Коллаба?</button>')
      ].join("");
      const total=daySlots.length+dayLocks.length+dayPending.length;
      const current=date===todayMsk();
      cells+='<div class="mod-day'+(date.slice(0,7)!==month?' outside':'')+(current?' today':'')+'">'+
        '<button type="button" class="mod-day-number" data-mod-date="'+date+'">'+Number(date.slice(8))+'</button>'+
        cards+(total>7?'<button type="button" class="mod-more" data-mod-date="'+date+'">Все события ('+total+')</button>':'')+'</div>';
    }
    const monthLocksList=locks.filter(x=>x.date.slice(0,7)===month).sort((a,b)=>(a.date+a.start).localeCompare(b.date+b.start));
    const pendingList=monthPending().filter(x=>x.date.slice(0,7)===month).sort((a,b)=>(a.date+a.start).localeCompare(b.date+b.start));
    const fullRows=monthLocksList.map(x=>'<button type="button" class="mod-row" data-mod-date="'+h(x.date)+'" data-mod-id="'+h(x.id)+'"><span class="tag collab">Принято</span>'+
      '<span><strong>'+h(x.game||"Коллаба")+'</strong><small>'+h(fmt(x.date))+' · '+h(hours(x))+' · '+h(counterpart(x,uid))+'</small></span></button>').join("");
    const pendingRows=pendingList.map(x=>'<button type="button" class="mod-row" data-mod-date="'+h(x.date)+'" data-mod-id="'+h(x.id)+'"><span class="tag maybe">Ожидает</span>'+
      '<span><strong>'+h(x.game||"Предложение")+'</strong><small>'+h(fmt(x.date))+' · '+h(hours(x))+' · '+h(counterpart(x,uid))+'</small></span></button>').join("");
    screen.innerHTML='<section class="moderator-page"><p class="eyebrow">Календарь модератора • только просмотр</p>'+
      '<div class="mod-head"><div><h1>Канал '+h(owner.nick||"стримера")+'</h1><p class="sub">Нажми на событие, чтобы увидеть игру, часы, гостей и примечания. Непринятые коллабы выделены жёлтым.</p></div>'+
      '<div class="mod-channel-controls"><label class="tiny-note" for="modSwitcher">Твои каналы</label>'+
      '<select id="modSwitcher" data-mod-switch aria-label="Переключить канал">'+channelOptions.map(x=>'<option value="'+h(x.uid)+'"'+(x.uid===uid?' selected':'')+'>'+h(x.name)+'</option>').join("")+'</select>'+
      '<button class="button button-ghost small" data-mod-add="1">+ Добавить канал</button>'+
      '<button class="button button-ghost small" data-mod-logout="1">Выйти</button></div></div>'+
      (errors.length?'<div class="notice bad">'+h(errors.join(" · "))+'</div>':'')+
      '<div class="panel"><div class="section-bar"><h2 class="calendar-heading">'+h(fmt(month+"-01",{month:"long",year:"numeric"}))+'</h2>'+
      '<div class="button-row"><button class="button button-ghost small" data-mod-month="-1">←</button><button class="button button-ghost small" data-mod-month="0">Этот месяц</button><button class="button button-ghost small" data-mod-month="1">→</button></div></div>'+
      '<div class="calendar-week">'+["Пн","Вт","Ср","Чт","Пт","Сб","Вс"].map(x=>'<span>'+x+'</span>').join("")+'</div>'+
      '<div class="mod-month-grid">'+cells+'</div></div>'+
      '<section class="panel" style="margin-top:18px"><div class="section-bar"><h2>Коллабы месяца</h2><span class="tiny-note">✓ подтверждено: '+monthLocksList.length+' · ◷ ожидает: '+pendingList.length+'</span></div>'+
      '<div class="two"><div><h3>Подтверждённые</h3>'+(fullRows||'<div class="empty">На этот месяц коллабов нет.</div>')+'</div>'+
      '<div><h3>Ожидают ответа</h3>'+(pendingRows||'<div class="empty">Нет неподтверждённых предложений.</div>')+'</div></div></section>'+
      '<p class="tiny-note" style="margin:15px 0">Модераторы не могут редактировать события и не видят личные сообщения приглашений. Каналы в переключателе — те, чьи ссылки уже открывались в этом браузере и доступ к которым подтверждён.</p></section>';
  }
  function watch(target,handle){
    subscriptions.push(onSnapshot(target,snapshot=>{handle(snapshot.docs.map(d=>({id:d.id,...d.data()})));render();},err=>{errors.push(err?.message||"Ошибка чтения");render();}));
  }
  const handler=e=>{
    const el=e.target.closest("[data-mod-date],[data-mod-month],[data-mod-add],[data-mod-logout]");
    if(!el)return;
    if(el.hasAttribute("data-mod-logout")){signOut(auth);return;}
    if(el.hasAttribute("data-mod-add")){
      const given=prompt("Вставь ссылку для модератора другого канала или UID стримера:");
      if(given===null)return;
      const target=parseChannel(given);
      if(!target){alert("Нужна ссылка вида .../#/mod/UID_СТРИМЕРА или сам UID.");return;}
      location.hash="#/mod/"+target;return;
    }
    if(el.hasAttribute("data-mod-date")){openDay(el.dataset.modDate,slots,monthLocks(),monthPending(),uid,el.dataset.modId||"");return;}
    const shift=Number(el.dataset.modMonth);
    if(shift===0)month=monthToday();
    else {const [y,m]=month.split("-").map(Number);month=new Date(Date.UTC(y,m-1+shift,1)).toISOString().slice(0,7);}
    render();
  };
  const change=e=>{
    const select=e.target.closest("[data-mod-switch]");
    if(select&&select.value!==uid)location.hash="#/mod/"+select.value;
  };
  screen.addEventListener("click",handler);
  screen.addEventListener("change",change);
  render();
  watch(query(collection(db,"slots"),where("ownerUid","==",uid)),x=>{slots=x;});
  watch(query(collection(db,"collabLocks"),where("fromUid","==",uid)),x=>{from=x;});
  watch(query(collection(db,"collabLocks"),where("toUid","==",uid)),x=>{to=x;});
  watch(collection(db,"moderatorPending",uid,"items"),x=>{pending=x;});
  watch(collection(db,"groupDiary",uid,"items"),x=>{groupDiary=x;});
  return ()=>{subscriptions.forEach(fn=>fn());screen.removeEventListener("click",handler);screen.removeEventListener("change",change);};
}
