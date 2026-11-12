// One-time local setup after deploying the Firebase onRequest function.
// Prompts for secrets only in your own terminal. No GitHub secrets or source edits.
import readline from "node:readline/promises";
import process from "node:process";
const rl=readline.createInterface({input:process.stdin,output:process.stdout});
try{
  const token=(await rl.question("Bot token from BotFather (only in your local terminal): ")).trim();
  const secret=(await rl.question("TELEGRAM_WEBHOOK_SECRET already saved in Firebase: ")).trim();
  const url=(await rl.question("Full telegramWebhook URL shown by Firebase deploy: ")).trim();
  if(!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token))throw Error("Invalid token format");
  if(!/^[A-Za-z0-9_-]{1,256}$/.test(secret))throw Error("Secret must contain A-Z, a-z, 0-9, _ or -");
  if(!url.startsWith("https://")||!url.includes("telegramWebhook")&&!url.includes("telegramwebhook"))
    throw Error("Use the HTTPS URL of your deployed telegramWebhook function");
  const res=await fetch("https://api.telegram.org/bot"+token+"/setWebhook",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({url,secret_token:secret,drop_pending_updates:false,
      allowed_updates:["message","callback_query"]})
  });
  const data=await res.json();
  if(!data.ok)throw Error(data.description||"Telegram rejected webhook");
  console.log("Webhook configured. Token and secret were not saved in files.");
}catch(e){console.error("Setup failed:",e.message);process.exitCode=1}
finally{rl.close()}
