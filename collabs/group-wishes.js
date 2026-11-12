import {
  doc, collection, writeBatch, updateDoc, serverTimestamp, FieldPath, getDoc
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

const h = (x) => String(x ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]);
const goodDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s||"") && !Number.isNaN(Date.parse(s+"T12:00:00Z"));
const goodTime = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s||"");
const time = o => h(o.start)+"–"+h(o.end);
const dateText = s => new Date(s+"T12:00:00Z").toLocaleDateString("ru-RU",{day:"numeric",month:"long",weekday:"short"});
export function groupParticipants(g){return [g.organizerUid,...(g.inviteeUids||[])];}
export function groupCollections(groupsA, groupsB) {
  return [...new Map([...groupsA,...groupsB].map(g=>[g.id,g])).values()]
    .sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
}
export function groupIsConfirmed(g){return g.status==="confirmed"&&Number.isInteger(g.chosenIndex)&&!!g.options?.[g.chosenIndex];}
export function groupChosen(g){return groupIsConfirmed(g)?g.options[g.chosenIndex]:null;}
export function groupCommon(g){
  if(g.status!=="collecting")return [];
  return g.options.map((o,i)=>({ ...o,index:i })).filter(o=>
    (g.inviteeUids||[]).every(uid=>Array.isArray(g.responses?.[uid])&&g.responses[uid].includes(o.index)));
}
export function groupInboxHtml(groups,uid){
  if(!groups.length)return "";
  const cards=groups.map(g=>{
    const owner=g.organizerUid===uid;
    const allReplied=(g.inviteeUids||[]).every(id=>Array.isArray(g.responses?.[id])&&g.responses[id].length>0);
    const common=groupCommon(g);
    const confirmed=groupChosen(g);
    const current=Array.isArray(g.responses?.[uid])?g.responses[uid]:[];
    const pending=g.status==="collecting";
    const names=[g.organizerName,...(g.inviteeNames||[])].join(", ");
    let details="";
    if(pending&&!owner){
      details='<p class="tiny-note">Отметь ВСЕ варианты, которые тебе подходят. Организатор выберет один общий после ответов остальных.</p>'+
        '<div class="group-options">'+g.options.map((o,i)=>
          '<label class="group-option"><input type="checkbox" data-group-choice="'+h(g.id)+'" value="'+i+'"'+(current.includes(i)?" checked":"")+'>'+
          '<span>'+h(dateText(o.date))+' · '+time(o)+' МСК</span></label>').join("")+'</div>'+
        '<div class="button-row"><button class="button small" data-action="group-reply" data-id="'+h(g.id)+'">Отправить выбранные варианты</button></div>';
    } else if(pending&&owner){
      details='<div class="group-responses">'+(g.inviteeUids||[]).map((id,i)=>{
        const selected=g.responses?.[id];
        return '<div class="group-answer"><strong>'+h(g.inviteeNames?.[i]||"Участница")+'</strong>'+
          '<small>'+(Array.isArray(selected)?selected.map(n=>h(dateText(g.options[n]?.date||g.options[0].date))+" · "+time(g.options[n]||g.options[0])).join("; "):"Ожидается ответ")+'</small></div>';
      }).join("")+'</div>'+
      '<p class="tiny-note">'+(allReplied?'Все ответили.':'Ожидаем ответы всех участниц.')+
        (allReplied&&!common.length?' Нет общего окна: предложи новые даты.':'')+'</p>'+
      (common.length?'<div class="field"><label>Общее время (подходит всем)</label><select data-group-final-choice="'+h(g.id)+'">'+
        common.map(o=>'<option value="'+o.index+'">'+h(dateText(o.date))+' · '+time(o)+' МСК</option>').join("")+
        '</select></div><button class="button" data-action="group-finalize" data-id="'+h(g.id)+'">Подтвердить для всех</button>':'');
    } else if(confirmed){
      details='<div class="notice ok">Подтверждено: '+h(dateText(confirmed.date))+' · '+time(confirmed)+' МСК. Это время занято у всех участников.</div>';
    } else {
      details='<span class="tiny-note">Приглашение отменено.</span>';
    }
    return '<article class="group-request"><div class="invite-top"><div><h3>'+h(g.game)+'</h3>'+
      '<p class="tiny-note">Организатор: '+h(g.organizerName)+' · Участники: '+h(names)+'</p></div>'+
      '<span class="tag '+(pending?'status-pending':g.status==="confirmed"?'status-accepted':'status-cancelled')+'">'+
      (pending?'Согласование':g.status==="confirmed"?"Подтверждено":"Отменено")+'</span></div>'+
      (g.message?'<p class="invite-message">'+h(g.message)+'</p>':"")+
      details+
      (g.status!=="cancelled"?'<div class="form-actions"><button class="button button-subtle small" data-action="group-cancel" data-id="'+h(g.id)+'">Отменить групповую коллабу</button></div>':"")+
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
export async function createGroupWish({db,form,members,uid,nick,today,busy}){
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
  if(invited.length<1||invited.length>10)throw new Error("Выбери от одной до десяти участниц.");
  if(invited.some(id=>id===uid||!members.some(m=>m.id===id)))throw new Error("Один из выбранных аккаунтов не найден.");
  if(!options.some(o=>!busy(uid,o)))throw new Error("В твоём календаре заняты все варианты.");
  const inviteeNames=invited.map(id=>members.find(m=>m.id===id).nick||"Стример");
  const ref=doc(collection(db,"groupWishes"));
  const participants=[uid,...invited];
  const names=[nick,...inviteeNames];
  const first=options[0];
  const summary={organizerUid:uid,organizerName:nick,participants:names,
    game,date:first.date,start:first.start,end:first.end,status:"collecting"};
  const batch=writeBatch(db);
  batch.set(ref,{organizerUid:uid,organizerName:nick,inviteeUids:invited,inviteeNames,
    game,message,options,responses:{},status:"collecting",chosenIndex:-1,
    createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
  for(const ownerUid of participants)batch.set(doc(db,"groupDiary",ownerUid,"items",ref.id),summary);
  await batch.commit();
  return {id:ref.id,names:inviteeNames};
}
export async function replyGroupWish(db,group,uid,choices){
  if(group.status!=="collecting"||!group.inviteeUids?.includes(uid))throw new Error("Приглашение уже закрыто.");
  const selections=[...new Set(choices)].sort((a,b)=>a-b);
  if(!selections.length||selections.some(n=>!Number.isInteger(n)||n<0||n>=group.options.length))
    throw new Error("Выбери хотя бы один подходящий вариант.");
  await updateDoc(doc(db,"groupWishes",group.id),
    new FieldPath("responses",uid),selections,"updatedAt",serverTimestamp());
}
export async function finalizeGroupWish(db,group,uid,index){
  if(group.status!=="collecting"||group.organizerUid!==uid)throw new Error("Подтвердить время может только организатор.");
  if(!Number.isInteger(index)||index<0||index>=group.options.length||!groupCommon(group).some(o=>o.index===index))
    throw new Error("Этот слот не подтверждён всеми участницами.");
  const chosen=group.options[index];
  const participants=groupParticipants(group);
  const batch=writeBatch(db);
  batch.update(doc(db,"groupWishes",group.id),{status:"confirmed",chosenIndex:index,updatedAt:serverTimestamp()});
  batch.set(doc(db,"groupCalendar",group.id),{
    organizerUid:group.organizerUid, participantsUids:participants,
    participants: [group.organizerName,...(group.inviteeNames||[])],
    game:group.game,date:chosen.date,start:chosen.start,end:chosen.end
  });
  for(const ownerUid of participants){
    batch.update(doc(db,"groupDiary",ownerUid,"items",group.id),{
      status:"confirmed",date:chosen.date,start:chosen.start,end:chosen.end
    });
    batch.set(doc(db,"publicGroupCollabs",ownerUid,"items",group.id),{
      date:chosen.date,start:chosen.start,end:chosen.end,type:"collab",game:"",partner:""
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
