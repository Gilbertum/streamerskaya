import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {groupGuestRecordId,groupGuestNames,parseGroupGuestNames,groupGuestRecord}
  from "../group-guests.js";
import {collabParties,partySessionId} from "../collab-parties.js";

const app=readFileSync(new URL("../app.js",import.meta.url),"utf8");
const inbox=readFileSync(new URL("../group-wishes.js",import.meta.url),"utf8");
const streamer=readFileSync(new URL("../streamers-view.js",import.meta.url),"utf8");
const rules=readFileSync(new URL("../firestore.rules",import.meta.url),"utf8");
const extract=(text,a,b)=>{
  const start=text.indexOf(a),end=text.indexOf(b,start+a.length);
  assert.ok(start>=0&&end>start,"Source missing: "+a);
  return text.slice(start,end);
};
const group={id:"group123",organizerUid:"x",participantsUids:["x","h"],
  participants:["Xwaran","Hell_Fox_X"],date:"2026-11-17",
  start:"21:00",end:"01:00",game:"Клеть"};
const roster={id:groupGuestRecordId(group.id),
  ...groupGuestRecord(group,["Гость Один","Гость Два"],"timestamp")};

test("group guest record is isolated by unique group ID and event identity",()=>{
  assert.equal(groupGuestRecordId(group.id),"group_group123");
  assert.deepEqual(groupGuestNames(group,[roster]),["Гость Один","Гость Два"]);
  assert.deepEqual(groupGuestNames({...group,id:"other"},[roster]),[]);
  assert.deepEqual(groupGuestNames({...group,date:"2026-11-18"},[roster]),[]);
  assert.deepEqual(groupGuestNames({...group,organizerUid:"h"},[roster]),[]);
  assert.throws(()=>groupGuestRecordId("../../bad"));
});
test("guest names are normalized and bounded; duplicate nicknames don't accumulate",()=>{
  assert.deepEqual(parseGroupGuestNames(" Аля \n\nБоря\n аЛя\n"),["Аля","Боря"]);
  assert.deepEqual(parseGroupGuestNames(""),[]);
  assert.throws(()=>parseGroupGuestNames("x".repeat(41)),/40/);
  assert.throws(()=>parseGroupGuestNames(Array.from({length:16},(_,i)=>i).join("\n")),/15/);
  assert.throws(()=>parseGroupGuestNames("bad\tname"),/40/);
});
test("direct collaboration roster does not leak group guests with matching game and time",()=>{
  const lock={id:"lock1",fromUid:"x",toUid:"h",fromName:"Xwaran",toName:"Hell_Fox_X",
    date:group.date,start:group.start,end:group.end,game:group.game};
  const party=collabParties([lock],uid=>uid,[roster])[0];
  assert.deepEqual(party.manualGuests,[]);
  const personalRoster={...roster,id:partySessionId(party)};
  const proper=collabParties([lock],uid=>uid,[roster,personalRoster])[0];
  assert.deepEqual(proper.manualGuests,["Гость Один","Гость Два"]);
});
test("calendar renders a group guest editor and includes manual guests in its roster",()=>{
  assert.match(app,/data-action="group-details"/);
  assert.match(app,/data-form="group-guests"/);
  assert.match(app,/manualGuests:groupGuestNames\(item,state\.manualGuests\)/);
  assert.match(app,/item\.manualGuests\|\|\[\]/);
  assert.match(app,/state\.authorized && type === "group-guests"/);
});
test("confirmed invitations and streamers calendar show the additional guests",()=>{
  assert.match(inbox,/groupInboxHtml\(groups,uid,guestRecords=\[\]\)/);
  assert.match(inbox,/groupGuestNames\(\{\.\.\.g,/);
  assert.match(inbox,/Изменить гостей/);
  assert.match(streamer,/groupGuestNames\(e,manualGuests\)/);
  assert.match(streamer,/\(гость\)/);
});
test("saving guests checks current confirmed status, owner, times, and Firestore permissions",async()=>{
  const state={uid:"x",groupCalendar:[group]},timestamp={server:true},saved=[];
  let read=0,closeCount=0,message="";
  const factory=new Function("state","db","parseGroupGuestNames","getDocFromServer","doc","setDoc",
    "groupGuestRecordId","groupGuestRecord","serverTimestamp","modalClose","flashMessage",
    extract(app,"async function saveGroupGuests(form) {","async function addPartyParticipants(form) {")+
    "\nreturn saveGroupGuests;");
  let response={exists:()=>true,data:()=>({
    organizerUid:"x",status:"confirmed",chosenIndex:0,
    options:[{date:group.date,start:group.start,end:group.end}],game:group.game
  })};
  const run=factory(state,{},parseGroupGuestNames,async()=>{read++;return response;},
    (_db,name,id)=>name+"/"+id,async(path,data)=>saved.push({path,data}),
    groupGuestRecordId,groupGuestRecord,()=>timestamp,()=>{closeCount++;},
    text=>{message=text});
  await run({dataset:{group:group.id},elements:{guestNames:{value:"Лиса\nКот"}}});
  assert.equal(read,1);
  assert.equal(closeCount,1);
  assert.equal(saved[0].path,"collabGuests/group_group123");
  assert.deepEqual(saved[0].data.guestNames,["Лиса","Кот"]);
  assert.match(message,/Гости групповой коллабы сохранены/);
  assert.match(rules,/match \/collabGuests\/\{sessionId\}/);
  assert.match(rules,/resource\.data\.ownerUid == request\.auth\.uid/);
});
test("only organizer can save, and cancelled group cannot be edited",async()=>{
  let written=0;
  const factory=new Function("state","db","parseGroupGuestNames","getDocFromServer","doc","setDoc",
    "groupGuestRecordId","groupGuestRecord","serverTimestamp","modalClose","flashMessage",
    extract(app,"async function saveGroupGuests(form) {","async function addPartyParticipants(form) {")+
    "\nreturn saveGroupGuests;");
  const inputs={dataset:{group:group.id},elements:{guestNames:{value:"Лиса"}}};
  const member=factory({uid:"h",groupCalendar:[group]},{},parseGroupGuestNames,
    async()=>{throw Error("Must not fetch");},()=>{},()=>{written++;},
    groupGuestRecordId,groupGuestRecord,()=>{},()=>{},()=>{});
  await assert.rejects(()=>member(inputs),/только организатор/);
  const owner=factory({uid:"x",groupCalendar:[group]},{},parseGroupGuestNames,
    async()=>({exists:()=>true,data:()=>({status:"cancelled",organizerUid:"x"})}),
    ()=>{},()=>{written++;},groupGuestRecordId,groupGuestRecord,()=>{},()=>{},()=>{});
  await assert.rejects(()=>owner(inputs),/отменена/);
  assert.equal(written,0);
});
