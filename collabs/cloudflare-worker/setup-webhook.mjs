// Register Telegram webhook once, from your own Windows terminal.
// Secrets are requested interactively and never written into project files.
import readline from "node:readline/promises";
import process from "node:process";
const rl=readline.createInterface({input:process.stdin,output:process.stdout});
try{
  const worker=(await rl.question("Worker URL (https://...workers.dev): ")).trim().replace(/\/$/,"");
  const token=(await rl.question("Telegram bot token from BotFather: ")).trim();
  const secret=(await rl.question("TELEGRAM_WEBHOOK_SECRET (same value as Cloudflare): ")).trim();
  if(!/^https:\/\/[A-Za-z0-9.-]+\.workers\.dev$/.test(worker))
    throw Error("Use your public https://*.workers.dev URL");
  if(!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token))throw Error("Telegram token format invalid");
  if(!/^[A-Za-z0-9_-]{16,128}$/.test(secret))
    throw Error("Webhook secret should be 16–128 letters/digits/_/-");
  const response=await fetch("https://api.telegram.org/bot"+token+"/setWebhook",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({url:worker+"/telegram/webhook",secret_token:secret,
      allowed_updates:["message","callback_query"],drop_pending_updates:false})
  });
  const result=await response.json();
  if(!result.ok)throw Error(result.description||"setWebhook failed");
  console.log("Telegram webhook installed on Cloudflare Worker. No secrets were saved.");
}catch(error){console.error("Webhook setup failed:",error.message);process.exitCode=1}
finally{rl.close();}
