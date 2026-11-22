import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {activeGroupMembers,activeInvitees,departed,groupAttendance,
 groupCandidateList,manualGuestNames,matchingManualSlot} from "../group-team.js";

const source=name=>readFileSync(new URL("../"+name,import.meta.url),"utf8");
const code=source("group-wishes.js"),app=source("app.js"),
  rules=source("firestore.rules"),helper=source("group-confirmation.js");
const isolate=(start,end,args,values)=>{
 const a=code.indexOf(start),b=end?code.indexOf(end,a+start.length):code.length;
 assert.ok(a>=0&&b>a,"Missing group-wishes code: "+start);
 const block=code.slice(a,b).replaceAll("export async function ","async function ");
 const name=start.split("(")[0].replace("export async function ","").trim();
 return new Function(...args,block+"\nreturn "+name+";")(...values);
};
const slot={date:"2026-11-28",start:"20:00",end:"00:00"};
const group={id:"g1",organizerUid:"owner",organizerName:"Xwaran",
 inviteeUids:["fox","reus"],inviteeNames:["Hell_Fox_X","Reus"],departedUids:[],
 options:[slot],chosenIndex:0,game:"Far Far West",status:"confirmed"};
const db={};
const doc=(_db,...parts)=>parts.join("/");
const collection=(_db,id)=>id;
const timestamp=()=>({server:true});
function fakeBatch(){
 const ops=[];
 return {ops,batch:{
  set:(ref,data)=>ops.push({op:"set",ref,data}),
  update:(ref,data)=>ops.push({op:"update",ref,data}),
  delete:ref=>ops.push({op:"delete",ref}),
  commit:async()=>{ops.push({op:"commit"})}
 }};
}
const groupFns={activeGroupMembers,activeInvitees,departed,groupAttendance};

