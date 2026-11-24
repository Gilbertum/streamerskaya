import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const source=readFileSync(new URL("../reschedule.js",import.meta.url),"utf8");
const app=readFileSync(new URL("../app.js",import.meta.url),"utf8");
const rules=readFileSync(new URL("../firestore.rules",import.meta.url),"utf8");

function mockFunctions(initial={}){
  const docs=new Map(Object.entries(initial)),writes=[];
  const tx={
    get:async ref=>({exists:()=>docs.has(ref),data:()=>docs.get(ref)}),
    update:(ref,values)=>writes.push({op:"update",ref,values}),
    set:(ref,values)=>writes.push({op:"set",ref,values}),
    delete:ref=>writes.push({op:"delete",ref})
  };
  const library=new Function("doc","runTransaction","serverTimestamp",
    source.replace(/import\s*\{[\s\S]*?\}\s*from\s*"https:\/\/[^"]+";/,"")
      .replace(/export (async )?function /g,(_m,asyncKeyword)=>asyncKeyword?"async function ":"function ") +
    "\nreturn {validMoveWindow,sameWindow,movedOptionList,moveGroupForEveryone,movePartyForEveryone};")(
    (_db,...path)=>path.join("/"),async(_db,handler)=>handler(tx),()=>({timestamp:true})
  );
  return {...library,writes};
}
const before={date:"2026-12-04",start:"21:00",end:"01:00"};
const after={date:"2026-12-05",start:"19:00",end:"23:00"};
const group={id:"g1",organizerUid:"owner",organizerName:"Xwaran",status:"confirmed",
 chosenIndex:1,options:[{date:"2026-12-03",start:"17:00",end:"21:00"},before],
 participantsUids:["owner","fox"],game:"Игра"};
const calendar={...before,participantsUids:["owner","fox"],participants:["Xwaran","Fox"]};
const initial={
 "groupWishes/g1":group,"groupCalendar/g1":calendar,
 "collabGuests/group_g1":{...before,ownerUid:"owner",game:"Игра",guestNames:["Nero"]},
 "groupDiary/owner/items/g1":before,"groupDiary/fox/items/g1":before,
 "publicGroupCollabs/owner/items/g1":{...before,game:"Игра",partner:"Fox"},
 "publicGroupCollabs/fox/items/g1":{...before,game:"",partner:""}
};
test("validates exact dates, cross-midnight time and same-day time changes",()=>{
 const {validMoveWindow,sameWindow}=mockFunctions();
 assert.equal(validMoveWindow(before),true);
 assert.equal(validMoveWindow({date:"2026-02-30",start:"20:00",end:"21:00"}),false);
 assert.equal(validMoveWindow({date:"2026-12-08",start:"22:00",end:"22:00"}),false);
 assert.equal(validMoveWindow({date:"2026-12-08",start:"00:00",end:"00:00"}),true);
 assert.equal(sameWindow(before,{...before}),true);
 assert.equal(sameWindow(before,after),false);
});
test("moves group for ALL attendees, keeps guest roster and visibility intact",async()=>{
 const lib=mockFunctions(initial);
 const result=await lib.moveGroupForEveryone({}, {group,calendar},after,"owner");
 assert.equal(result.participants,2);
 assert.deepEqual(lib.writes.find(w=>w.ref==="groupWishes/g1").values.options,
   [group.options[0],after]);
 assert.ok(lib.writes.some(w=>w.ref==="groupCalendar/g1"));
 for(const id of ["owner","fox"]){
   assert.ok(lib.writes.some(w=>w.ref==="groupDiary/"+id+"/items/g1"));
   assert.ok(lib.writes.some(w=>w.ref==="publicGroupCollabs/"+id+"/items/g1"));
 }
 assert.deepEqual(lib.writes.find(w=>w.ref==="collabGuests/group_g1").values.date,after.date);
 assert.ok(lib.writes.every(w=>w.op==="update"));
 assert.equal(lib.writes.length,7);
});
test("an outdated roster stops move before ANY write",async()=>{
 const lib=mockFunctions({...initial,"groupCalendar/g1":{...calendar,participantsUids:["owner"]}});
 await assert.rejects(()=>lib.moveGroupForEveryone({}, {group,calendar},after,"owner"),
   /изменилась за время проверки/);
 assert.equal(lib.writes.length,0);
});
test("direct group of 3 participants gets one atomic move, guest record migrates",async()=>{
 const party={id:"lock0",fromUid:"owner",date:before.date,start:before.start,end:before.end,
  game:"Co-op",locks:[{id:"lock0",toUid:"fox"},{id:"lock1",toUid:"reus"}]};
 const events={};
 for(const [id,other] of [["lock0","fox"],["lock1","reus"]]){
   events["collabLocks/"+id]={...before,fromUid:"owner",toUid:other,game:"Co-op"};
   events["proposals/"+id]={...before,fromUid:"owner",toUid:other,status:"accepted"};
   events["publicCollabs/owner/items/"+id]={...before,game:"Co-op",partner:""};
   events["publicCollabs/"+other+"/items/"+id]={...before,game:"",partner:""};
 }
 events["collabGuests/old-key"]={...before,ownerUid:"owner",guestNames:["Nero"],game:"Co-op"};
 const lib=mockFunctions(events);
 const result=await lib.movePartyForEveryone({},{
   party,selected:party.locks,locks:party.locks.map(x=>({...x,fromUid:"owner",game:"Co-op",...before}))
 },after,"owner","old-key","new-key");
 assert.equal(result.participants,3);
 assert.equal(lib.writes.filter(w=>w.op==="update").length,8);
 assert.ok(lib.writes.some(w=>w.op==="set"&&w.ref==="collabGuests/new-key"));
 assert.ok(lib.writes.some(w=>w.op==="delete"&&w.ref==="collabGuests/old-key"));
 assert.deepEqual(lib.writes.find(w=>w.op==="set").values.guestNames,["Nero"]);
});
test("reschedule is shown to organizer for group and party, not all participants",()=>{
 assert.match(app,/data-action="move-group"/);
 assert.match(app,/data-action="move-party"/);
 assert.match(app,/data-form="move-group"/);
 assert.match(app,/data-form="move-party"/);
 assert.match(app,/item\.organizerUid===state\.uid/);
 assert.match(app,/party\.fromUid===state\.uid/);
 assert.match(app,/freshMoveContext\(db,form\.dataset\.id,state\.uid\)/);
 assert.match(app,/freshPartyMoveContext\(db,party,state\.uid\)/);
 assert.match(rules,/function validGroupMove/);
 assert.match(rules,/request\.auth\.uid == resource\.data\.fromUid/);
});
