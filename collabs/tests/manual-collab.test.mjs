import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const app=readFileSync(new URL("../app.js",import.meta.url),"utf8");
const helper=readFileSync(new URL("../manual-collab.js",import.meta.url),"utf8");
const exportCode=readFileSync(new URL("../twitch-export.js",import.meta.url),"utf8");
const {publicSlotEvent,manualCollabTwitchTitle}=new Function(
  helper.replace(/^export /gm,"")+
  "\nreturn {publicSlotEvent,manualCollabTwitchTitle};"
)();
function extract(text,from,to){
 const a=text.indexOf(from),b=text.indexOf(to,a+from.length);
 assert.ok(a>=0 && b>a,"Cannot locate "+from);
 return text.slice(a,b);
}
const sanitize=x=>String(x??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;");
function renderEvent(item){
 let result="",state={uid:"user_one",slots:item?[item]:[],date:"2026-11-21"};
 const fn=new Function("state","h","typeName","modalOpen",
   extract(app,"function eventModal(id) {","function wishTimeRow(")+"\nreturn eventModal;"
 )(state,sanitize,type=>type,markup=>result=markup);
 fn(item?.id);
 return result;
}
function saver({slots=[],locks=[],groupCalendar=[]}={}){
 const events=[],state={uid:"user_one",slots,locks,groupCalendar};
 const deleted={marker:"DELETE_FIELD"};
 let published=0,pushed=0;
 class FormDataMock{
   constructor(form){this.data=form.data;}
   entries(){return Object.entries(this.data)[Symbol.iterator]();}
 }
 const fn=new Function(
  "FormData","isDate","isTime","state","db","serverTimestamp","deleteField",
  "updateDoc","doc","addDoc","collection","publishPublicSchedule",
  "modalClose","render","flashMessage","queueTwitchAutoPush","overlaps",
  extract(app,"async function saveEvent(form) {","async function saveProfile(form) {")+"\nreturn saveEvent;"
 )(
  FormDataMock,v=>/^\d{4}-\d{2}-\d{2}$/.test(v),
  v=>/^\d{2}:\d{2}$/.test(v),
  state,{},()=>({timestamp:true}),()=>deleted,
  async(ref,record)=>{events.push({method:"update",ref,record});},
  (...parts)=>parts.slice(1).join("/"),
  async(ref,record)=>{events.push({method:"add",ref,record});},
  name=>name,
  async()=>{published++;},()=>{},()=>{},()=>{},()=>{pushed++;},
  (a,b)=>a.date===b.date&&a.start<b.end&&b.start<a.end
 );
 return {fn,events,deleted,counts:()=>({published,pushed})};
}
const date={date:"2026-11-21",start:"20:00",end:"23:00"};
test("manual collab selector is available with a conditional nickname field",()=>{
 const html=renderEvent();
 assert.match(html,/option value="collab"/);
 assert.match(html,/name="guestNick"/);
 assert.match(html,/data-manual-collab hidden/);
 assert.match(html,/name="showGame"/);
 assert.match(html,/name="showGuest"/);
});
test("editing a manual collab restores nickname and visibility without invitation UI",()=>{
 const html=renderEvent({id:"abcd",ownerUid:"user_one",type:"collab",
   title:"The Forest",guestNick:"HellFox",showGame:true,showGuest:false,
   public:true,...date});
 assert.match(html,/name="guestNick"[^>]*HellFox/);
 assert.match(html,/name="showGame" type="checkbox" checked/);
 assert.match(html,/name="showGuest" type="checkbox"/);
 assert.doesNotMatch(html,/data-manual-collab hidden/);
 assert.match(html,/data-id="abcd"/);
});
test("nickname is required for a manual collab",async()=>{
 const x=saver();
 await assert.rejects(x.fn({dataset:{},data:{type:"collab",...date,title:"The Forest"}}),
   /Укажи ник гостя/);
 assert.equal(x.events.length,0);
});
test("manual collab saves as one owner slot and makes no invitations",async()=>{
 const x=saver();
 await x.fn({dataset:{},data:{type:"collab",...date,title:" The Forest ",guestNick:" Friend123 "}});
 assert.equal(x.events.length,1);
 assert.equal(x.events[0].method,"add");
 const record=x.events[0].record;
 assert.equal(record.type,"collab");
 assert.equal(record.title,"The Forest");
 assert.equal(record.guestNick,"Friend123");
 assert.equal(record.public,true);
 assert.equal(record.showGame,false);
 assert.equal(record.showGuest,false);
 assert.deepEqual(x.counts(),{published:1,pushed:1});
});
test("manual collab can intentionally be hidden from all viewers",async()=>{
 const x=saver();
 await x.fn({dataset:{},data:{type:"collab",...date,title:"The Forest",
  guestNick:"Guest",hidePublic:"on",showGame:"on",showGuest:"on"}});
 assert.equal(x.events[0].record.public,false);
 assert.equal(x.events[0].record.showGame,true);
 assert.equal(x.events[0].record.showGuest,true);
});
test("manual collab cannot overlap a confirmed stream",async()=>{
 const x=saver({slots:[{id:"stream1",ownerUid:"user_one",type:"stream",...date}]});
 await assert.rejects(x.fn({dataset:{},data:{type:"collab",...date,guestNick:"Friend"}}),
  /время уже занято/);
 assert.equal(x.events.length,0);
});
test("editing the same manual collab doesn't reject its own slot",async()=>{
 const x=saver({slots:[{id:"mycollab",ownerUid:"user_one",type:"collab",...date}]});
 await x.fn({dataset:{id:"mycollab"},data:{type:"collab",...date,guestNick:"Guest 2"}});
 assert.equal(x.events[0].method,"update");
 assert.equal(x.events[0].ref,"slots/mycollab");
 assert.equal(x.events[0].record.guestNick,"Guest 2");
});
test("legacy stream updates strip guest fields and remain valid before rules migration",async()=>{
 const x=saver();
 await x.fn({dataset:{id:"mycollab"},data:{type:"stream",...date,title:"Normal stream"}});
 assert.equal(x.events[0].method,"update");
 assert.equal(x.events[0].record.guestNick,x.deleted);
 assert.equal(x.events[0].record.showGame,x.deleted);
 assert.equal(x.events[0].record.showGuest,x.deleted);
 assert.equal(x.events[0].record.type,"stream");
});
test("new normal streams retain old Firestore schema until rules upgrade",async()=>{
 const x=saver();
 await x.fn({dataset:{},data:{type:"stream",...date,title:"Normal stream"}});
 assert.deepEqual(["guestNick","showGame","showGuest"].filter(k=>k in x.events[0].record),[]);
});
test("viewer projection hides private game and guest by default",()=>{
 assert.deepEqual(publicSlotEvent({type:"collab",...date,
   title:"Super-secret game",guestNick:"Secret partner"}),{
   type:"collab",...date,game:"",partner:""
 });
});
test("owner may disclose game, guest, or both separately",()=>{
 const base={type:"collab",...date,title:"The Forest",guestNick:"Guest"};
 assert.deepEqual([publicSlotEvent({...base,showGame:true}).game,
  publicSlotEvent({...base,showGame:true}).partner],["The Forest",""]);
 assert.deepEqual([publicSlotEvent({...base,showGuest:true}).game,
  publicSlotEvent({...base,showGuest:true}).partner],["","Guest"]);
});
test("Twitch title is private by default and respects deliberate reveal",()=>{
 const base={type:"collab",title:"secret game",guestNick:"private nick"};
 assert.equal(manualCollabTwitchTitle(base),"Коллаба");
 assert.equal(manualCollabTwitchTitle({...base,showGame:true}),"Коллаба: secret game");
 assert.equal(manualCollabTwitchTitle({...base,showGuest:true}),"Коллаба с private nick");
});
test("manual collab gets an export source with the same stable slot ID",()=>{
 const body=extract(exportCode,"export function buildTwitchExportSources(","async function twitchRequest(")
  .replace("export function buildTwitchExportSources(","function buildTwitchExportSources(");
 const fn=new Function("utcWindow","title","collabParties","collabSourceId",
   "manualCollabTwitchTitle",body+"\nreturn buildTwitchExportSources;")(
   e=>({start:e.date+"T17:00:00.000Z",end:e.date+"T20:00:00.000Z",duration:180}),
   v=>String(v).slice(0,140),()=>[],()=>"",manualCollabTwitchTitle
 );
 const collab={id:"mycollab",ownerUid:"user_one",type:"collab",...date,
   guestNick:"Secret",title:"The Forest",showGame:false,showGuest:false,public:true};
 const source=fn({uid:"user_one",slots:[collab],locks:[],groups:[],
   publicCollabs:[],publicGroups:[],today:"2026-11-19"});
 assert.equal(source.length,1);
 assert.equal(source[0].id,"slot_mycollab");
 assert.equal(source[0].display,"Коллаба");
 assert.equal(source[0].type,"collab");
 const hidden=fn({uid:"user_one",slots:[{...collab,public:false}],locks:[],groups:[],
   publicCollabs:[],publicGroups:[],today:"2026-11-19"});
 assert.equal(hidden.length,0);
});
test("Firestore policy enforces collab guest and privacy flag schema",()=>{
 const rules=readFileSync(new URL("../firestore.rules",import.meta.url),"utf8");
 assert.match(rules,/d\.type in \['stream','collab','off'/);
 assert.match(rules,/d\.guestNick\.size\(\) >= 1/);
 assert.match(rules,/d\.get\('showGuest',false\) is bool/);
 assert.match(rules,/d\.get\('showGame',false\) is bool/);
});
