"use strict";
const crypto=require("node:crypto");
const {initializeApp}=require("firebase-admin/app");
const {getFirestore,FieldValue}=require("firebase-admin/firestore");
const {onCall,onRequest,HttpsError}=require("firebase-functions/v2/https");
const {onDocumentCreated}=require("firebase-functions/v2/firestore");
const {defineSecret}=require("firebase-functions/params");
const {overlaps,conflict,siteLink,scheduleText,inviteText}=require("./telegram-logic");
initializeApp();
const db=getFirestore();
const BOT=defineSecret("TELEGRAM_BOT_TOKEN");
const WEBHOOK=defineSecret("TELEGRAM_WEBHOOK_SECRET");
const region="europe-west1";
const idOk=x=>/^[a-zA-Z0-9_-]{12,128}$/.test(String(x||""));
const ensure=(cond,code,msg)=>{if(!cond)throw new HttpsError(code,msg)};
async function allowed(uid){
  const snap=await db.doc("allowedUsers/"+uid).get();
  return snap.exists && snap.data().enabled===true;
}
async function authenticated(req){
  const uid=req.auth?.uid;
  ensure(uid&&await allowed(uid),"permission-denied","Нет доступа к Collab Room");
  return uid;
}
async function api(method,payload){
  const res=await fetch("https://api.telegram.org/bot"+BOT.value()+"/"+method,{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify(payload),signal:AbortSignal.timeout(18000)
  });
  const reply=await res.json();
  if(!res.ok||!reply.ok)throw new Error("Telegram "+method+": "+(reply.description||res.status));
  return reply.result;
}
const chRef=uid=>db.doc("telegramChannels/"+uid);
const acRef=uid=>db.doc("telegramAccounts/"+uid);

