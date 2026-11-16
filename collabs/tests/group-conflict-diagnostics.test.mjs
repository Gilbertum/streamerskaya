import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const app=readFileSync(new URL("../app.js",import.meta.url),"utf8");
function between(source,a,b) {
  const start=source.indexOf(a);
  const end=source.indexOf(b,start+a.length);
  assert.ok(start>=0 && end>start,"Missing source section: "+a);
  return source.slice(start,end);
}
function simulate(slots,locks=[],groups=[]) {
  const state={slots,locks,groupCalendar:groups};
  const funcs=new Function("state","nameOf","canJoinExistingSession",
    between(app,"function isDate(value) {","function flashMessage(")+
    between(app,"function bookingConflicts(","function duplicateConfirmedInvite(")+
    "\nreturn {overlaps,bookingConflicts};"
  );
  return funcs(state,uid=>uid,()=>false);
}
const meeting={date:"2026-11-17",start:"21:00",end:"01:00"};

test("a planned meeting runs until 01:00 the following day",()=>{
  const {overlaps}=simulate([]);
  assert.equal(overlaps(meeting,{date:"2026-11-18",start:"00:30",end:"01:30"}),true);
  assert.equal(overlaps(meeting,{date:"2026-11-18",start:"01:00",end:"03:00"}),false);
  assert.equal(overlaps(meeting,{date:"2026-11-18",start:"20:00",end:"23:00"}),false);
  assert.equal(overlaps(meeting,{date:"2026-11-16",start:"00:00",end:"00:00"}),false);
});
test("a conflicting slot on the next date is identified with title and time",()=>{
  const slot={id:"s1",ownerUid:"Xwaran",type:"stream",title:"Тест",
    date:"2026-11-18",start:"00:30",end:"01:30"};
  const {bookingConflicts}=simulate([slot]);
  assert.deepEqual(bookingConflicts("Xwaran",meeting),[{
    date:"2026-11-18",start:"00:30",end:"01:30",label:"Twitch: Тест"
  }]);
  assert.deepEqual(bookingConflicts("Hell_Fox_X",meeting),[]);
});
test("an evening stream on the following day must not block a nighttime meeting",()=>{
  const {bookingConflicts}=simulate([{
    id:"s1",ownerUid:"Xwaran",type:"stream",title:"Тест",
    date:"2026-11-18",start:"20:00",end:"23:00"
  }]);
  assert.deepEqual(bookingConflicts("Xwaran",meeting),[]);
});
test("confirm action reports blocking participant and booking, not a generic error",()=>{
  const groupFinalize=between(app,'} else if (action === "group-finalize") {','} else {\n          await cancelGroupWish');
  assert.match(groupFinalize,/bookingConflicts\(uid,chosen\)/);
  assert.match(groupFinalize,/nameOf\(blocker\.uid\)/);
  assert.match(groupFinalize,/blocker\.date/);
  assert.match(groupFinalize,/blocker\.start/);
  assert.match(groupFinalize,/blocker\.end/);
  assert.doesNotMatch(groupFinalize,/Выбранное время уже занято у кого-то из участников/);
});
