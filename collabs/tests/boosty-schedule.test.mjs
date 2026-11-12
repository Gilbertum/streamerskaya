import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const load = name => readFileSync(new URL("../"+name,import.meta.url),"utf8");
const app=load("app.js");
const views=load("views.js");
const manual=load("manual-collab.js");
const exporter=load("twitch-export.js");
const rules=load("firestore.rules");
const css=load("styles.css");
const between=(source,start,end)=>{
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  assert.ok(a>=0 && b>a,"Source section is missing: "+start);
  return source.slice(a,b);
};
const escape=value=>String(value??"").replaceAll("&","&amp;").replaceAll('"',"&quot;").replaceAll("<","&lt;");

function eventModal(item) {
  let html="";
  const state={uid:"owner",date:"2026-11-15",slots:item?[item]:[]};
  const fn=new Function("state","h","typeName","modalOpen",
    between(app,"function eventModal(id) {","function wishTimeRow(")+"\nreturn eventModal;")(
      state,escape,v=>v,text=>{html=text});
  fn(item?.id);
  return html;
}

test("both stream platforms are selectable; the former stream type remains Twitch",()=>{
  const create=eventModal();
  assert.match(create,/value="stream" selected>Стрим · Twitch/);
  assert.match(create,/value="boosty">Стрим · Boosty/);
  const edit=eventModal({id:"b1",ownerUid:"owner",type:"boosty",date:"2026-11-15",
    start:"15:00",end:"23:00",title:"Boosty эфир",public:true});
  assert.match(edit,/value="boosty" selected>Стрим · Boosty/);
  assert.match(edit,/name="title"[^>]*Boosty эфир/);
});

test("new Boosty event is saved as a public Boosty event, not as a Twitch stream",async()=>{
  let saved,added=0,published=0;
  class FakeFormData {
    constructor(form){this.values=form.content;}
    entries(){return Object.entries(this.values)[Symbol.iterator]();}
  }
  const fn=new Function(
    "FormData","isDate","isTime","state","db","serverTimestamp","deleteField",
    "updateDoc","doc","addDoc","collection","publishPublicSchedule",
    "modalClose","render","flashMessage","queueTwitchAutoPush",
    between(app,"async function saveEvent(form) {","async function saveProfile(form) {")+"\nreturn saveEvent;"
  )(
    FakeFormData, v=>/^\d{4}-\d\d-\d\d$/.test(v), v=>/^\d\d:\d\d$/.test(v),
    {uid:"owner",date:"2026-11-15",month:"2026-11"}, {},()=>({}),()=>({}),
    async()=>{throw Error("Should not update a new event");},(...xs)=>xs.join("/"),
    async(_col,record)=>{saved=record;added++;},name=>name,
    async()=>{published++;},()=>{},()=>{},()=>{},()=>{}
  );
  await fn({dataset:{id:""},content:{
    type:"boosty",title:"Пятничный Boosty",date:"2026-11-15",
    start:"15:00",end:"23:00",details:"подписчики"
  }});
  assert.equal(saved.type,"boosty");
  assert.equal(saved.title,"Пятничный Boosty");
  assert.equal(saved.public,true);
  assert.equal(added,1);
  assert.equal(published,1);
});

test("Boosty reaches the public viewer with its own label and retains the game title",()=>{
  const publicSlot=new Function(
    between(manual,"export function publicSlotEvent(e) {","export function manualCollabTwitchTitle(")
      .replace("export function","function")+"\nreturn publicSlotEvent;"
  )();
  const e=publicSlot({type:"boosty",date:"2026-11-15",start:"15:00",end:"23:00",title:"Boosty night"});
  assert.equal(e.type,"boosty");
  assert.equal(e.title,"Boosty night");
  const card=new Function("h","span",
    between(views,"function publicCard(e) {","// Multiple accepted")+"\nreturn publicCard;"
  )(escape,e=>e.start+"–"+e.end);
  assert.match(card(e),/class="community-event boosty"/);
  assert.match(card(e),/Boosty · 15:00–23:00 МСК/);
  assert.match(card({...e,type:"stream"}),/class="community-event stream"/);
});

test("Boosty is not exported to Twitch and Firestore accepts it",()=>{
  assert.match(exporter,/!\["stream","collab"\]\.includes\(e\.type\)/);
  assert.doesNotMatch(exporter,/\["stream","boosty","collab"\]/);
  assert.match(rules,/d\.type in \['stream','boosty','collab'/);
  assert.match(rules,/d\.type in \['stream','boosty','off','collab'\]/);
  assert.match(app,/\["stream", "boosty", "off", "collab"\]/);
});

test("colors remain distinct on the personal, public, and moderator calendars",()=>{
  for(const name of ["stream","boosty","off"]){
    assert.ok(css.includes(".calendar-day-label."+name));
    assert.ok(css.includes(".tag."+name));
    assert.ok(css.includes(".mod-chip."+name));
    assert.ok(css.includes(".community-event."+name));
  }
  assert.match(css,/--calendar-twitch:#9146ff/);
  assert.match(css,/--calendar-boosty:#ff7136/);
  assert.match(css,/--calendar-off:#57be89/);
});
