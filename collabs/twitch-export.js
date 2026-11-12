// Collab Room -> Twitch, deliberate user-confirmed exports.
// Only public streams and collabs explicitly shown to this streamer's audience.
// Mappings persist in owner-only Firestore documents, never tokens or secrets.
const moduleTag = new URL(import.meta.url).search || "?load=" + Date.now();
const { twitchLogin, twitchScheduleHeaders } = await import("./twitch-panel.js" + moduleTag);
const { collabParties } = await import("./collab-parties.js" + moduleTag);
const { manualCollabTwitchTitle } = await import("./manual-collab.js" + moduleTag);

const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const isoDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||"")&& !Number.isNaN(Date.parse(s+"T12:00:00Z"));
const tm=s=>/^([01]\d|2[0-3]):[0-5]\d$/.test(s||"");
const min=(v)=>Math.round(Number(v));
export function utcWindow(event){
  if(!isoDate(event.date)||!tm(event.start)||!tm(event.end)||event.start===event.end)return null;
  const start=new Date(event.date+"T"+event.start+":00+03:00");
  if(start.getTime()<=Date.now()+5*60000)return null;
  let end=new Date(event.date+"T"+event.end+":00+03:00");
  if(end<=start)end=new Date(end.getTime()+86400000);
  const duration=min((end-start)/60000);
  if(duration<30||duration>1380)return null;
  return {start:start.toISOString(),end:end.toISOString(),duration};
}
export function collabSourceId(party){
  const str=[party.fromUid,party.date,party.start,party.end,String(party.game||"").trim().toLowerCase()].join("|");
  // Two independent 32-bit hashes avoid coupling the source key to the representative lock ID.
  let a=0x811c9dc5,b=0x2468ace1;
  for(let i=0;i<str.length;i++){
    const code=str.charCodeAt(i);
    a=Math.imul(a^code,0x01000193);
    b=Math.imul(b^(code+97),0x01000193);
  }
  return "party_"+(a>>>0).toString(16).padStart(8,"0")+(b>>>0).toString(16).padStart(8,"0");
}
const title=v=>String(v||"Стрим").trim().slice(0,140)||"Стрим";
export function buildTwitchExportSources({uid,slots,locks,groups,publicCollabs,publicGroups,today,limit=60}){
  const result=[];
  const maxDay=new Date(today+"T12:00:00Z");maxDay.setUTCDate(maxDay.getUTCDate()+limit);
  const until=maxDay.toISOString().slice(0,10);
  const push=(id,type,e,display)=>{
    if(!e||e.date<today||e.date>until)return;
    const window=utcWindow(e);
    if(!window)return;
    result.push({id,type,display:title(display),date:e.date,start:e.start,end:e.end,
      startUtc:window.start,endUtc:window.end,duration:window.duration});
  };
  for(const e of slots) {
    // Do not echo records previously pulled FROM Twitch in the retired importer.
    if(e.ownerUid!==uid||!["stream","collab"].includes(e.type)||
      e.public!==true||e.id.startsWith("tw_"+uid+"_"))continue;
    push("slot_"+e.id,e.type,e,
      e.type==="collab" ? manualCollabTwitchTitle(e) : (e.title||"Стрим"));
  }
  const visible=new Map(publicCollabs.map(p=>[p.id,p]));
  for(const party of collabParties(locks)){
    if(!party.participantUids.includes(uid))continue;
    const shared=party.locks.map(l=>visible.get(l.id)).filter(Boolean);
    if(!shared.length)continue;
    const announced=shared.find(p=>p.game)||shared[0];
    push(collabSourceId(party),"collab",party,announced.game||"Коллаба");
  }
  const publicGroupMap=new Map(publicGroups.map(p=>[p.id,p]));
  for(const g of groups){
    if(!g.participantsUids?.includes(uid))continue;
    const publicEvent=publicGroupMap.get(g.id);
    if(!publicEvent)continue;
    push("group_"+g.id,"collab",g,publicEvent.game||"Коллаба");
  }
  const winnerByWindow=new Map();
  // One Twitch segment for the same stream and collaboration time.
  for(const item of result){
    const key=item.startUtc+"|"+item.endUtc,old=winnerByWindow.get(key);
    if(!old || old.type==="collab"&&item.type==="stream")winnerByWindow.set(key,item);
  }
  return [...winnerByWindow.values()].sort((a,b)=>a.startUtc.localeCompare(b.startUtc)||a.id.localeCompare(b.id));
}
async function twitchRequest(path,headers,options={}){
  const response=await fetch("https://api.twitch.tv/helix/"+path,{
    ...options,headers:{...headers,...options.headers},cache:"no-store"
  });
  if(response.status===404 && options.missingOk)return null;
  if(!response.ok){
    let details="";
    try{const json=await response.json();details=String(json.message||"").slice(0,180);}catch{}
    if(response.status===401)throw new Error("Twitch: авторизация истекла или не предоставлено разрешение channel:manage:schedule.");
    if(response.status===403||response.status===400 && /affiliate|partner|non-recurring/i.test(details))
      throw new Error("Twitch не разрешает создать разовое событие. Для этого нужен Affiliate или Partner. "+details);
    throw new Error("Twitch API "+response.status+(details?": "+details:""));
  }
  if(response.status===204)return {};
  return response.json();
}
export async function exportIdentity(twitchProfileUrl){
  const headers=twitchScheduleHeaders();
  if(!headers)throw new Error("Сначала подключи Twitch во вкладке «Стримеры».");
  // Verify token and scope with Twitch. Never trust the login in localStorage.
  const validated=await fetch("https://id.twitch.tv/oauth2/validate",{
    headers:{Authorization:headers.Authorization.replace(/^Bearer /,"OAuth ")},cache:"no-store"
  });
  if(!validated.ok)throw new Error("Сессия Twitch истекла. Подключи аккаунт ещё раз.");
  const identity=await validated.json();
  const expected=twitchLogin(twitchProfileUrl);
  if(!expected)throw new Error("В профиле Collab Room должна быть ссылка на твой Twitch-канал.");
  if(String(identity.login||"").toLowerCase()!==expected)
    throw new Error("Сейчас авторизован Twitch «"+(identity.login||"другой аккаунт")+
      "», а в профиле Collab Room указан «"+expected+"». Подключи правильный аккаунт.");
  return {ready:Array.isArray(identity.scopes)&&identity.scopes.includes("channel:manage:schedule"),
    broadcasterId:String(identity.user_id||""),login:expected,headers};
}
// Twitch expands weekly recurring segments indefinitely into the future.
// Never read the entire schedule: check only the span of this export preview.
// A linked remote segment outside that span is checked separately by its ID.
export async function getTwitchSegments(identity,{sources=[],links=[]}={}){
  if(!sources.length)return [];
  const valid=sources.filter(x=>Number.isFinite(Date.parse(x.startUtc))&&Number.isFinite(Date.parse(x.endUtc)));
  if(valid.length!==sources.length)throw new Error("Один из стримов имеет неверную дату. Проверь расписание Collab Room.");
  const from=Math.min(...valid.map(x=>Date.parse(x.startUtc)));
  const to=Math.max(...valid.map(x=>Date.parse(x.endUtc)));
  // A Twitch segment can start the previous day and overlap the first event.
  const scanStart=new Date(from-24*3600000).toISOString();
  const remoteById=new Map();
  let cursor="",pages=0,previousStart=-Infinity,reachedEnd=false;
  const usedCursors=new Set();
  do{
    const q=new URLSearchParams({
      broadcaster_id:identity.broadcasterId,start_time:scanStart,first:"25"
    });
    if(cursor)q.set("after",cursor);
    const data=await twitchRequest("schedule?"+q.toString(),identity.headers,{missingOk:true});
    if(!data)break;
    const page=data.data?.segments||[];
    let beyond=false;
    for(const event of page){
      const start=Date.parse(event.start_time),end=Date.parse(event.end_time);
      if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)
        throw new Error("Twitch вернул некорректные даты. Экспорт остановлен для защиты от пересечений.");
      if(start<previousStart)
        throw new Error("Twitch вернул события не по порядку. Безопасно проверить совпадения не удалось.");
      previousStart=start;
      if(start>=to){beyond=true;continue;}
      if(end>from && event.id)remoteById.set(event.id,event);
    }
    pages++;
    cursor=data.pagination?.cursor||"";
    if(beyond){reachedEnd=true;break;}
    if(!cursor||page.length===0)break;
    if(usedCursors.has(cursor))
      throw new Error("Twitch повторил страницу расписания. Экспорт остановлен во избежание дублей.");
    usedCursors.add(cursor);
    if(pages>=40)
      throw new Error("В выбранном периоде Twitch вернул более 1000 записей. Безопасную проверку завершить не удалось.");
  }while(cursor);
  // A mapped segment could have moved outside the current Collab Room window.
  // Twitch supports fetching up to 100 explicit IDs; it ignores pagination.
  const relevantIds=new Set(sources.map(x=>links.find(l=>l.id===x.id)?.segmentId).filter(Boolean));
  const missing=[...relevantIds].filter(id=>!remoteById.has(id));
  for(let i=0;i<missing.length;i+=100){
    const q=new URLSearchParams({broadcaster_id:identity.broadcasterId});
    for(const id of missing.slice(i,i+100))q.append("id",id);
    const data=await twitchRequest("schedule?"+q.toString(),identity.headers,{missingOk:true});
    for(const event of data?.data?.segments||[])if(event.id&&relevantIds.has(event.id))
      remoteById.set(event.id,event);
  }
  return [...remoteById.values()];
}
function intersects(a,b){
  return Date.parse(a.startUtc)<Date.parse(b.end_time) &&
    Date.parse(b.start_time)<Date.parse(a.endUtc);
}
export function buildExportPlan({sources,links,remote}){
  const mapping=new Map(links.map(x=>[x.id,x]));
  const remoteById=new Map(remote.map(x=>[x.id,x]));
  const entries=[],reserved=[];
  for(const source of sources){
    const localConflict=reserved.some(x=>Date.parse(source.startUtc)<Date.parse(x.endUtc) &&
      Date.parse(x.startUtc)<Date.parse(source.endUtc));
    if(localConflict){
      entries.push({...source,mode:"blocked",why:"На сайте есть другое пересекающееся публичное событие."});
      continue;
    }
    reserved.push(source);
    const linked=mapping.get(source.id),remoteLinked=linked?remoteById.get(linked.segmentId):null;
    if(linked && !remoteLinked){
      entries.push({...source,mode:"blocked",why:"Связанный эфир удалён на Twitch. Новое событие не создаётся автоматически."});
      continue;
    }
    if(remoteLinked?.is_recurring){
      entries.push({...source,mode:"blocked",why:"Связано с повторяющимся событием Twitch. Изменять всю серию нельзя."});continue;
    }
    const competing=remote.find(x=>x.id!==remoteLinked?.id &&
      !x.canceled_until && intersects(source,x) &&
      !(!linked && !x.is_recurring &&
        Date.parse(x.start_time)===Date.parse(source.startUtc) &&
        Date.parse(x.end_time)===Date.parse(source.endUtc) &&
        String(x.title||"").trim()===source.display));
    if(competing){
      entries.push({...source,mode:"blocked",why:"На Twitch в это время уже есть другой эфир."});continue;
    }
    if(remoteLinked){
      const same=Date.parse(remoteLinked.start_time)===Date.parse(source.startUtc) &&
        Date.parse(remoteLinked.end_time)===Date.parse(source.endUtc) &&
        String(remoteLinked.title||"").trim()===source.display;
      entries.push({...source,mode:same?"same":"update",segmentId:remoteLinked.id});
      continue;
    }
    const exact=remote.find(x=>!x.is_recurring&&!x.canceled_until&&
      Date.parse(x.start_time)===Date.parse(source.startUtc)&&
      Date.parse(x.end_time)===Date.parse(source.endUtc)&&
      String(x.title||"").trim()===source.display);
    if(exact){
      entries.push({...source,mode:"exists",why:"Такой эфир уже есть на Twitch; не создаём дубль."});
      continue;
    }
    entries.push({...source,mode:"create"});
  }
  // Missing/hidden/deleted source events are deliberately never deleted by this tool.
  return entries;
}
export function exportPreviewHtml(plan,login){
  const candidates=plan.filter(x=>x.mode==="create"||x.mode==="update");
  const blocked=plan.filter(x=>x.mode==="blocked");
  return '<div class="notice info">Канал: <strong>'+esc(login)+'</strong>. Новых: '+plan.filter(x=>x.mode==="create").length+
    ' · обновлений: '+plan.filter(x=>x.mode==="update").length+
    ' · уже совпадают: '+plan.filter(x=>x.mode==="same"||x.mode==="exists").length+
    ' · конфликты: '+blocked.length+'</div>'+
    '<div class="twitch-export-items">'+plan.map(x=>
      '<label class="twitch-export-item'+(x.mode==="blocked"?' is-blocked':'')+'">'+
      '<input type="checkbox" name="pushItem" value="'+esc(x.id)+'"'+
      (x.mode==="create"||x.mode==="update"?' checked':' disabled')+'>'+
      '<span><strong>'+esc(x.display)+'</strong><small>'+esc(x.date)+' · '+esc(x.start)+'–'+esc(x.end)+' МСК</small>'+
      '<small>'+esc(x.mode==="create"?"Создать на Twitch":x.mode==="update"?"Обновить на Twitch":
        x.mode==="same"?"Уже синхронизировано":x.why||"Уже есть")+'</small></span></label>'
    ).join("")+'</div>'+
    '<p class="tiny-note">Twitch публичный. В список попадают только опубликованные зрителям стримы и подтверждённые коллабы с публичной отметкой. Выходные, личные планы и скрытые коллабы не отправляются. Уже созданные вручную события Twitch не изменяются.</p>'+
    (candidates.length?'':'<p class="tiny-note">Новых событий для экспорта нет.</p>');
}
export async function pushSelectedEvents({identity,plan,selected,saveLink}){
  const chosen=plan.filter(x=>selected.includes(x.id)&&(x.mode==="create"||x.mode==="update"));
  if(chosen.length>30)throw new Error("За один раз можно экспортировать не более 30 событий.");
  const results=[];
  for(const e of chosen){
    const body={start_time:e.startUtc,timezone:"Europe/Moscow",
      duration:e.duration,title:e.display};
    if(e.mode==="create")body.is_recurring=false;
    const params=new URLSearchParams({broadcaster_id:identity.broadcasterId});
    if(e.mode==="update")params.set("id",e.segmentId);
    try {
      const data=await twitchRequest("schedule/segment?"+params.toString(),identity.headers,{
        method:e.mode==="create"?"POST":"PATCH",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(body)
      });
      const id=data?.data?.segments?.[0]?.id || (e.mode==="update"?e.segmentId:"");
      if(!id)throw new Error("Twitch не вернул ID созданного события. Проверь расписание Twitch перед повторной попыткой.");
      await saveLink(e,id,identity.broadcasterId);
      results.push({id:e.id,ok:true});
    }catch(error){
      results.push({id:e.id,ok:false,error:String(error.message||error)});
      // Stop after error; never blindly retry POSTs because Twitch may have saved it.
      break;
    }
  }
  return results;
}
