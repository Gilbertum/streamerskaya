import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {validBirthday,availabilityText,formatBirthday,nextBirthday,upcomingBirthdays}
  from "../member-profile.js";

const app=readFileSync(new URL("../app.js",import.meta.url),"utf8");
const streamer=readFileSync(new URL("../streamers-view.js",import.meta.url),"utf8");
const publicView=readFileSync(new URL("../views.js",import.meta.url),"utf8");
const rules=readFileSync(new URL("../firestore.rules",import.meta.url),"utf8");
const section=(source,begin,end)=>{
  const i=source.indexOf(begin),j=source.indexOf(end,i+begin.length);
  assert.ok(i>=0 && j>i,"Section not found: "+begin);
  return source.slice(i,j);
};

test("Reus can select masculine status, others use feminine or a non-assuming status",()=>{
  assert.equal(availabilityText({nick:"Reus",addressForm:"male"},"free"),"Свободен");
  assert.equal(availabilityText({nick:"Reus",addressForm:"male"},"busy"),"Занят");
  assert.equal(availabilityText({addressForm:"female"},"free"),"Свободна");
  assert.equal(availabilityText({addressForm:"female"},"busy"),"Занята");
  assert.equal(availabilityText({},"free"),"Свободное время");
  assert.equal(availabilityText({},"busy"),"Время занято");
  assert.equal(availabilityText({addressForm:"neutral"},"unavailable"),"Недоступно");
  assert.equal(availabilityText({addressForm:"male"},"maybe"),"Под вопросом");
});
test("birth day and month are validated without collecting birth year",()=>{
  assert.equal(validBirthday(0,0),true);
  assert.equal(validBirthday(2,29),true);
  assert.equal(validBirthday(2,30),false);
  assert.equal(validBirthday(4,31),false);
  assert.equal(validBirthday(0,15),false);
  assert.equal(validBirthday(8,0),false);
  assert.equal(validBirthday(12,31),true);
  assert.equal(formatBirthday({birthMonth:2,birthDay:29}),"29 февраля");
});
test("upcoming birthday alert is based on Moscow calendar date and crosses the New Year",()=>{
  const people=[
    {id:"a",nick:"Сегодня",birthMonth:11,birthDay:20},
    {id:"b",nick:"Скоро",birthMonth:11,birthDay:27},
    {id:"c",nick:"Не скоро",birthMonth:12,birthDay:2}
  ];
  assert.deepEqual(upcomingBirthdays(people,"2026-11-20").map(x=>[x.nick,x.days]),
    [["Сегодня",0],["Скоро",7]]);
  assert.deepEqual(upcomingBirthdays([
    {id:"new",nick:"Новый год",birthMonth:1,birthDay:1}
  ],"2026-12-29").map(x=>x.days),[3]);
  assert.equal(nextBirthday({birthMonth:2,birthDay:29},"2026-11-20").date,"2028-02-29");
  assert.deepEqual(upcomingBirthdays([{nick:"Без даты"}],"2026-11-20"),[]);
});
test("profile UI includes optional address and birth date selectors, while anonymous viewer is unchanged",()=>{
  assert.match(app,/name="addressForm"/);
  assert.match(app,/name="birthDay"/);
  assert.match(app,/name="birthMonth"/);
  assert.match(app,/birthdayReminder\(\)/);
  assert.match(streamer,/birthdayNotice\(members\)/);
  assert.match(streamer,/birthdayHere\?' 🎂'/);
  assert.match(app,/availabilityText\(m,m\.status\)/);
  assert.doesNotMatch(publicView,/birthDay|birthMonth|addressForm|upcomingBirthdays/);
});
test("rules accept only safe fields and both birth fields together while retaining old profiles",()=>{
  assert.match(rules,/d\.get\('addressForm','neutral'\) in \['neutral','male','female'\]/);
  assert.match(rules,/d\.get\('birthDay',0\) is int/);
  assert.match(rules,/d\.get\('birthMonth',0\) is int/);
  assert.match(rules,/d\.get\('birthMonth',0\) != 2 \|\| d\.get\('birthDay',0\) <= 29/);
  assert.match(rules,/d\.get\('birthMonth',0\) == 0 && d\.get\('birthDay',0\) == 0/);
  assert.match(rules,/allow create, update: if member\(\) && me\(uid\) && goodMember/);
});
function saveFixture({deniedOnce=false}={}){
  const calls=[],alerts=[],state={uid:"example",nick:"Old",member:null};
  class FakeFormData{
    constructor(form){this.raw=form.data;}
    entries(){return Object.entries(this.raw)[Symbol.iterator]();}
  }
  let denied=deniedOnce;
  const save=new Function("FormData","validBirthday","safeUrl","serverTimestamp","setDoc",
    "doc","db","state","publishPublicSchedule","render","flashMessage",
    section(app,"async function saveProfile(form) {","async function sendInvite(")+
    "\nreturn saveProfile;")(
    FakeFormData,validBirthday,()=>true,()=>({timestamp:true}),
    async(_ref,record)=>{
      calls.push(record);
      if(denied){denied=false;const err=new Error("Rules not deployed");err.code="permission-denied";throw err;}
    },
    (_,collection,id)=>collection+"/"+id,{},state,async()=>{},()=>{},
    (msg,isError)=>alerts.push({msg,isError})
  );
  const data={
    nick:"Reus",addressForm:"male",birthDay:"15",birthMonth:"7",
    twitch:"https://twitch.tv/reus",steam:"",telegram:"",telegramDM:"",
    youtube:"",tiktok:"",discord:"",weekdays:"",weekend:""
  };
  return {save,data,state,calls,alerts};
}
test("saving new profile persists address and date, no year",async()=>{
  const f=saveFixture();
  await f.save({data:f.data});
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].addressForm,"male");
  assert.equal(f.calls[0].birthDay,15);
  assert.equal(f.calls[0].birthMonth,7);
  assert.equal(f.calls[0].birthYear,undefined);
  assert.equal(f.alerts[0].isError,false);
});
test("incomplete or impossible dates refuse to save",async()=>{
  const f=saveFixture();
  await assert.rejects(()=>f.save({data:{...f.data,birthMonth:"",birthDay:"15"}}),/Выбери день и месяц/);
  await assert.rejects(()=>f.save({data:{...f.data,birthMonth:"2",birthDay:"30"}}),/Выбери день и месяц/);
  assert.equal(f.calls.length,0);
});
test("older Firestore rules still allow editing old fields, but visibly warn new fields were NOT saved",async()=>{
  const f=saveFixture({deniedOnce:true});
  await f.save({data:f.data});
  assert.equal(f.calls.length,2);
  assert.equal(f.calls[1].addressForm,undefined);
  assert.equal(f.calls[1].birthDay,undefined);
  assert.equal(f.state.member.addressForm,undefined);
  assert.equal(f.alerts[0].isError,true);
  assert.match(f.alerts[0].msg,/НЕ сохранены/);
});
