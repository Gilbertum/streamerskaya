"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const logic=require("./telegram-logic");
const date="2026-11-21",start="15:00",end="00:00";
const p={fromUid:"x",toUid:"hell",game:"Chained Together",date,start,end};
test("a teammate may join existing organizer party",()=>{
 const current={fromUid:"x",toUid:"reus",game:p.game,date,start,end};
 assert.equal(logic.conflict({proposal:p,slots:[],locks:[current],groups:[]}),"");
});
test("same recipient duplicate is blocked",()=>{
 assert.match(logic.conflict({proposal:p,slots:[],locks:[{...p}],groups:[]}),/подтверждённой коллабой/);
});
test("different game at same time remains blocked",()=>{
 const lock={...p,toUid:"reus",game:"The Forest"};
 assert.match(logic.conflict({proposal:p,slots:[],locks:[lock],groups:[]}),/подтверждённой коллабой/);
});
test("day off is not bypassed",()=>{
 const off={ownerUid:"hell",type:"off",date,start:"00:00",end:"00:00"};
 assert.match(logic.conflict({proposal:p,slots:[off],locks:[],groups:[]}),/выходной/);
});
test("overnight intersection works",()=>{
 const a={date:"2026-11-20",start:"23:00",end:"03:00"};
 const b={date:"2026-11-21",start:"02:00",end:"04:00"};
 assert.equal(logic.overlaps(a,b),true);
});
test("separate non-overlapping slots stay independent",()=>{
 const a={date,start:"10:00",end:"12:00"};
 const b={date,start:"12:00",end:"15:00"};
 assert.equal(logic.overlaps(a,b),false);
});
test("private notes are not included in public channel text",()=>{
 const text=logic.scheduleText("Xwaran","nJ3iWxE43Xhb1p4qTxrlaUUZwbI2");
 assert.match(text,/Расписание обновилось/);
 assert.match(text,/#\/s\//);
 assert.ok(!text.includes("private"));
});
test("invitation text contains public offer fields",()=>{
 const text=logic.inviteText({...p,fromName:"Xwaran",message:"Цепи"});
 assert.match(text,/Chained Together/);
 assert.match(text,/Цепи/);
});