test("declining one invitee keeps game, times and remaining participants",()=>{
 const changed={...group,departedUids:["reus"]};
 assert.deepEqual(activeGroupMembers(changed),{
  ids:["owner","fox"],names:["Xwaran","Hell_Fox_X"]
 });
 assert.equal(groupAttendance(changed,"reus"),"departed");
 assert.equal(groupAttendance(changed,"fox"),"active");
 assert.deepEqual(activeInvitees(changed),["fox"]);
 assert.equal(group.game,changed.game);
 assert.deepEqual(group.options,changed.options);
});
test("replacement picker suggests free streamers, excludes busy and previously invited",()=>{
 const people=[{id:"owner",nick:"Xwaran"},{id:"fox",nick:"Fox"},
  {id:"reus",nick:"Reus"},{id:"available",nick:"Новый"},
  {id:"busy",nick:"Занятый"},{id:"maybe",nick:"Под вопросом"}];
 const statuses={available:"free",busy:"busy",maybe:"maybe"};
 const selected=groupCandidateList(group,people,uid=>statuses[uid]||"free");
 assert.deepEqual(selected.map(p=>p.id),["available","maybe"]);
});
test("withdrawing from confirmed group changes calendar, diaries and own marker, not other participants",async()=>{
 const {ops,batch}=fakeBatch();
 const leave=isolate("export async function leaveGroupWish(","// Organizer can invite",
 ["getDocFromServer","doc","db","groupAttendance","departed","activeGroupMembers","writeBatch","serverTimestamp"],
 [async()=>({exists:()=>true,id:"g1",data:()=>group}),doc,db,
 groupAttendance,departed,activeGroupMembers,()=>batch,timestamp]);
 const result=await leave(db,"g1","reus");
 assert.deepEqual(result.remaining,["Xwaran","Hell_Fox_X"]);
 assert.ok(ops.some(o=>o.ref==="groupWishes/g1"&&
  o.op==="update"&&o.data.departedUids.includes("reus")&&o.data.status===undefined));
 assert.deepEqual(ops.find(o=>o.ref==="groupCalendar/g1").data.participantsUids,["owner","fox"]);
 assert.ok(ops.some(o=>o.op==="delete"&&o.ref==="groupDiary/reus/items/g1"));
 assert.ok(ops.some(o=>o.op==="delete"&&o.ref==="publicGroupCollabs/reus/items/g1"));
 assert.ok(!ops.some(o=>o.op==="delete"&&o.ref.includes("groupDiary/fox")));
 assert.ok(!ops.some(o=>o.op==="delete"&&o.ref==="groupCalendar/g1"));
});
test("declining an invitation before confirmation does not create or remove a confirmed booking",async()=>{
 const collecting={...group,status:"collecting",chosenIndex:-1};
 const {ops,batch}=fakeBatch();
 const leave=isolate("export async function leaveGroupWish(","// Organizer can invite",
 ["getDocFromServer","doc","db","groupAttendance","departed","activeGroupMembers","writeBatch","serverTimestamp"],
 [async()=>({exists:()=>true,id:"g1",data:()=>collecting}),doc,db,
 groupAttendance,departed,activeGroupMembers,()=>batch,timestamp]);
 await leave(db,"g1","reus");
 assert.ok(!ops.some(o=>o.ref.startsWith("groupCalendar/")));
 assert.ok(!ops.some(o=>o.ref.startsWith("publicGroupCollabs/")));
 assert.ok(ops.some(o=>o.op==="delete"&&o.ref==="groupDiary/reus/items/g1"));
});
test("manual guest names survive conversion without silently dropping entries",()=>{
 assert.deepEqual(manualGuestNames("Nero, Пузр, Реус, мужчина Неро, Лиса",["Реус"]),
   ["Nero","Пузр","мужчина Неро","Лиса"]);
 assert.throws(()=>manualGuestNames("x".repeat(41)),/40 символов/);
 assert.throws(()=>manualGuestNames(Array.from({length:16},(_,i)=>"g"+i).join(",")),/15 гостей/);
 const sourceSlot={id:"slot1",ownerUid:"owner",type:"collab",
   title:group.game,...slot,guestNick:"Nero, Reus"};
 assert.equal(matchingManualSlot(sourceSlot,{...group,sourceSlotId:"slot1"},slot),true);
 assert.equal(matchingManualSlot({...sourceSlot,start:"19:00"},{...group,sourceSlotId:"slot1"},slot),false);
});
test("finalization swaps the original manual calendar event for the group atomically",async()=>{
 const sourceSlot={id:"slot1",ownerUid:"owner",type:"collab",
  title:group.game,...slot,guestNick:"Nero, Reus"};
 const conversion={...group,status:"collecting",chosenIndex:-1,sourceSlotId:"slot1"};
 const {ops,batch}=fakeBatch();
 const finalize=isolate("export async function finalizeGroupWish(","export async function cancelGroupWish(",
 ["groupCommon","getDocFromServer","doc","db","matchingManualSlot","activeGroupMembers",
 "writeBatch","serverTimestamp","manualGuestNames","groupGuestRecordId"],
 [()=>[{...slot,index:0}],async()=>({exists:()=>true,id:"slot1",data:()=>sourceSlot}),
 doc,db,matchingManualSlot,activeGroupMembers,()=>batch,timestamp,manualGuestNames,
 id=>"group_"+id]);
 await finalize(db,conversion,"owner",0);
 assert.ok(ops.some(o=>o.op==="delete"&&o.ref==="slots/slot1"));
 assert.ok(ops.some(o=>o.op==="set"&&o.ref==="groupCalendar/g1"));
 const guests=ops.find(o=>o.op==="set"&&o.ref==="collabGuests/group_g1");
 assert.deepEqual(guests.data.guestNames,["Nero","Reus"]);
 assert.ok(ops.some(o=>o.op==="update"&&o.ref==="groupWishes/g1"&&o.data.status==="confirmed"));
 assert.ok(!ops.some(o=>o.op==="delete"&&o.ref.startsWith("groupDiary/")));
});
test("replacement acceptance does not require accessing other members' private groupWishes",async()=>{
 const invite={id:"jr1",groupId:"g1",organizerUid:"owner",toUid:"new",
  toName:"Новый",game:group.game,...slot,status:"pending"};
 const calendar={organizerUid:"owner",participantsUids:["owner","fox"],
  participants:["Xwaran","Hell_Fox_X"],game:group.game,...slot};
 const paths=[];
 const snapshots={
  "groupJoinRequests/jr1":{exists:()=>true,id:"jr1",data:()=>invite},
  "groupCalendar/g1":{exists:()=>true,id:"g1",data:()=>calendar}
 };
 const {ops,batch}=fakeBatch();
 const accept=isolate("export async function respondGroupJoin(",null,
 ["getDocFromServer","doc","db","writeBatch","serverTimestamp","arrayUnion"],
 [async ref=>{paths.push(ref);return snapshots[ref];},doc,db,()=>batch,timestamp,
 (...items)=>({union:items})]);
 await accept(db,"jr1","new",true);
 assert.deepEqual(paths,["groupJoinRequests/jr1","groupCalendar/g1"]);
 assert.equal(ops.find(o=>o.ref==="groupWishes/g1").data.inviteeUids.union[0],"new");
 assert.equal(ops.find(o=>o.ref==="groupWishes/g1").data.lastJoinId,"jr1");
 assert.deepEqual(ops.find(o=>o.ref==="groupCalendar/g1").data.participantsUids,
   ["owner","fox","new"]);
 assert.ok(ops.some(o=>o.op==="set"&&o.ref==="groupDiary/new/items/g1"));
 assert.ok(ops.some(o=>o.op==="set"&&o.ref==="publicGroupCollabs/new/items/g1"&&o.data.partner===""));
 assert.ok(!ops.some(o=>o.op==="delete"));
});
test("declining a replacement invitation does not alter any group booking",async()=>{
 const invite={id:"jr1",groupId:"g1",organizerUid:"owner",toUid:"new",
  toName:"Новый",game:group.game,...slot,status:"pending"};
 const calendar={organizerUid:"owner",participantsUids:["owner","fox"],
  participants:["Xwaran","Hell_Fox_X"],game:group.game,...slot};
 const {ops,batch}=fakeBatch();
 const reply=isolate("export async function respondGroupJoin(",null,
 ["getDocFromServer","doc","db","writeBatch","serverTimestamp","arrayUnion"],
 [async ref=>ref==="groupJoinRequests/jr1"?
  {exists:()=>true,id:"jr1",data:()=>invite}:
  {exists:()=>true,id:"g1",data:()=>calendar},
  doc,db,()=>batch,timestamp,()=>{}]);
 await reply(db,"jr1","new",false);
 assert.equal(ops.filter(o=>o.op==="update").length,1);
 assert.equal(ops[0].ref,"groupJoinRequests/jr1");
 assert.equal(ops[0].data.status,"declined");
});
test("room UI offers decline, replacement and direct manual invitation flow",()=>{
 assert.match(code,/data-action="group-leave"/);
 assert.match(code,/data-action="group-add-member"/);
 assert.match(app,/data-action="group-join-reply"/);
 assert.match(app,/data-action="event-invite"/);
 assert.match(app,/groupJoinInvitationsHtml\(\)/);
 assert.match(app,/data-action="group-leave"/);
 assert.match(app,/data-form="group-add-member"/);
 assert.match(app,/wishModal\(\{/);
});
test("Firestore rules require explicit membership consent and do not expose private groups",()=>{
 assert.match(rules,/match \/groupJoinRequests\/\{joinId\}/);
 assert.match(rules,/join\.status == 'accepted'/);
 assert.match(rules,/request\.auth\.uid == resource\.data\.toUid/);
 assert.match(rules,/groupActiveIds\(g\)/);
 assert.match(rules,/departedUids/);
 assert.match(rules,/allow get, list: if member\(\) && groupMember\(resource\.data, request\.auth\.uid\)/);
 assert.match(rules,/sourceSlotId/);
});
