// Telegram actions are callable Cloud Functions, never direct Bot API calls.
// There is no bot token in the browser bundle or in Firestore.
const moduleTag = new URL(import.meta.url).search || "?load=" + Date.now();
const {getFunctions,httpsCallable} = await import("https://www.gstatic.com/firebasejs/13.2.0/firebase-functions.js");
export function telegramClient(firebaseApp) {
  const functions=getFunctions(firebaseApp,"europe-west1");
  async function invoke(name,data={}) {
    try {return (await httpsCallable(functions,name)(data)).data;}
    catch(error) {
      if(["functions/not-found","functions/unavailable"].includes(error.code))
        throw new Error("Telegram-сервер пока не подключён. Опубликуй Firebase Functions по инструкции в README.");
      if(error.code==="functions/internal")throw new Error("Telegram-сервер вернул ошибку. Проверь журналы Firebase Functions; токен не присылай.");
      throw new Error(error.message||"Telegram: действие не удалось.");
    }
  }
  return {
    status:()=>invoke("telegramStatus"),
    connect:()=>invoke("telegramConnect"),
    channel:(channel)=>invoke("telegramSetChannel",{channel}),
    post:()=>invoke("telegramPostSchedule")
  };
}
