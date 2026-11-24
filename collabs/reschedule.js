// Organizer-only, one-confirmation rescheduling of accepted collaborations.
// Transactions keep old records intact on any failure and never change public visibility.
import {
  doc, collection, query, where, getDocsFromServer, getDocFromServer,
  runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

const validTime=x=>/^([01]\d|2[0-3]):[0-5]\d$/.test(String(x||""));
const validDate=x=>/^\d{4}-\d{2}-\d{2}$/.test(String(x||""))&&
  new Date(x+"T12:00:00Z").toISOString().slice(0,10)===x;
export function validMoveWindow(value){
  return !!value&&validDate(value.date)&&validTime(value.start)&&validTime(value.end)&&
    (value.start!==value.end||value.start==="00:00");
}
export function sameWindow(a,b){
  return a?.date===b?.date&&a?.start===b?.start&&a?.end===b?.end;
}
export function movedOptionList(group,target){
  if(!validMoveWindow(target)||!Number.isInteger(group?.chosenIndex)||
    !group.options?.[group.chosenIndex])throw new Error("Некорректная дата или часы.");
  return group.options.map((option,i)=>i===group.chosenIndex?{...option,...target}:option);
}
export async function freshMoveContext(db,groupId,uid){
  const [wishSnap,calendarSnap,pendingSnap,slots,locks,groups,members]=await Promise.all([
    getDocFromServer(doc(db,"groupWishes",groupId)),
    getDocFromServer(doc(db,"groupCalendar",groupId)),
    getDocsFromServer(query(collection(db,"groupJoinRequests"),where("organizerUid","==",uid))),
    getDocsFromServer(collection(db,"slots")),
    getDocsFromServer(collection(db,"collabLocks")),
    getDocsFromServer(collection(db,"groupCalendar")),
    getDocsFromServer(collection(db,"members"))
  ]);
  if(!wishSnap.exists()||!calendarSnap.exists())throw new Error("Подтверждённая коллаба уже недоступна.");
  const group={id:wishSnap.id,...wishSnap.data()};
  const calendar={id:calendarSnap.id,...calendarSnap.data()};
  if(group.organizerUid!==uid||group.status!=="confirmed")
    throw new Error("Перенести групповую коллабу может только её организатор.");
  if(!sameWindow(group.options?.[group.chosenIndex],calendar))
    throw new Error("Участники или время изменились. Обнови расписание.");
  if(pendingSnap.docs.some(d=>d.data().groupId===groupId&&d.data().status==="pending"))
    throw new Error("Есть ожидающие ответа приглашения в группу. Сначала дождись ответа либо отмени их.");
  const rows=snap=>snap.docs.map(d=>({id:d.id,...d.data()}));
  return {group,calendar,slots:rows(slots),locks:rows(locks),groups:rows(groups),members:rows(members)};
}
export async function moveGroupForEveryone(db,context,target,uid){
  if(!validMoveWindow(target))throw new Error("Выбери корректную дату и часы (МСК).");
  if(sameWindow(context.calendar,target))throw new Error("Выбери другое время.");
  const groupRef=doc(db,"groupWishes",context.group.id);
  const calendarRef=doc(db,"groupCalendar",context.group.id);
  const guestRef=doc(db,"collabGuests","group_"+context.group.id);
  return runTransaction(db,async tx=>{
    const wishSnap=await tx.get(groupRef);
    const calendarSnap=await tx.get(calendarRef);
    const guestSnap=await tx.get(guestRef);
    if(!wishSnap.exists()||!calendarSnap.exists())throw new Error("Коллаба больше не подтверждена.");
    const g=wishSnap.data(),cal=calendarSnap.data();
    if(g.organizerUid!==uid||g.status!=="confirmed"||
      !sameWindow(g.options?.[g.chosenIndex],cal)||
      !sameWindow(cal,context.calendar)||
      JSON.stringify(cal.participantsUids)!==JSON.stringify(context.calendar.participantsUids))
      throw new Error("Коллаба изменилась за время проверки. Обнови страницу и повтори перенос.");
    if(guestSnap.exists()&&
      (!sameWindow(guestSnap.data(),cal)||guestSnap.data().ownerUid!==uid))
      throw new Error("Список гостей обновился. Повтори перенос после обновления.");
    const participants=cal.participantsUids;
    if(!Array.isArray(participants)||!participants.length||participants.length>11)
      throw new Error("Недопустимый состав групповой коллабы.");
    const refs=participants.map(id=>({
      uid:id,diary:doc(db,"groupDiary",id,"items",context.group.id),
      public:doc(db,"publicGroupCollabs",id,"items",context.group.id)
    }));
    const records=[];
    for(const ref of refs){
      const [diary,marker]=await Promise.all([tx.get(ref.diary),tx.get(ref.public)]);
      if(!diary.exists()||!marker.exists()||
        !sameWindow(diary.data(),cal)||!sameWindow(marker.data(),cal))
        throw new Error("У одного из участников расписание изменилось. Обнови страницу и повтори перенос.");
      records.push({ref,diary,marker});
    }
    tx.update(groupRef,{options:movedOptionList(g,target),updatedAt:serverTimestamp()});
    tx.update(calendarRef,target);
    for(const {ref} of records){
      tx.update(ref.diary,target);
      // Only the time changes. The streamer's independently chosen game/partner
      // visibility survives the move; no private details are opened.
      tx.update(ref.public,target);
    }
    if(guestSnap.exists())tx.update(guestRef,{...target,updatedAt:serverTimestamp()});
    return {participants:participants.length,old:cal,newTime:target};
  });
}
