import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
const env={TELEGRAM_BOT_TOKEN:"TEST_NO_NETWORK",TELEGRAM_WEBHOOK_SECRET:"WEBHOOK_TEST",
  GOOGLE_SERVICE_ACCOUNT_JSON:"{}"};
test("health shows configured only with all 3 secrets",async()=>{
  const res=await worker.fetch(new Request("https://test.workers.dev/health"),env);
  assert.equal(res.status,200);
  assert.equal((await res.json()).configured,true);
  const missing=await worker.fetch(new Request("https://test.workers.dev/health"),
    {...env,GOOGLE_SERVICE_ACCOUNT_JSON:""});
  assert.equal((await missing.json()).configured,false);
});
test("reject public API requests from untrusted origin",async()=>{
  const req=new Request("https://test.workers.dev/api",{method:"POST",
    headers:{Origin:"https://attacker.example","Content-Type":"application/json"},
    body:JSON.stringify({action:"status"})});
  const result=await worker.fetch(req,env);
  assert.equal(result.status,403);
});
test("preflight permits configured GitHub Pages origin",async()=>{
  const req=new Request("https://test.workers.dev/api",{method:"OPTIONS",
    headers:{Origin:"https://gilbertum.github.io"}});
  const result=await worker.fetch(req,env);
  assert.equal(result.status,204);
  assert.equal(result.headers.get("Access-Control-Allow-Origin"),"https://gilbertum.github.io");
});
test("block webhook requests without secret",async()=>{
  const req=new Request("https://test.workers.dev/telegram/webhook",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({message:{text:"/start fake"}})});
  const result=await worker.fetch(req,env);
  assert.equal(result.status,403);
});
test("webhook must be a POST",async()=>{
  const result=await worker.fetch(new Request("https://test.workers.dev/telegram/webhook",
    {method:"GET",headers:{"X-Telegram-Bot-Api-Secret-Token":"WEBHOOK_TEST"}}),env);
  assert.equal(result.status,403);
});
