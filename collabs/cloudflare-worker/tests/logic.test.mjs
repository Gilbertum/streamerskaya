import test from "node:test";
import assert from "node:assert/strict";
import {overlaps,conflict,inviteText,groupText,scheduleText,callbackMarkup,recent} from "../src/logic.js";
const p={id:"invite123456789012",fromUid:"owner",toUid:"hell",game:"Chained Together",
 date:"2026-11-21",start:"15:00",end:"00:00",fromName:"Xwaran"};
test("another guest may join the same organizer, game and hours",()=>{
 const existing={...p,toUid:"reus"};
 assert.equal(conflict({proposal:p,slots:[],locks:[existing],groups:[]}),"");
});
test("same recipient duplicate fails",()=>{
 assert.match(conflict({proposal:p,slots:[],locks:[{...p}],groups:[]}),/подтверждённой/);
});
test("different games do not overlap across organizer",()=>{
 assert.match(conflict({proposal:p,slots:[],locks:[{...p,toUid:"reus",game:"The Forest"}],groups:[]}),/подтверждённой/);
});
test("day off is respected",()=>{
 assert.match(conflict({proposal:p,slots:[{ownerUid:"hell",type:"off",date:p.date,start:"00:00",end:"00:00"}],locks:[],groups:[]}),/выходной/);
});
test("night events extend into following date",()=>{
 assert.equal(overlaps({date:"2026-11-20",start:"23:00",end:"03:00"},
 {date:"2026-11-21",start:"02:00",end:"04:00"}),true);
});
test("adjacent events do not overlap",()=>{
 assert.equal(overlaps({date:p.date,start:"10:00",end:"12:00"},
 {date:p.date,start:"12:00",end:"15:00"}),false);
});
test("invite text exposes no private notes by default",()=>{
 assert.match(inviteText(p),/Chained Together/);
 assert.doesNotMatch(inviteText(p),/секрет/);
});
test("group invite explains multiple proposed dates",()=>{
 assert.match(groupText({game:"Forest",organizerName:"Xwaran",
 options:[{date:"2026-11-21",start:"15:00",end:"20:00"}]}),/Предложенные даты/);
});
test("channel publish message has only public link",()=>{
 const text=scheduleText("nJ3iWxE43Xhb1p4qTxrlaUUZwbI2");
 assert.match(text,/Расписание обновилось/);
 assert.match(text,/#\/s\//);
});
test("Telegram keyboard contains three requested buttons",()=>{
 const rows=callbackMarkup("p","proposal12345678901").inline_keyboard.flat().map(x=>x.text);
 assert.equal(rows.length,3);
 assert.ok(rows.every(x=>["✅ Принять","❌ Отклонить","📅 Проверить расписание"].includes(x)));
});
test("old proposals are ignored by polling",()=>{
 assert.equal(recent("2026-11-10T00:00:00.000Z",Date.parse("2026-11-12T12:00:00Z")),false);
});
test("recent proposals are picked up",()=>{
 assert.equal(recent("2026-11-12T11:00:00Z",Date.parse("2026-11-12T12:00:00Z")),true);
});
