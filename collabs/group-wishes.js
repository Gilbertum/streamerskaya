import {
  doc, collection, query, where, writeBatch, updateDoc, serverTimestamp, FieldPath, getDocFromServer, getDocsFromServer
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
const moduleTag = new URL(import.meta.url).search || "?load=" + Date.now();
const { groupGuestNames, groupGuestRecordId } = await import("./group-guests.js" + moduleTag);
const { activeGroupMembers, activeInvitees, departed, groupAttendance, manualGuestNames,
  matchingManualSlot } = await import("./group-team.js" + moduleTag);

const h = (x) => String(x ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]);
const goodDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s||"") && !Number.isNaN(Date.parse(s+"T12:00:00Z"));
const goodTime = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s||"");
const time = o => h(o.start)+"–"+h(o.end);
const dateText = s => new Date(s+"T12:00:00Z").toLocaleDateString("ru-RU",{day:"numeric",month:"long",weekday:"short"});
export function groupParticipants(g){return activeGroupMembers(g).ids;}
export function groupCollections(groupsA, groupsB) {
  return [...new Map([...groupsA,...groupsB].map(g=>[g.id,g])).values()]
    .sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
}
export function groupIsConfirmed(g){return g.status==="confirmed"&&Number.isInteger(g.chosenIndex)&&!!g.options?.[g.chosenIndex];}
export function groupChosen(g){return groupIsConfirmed(g)?g.options[g.chosenIndex]:null;}
export function groupCommon(g){
  if(g.status!=="collecting" || !activeInvitees(g).length)return [];
  return g.options.map((o,i)=>({ ...o,index:i })).filter(o=>
    activeInvitees(g).every(uid=>Array.isArray(g.responses?.[uid])&&g.responses[uid].includes(o.index)));
}
export function groupInboxHtml(groups,uid,guestRecords=[]){
  if(!groups.length)return "";
  const cards=groups.map(g=>{
    const owner=g.organizerUid===uid;
    const attendance=groupAttendance(g,uid);
    const allReplied=activeInvitees(g).every(id=>Array.isArray(g.responses?.[id]));
    const common=groupCommon(g);
    const confirmed=groupChosen(g);
    const current=Array.isArray(g.responses?.[uid])?g.responses[uid]:[];
    const pending=g.status==="collecting";
    const guests=g.status==="confirmed" ? groupGuestNames({...g,...(groupChosen(g)||{})},guestRecords) : [];
    const names=activeGroupMembers(g).names.join(", ");
    const left=(g.inviteeUids||[]).filter(id=>departed(g).includes(id)).map(id=>
      g.inviteeNames?.[g.inviteeUids.indexOf(id)]||"Участник");
    let details="";
    if(attendance==="departed"){
      details='<div class="notice info">Ты отказался от участия. Коллаба остаётся у остальных.</div>';
    } else if(pending&&!owner){
      details='<p class="tiny-note">Отметь ВСЕ варианты, которые тебе подходят. Организатор выберет один общий после ответов остальных.</p>'+
        '<div class="group-options">'+g.options.map((o,i)=>
          '<label class="group-option"><input type="checkbox" data-group-choice="'+h(g.id)+'" value="'+i+'"'+(current.includes(i)?" checked":"")+'>'+
          '<span>'+h(dateText(o.date))+' · '+time(o)+' МСК</span></label>').join("")+'</div>'+
        '<div class="button-row"><button class="button small" data-action="group-reply" data-id="'+h(g.id)+'">Отправить выбранные варианты</button></div>';
    } else if(pending&&owner){
      details='<div class="group-responses">'+activeInvitees(g).map(id=>{
        const i=g.inviteeUids.indexOf(id);
        const selected=g.responses?.[id];
        return '<div class="group-answer"><strong>'+h(g.inviteeNames?.[i]||"Участник")+'</strong>'+
          '<small>'+(Array.isArray(selected)?(selected.length?selected.map(n=>h(dateText(g.options[n]?.date||g.options[0].date))+" · "+time(g.options[n]||g.options[0])).join("; "):"Отклонено в Telegram"):"Ожидается ответ")+'</small></div>';
      }).join("")+'</div>'+
      '<p class="tiny-note">'+(allReplied?'Все ответили.':'Ожидаем ответы всех участников.')+
        (allReplied&&!common.length?' Нет общего окна: предложи новые даты.':'')+'</p>'+
      (left.length?'<div class="notice info">От участия отказались: '+h(left.join(", "))+
        '. Пригласи замену, не отменяя коллабу.</div>':"")+
      (common.length?'<div class="field"><label>Общее время (подходит всем)</label><select data-group-final-choice="'+h(g.id)+'">'+
        common.map(o=>'<option value="'+o.index+'">'+h(dateText(o.date))+' · '+time(o)+' МСК</option>').join("")+
        '</select></div><p class="tiny-note">Перед подтверждением обновим расписания всех участников с сервера Firebase. При занятости появится предупреждение, но подтверждение можно продолжить.</p>'+
        '<button class="button" data-action="group-finalize" data-id="'+h(g.id)+'">Подтвердить для всех</button>':'');
    } else if(confirmed){
      details='<div class="notice ok">Подтверждено: '+h(dateText(confirmed.date))+' · '+time(confirmed)+' МСК. Это время занято у всех участников.</div>'+
        '<p class="tiny-note">Гости вне сервиса: '+(guests.length?h(guests.join(", ")):"пока нет")+'</p>'+
        '<button class="button button-ghost small" data-action="group-details" data-id="'+h(g.id)+'">'+'Состав и видимость'+'</button>';
    } else {
      details='<span class="tiny-note">Приглашение отменено.</span>';
    }
    const canInvite=owner && (pending||g.status==="confirmed") && activeInvitees(g).length<10;
    const inviteAction=canInvite?
      '<button class="button button-ghost small" data-action="group-add-member" data-id="'+h(g.id)+'">+ Пригласить участника</button>':"";
    const leaveAction=!owner&&attendance==="active"&&g.status!=="cancelled"?
      '<button class="button button-subtle small" data-action="group-leave" data-id="'+h(g.id)+'">Отказаться от участия</button>':"";
    const cancelAction=owner&&g.status!=="cancelled"?
      '<button class="button button-subtle small" data-action="group-cancel" data-id="'+h(g.id)+'">Отменить для всех</button>':"";
    return '<article class="group-request"><div class="invite-top"><div><h3>'+h(g.game)+'</h3>'+
      '<p class="tiny-note">Организатор: '+h(g.organizerName)+' · Участники: '+h(names)+'</p></div>'+
      '<span class="tag '+(pending?'status-pending':g.status==="confirmed"?'status-accepted':'status-cancelled')+'">'+
      (pending?'Согласование':g.status==="confirmed"?"Подтверждено":"Отменено")+'</span></div>'+
      (g.message?'<p class="invite-message">'+h(g.message)+'</p>':"")+
      details+
      (inviteAction||leaveAction||cancelAction?
        '<div class="form-actions">'+inviteAction+leaveAction+cancelAction+'</div>':"")+
      '</article>';
  }).join("");
  return '<section class="panel" style="margin-bottom:20px"><div class="section-bar"><h2>Групповые коллабы</h2><span class="tiny-note">'+groups.length+' заявок</span></div>'+cards+'</section>';
}
function validateChoices(options,now) {
  if(options.length<1||options.length>5)throw new Error("Нужно от 1 до 5 вариантов.");
  const used=new Set();
  for(const o of options){
    if(!goodDate(o.date)||!goodTime(o.start)||!goodTime(o.end)||o.start===o.end||o.date<now)
      throw new Error("Проверь даты и время: варианты не должны быть в прошлом или иметь одинаковые часы.");
    const key=o.date+"|"+o.start+"|"+o.end;
    if(used.has(key))throw new Error("Повторяющиеся варианты не допускаются.");
    used.add(key);
  }
}
export async function createGroupWish({db,form,members,uid,nick,today,sourceSlot=null}){
  const game=String(form.elements.game.value||"").trim().slice(0,90);
  const message=String(form.elements.message.value||"").trim().slice(0,500);
  if(!game)throw new Error("Укажи игру.");
  const options=[...form.querySelectorAll("[data-wish-row]")].map(row=>({
    date:row.querySelector('[name="wishDate"]').value,
    start:row.querySelector('[name="wishStart"]').value,
    end:row.querySelector('[name="wishEnd"]').value
  }));
  validateChoices(options,today);
  const invited=[...new Set([...form.querySelectorAll('[name="wishRecipient"]:checked')].map(el=>el.value))];
  if(invited.length<1||invited.length>10)throw new Error("Выбери от одного до десяти участников.");
  if(invited.some(id=>id===uid||!members.some(m=>m.id===id)))throw new Error("Один из выбранных аккаунтов не найден.");
  const inviteeNames=invited.map(id=>members.find(m=>m.id===id).nick||"Стример");
  const ref=doc(collection(db,"groupWishes"));
  const participants=[uid,...invited];
  const names=[nick,...inviteeNames];
  const first=options[0];
  if(sourceSlot && (
    sourceSlot.ownerUid!==uid||sourceSlot.type!=="collab"||
    !sourceSlot.id||sourceSlot.title!==game||sourceSlot.date!==first.date||
    sourceSlot.start!==first.start||sourceSlot.end!==first.end||options.length!==1
  ))throw new Error("Данные ручной коллабы изменились. Сохрани её и открой приглашения заново.");
  const summary={organizerUid:uid,organizerName:nick,participants:names,
    game,date:first.date,start:first.start,end:first.end,status:"collecting"};
  const batch=writeBatch(db);
  batch.set(ref,{organizerUid:uid,organizerName:nick,inviteeUids:invited,inviteeNames,
    game,message,options,responses:{},status:"collecting",chosenIndex:-1,
    ...(sourceSlot?{sourceSlotId:sourceSlot.id}:{}),
    createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
  for(const ownerUid of participants)batch.set(doc(db,"groupDiary",ownerUid,"items",ref.id),summary);
  await batch.commit();
  return {id:ref.id,names:inviteeNames};
}
export async function replyGroupWish(db,group,uid,choices){
  if(group.status!=="collecting"||groupAttendance(group,uid)!=="active")throw new Error("Приглашение уже закрыто или ты отказался от участия.");
  const selections=[...new Set(choices)].sort((a,b)=>a-b);
  if(!selections.length||selections.some(n=>!Number.isInteger(n)||n<0||n>=group.options.length))
    throw new Error("Выбери хотя бы один подходящий вариант.");
  await updateDoc(doc(db,"groupWishes",group.id),
    new FieldPath("responses",uid),selections,"updatedAt",serverTimestamp());
}
// Force server reads immediately before a group is finalized; never fall back to cache.
export async function freshGroupFinalizeSnapshot(db,groupId,uid,index){
  const [groupSnapshot,slotSnapshot,lockSnapshot,calendarSnapshot,memberSnapshot]=await Promise.all([
    getDocFromServer(doc(db,"groupWishes",groupId)),
    getDocsFromServer(collection(db,"slots")),
    getDocsFromServer(collection(db,"collabLocks")),
    getDocsFromServer(collection(db,"groupCalendar")),
    getDocsFromServer(collection(db,"members"))
  ]);
  if(!groupSnapshot.exists())throw new Error("Групповая коллаба больше не найдена в Firebase.");
  const group={id:groupSnapshot.id,...groupSnapshot.data()};
  if(group.status!=="collecting"||group.organizerUid!==uid)
    throw new Error("Коллаба уже закрыта или у тебя нет прав организатора. Обнови страницу.");
  if(!Number.isInteger(index)||!group.options?.[index]||
     !groupCommon(group).some(o=>o.index===index))
    throw new Error("Вариант времени изменился или больше не согласован всеми участниками. Обнови приглашения.");
  const rows=snap=>snap.docs.map(d=>({id:d.id,...d.data()}));
  return {group,chosen:group.options[index],slots:rows(slotSnapshot),
    locks:rows(lockSnapshot),groups:rows(calendarSnapshot),members:rows(memberSnapshot)};
}

export async function finalizeGroupWish(db,group,uid,index){
  if(group.status!=="collecting"||group.organizerUid!==uid)throw new Error("Подтвердить время может только организатор.");
  if(!Number.isInteger(index)||index<0||index>=group.options.length||!groupCommon(group).some(o=>o.index===index))
    throw new Error("Этот слот не подтверждён всеми участниками.");
  const chosen=group.options[index];
  const {ids:participants,names:participantNames}=activeGroupMembers(group);
  let oldSlot=null;
  if(group.sourceSlotId){
    const original=await getDocFromServer(doc(db,"slots",group.sourceSlotId));
    oldSlot=original.exists()?{id:original.id,...original.data()}:null;
    if(!matchingManualSlot(oldSlot,group,chosen))
      throw new Error("Исходная ручная коллаба была изменена или удалена. Проверь календарь и создай новое приглашение.");
  }
  const batch=writeBatch(db);
  batch.update(doc(db,"groupWishes",group.id),{status:"confirmed",chosenIndex:index,updatedAt:serverTimestamp()});
  batch.set(doc(db,"groupCalendar",group.id),{
    organizerUid:group.organizerUid, participantsUids:participants,
    participants: participantNames,
    game:group.game,date:chosen.date,start:chosen.start,end:chosen.end
  });
  for(const ownerUid of participants){
    batch.update(doc(db,"groupDiary",ownerUid,"items",group.id),{
      status:"confirmed",date:chosen.date,start:chosen.start,end:chosen.end,
      participants:participantNames
    });
    batch.set(doc(db,"publicGroupCollabs",ownerUid,"items",group.id),{
      date:chosen.date,start:chosen.start,end:chosen.end,type:"collab",game:"",partner:""
    });
  }
  if(oldSlot){
    batch.delete(doc(db,"slots",oldSlot.id));
    const guestNames=manualGuestNames(oldSlot.guestNick,
      participantNames);
    if(guestNames.length)batch.set(doc(db,"collabGuests",groupGuestRecordId(group.id)),{
      ownerUid:group.organizerUid,date:chosen.date,start:chosen.start,end:chosen.end,
      game:group.game,guestNames,updatedAt:serverTimestamp()
    });
  }
  await batch.commit();
  return chosen;
}
export async function cancelGroupWish(db,group,uid){
  if(group.status==="cancelled"||!groupParticipants(group).includes(uid))throw new Error("Нет прав или коллаба уже отменена.");
  const batch=writeBatch(db);
  batch.update(doc(db,"groupWishes",group.id),{status:"cancelled",updatedAt:serverTimestamp()});
  if(group.status==="confirmed")batch.delete(doc(db,"groupCalendar",group.id));
  for(const ownerUid of groupParticipants(group)){
    batch.delete(doc(db,"groupDiary",ownerUid,"items",group.id));
    if(group.status==="confirmed")batch.delete(doc(db,"publicGroupCollabs",ownerUid,"items",group.id));
  }
  await batch.commit();
}


// A participant may withdraw without cancelling the group for everyone.
export async function leaveGroupWish(db,groupId,uid){
  const snapshot=await getDocFromServer(doc(db,"groupWishes",groupId));
  if(!snapshot.exists())throw new Error("Коллаба больше не найдена.");
  const group={id:snapshot.id,...snapshot.data()};
  if(!["collecting","confirmed"].includes(group.status)||
    groupAttendance(group,uid)!=="active")
    throw new Error("Нельзя отказаться: приглашение больше не активно.");
  const updated={...group,departedUids:[...departed(group),uid]};
  const batch=writeBatch(db);
  batch.update(doc(db,"groupWishes",groupId),{
    departedUids:updated.departedUids,updatedAt:serverTimestamp()
  });
  const {ids,names}=activeGroupMembers(updated);
  for(const ownerUid of ids){
    batch.update(doc(db,"groupDiary",ownerUid,"items",groupId),{participants:names});
  }
  batch.delete(doc(db,"groupDiary",uid,"items",groupId));
  if(group.status==="confirmed"){
    batch.update(doc(db,"groupCalendar",groupId),{participantsUids:ids,participants:names});
    batch.delete(doc(db,"publicGroupCollabs",uid,"items",groupId));
  }
  await batch.commit();
  return {group:updated,remaining:names};
}

// Organizer can invite an available person into the same group, preserving
// accepted participants and every existing booking.
export async function inviteGroupCandidate(db,groupId,uid,person){
  const snapshot=await getDocFromServer(doc(db,"groupWishes",groupId));
  if(!snapshot.exists())throw new Error("Коллаба уже не существует.");
  const group={id:snapshot.id,...snapshot.data()};
  if(!["collecting","confirmed"].includes(group.status)||group.organizerUid!==uid)
    throw new Error("Пригласить замену может только организатор активной коллабы.");
  if([group.organizerUid,...group.inviteeUids].includes(person?.id))
    throw new Error("Этот аккаунт уже участвовал в данной коллабе.");
  if(activeInvitees(group).length>=10)throw new Error("В группе максимум 10 приглашённых участников.");
  if((group.inviteeUids||[]).length>=30)throw new Error("Превышен лимит истории приглашений для этой коллабы.");
  const nick=String(person.nick||"").trim().slice(0,40);
  if(!nick)throw new Error("Участник без ника.");
  if(group.status==="collecting"){
    const updated={...group,inviteeUids:[...group.inviteeUids,person.id],
      inviteeNames:[...group.inviteeNames,nick]};
    const batch=writeBatch(db);
    batch.update(doc(db,"groupWishes",group.id),{
      inviteeUids:updated.inviteeUids,inviteeNames:updated.inviteeNames,updatedAt:serverTimestamp()
    });
    batch.set(doc(db,"groupDiary",person.id,"items",group.id),{
      organizerUid:group.organizerUid,organizerName:group.organizerName,
      participants:activeGroupMembers(updated).names,game:group.game,
      date:group.options[0].date,start:group.options[0].start,end:group.options[0].end,
      status:"collecting"
    });
    // Update every previous active diary's roster in the same batch.
    for(const id of activeGroupMembers(group).ids)
      batch.update(doc(db,"groupDiary",id,"items",group.id),{
        participants:activeGroupMembers(updated).names
      });
    await batch.commit();
    return {status:"collecting",candidate:nick};
  }
  const chosen=group.options[group.chosenIndex];
  const previous=await getDocsFromServer(query(collection(db,"groupJoinRequests"),where("organizerUid","==",uid)));
  if(previous.docs.some(d=>d.data().groupId===group.id && d.data().toUid===person.id && d.data().status==="pending"))
    throw new Error("Приглашение этому человеку уже отправлено. Дождись его ответа.");
  const ref=doc(collection(db,"groupJoinRequests"));
  await writeJoinRequest(db,ref,{
    groupId:group.id,organizerUid:uid,toUid:person.id,toName:nick,
    game:group.game,date:chosen.date,start:chosen.start,end:chosen.end,
    status:"pending",createdAt:serverTimestamp(),updatedAt:serverTimestamp()
  });
  return {status:"pending",candidate:nick};
}

// Kept as helper for easy injection in tests. No invitation reserves time.
async function writeJoinRequest(db,ref,data){
  const batch=writeBatch(db);
  batch.set(ref,data);
  await batch.commit();
}

export async function respondGroupJoin(db,requestId,uid,accept){
  const requestSnap=await getDocFromServer(doc(db,"groupJoinRequests",requestId));
  if(!requestSnap.exists())throw new Error("Приглашение на замену уже не существует.");
  const invite={id:requestSnap.id,...requestSnap.data()};
  if(invite.toUid!==uid||invite.status!=="pending")
    throw new Error("На это приглашение уже ответили или оно предназначено другому человеку.");
  const groupSnap=await getDocFromServer(doc(db,"groupWishes",invite.groupId));
  if(!groupSnap.exists())throw new Error("Исходная коллаба не найдена.");
  const group={id:groupSnap.id,...groupSnap.data()};
  if(group.status!=="confirmed"||group.organizerUid!==invite.organizerUid ||
     group.game!==invite.game)
    throw new Error("Коллаба изменилась или отменена.");
  const chosen=group.options[group.chosenIndex];
  if(!chosen||chosen.date!==invite.date||chosen.start!==invite.start||
    chosen.end!==invite.end)
    throw new Error("Дата коллабы изменилась. Попроси новое приглашение.");
  const batch=writeBatch(db);
  batch.update(doc(db,"groupJoinRequests",requestId),{
    status:accept?"accepted":"declined",updatedAt:serverTimestamp()
  });
  if(accept){
    if([group.organizerUid,...group.inviteeUids].includes(uid))
      throw new Error("Участник уже был приглашён в эту коллабу.");
    if(activeInvitees(group).length>=10||group.inviteeUids.length>=30)
      throw new Error("В коллабе больше нет свободных мест.");
    const amended={...group,inviteeUids:[...group.inviteeUids,uid],
      inviteeNames:[...group.inviteeNames,invite.toName],lastJoinId:requestId};
    const {ids,names}=activeGroupMembers(amended);
    batch.update(doc(db,"groupWishes",group.id),{
      inviteeUids:amended.inviteeUids,inviteeNames:amended.inviteeNames,
      lastJoinId:requestId,updatedAt:serverTimestamp()
    });
    batch.update(doc(db,"groupCalendar",group.id),{
      participantsUids:ids,participants:names
    });
    for(const personUid of activeGroupMembers(group).ids)
      batch.update(doc(db,"groupDiary",personUid,"items",group.id),{
        participants:names
      });
    batch.set(doc(db,"groupDiary",uid,"items",group.id),{
      organizerUid:group.organizerUid,organizerName:group.organizerName,
      participants:names,game:group.game,date:chosen.date,start:chosen.start,
      end:chosen.end,status:"confirmed"
    });
    batch.set(doc(db,"publicGroupCollabs",uid,"items",group.id),{
      type:"collab",date:chosen.date,start:chosen.start,end:chosen.end,
      game:"",partner:""
    });
  }
  await batch.commit();
  return {accepted:accept,groupId:group.id};
}
