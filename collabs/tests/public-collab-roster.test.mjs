import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {ROSTER_TYPE,rosterPreference,projectRoster,rebuildRosterProjections,
  publicCollabEvents} from "../public-collab-roster.js";
import {collabParties,partySessionId} from "../collab-parties.js";

const app=readFileSync(new URL("../app.js",import.meta.url),"utf8");
const views=readFileSync(new URL("../views.js",import.meta.url),"utf8");
const rules=readFileSync(new URL("../firestore.rules",import.meta.url),"utf8");
const group={id:"g1",organizerUid:"x",participantsUids:["x","fox"],
  participants:["Xwaran","Hell_Fox_X"],game:"Клеть",date:"2026-11-17",
  start:"21:00",end:"01:00"};
const guests=[{id:"group_g1",ownerUid:"x",date:group.date,start:group.start,
  end:group.end,game:group.game,guestNames:["kzlk_90","Онарка"]}];
const context={uid:"x",groups:[group],parties:[],guestRecords:guests,members:[]};
const preference=(kind,sourceId,showGame=true,showParticipants=true)=>
  ({type:ROSTER_TYPE,kind,sourceId,showGame,showParticipants});

test("a group opt-in shows ALL participants outside the viewer plus both external guests",()=>{
  const projected=projectRoster(preference("group","g1"),context);
  assert.equal(projected.game,"Клеть");
  assert.equal(projected.partner,"Hell_Fox_X, kzlk_90, Онарка");
  const fox=projectRoster(preference("group","g1"),{...context,uid:"fox"});
  assert.equal(fox.partner,"Xwaran, kzlk_90, Онарка");
  assert.equal(rosterPreference([projected],"group","g1"),projected);
});
test("game and full roster are independent privacy switches, hidden by default",()=>{
  assert.equal(projectRoster(preference("group","g1",false,false),context),null);
  const onlyTitle=projectRoster(preference("group","g1",true,false),context);
  assert.equal(onlyTitle.game,"Клеть");
  assert.equal(onlyTitle.partner,"");
  const onlyRoster=projectRoster(preference("group","g1",false,true),context);
  assert.equal(onlyRoster.game,"");
  assert.equal(onlyRoster.partner,"Hell_Fox_X, kzlk_90, Онарка");
  assert.equal(rosterPreference([],"group","g1"),null);
});
test("without an explicit opt-in the public page uses hidden group marker, not a private roster",()=>{
  const marker={id:"g1",type:"collab",date:group.date,
    start:group.start,end:group.end,game:"",partner:""};
  const res=publicCollabEvents({groups:[marker],projections:[],slots:[],direct:[]});
  assert.equal(res.events.length,1);
  assert.equal(res.events[0].game,"");
  assert.equal(res.events[0].partner,"");
});
test("only matching published markers reveal opt-in group roster",()=>{
  const projected=projectRoster(preference("group","g1"),context);
  const marker={id:"g1",date:group.date,start:group.start,end:group.end,
    game:"",partner:""};
  assert.equal(publicCollabEvents({groups:[marker],projections:[projected]}).events[0].partner,
    "Hell_Fox_X, kzlk_90, Онарка");
  assert.equal(publicCollabEvents({groups:[],projections:[projected]}).events.length,0);
  const stale=publicCollabEvents({groups:[{...marker,date:"2026-11-18"}],projections:[projected]});
  assert.equal(stale.events[0].partner,"Hell_Fox_X, kzlk_90, Онарка");
  assert.equal(stale.events[0].date,"2026-11-18");
});
test("multiple confirmed direct participants are listed when the viewer has ONE public marker",()=>{
  const locks=[
    {id:"l1",fromUid:"x",toUid:"fox",fromName:"Xwaran",toName:"Hell_Fox_X",
      date:group.date,start:group.start,end:group.end,game:"Клеть"},
    {id:"l2",fromUid:"x",toUid:"p",fromName:"Xwaran",toName:"Player_2",
      date:group.date,start:group.start,end:group.end,game:"Клеть"}
  ];
  const party=collabParties(locks,uid=>({x:"Xwaran",fox:"Hell_Fox_X",p:"Player_2"})[uid],
    [{id:"guest-roster",guestNames:[]}])[0];
  party.publicRosterId=partySessionId(party);
  party.manualGuests=["Гость вне сервиса"];
  const doc=projectRoster(preference("party",party.publicRosterId),
    {uid:"fox",groups:[],parties:[party],guestRecords:[],members:[]});
  assert.equal(doc.partner,"Xwaran, Player_2, Гость вне сервиса");
  assert.deepEqual(doc.sourceIds,["l1","l2"]);
  const page=publicCollabEvents({direct:[{id:"l1",date:party.date,start:party.start,end:party.end,
    type:"collab",game:"",partner:""}],groups:[],projections:[doc]});
  assert.equal(page.events[0].partner,"Xwaran, Player_2, Гость вне сервиса");
  assert.equal(page.remainingDirect.length,0);
  assert.equal(publicCollabEvents({direct:[],projections:[doc]}).events.length,0);
});
test("rescheduled direct collab preserves prior opt-in and uses the new public time",()=>{
  const old={type:ROSTER_TYPE,kind:"party",sourceId:"old-session",sourceIds:["lock1","lock2"],
    date:"2026-11-17",start:"21:00",end:"01:00",
    game:"Co-op",partner:"Друг, Гость",showGame:true,showParticipants:true};
  const card=publicCollabEvents({direct:[{id:"lock1",date:"2026-11-22",
    start:"17:00",end:"22:00",type:"collab",game:"",partner:""}],projections:[old]});
  assert.equal(card.events.length,1);
  assert.equal(card.events[0].date,"2026-11-22");
  assert.equal(card.events[0].partner,"Друг, Гость");
  assert.equal(card.remainingDirect.length,0);
});
test("unrelated events at the same time never inherit another group's names",()=>{
  const doc=projectRoster(preference("group","g1"),context);
  const another={id:"g2",date:group.date,start:group.start,end:group.end,
    game:"",partner:""};
  const res=publicCollabEvents({groups:[another],projections:[doc]});
  assert.equal(res.events[0].partner,"");
});
test("refresh repopulates active published rosters after guests change",()=>{
  const old=projectRoster(preference("group","g1"),context);
  const changed=[{...guests[0],guestNames:["Новый ник","Онарка"]}];
  const updated=rebuildRosterProjections([old],{...context,guestRecords:changed});
  assert.equal(updated[0].partner,"Hell_Fox_X, Новый ник, Онарка");
  const kept=rebuildRosterProjections([old],{...context,groups:[]});
  assert.deepEqual(kept,[old]); // Temporarily unloaded private cache must not erase opt-in.
});
test("owner-only publicSchedules and per-user visibility, no new Firestore Rules required",()=>{
  assert.match(rules,/match \/publicSchedules\/\{uid\}/);
  assert.match(rules,/allow create, update: if member\(\) && me\(uid\)/);
  assert.match(app,/publishPublicSchedule\(updated,party\)/);
  assert.match(app,/batch\.set\(doc\(db,"publicCollabs",state\.uid,"items",lock\.id\)/);
  assert.match(app,/collab-roster-visibility/);
  assert.match(app,/Показывать весь состав/);
  assert.match(views,/publicCollabEvents/);
  assert.match(views,/ownEvents\.filter\(e=>e\?\.type!==ROSTER_TYPE\)/);
});
