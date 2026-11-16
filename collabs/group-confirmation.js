// Fresh group-booking review: pure helpers, no cached UI state and no writes.
const validTime=value=>/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value||""));
const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||""));
function interval(event){
  if(!validDate(event?.date)||!validTime(event?.start)||!validTime(event?.end))return null;
  const start=Date.parse(event.date+"T"+event.start+":00+03:00");
  let end=Date.parse(event.date+"T"+event.end+":00+03:00");
  if(!Number.isFinite(start)||!Number.isFinite(end))return null;
  if(end<=start)end+=86400000; // Overnight/whole-day bookings include the following date.
  return [start,end];
}
export function groupBookingOverlaps(a,b){
  const x=interval(a),y=interval(b);
  return !!x&&!!y&&x[0]<y[1]&&y[0]<x[1];
}
const slotDescription=item=>({
  stream:"Twitch",boosty:"Boosty",off:"Выходной",busy:"Недоступно",
  maybe:"Под вопросом",collab:"Коллаба"
})[item.type]||"Событие";

export function groupBookingConflicts(group,chosen,{slots=[],locks=[],groups=[],members=[]}={}){
  const ids=[...new Set([group.organizerUid,...(group.inviteeUids||[])])];
  const participants=new Set(ids);
  const names=new Map(members.map(m=>[m.id,m.nick]));
  if(!names.get(group.organizerUid))names.set(group.organizerUid,group.organizerName||"Организатор");
  (group.inviteeUids||[]).forEach((id,index)=>{
    if(!names.get(id))names.set(id,group.inviteeNames?.[index]||"Участник");
  });
  const conflicts=[],seen=new Set();
  const add=(uid,kind,record,label)=>{
    if(!participants.has(uid)||!groupBookingOverlaps(record,chosen))return;
    const id=record.id||[record.date,record.start,record.end,label].join("|");
    const key=uid+"|"+kind+"|"+id;
    if(seen.has(key))return;
    seen.add(key);
    conflicts.push({
      uid,nick:names.get(uid)||"Участник",kind,
      date:record.date,start:record.start,end:record.end,label
    });
  };
  for(const slot of slots){
    if(["free"].includes(slot.type))continue;
    const label=slotDescription(slot)+(slot.title?": "+slot.title:"")+
      (slot.type==="collab"&&slot.guestNick?" с "+slot.guestNick:"");
    add(slot.ownerUid,"slot",slot,label);
  }
  for(const lock of locks){
    const label="Подтверждённая коллаба: "+(lock.game||"без названия");
    add(lock.fromUid,"lock",lock,label);
    add(lock.toUid,"lock",lock,label);
  }
  for(const booking of groups){
    if(booking.id===group.id)continue;
    for(const uid of booking.participantsUids||[])
      add(uid,"group",booking,"Групповая коллаба: "+(booking.game||"без названия"));
  }
  return conflicts.sort((a,b)=>a.nick.localeCompare(b.nick,"ru")||
    a.date.localeCompare(b.date)||a.start.localeCompare(b.start));
}

export function groupConflictWarning(conflicts,chosen){
  const shown=conflicts.slice(0,8).map(c=>
    "• "+c.nick+": "+c.label+" — "+c.date+" "+c.start+"–"+c.end+" МСК");
  if(conflicts.length>8)shown.push("…ещё "+(conflicts.length-8)+" пересечений");
  return "ВНИМАНИЕ: сервер Firebase обнаружил пересечения для коллабы "+
    chosen.date+" "+chosen.start+"–"+chosen.end+" МСК:\n\n"+
    shown.join("\n")+
    "\n\nВсё равно подтвердить коллабу для всех участников? "+
    "Она появится в их расписаниях, а существующие события останутся без изменений.";
}