exports.telegramConnect=onCall({region,secrets:[BOT]},async req=>{
  const uid=await authenticated(req);
  const code=crypto.randomBytes(24).toString("hex");
  const bot=await api("getMe",{});
  await db.doc("telegramLinkCodes/"+code).set({
    ownerUid:uid,createdAt:FieldValue.serverTimestamp(),expiresAt:Date.now()+15*60*1000
  });
  return {url:"https://t.me/"+bot.username+"?start="+code};
});
exports.telegramStatus=onCall({region},async req=>{
  const uid=await authenticated(req);
  const [account,channel]=await Promise.all([acRef(uid).get(),chRef(uid).get()]);
  return {bound:account.exists,username:account.data()?.username||"",
    channel:channel.data()?.channel||""};
});
exports.telegramSetChannel=onCall({region,secrets:[BOT]},async req=>{
  const uid=await authenticated(req);
  const channel=String(req.data?.channel||"").trim();
  ensure(/^@[a-zA-Z0-9_]{5,32}$/.test(channel),"invalid-argument","Укажи публичный канал как @channel");
  const account=await acRef(uid).get();
  ensure(account.exists,"failed-precondition","Сначала привяжи личный Telegram через бота");
  const chat=await api("getChat",{chat_id:channel});
  ensure(chat.type==="channel","failed-precondition","Это не Telegram-канал");
  const bot=await api("getMe",{});
  const [botMember,userMember]=await Promise.all([
    api("getChatMember",{chat_id:chat.id,user_id:bot.id}),
    api("getChatMember",{chat_id:chat.id,user_id:Number(account.data().telegramUserId)})
  ]);
  ensure(["administrator","creator"].includes(botMember.status) &&
    (botMember.status==="creator"||botMember.can_post_messages===true),
    "permission-denied","Добавь бота администратором с правом публикации в канале");
  ensure(["administrator","creator"].includes(userMember.status),"permission-denied",
    "Твой привязанный Telegram должен быть администратором этого канала");
  await chRef(uid).set({ownerUid:uid,channel,chatId:String(chat.id),updatedAt:FieldValue.serverTimestamp()});
  return {channel};
});
exports.telegramPostSchedule=onCall({region,secrets:[BOT]},async req=>{
  const uid=await authenticated(req);
  const config=await chRef(uid).get();
  ensure(config.exists,"failed-precondition","Сначала подключи Telegram-канал в профиле");
  const record=config.data(), now=Date.now(), limit=db.doc("telegramChannelCooldown/"+uid);
  await db.runTransaction(async tx=>{
    const old=await tx.get(limit);
    ensure(!old.exists||now-(old.data().lastAt||0)>60000,"resource-exhausted",
      "Повторная публикация доступна через минуту");
    tx.set(limit,{lastAt:now});
  });
  try{
    const message=await api("sendMessage",{
      chat_id:record.chatId,text:scheduleText("",uid),disable_web_page_preview:false
    });
    return {channel:record.channel,messageId:message.message_id};
  }catch(error){
    await limit.delete().catch(()=>{});
    throw new HttpsError("failed-precondition",String(error.message||error));
  }
});
function eq(a,b){
  const x=Buffer.from(String(a||"")),y=Buffer.from(String(b||""));
  return x.length===y.length&&crypto.timingSafeEqual(x,y);
}
async function bindAccount(message){
  const match=String(message.text||"").match(/^\/start(?:@\w+)?\s+([a-f0-9]{48})$/i);
  if(!match||message.chat?.type!=="private")return;
  const ref=db.doc("telegramLinkCodes/"+match[1]),uid=await db.runTransaction(async tx=>{
    const snap=await tx.get(ref);
    if(!snap.exists||snap.data().expiresAt<Date.now())return null;
    const id=snap.data().ownerUid;
    tx.set(acRef(id),{ownerUid:id,chatId:String(message.chat.id),
      telegramUserId:String(message.from.id),username:message.from.username||"",
      updatedAt:FieldValue.serverTimestamp()});
    tx.delete(ref);
    return id;
  });
  await api("sendMessage",{chat_id:message.chat.id,text:uid?
    "✅ Telegram подключён к Collab Room. Новые приглашения будут приходить сюда.":
    "Ссылка устарела или уже использована. Создай новую в профиле Collab Room."});
}
const validCallback=v=>/^[adsc]:[pg]:[A-Za-z0-9_-]{12,128}$/.test(v||"");
async function respondProposal(id,uid,action){
  const ref=db.doc("proposals/"+id);
  return db.runTransaction(async tx=>{
    const snapshot=await tx.get(ref);
    if(!snapshot.exists)return "Приглашение больше не существует";
    const p=snapshot.data();
    if(p.toUid!==uid)return "Приглашение адресовано другому участнику";
    if(p.status!=="pending")return "Приглашение уже обработано";
    if(action==="a" && ((p.timeOptions||[]).length>1||p.replacesId))
      return "В этой заявке требуется выбрать время или согласовать перенос на сайте: "+siteLink(uid);
    if(action==="a"){
      const [slotDocs,lockDocs,groups]=await Promise.all([
        tx.get(db.collection("slots").where("ownerUid","in",[p.fromUid,p.toUid])),
        tx.get(db.collection("collabLocks")),
        tx.get(db.collection("groupCalendar"))
      ]);
      const reason=conflict({proposal:p,slots:slotDocs.docs.map(d=>d.data()),
        locks:lockDocs.docs.map(d=>({id:d.id,...d.data()})),
        groups:groups.docs.map(d=>d.data())});
      if(reason)return "Не удалось принять: "+reason+". Проверь календарь в Collab Room.";
      tx.set(db.doc("collabLocks/"+id),{
        fromUid:p.fromUid,toUid:p.toUid,fromName:p.fromName,toName:p.toName,
        date:p.date,start:p.start,end:p.end,game:p.game
      });
      for(const ownerUid of [p.fromUid,p.toUid])tx.set(db.doc("publicCollabs/"+ownerUid+"/items/"+id),{
        date:p.date,start:p.start,end:p.end,type:"collab",game:"",partner:""
      });
    }
    tx.update(ref,{status:action==="a"?"accepted":"declined",
      respondedAt:FieldValue.serverTimestamp()});
    for(const ownerUid of [p.fromUid,p.toUid])
      tx.delete(db.doc("moderatorPending/"+ownerUid+"/items/"+id));
    return action==="a"?"✅ Приглашение принято. Коллаба добавлена в календари.":"❌ Приглашение отклонено.";
  });
}
async function respondGroup(id,uid,action){
  const ref=db.doc("groupWishes/"+id);
  return db.runTransaction(async tx=>{
    const sn=await tx.get(ref);
    if(!sn.exists)return "Приглашение уже удалено";
    const g=sn.data();
    if(!g.inviteeUids?.includes(uid))return "Нет доступа";
    if(g.status!=="collecting")return "Согласование уже завершено";
    if(action==="a" && g.options.length!==1)
      return "В заявке несколько вариантов: выбери подходящие даты в Collab Room: "+siteLink(uid);
    tx.update(ref,{["responses."+uid]:action==="a"?[0]:[],
      updatedAt:FieldValue.serverTimestamp()});
    return action==="a"?"✅ Ответ отправлен. Организатор выберет окончательное время.":
      "❌ Отказ передан организатору.";
  });
}
async function sendScheduleToUser(uid,chatId,date){
  const [slots,locks]=await Promise.all([
    db.collection("slots").where("ownerUid","==",uid).get(),
    db.collection("collabLocks").get()
  ]);
  const items=[
    ...slots.docs.map(x=>x.data()).filter(x=>x.date===date),
    ...locks.docs.map(x=>x.data()).filter(x=>x.date===date && [x.fromUid,x.toUid].includes(uid))
  ].slice(0,15);
  const text=items.length?items.map(x=>"• "+(x.game||x.title||x.type||"Событие")+
    " · "+(x.start||"")+"–"+(x.end||"")).join("\n"):"На этот день записей пока нет.";
  await api("sendMessage",{chat_id:chatId,
    text:"📅 Твоё расписание · "+date+"\n"+text+"\n\nПолный календарь: "+siteLink(uid)});
}
async function handleCallback(c){
  const data=String(c.data||"");
  if(!validCallback(data))return api("answerCallbackQuery",{callback_query_id:c.id,text:"Кнопка больше не поддерживается"});
  const [action,kind,id]=data.split(":");
  const snap=await db.doc((kind==="p"?"proposals/":"groupWishes/")+id).get();
  if(!snap.exists)return api("answerCallbackQuery",{callback_query_id:c.id,text:"Приглашение не найдено"});
  const p=snap.data();
  const recipient=kind==="p"?p.toUid:null;
  let uid=recipient;
  if(kind==="g"){
    const recipients=p.inviteeUids||[];
    const accounts=await Promise.all(recipients.map(id=>acRef(id).get()));
    uid=recipients.find((id,i)=>accounts[i].exists&&
      accounts[i].data().telegramUserId===String(c.from.id));
  }
  const binding=uid?await acRef(uid).get():null;
  if(!binding?.exists||binding.data().telegramUserId!==String(c.from.id)||!await allowed(uid))
    return api("answerCallbackQuery",{callback_query_id:c.id,text:"Это приглашение другого пользователя",show_alert:true});
  const text=action==="s"?"Проверка расписания отправлена в личный чат":
    kind==="p"?await respondProposal(id,uid,action):await respondGroup(id,uid,action);
  await api("answerCallbackQuery",{callback_query_id:c.id,text:text.slice(0,180),show_alert:false});
  if(action==="s"){
    await sendScheduleToUser(uid,binding.data().chatId,p.date||p.options?.[0]?.date);
  }else{
    await api("sendMessage",{chat_id:binding.data().chatId,text});
    if(!text.includes("требуется")&&!text.includes("несколько вариантов")){
      await api("editMessageReplyMarkup",{
        chat_id:c.message.chat.id,message_id:c.message.message_id,reply_markup:{inline_keyboard:[]}
      }).catch(()=>{});
    }
  }
}
exports.telegramWebhook=onRequest({region,secrets:[BOT,WEBHOOK],invoker:"public",
  maxInstances:3,timeoutSeconds:30},async(req,res)=>{
  if(req.method!=="POST"||!eq(req.get("X-Telegram-Bot-Api-Secret-Token"),WEBHOOK.value())){
    res.status(403).send("Forbidden");return;
  }
  try{
    if(req.body?.message?.text?.startsWith("/start"))await bindAccount(req.body.message);
    else if(req.body?.callback_query)await handleCallback(req.body.callback_query);
  }catch(error){console.error("Telegram webhook action failed:",error);}
  res.status(200).send("OK");
});
async function dispatch(key,uid,text,keyboard){
  const account=await acRef(uid).get();
  if(!account.exists)return;
  const ref=db.doc("telegramDispatch/"+key+"_"+uid);
  try{await ref.create({createdAt:FieldValue.serverTimestamp(),status:"sending"});}
  catch(error){if(error.code===6)return;throw error;}
  try{
    await api("sendMessage",{chat_id:account.data().chatId,text,
      reply_markup:{inline_keyboard:keyboard}});
    await ref.update({status:"sent",sentAt:FieldValue.serverTimestamp()});
  }catch(error){
    await ref.update({status:"error",error:String(error.message||error).slice(0,200)});
    console.error("Notification failed:",key,uid,error);
  }
}
const keys=(kind,id)=>[
  [{text:"✅ Принять",callback_data:"a:"+kind+":"+id},
   {text:"❌ Отклонить",callback_data:"d:"+kind+":"+id}],
  [{text:"📅 Проверить расписание",callback_data:"s:"+kind+":"+id}]
];
exports.telegramNotifyProposal=onDocumentCreated({document:"proposals/{id}",
  region,secrets:[BOT]},async event=>{
    const p=event.data?.data(),id=event.params.id;
    if(!p||p.status!=="pending"||!idOk(id))return;
    await dispatch("p_"+id,p.toUid,inviteText(p),keys("p",id));
});
exports.telegramNotifyGroup=onDocumentCreated({document:"groupWishes/{id}",
  region,secrets:[BOT]},async event=>{
    const g=event.data?.data(),id=event.params.id;
    if(!g||!idOk(id)||g.status!=="collecting")return;
    const times=(g.options||[]).slice(0,5).map(o=>o.date+" "+o.start+"–"+o.end).join("\n");
    for(const uid of g.inviteeUids||[])await dispatch("g_"+id,uid,
      "🎮 Групповая коллаба от "+g.organizerName+"\nИгра: "+g.game+"\n"+
      "Варианты:\n"+times+"\n\nНесколько дат нужно выбрать на сайте.",keys("g",id));
});
