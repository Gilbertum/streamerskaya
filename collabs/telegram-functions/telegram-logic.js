"use strict";
const startOf = v => {
  const [date,time] = [String(v.date||""),String(v.start||"")];
  const start=Date.parse(date+"T"+time+":00+03:00");
  return Number.isFinite(start)?start:NaN;
};
function times(item){
  const start=startOf(item);
  let end=Date.parse(String(item.date)+"T"+String(item.end)+":00+03:00");
  if(!Number.isFinite(start)||!Number.isFinite(end))return null;
  if(end<=start)end+=86400000;
  return [start,end];
}
function overlaps(a,b){
  const x=times(a),y=times(b);
  return !!x&&!!y&&x[0]<y[1]&&y[0]<x[1];
}
function compatible(lock,p){
  return lock.fromUid===p.fromUid && lock.date===p.date &&
    lock.start===p.start && lock.end===p.end &&
    String(lock.game||"").trim().toLowerCase()===String(p.game||"").trim().toLowerCase();
}
function conflict({proposal,slots,locks,groups}){
  const users=new Set([proposal.fromUid,proposal.toUid]);
  for(const s of slots){
    if(!users.has(s.ownerUid)||["free","maybe"].includes(s.type))continue;
    if(s.type==="off" && s.date===proposal.date)return "Участник отмечен как выходной";
    if(overlaps(s,proposal))return "Есть пересечение со стримом или недоступным временем";
  }
  for(const lock of locks){
    if(lock.id===proposal.replacesId||!users.has(lock.fromUid)&&!users.has(lock.toUid))continue;
    if(compatible(lock,proposal)&&lock.fromUid===proposal.fromUid&&lock.toUid!==proposal.toUid)continue;
    if(overlaps(lock,proposal))return "Есть пересечение с другой подтверждённой коллабой";
  }
  for(const group of groups){
    if((group.participantsUids||[]).some(uid=>users.has(uid)) && overlaps(group,proposal))
      return "Есть пересечение с групповой коллабой";
  }
  return "";
}
function safeName(s){return String(s||"Стример").replace(/[\r\n\t]/g," ").trim().slice(0,90)}
function siteLink(uid){
  if(!/^[A-Za-z0-9_-]{12,128}$/.test(uid))throw new Error("Invalid UID");
  return "https://gilbertum.github.io/streamerskaya/collabs/#/s/"+uid;
}
function scheduleText(nick,uid){
  return "📅 Расписание обновилось!\nСмотреть по ссылке: "+siteLink(uid);
}
function inviteText(p){
  return "🎮 Приглашение на коллабу\nОт: "+safeName(p.fromName)+
    "\nИгра: "+safeName(p.game)+
    "\nКогда: "+String(p.date)+" · "+String(p.start)+"–"+String(p.end)+" МСК"+
    (p.message?"\n\n"+String(p.message).slice(0,250):"");
}
module.exports={overlaps,compatible,conflict,safeName,siteLink,scheduleText,inviteText};
