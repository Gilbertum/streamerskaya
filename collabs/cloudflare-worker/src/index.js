import {get,query,queryAll,patch,create,del,begin,commit,write,remove,verifyUser,StoreError} from "./store.js";
import {overlaps,conflict,siteUrl,siteLink,scheduleText,inviteText,groupText,callbackMarkup,recent} from "./logic.js";

const now=()=>new Date();
const validId=x=>/^[A-Za-z0-9_-]{12,128}$/.test(String(x||""));
const privatePath=uid=>"telegramAccounts/"+uid;
const channelPath=uid=>"telegramChannels/"+uid;
const json=(data,status=200,origin="")=>new Response(JSON.stringify(data),{
  status,headers:{"Content-Type":"application/json; charset=utf-8",
    "Cache-Control":"no-store",...(origin?{"Access-Control-Allow-Origin":origin,"Vary":"Origin"}:{})}
});
const equal=(a,b)=>{
  const first=new TextEncoder().encode(a||""),second=new TextEncoder().encode(b||"");
  let diff=first.length^second.length;
  for(let i=0;i<Math.max(first.length,second.length);i++)diff|=(first[i]||0)^(second[i]||0);
  return diff===0 && first.length>0;
};
async function telegram(env,method,data){
  const response=await fetch("https://api.telegram.org/bot"+env.TELEGRAM_BOT_TOKEN+"/"+method,{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify(data),signal:AbortSignal.timeout(16000)
  });
  let reply={};try{reply=await response.json();}catch{}
  if(!response.ok||!reply.ok)throw new Error("Telegram "+method+": "+String(reply.description||response.status).slice(0,160));
  return reply.result;
}
async function authorizedRequest(request,env){
  const header=request.headers.get("Authorization")||"";
  if(!header.startsWith("Bearer "))throw new Error("Войди в личный кабинет Collab Room");
  return verifyUser(env,header.slice(7));
}
async function status(uid,env){
  const [a,c]=await Promise.all([get(env,privatePath(uid)),get(env,channelPath(uid))]);
  return {bound:!!a,username:a?.username||"",channel:c?.channel||""};
}
async function connect(uid,env){
  const bytes=crypto.getRandomValues(new Uint8Array(24));
  const code=Array.from(bytes,x=>x.toString(16).padStart(2,"0")).join("");
  const bot=await telegram(env,"getMe",{});
  await create(env,"telegramLinkCodes/"+code,{
    ownerUid:uid,expiresAt:Date.now()+15*60000,createdAt:now()
  });
  return {url:"https://t.me/"+bot.username+"?start="+code};
}
async function channel(uid,env,input){
  const name=String(input||"").trim();
  if(!/^@[a-zA-Z0-9_]{5,32}$/.test(name))throw new Error("Укажи публичный Telegram-канал как @channel");
  const account=await get(env,privatePath(uid));
  if(!account)throw new Error("Сначала привяжи личный Telegram");
  const chat=await telegram(env,"getChat",{chat_id:name});
  if(chat.type!=="channel")throw new Error("Это не канал Telegram");
  const bot=await telegram(env,"getMe",{});
  const [b,u]=await Promise.all([
    telegram(env,"getChatMember",{chat_id:chat.id,user_id:bot.id}),
    telegram(env,"getChatMember",{chat_id:chat.id,user_id:Number(account.telegramUserId)})
  ]);
  if(!["administrator","creator"].includes(b.status)||
    b.status==="administrator"&&b.can_post_messages!==true)
    throw new Error("Бот должен быть администратором канала с правом публиковать сообщения");
  if(!["administrator","creator"].includes(u.status))
    throw new Error("Твой привязанный Telegram должен быть администратором этого канала");
  await patch(env,channelPath(uid),{
    ownerUid:uid,channel:name,chatId:String(chat.id),updatedAt:now()
  });
  return {channel:name};
}
async function post(uid,env){
  const config=await get(env,channelPath(uid));
  if(!config)throw new Error("Сначала подключи свой Telegram-канал");
  const path="telegramChannelCooldown/"+uid,timestamp=Date.now();
  const previous=await get(env,path);
  if(previous?.lastAt && timestamp-previous.lastAt<60000)
    throw new Error("Повторная публикация доступна через минуту");
  await patch(env,path,{lastAt:timestamp},previous?{updateTime:previous.__updateTime}:{createOnly:true});
  try{
    const message=await telegram(env,"sendMessage",{
      chat_id:config.chatId,text:scheduleText(uid),disable_web_page_preview:false
    });
    return {channel:config.channel,messageId:message.message_id};
  }catch(error){
    // Preserve cooldown on uncertain failures to avoid accidental duplicate posts.
    throw error;
  }
}
async function allowed(env,uid){
  return !!uid && (await get(env,"allowedUsers/"+uid))?.enabled===true;
}
async function start(env,msg){
  const match=String(msg.text||"").match(/^\/start(?:@\w+)?\s+([a-f0-9]{48})$/i);
  if(!match||msg.chat?.type!=="private"||!msg.from?.id)return;
  const path="telegramLinkCodes/"+match[1],transaction=await begin(env);
  const code=await get(env,path,transaction);
  if(!code || code.expiresAt<Date.now() || !await allowed(env,code.ownerUid)){
    await telegram(env,"sendMessage",{chat_id:msg.chat.id,
      text:"Ссылка истекла или уже использована. Создай новую в профиле Collab Room."});
    return;
  }
  await commit(env,[
    write(env,privatePath(code.ownerUid),{
      ownerUid:code.ownerUid,chatId:String(msg.chat.id),
      telegramUserId:String(msg.from.id),username:String(msg.from.username||""),
      updatedAt:now()
    }),
    remove(env,path)
  ],transaction);
  await telegram(env,"sendMessage",{chat_id:msg.chat.id,
    text:"✅ Telegram подключён к Collab Room. Ожидай приглашения от участниц."});
}
async function accountFor(env,uid,telegramId,chatId){
  if(!validId(uid)||!await allowed(env,uid))return null;
  const account=await get(env,privatePath(uid));
  return account && account.telegramUserId===String(telegramId) &&
    account.chatId===String(chatId) ?account:null;
}
function assertFullPage(items,label){
  if(items.length>=150)throw new Error("Слишком много событий "+label+"; проверь приглашение на сайте");
}
async function acceptOrDecline(env,id,uid,action){
  const transaction=await begin(env);
  const proposal=await get(env,"proposals/"+id,transaction);
  if(!proposal||proposal.toUid!==uid)return "Приглашение недоступно";
  if(proposal.status!=="pending")return "Приглашение уже обработано";
  const chosen=proposal.timeOptions?.length===1?{...proposal,...proposal.timeOptions[0]}:proposal;
  if(action==="a" && (proposal.timeOptions?.length>1 || proposal.replacesId))
    return "Выбор вариантов или перенос нужно подтвердить на сайте: "+siteUrl;
  const writes=[];
  if(action==="a"){
    if(!chosen.date||!chosen.start||!chosen.end)
      return "У приглашения нет точных даты или времени; открой его на сайте";
    const [slots,locks,groups]=await Promise.all([
      queryAll(env,"slots",{transaction}),queryAll(env,"collabLocks",{transaction}),
      queryAll(env,"groupCalendar",{transaction})
    ]);
    assertFullPage(slots,"стримов");assertFullPage(locks,"коллабов");assertFullPage(groups,"групповых коллабов");
    const reason=conflict({proposal:chosen,slots,locks,groups});
    if(reason)return "Нельзя принять: "+reason+". Проверь календарь на сайте.";
    writes.push(write(env,"collabLocks/"+id,{
      fromUid:proposal.fromUid,toUid:proposal.toUid,
      fromName:proposal.fromName||"",toName:proposal.toName||"",
      date:chosen.date,start:chosen.start,end:chosen.end,game:proposal.game||"Коллаба"
    },{exists:false}));
    for(const participant of [proposal.fromUid,proposal.toUid]){
      writes.push(write(env,"publicCollabs/"+participant+"/items/"+id,{
        date:chosen.date,start:chosen.start,end:chosen.end,type:"collab",game:"",partner:""
      }));
    }
  }
  writes.push(write(env,"proposals/"+id,{
    status:action==="a"?"accepted":"declined",respondedAt:now(),
    ...(action==="a"&&proposal.timeOptions?.length===1?{
      chosenIndex:0,date:chosen.date,start:chosen.start,end:chosen.end
    }:{})
  },{mask:["status","respondedAt",...(action==="a"&&proposal.timeOptions?.length===1?
    ["chosenIndex","date","start","end"]:[])] ,exists:true}));
  for(const participant of [proposal.fromUid,proposal.toUid])
    writes.push(remove(env,"moderatorPending/"+participant+"/items/"+id));
  await commit(env,writes,transaction);
  return action==="a"?"✅ Приглашение принято. Коллаба появилась в календарях.":
    "❌ Приглашение отклонено.";
}
async function answerGroup(env,id,uid,action){
  const transaction=await begin(env);
  const group=await get(env,"groupWishes/"+id,transaction);
  if(!group?.inviteeUids?.includes(uid)||group.status!=="collecting")
    return "Групповое приглашение уже закрыто";
  if(action==="a" && group.options?.length!==1)
    return "Отметь подходящие варианты на сайте: "+siteUrl;
  const responses={...(group.responses||{}),[uid]:action==="a"?[0]:[]};
  await commit(env,[write(env,"groupWishes/"+id,{responses,updatedAt:now()},
    {mask:["responses","updatedAt"],exists:true})],transaction);
  return action==="a"?"✅ Согласие отправлено организатору. Окончательное время ещё не назначено.":
    "❌ Отказ передан организатору.";
}
async function privateSchedule(env,uid,date){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||""))return "Дата не указана";
  const [slots,locks,groups]=await Promise.all([
    query(env,"slots","ownerUid",uid,{limit:140}),
    queryAll(env,"collabLocks",{limit:140}),queryAll(env,"groupCalendar",{limit:140})
  ]);
  assertFullPage(slots,"стримов");assertFullPage(locks,"коллабов");assertFullPage(groups,"групповых коллабов");
  const items=[
    ...slots.filter(x=>x.date===date),
    ...locks.filter(x=>x.date===date&&[x.fromUid,x.toUid].includes(uid)),
    ...groups.filter(x=>x.date===date&&x.participantsUids?.includes(uid))
  ].slice(0,15);
  const rendered=items.length?items.map(x=>"• "+String(x.game||x.title||x.type||"Событие").slice(0,80)+
    " · "+(x.start||"")+"–"+(x.end||"")).join("\n"):"На эту дату записей пока нет.";
  return "📅 Твоё расписание · "+date+"\n"+rendered+"\n\n"+siteLink(uid);
}
async function callback(env,cb){
  const match=String(cb.data||"").match(/^([ads]):([pg]):([A-Za-z0-9_-]{12,128})$/);
  if(!match){await telegram(env,"answerCallbackQuery",{callback_query_id:cb.id,text:"Кнопка устарела"});return;}
  const [,action,kind,id]=match;
  const record=await get(env,(kind==="p"?"proposals/":"groupWishes/")+id);
  if(!record){await telegram(env,"answerCallbackQuery",{callback_query_id:cb.id,text:"Приглашение удалено"});return;}
  const candidates=kind==="p"?[record.toUid]:(record.inviteeUids||[]).slice(0,10);
  let uid=null,account=null;
  for(const candidate of candidates){
    const user=await accountFor(env,candidate,cb.from?.id,cb.message?.chat?.id);
    if(user){uid=candidate;account=user;break;}
  }
  if(!uid){
    await telegram(env,"answerCallbackQuery",{
      callback_query_id:cb.id,text:"Это приглашение другого пользователя",show_alert:true
    });return;
  }
  if(action==="s"){
    const message=await privateSchedule(env,uid,record.date||record.options?.[0]?.date);
    await telegram(env,"sendMessage",{chat_id:account.chatId,text:message});
    await telegram(env,"answerCallbackQuery",{callback_query_id:cb.id,text:"Расписание отправлено в личный чат"});
    return;
  }
  let answer;
  try{answer=kind==="p"?await acceptOrDecline(env,id,uid,action):
    await answerGroup(env,id,uid,action);}
  catch(error){answer="Не удалось обработать ответ. Открой приглашение на сайте: "+siteUrl;
    console.error("Telegram response failed",error.message);}
  await telegram(env,"answerCallbackQuery",{callback_query_id:cb.id,text:answer.slice(0,180)});
  await telegram(env,"sendMessage",{chat_id:account.chatId,text:answer});
  if(answer.startsWith("✅")||answer.startsWith("❌")){
    await telegram(env,"editMessageReplyMarkup",{chat_id:cb.message.chat.id,
      message_id:cb.message.message_id,reply_markup:{inline_keyboard:[]}}).catch(()=>{});
  }
}
async function dispatch(env,key,uid,message,kind,id){
  if(!validId(uid))return false;
  const bound=await get(env,privatePath(uid));
  if(!bound?.chatId)return false;
  const path="telegramDispatch/"+key+"_"+uid,prev=await get(env,path);
  const stamp=Date.now();
  if(prev && (prev.status==="sent"||prev.attempts>=3||
      prev.status==="sending"&&stamp-prev.lastAt<15*60000||
      prev.status==="error"&&stamp-prev.lastAt<15*60000))return false;
  const attempts=(prev?.attempts||0)+1;
  try{
    await patch(env,path,{lastAt:stamp,attempts,status:"sending"},
      prev?{updateTime:prev.__updateTime}:{createOnly:true});
  }catch(e){if(e instanceof StoreError && [409,412].includes(e.status))return false;throw e;}
  try{
    await telegram(env,"sendMessage",{chat_id:bound.chatId,text:message,
      reply_markup:callbackMarkup(kind,id)});
    await patch(env,path,{status:"sent",lastAt:Date.now(),attempts});
    return true;
  }catch(error){
    console.warn("Telegram notification error",String(error.message).slice(0,100));
    await patch(env,path,{status:"error",lastAt:Date.now(),attempts}).catch(()=>{});
    return false;
  }
}
async function poll(env){
  if(!env.GOOGLE_SERVICE_ACCOUNT_JSON||!env.TELEGRAM_BOT_TOKEN)return;
  const [proposals,groups]=await Promise.all([
    query(env,"proposals","status","pending",{limit:145}),
    query(env,"groupWishes","status","collecting",{limit:145})
  ]);
  assertFullPage(proposals,"приглашений");assertFullPage(groups,"групповых заявок");
  const tasks=[];
  for(const p of proposals)if(validId(p.id)&&recent(p.createdAt) && validId(p.toUid))
    tasks.push({key:"p_"+p.id,uid:p.toUid,id:p.id,kind:"p",message:inviteText(p)});
  for(const g of groups)if(validId(g.id)&&recent(g.createdAt))
    for(const uid of (g.inviteeUids||[]).slice(0,10))if(validId(uid))
      tasks.push({key:"g_"+g.id,uid,id:g.id,kind:"g",message:groupText(g)});
  // Free Workers have 50 external subrequests per invocation.
  // Rotate pages: already-sent first invitations must NEVER starve newer ones.
  // A complete cycle of pages is checked across successive Cron invocations.
  if(!tasks.length)return;
  const pageSize=4,numberOfPages=Math.ceil(tasks.length/pageSize);
  const page=Math.floor(Date.now()/180000)%numberOfPages;
  for(const task of tasks.slice(page*pageSize,(page+1)*pageSize))
    await dispatch(env,task.key,task.uid,task.message,task.kind,task.id);
}
async function immediateNotification(env,uid,kind,id){
  if(!validId(id)||!["p","g"].includes(kind))throw new Error("Invalid invitation");
  const record=await get(env,(kind==="p"?"proposals/":"groupWishes/")+id);
  if(!record)throw new Error("Invitation not found");
  if(kind==="p"){
    if(record.fromUid!==uid||record.status!=="pending")return {queued:false};
    return {queued:await dispatch(env,"p_"+id,record.toUid,inviteText(record),kind,id)};
  }
  if(record.organizerUid!==uid||record.status!=="collecting")return {queued:false};
  let count=0;
  for(const toUid of (record.inviteeUids||[]).slice(0,4))
    if(await dispatch(env,"g_"+id,toUid,groupText(record),kind,id))count++;
  return {queued:count>0};
}
async function apiAction(request,env){
  const uid=await authorizedRequest(request,env);
  const body=await request.json();
  const action=String(body.action||"");
  if(action==="status")return status(uid,env);
  if(action==="connect")return connect(uid,env);
  if(action==="channel")return channel(uid,env,body.channel);
  if(action==="post")return post(uid,env);
  if(action==="notify")return immediateNotification(env,uid,body.kind,body.id);
  throw new Error("Unknown action");
}
export default {
  async fetch(request,env){
    const url=new URL(request.url),origin=request.headers.get("Origin")||"";
    const validOrigin=origin==="https://gilbertum.github.io";
    const cors={"Access-Control-Allow-Origin":validOrigin?origin:"null",
      "Access-Control-Allow-Headers":"Authorization, Content-Type",
      "Access-Control-Allow-Methods":"POST, OPTIONS","Vary":"Origin"};
    if(url.pathname==="/health"&&request.method==="GET")
      return json({ok:true,service:"collab-room-telegram-cloudflare",configured:!!env.TELEGRAM_BOT_TOKEN});
    if(url.pathname==="/api"){
      if(request.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
      if(!validOrigin||request.method!=="POST")return json({error:"Forbidden"},403);
      try{return json(await apiAction(request,env),200,origin);}
      catch(error){
        console.error("Worker API:",error.message);
        const safe=error instanceof StoreError ? "Ошибка чтения Firebase. Проверь настройки сервисного аккаунта." :
          String(error.message||"Сервис Telegram недоступен").slice(0,220);
        return json({error:safe},400,origin);
      }
    }
    if(url.pathname==="/telegram/webhook"){
      if(request.method!=="POST"||
        !equal(request.headers.get("X-Telegram-Bot-Api-Secret-Token"),env.TELEGRAM_WEBHOOK_SECRET))
        return new Response("Forbidden",{status:403});
      try{
        const body=await request.json();
        if(body.message?.text?.startsWith("/start"))await start(env,body.message);
        else if(body.callback_query)await callback(env,body.callback_query);
      }catch(error){console.error("Webhook processing failed",error.message);}
      return new Response("OK",{status:200});
    }
    return new Response("Not found",{status:404});
  },
  async scheduled(_event,env,ctx){
    ctx.waitUntil(poll(env).catch(error=>console.error("Telegram poll failed",error.message)));
  }
};
