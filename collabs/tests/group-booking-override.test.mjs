import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const source=name=>readFileSync(new URL("../"+name,import.meta.url),"utf8");
const app=source("app.js"),groupSource=source("group-wishes.js"),pure=source("group-confirmation.js");
const helper=new Function(pure.replace(/export function /g,"function ")+
  "\nreturn {groupBookingConflicts,groupConflictWarning,groupBookingOverlaps};")();
const {groupBookingConflicts,groupConflictWarning,groupBookingOverlaps}=helper;
const chosen={date:"2026-11-17",start:"21:00",end:"01:00"};
const group={
  id:"g-1",organizerUid:"x",organizerName:"Xwaran",
  inviteeUids:["f"],inviteeNames:["Hell_Fox_X"],
  status:"collecting",options:[chosen],responses:{f:[0]}
};

function extract(source,start,end){
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,"Missing section: "+start);
  return source.slice(a,b);
}
function freshGetter(data=group,items={},fail=""){
  const reads=[];
  const groupsByCollection={
    slots:items.slots||[],collabLocks:items.locks||[],
    groupCalendar:items.groups||[],members:items.members||[]
  };
  const snapshot=(id,rows)=>({docs:rows.map((r,i)=>({id:r.id||id+i,data:()=>r}))});
  const fn=new Function("getDocFromServer","getDocsFromServer","doc","collection","groupCommon",
    extract(groupSource,"export async function freshGroupFinalizeSnapshot(","export async function finalizeGroupWish(")
      .replace("export async function","async function")+
      "\nreturn freshGroupFinalizeSnapshot;")(
      async ref=>{
        reads.push("doc:"+ref);
        if(fail==="doc")throw Error("offline");
        return {exists:()=>!!data,id:"g-1",data:()=>data};
      },
      async ref=>{
        reads.push("collection:"+ref);
        if(fail===ref)throw Error("offline");
        return snapshot(ref,groupsByCollection[ref]);
      },
      (_db,collection,id)=>collection+"/"+id,
      (_db,collection)=>collection,
      g=>g.options.map((o,index)=>({...o,index})).filter(x=>
        g.inviteeUids.every(id=>Array.isArray(g.responses?.[id])&&g.responses[id].includes(x.index)))
    );
  return {fn,reads};
}
test("cross-midnight conflict is reported for every affected participant",()=>{
  const slots=[
    {id:"t",ownerUid:"x",type:"stream",title:"Ночной эфир",date:"2026-11-18",start:"00:30",end:"02:00"},
    {id:"b",ownerUid:"f",type:"boosty",title:"Boosty",date:"2026-11-17",start:"23:00",end:"23:30"}
  ];
  const review=groupBookingConflicts(group,chosen,{slots,members:[]});
  assert.equal(review.length,2);
  assert.ok(review.some(r=>r.nick==="Xwaran"&&r.date==="2026-11-18"&&r.label==="Twitch: Ночной эфир"));
  assert.ok(review.some(r=>r.nick==="Hell_Fox_X"&&r.label==="Boosty: Boosty"));
  const warning=groupConflictWarning(review,chosen);
  assert.match(warning,/Всё равно подтвердить/);
  assert.match(warning,/существующие события останутся без изменений/);
  assert.match(warning,/00:30–02:00/);
});
test("end boundary at 01:00 and next day's evening do not overlap",()=>{
  assert.equal(groupBookingOverlaps(chosen,{date:"2026-11-18",start:"01:00",end:"03:00"}),false);
  assert.equal(groupBookingOverlaps(chosen,{date:"2026-11-18",start:"19:00",end:"23:00"}),false);
  assert.equal(groupBookingOverlaps(chosen,{date:"2026-11-18",start:"00:30",end:"01:30"}),true);
});
test("group, accepted lock and day-off can be warned about, not deleted",()=>{
  const conflicts=groupBookingConflicts(group,chosen,{
    slots:[{id:"o",ownerUid:"x",type:"off",date:"2026-11-17",start:"00:00",end:"00:00"}],
    locks:[{id:"l",fromUid:"f",toUid:"someone",game:"Co-op",date:"2026-11-17",start:"20:00",end:"22:00"}],
    groups:[{id:"g2",participantsUids:["f"],game:"Соревнование",date:"2026-11-17",start:"22:30",end:"23:00"}]
  });
  assert.equal(conflicts.length,3);
  assert.ok(conflicts.some(c=>c.label==="Выходной"));
  assert.ok(conflicts.some(c=>c.label.includes("Подтверждённая коллаба")));
  assert.ok(conflicts.some(c=>c.label.includes("Групповая коллаба")));
});
test("fresh read retrieves all calendars and the current invitation FROM SERVER",async()=>{
  const {fn,reads}=freshGetter(group,{
    slots:[{id:"test",type:"busy"}],members:[{id:"x",nick:"Xwaran"}]});
  const review=await fn({},"g-1","x",0);
  assert.equal(review.group.id,"g-1");
  assert.equal(review.slots.length,1);
  assert.deepEqual(reads,[
    "doc:groupWishes/g-1","collection:slots","collection:collabLocks",
    "collection:groupCalendar","collection:members"
  ]);
});
test("stale invitation approval and canceled invitation MUST stop finalizing",async()=>{
  await assert.rejects(()=>freshGetter({...group,responses:{f:[]}}).fn({},"g-1","x",0),/не согласован/);
  await assert.rejects(()=>freshGetter({...group,status:"cancelled"}).fn({},"g-1","x",0),/закрыта/);
  await assert.rejects(()=>freshGetter(null).fn({},"g-1","x",0),/не найдена/);
});
test("no cached fallback: a failed server read cancels confirmation",async()=>{
  const {fn}=freshGetter(group,{},"slots");
  await assert.rejects(()=>fn({},"g-1","x",0),/offline/);
});
test("UI requires explicit confirmation for conflicts but never blocks busy slots outright",()=>{
  const block=extract(app,'} else if (action === "group-finalize") {','} else {\n          await cancelGroupWish');
  assert.match(block,/freshGroupFinalizeSnapshot\(db,group\.id,state\.uid,index\)/);
  assert.match(block,/groupBookingConflicts\(fresh\.group,fresh\.chosen,fresh\)/);
  assert.match(block,/confirm\(groupConflictWarning\(conflicts,fresh\.chosen\)\)/);
  assert.match(block,/finalizeGroupWish\(db,fresh\.group,state\.uid,index\)/);
  assert.doesNotMatch(block,/availability\(uid,chosen\)/);
  assert.doesNotMatch(groupSource,/if\(!options\.some\(o=>!busy\(uid,o\)\)\)/);
});
