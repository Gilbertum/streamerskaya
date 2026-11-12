// Framework-free, testable Telegram and collab decision logic.
export const safeName=value=>String(value||"Стример").replace(/[\r\n\t]/g," ").trim().slice(0,90);
export const siteUrl="https://gilbertum.github.io/streamerskaya/collabs/";
export function siteLink(uid){
  if(!/^[A-Za-z0-9_-]{12,128}$/.test(String(uid||"")))throw new Error("Invalid Firebase UID");
  return siteUrl+"#/s/"+uid;
}
export const scheduleText=uid=>"📅 Расписание обновилось!\nСмотреть по ссылке: "+siteLink(uid);
export function inviteText(p){
  return "🎮 Приглашение на коллабу\nОт: "+safeName(p.fromName)+
    "\nИгра: "+safeName(p.game)+"\nДата: "+String(p.date)+
    "\nВремя: "+String(p.start)+"–"+String(p.end)+" МСК"+
    (p.message?"\n\n"+String(p.message).slice(0,250):"");
}
export function groupText(g){
  const times=(g.options||[]).slice(0,5).map(o=>o.date+" · "+o.start+"–"+o.end+" МСК").join("\n");
  return "🎮 Групповая коллаба от "+safeName(g.organizerName)+
    "\nИгра: "+safeName(g.game)+"\nПредложенные даты:\n"+times+
    "\n\nЕсли вариантов больше одного, выбери подходящие даты в Collab Room: "+siteUrl;
}
export function interval(v){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(v.date||"")||
     !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.start||"")||
     !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.end||""))return null;
  const first=Date.parse(v.date+"T"+v.start+":00+03:00");
  let last=Date.parse(v.date+"T"+v.end+":00+03:00");
  if(!Number.isFinite(first)||!Number.isFinite(last))return null;
  if(last<=first)last+=86400000;
  return [first,last];
}
export function overlaps(a,b){
  const x=interval(a),y=interval(b);
  return !!x&&!!y&&x[0]<y[1]&&y[0]<x[1];
}
const same=(a,b)=>a.fromUid===b.fromUid&&a.date===b.date&&
  a.start===b.start&&a.end===b.end&&
  String(a.game||"").trim().toLowerCase()===String(b.game||"").trim().toLowerCase();
export function conflict({proposal,slots,locks,groups}){
  const users=new Set([proposal.fromUid,proposal.toUid]);
  for(const s of slots){
    if(!users.has(s.ownerUid)||["free","maybe"].includes(s.type))continue;
    if(s.type==="off" && s.date===proposal.date)return "Участник отметил выходной";
    if(overlaps(s,proposal))return "Время пересекается со стримом или недоступностью";
  }
  for(const lock of locks){
    if((proposal.replacesId && lock.id===proposal.replacesId) ||
      (!users.has(lock.fromUid)&&!users.has(lock.toUid)))continue;
    // An organizer can invite more players into the same already confirmed game.
    if(same(lock,proposal)&&lock.toUid!==proposal.toUid)continue;
    if(overlaps(lock,proposal))return "Время пересекается с подтверждённой коллабой";
  }
  for(const group of groups){
    if(group.participantsUids?.some(id=>users.has(id)) && overlaps(group,proposal))
      return "Время пересекается с групповой коллабой";
  }
  return "";
}
export function callbackMarkup(kind,id){
  return {inline_keyboard:[
    [{text:"✅ Принять",callback_data:"a:"+kind+":"+id},
     {text:"❌ Отклонить",callback_data:"d:"+kind+":"+id}],
    [{text:"📅 Проверить расписание",callback_data:"s:"+kind+":"+id}]
  ]};
}
export function recent(createdAt,now=Date.now(),maxAge=48*3600000){
  const timestamp=Date.parse(createdAt||"");
  return Number.isFinite(timestamp)&&timestamp<=now+60000&&timestamp>=now-maxAge;
}
