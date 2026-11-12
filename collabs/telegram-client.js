// Browser-to-Cloudflare Worker interface. No bot token or Google credentials here.
const moduleTag = new URL(import.meta.url).search || "?load=" + Date.now();
const { telegramWorkerUrl } = await import("./telegram-worker-config.js" + moduleTag);
export function telegramClient(auth){
  async function invoke(action,fields={}){
    const endpoint=String(telegramWorkerUrl||"").trim().replace(/\/+$/,"");
    if(!/^https:\/\/[A-Za-z0-9.-]+$/.test(endpoint))
      throw new Error("Telegram ещё не подключён: сначала опубликуй Cloudflare Worker и укажи его адрес в telegram-worker-config.js.");
    const user=auth.currentUser;
    if(!user)throw new Error("Сначала войди в Collab Room.");
    const idToken=await user.getIdToken();
    let response;
    try{
      response=await fetch(endpoint+"/api",{
        method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+idToken},
        body:JSON.stringify({action,...fields}),cache:"no-store"
      });
    }catch(error){throw new Error("Cloudflare Worker недоступен. Проверь адрес, настройки CORS и статус сервиса.");}
    let data={};
    try{data=await response.json();}catch{}
    if(!response.ok)throw new Error(data.error||"Telegram: серверная ошибка "+response.status);
    return data;
  }
  return {
    status:()=>invoke("status"),
    connect:()=>invoke("connect"),
    channel:(channel)=>invoke("channel",{channel}),
    post:()=>invoke("post"),
    notify:(kind,id)=>invoke("notify",{kind,id})
  };
}
