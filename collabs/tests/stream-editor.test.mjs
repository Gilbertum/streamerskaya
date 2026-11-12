import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const app=readFileSync(new URL("../app.js",import.meta.url),"utf8");
const exporter=readFileSync(new URL("../twitch-export.js",import.meta.url),"utf8");
function between(source,start,end){
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  assert.ok(a>=0 && b>a,"Missing source section: "+start);
  return source.slice(a,b);
}
const escape = value => String(value??"").replaceAll("&","&amp;").replaceAll('"',"&quot;").replaceAll("<","&lt;");
function viewModal(item){
  let html="";
  const state={
    uid:"uid_1",date:"2026-11-20",
    slots:item?[item]:[]
  };
  const fn=new Function("state","h","typeName","modalOpen",
    between(app,"function eventModal(id) {","function wishTimeRow(")+"\nreturn eventModal;")(
      state,escape,value=>value,content=>{html=content}
    );
  fn(item?.id);
  return html;
}
test("a previously exported stream can open the edit form without dangling twitchOwnedId",()=>{
  assert.equal(app.includes("twitchOwnedId"),false);
  const html=viewModal({id:"slot-unique",ownerUid:"uid_1",type:"stream",
    date:"2026-11-20",start:"20:00",end:"23:00",title:"The Forest",public:true});
  assert.match(html,/Редактировать событие/);
  assert.match(html,/name="title"[^>]*The Forest/);
  assert.match(html,/data-id="slot-unique"/);
  assert.match(html,/обнови расписание через «↗ В Twitch»/);
});
test("day off editing is still available",()=>{
  const html=viewModal({id:"offday",ownerUid:"uid_1",type:"off",
    date:"2026-11-22",start:"00:00",end:"00:00",title:"",public:true});
  assert.match(html,/Редактировать событие/);
  assert.match(html,/Выходной/);
});
test("saving a changed Twitch-exported stream updates the original slot ID",async()=>{
  const state={uid:"uid_1",date:"2026-11-20",month:"2026-11"};
  let updateCall,addCalls=0,autoTriggered=0,published=0;
  class FakeFormData{
    constructor(form){this.content=form.content;}
    entries(){return Object.entries(this.content)[Symbol.iterator]();}
  }
  const fn=new Function(
    "FormData","isDate","isTime","state","db","serverTimestamp",
    "updateDoc","doc","addDoc","collection","publishPublicSchedule",
    "modalClose","render","flashMessage","queueTwitchAutoPush",
    between(app,"async function saveEvent(form) {","async function saveProfile(form) {")+
    "\nreturn saveEvent;"
  )(
    FakeFormData,
    v=>/^\d{4}-\d{2}-\d{2}$/.test(v),
    v=>/^\d{2}:\d{2}$/.test(v),
    state,{},()=>({serverStamp:true}),
    async(ref,record)=>{updateCall={ref,record};},
    (...segments)=>segments.slice(1).join("/"),
    async()=>{addCalls++;},
    name=>name,
    async()=>{published++;},
    ()=>{},()=>{},()=>{},
    ()=>{autoTriggered++;}
  );
  await fn({dataset:{id:"slot-unique"},content:{
    type:"stream",title:"Super Bunny Man",details:"Событие изменено",
    date:"2026-11-22",start:"21:00",end:"03:00"
  }});
  assert.equal(updateCall.ref,"slots/slot-unique");
  assert.deepEqual(Object.fromEntries(["date","start","end","title","public"].map(k=>[k,updateCall.record[k]])),{
    date:"2026-11-22",start:"21:00",end:"03:00",title:"Super Bunny Man",public:true
  });
  assert.equal(addCalls,0,"Editing must never create a new slot");
  assert.equal(published,1);
  assert.equal(autoTriggered,1);
});
const buildExportPlan=new Function(
  between(exporter,"function intersects(a,b){","export function exportPreviewHtml(")
    .replace("export function buildExportPlan","function buildExportPlan")+
  "\nreturn buildExportPlan;"
)();
test("changing hours/title updates the existing Twitch segment instead of creating a duplicate",()=>{
 const original={id:"12345",title:"The Forest",start_time:"2026-11-20T17:00:00.000Z",
   end_time:"2026-11-20T20:00:00.000Z",is_recurring:false,canceled_until:null};
 const updated={id:"slot_slot-unique",type:"stream",display:"Super Bunny Man",
   date:"2026-11-22",start:"21:00",end:"03:00",
   startUtc:"2026-11-22T18:00:00.000Z",endUtc:"2026-11-23T00:00:00.000Z",duration:360};
 const links=[{id:"slot_slot-unique",segmentId:"12345",broadcasterId:"1028275935"}];
 const result=buildExportPlan({sources:[updated],links,remote:[original]});
 assert.equal(result.length,1);
 assert.equal(result[0].mode,"update");
 assert.equal(result[0].segmentId,"12345");
});
test("an identical Twitch event with no stored link isn't published twice",()=>{
 const remote={id:"existing",title:"Super Bunny Man",
   start_time:"2026-11-22T18:00:00.000Z",end_time:"2026-11-23T00:00:00.000Z",is_recurring:false};
 const source={id:"slot_test",display:"Super Bunny Man",startUtc:remote.start_time,endUtc:remote.end_time};
 const result=buildExportPlan({sources:[source],links:[],remote:[remote]});
 assert.equal(result[0].mode,"exists");
});
test("no gendered participant labels remain in live UI",()=>{
 for(const file of ["app.js","streamers-view.js","group-wishes.js","moderator-v3.js",
   "views.js","twitch-panel.js"]){
   const text=readFileSync(new URL("../"+file,import.meta.url),"utf8");
   assert.doesNotMatch(text,/участниц|стримерш|девочк|подруг/gi,file);
 }
});
