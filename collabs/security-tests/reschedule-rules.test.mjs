import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {initializeTestEnvironment,assertSucceeds,assertFails} from "@firebase/rules-unit-testing";
import {doc,setDoc,getDoc,updateDoc,writeBatch,serverTimestamp,Timestamp} from "firebase/firestore";

const rules=readFileSync(new URL("../firestore.rules",import.meta.url),"utf8");
const oldTime={date:"2026-12-04",start:"21:00",end:"01:00"};
const newTime={date:"2026-12-05",start:"20:00",end:"23:30"};
const original={organizerUid:"owner",organizerName:"Xwaran",
  inviteeUids:["fox","reus"],inviteeNames:["Hell_Fox_X","Reus"],
  game:"Тестовая игра",message:"Приватно",options:[oldTime],
  responses:{fox:[0],reus:[0]},status:"confirmed",chosenIndex:0,
  createdAt:Timestamp.now(),updatedAt:Timestamp.now()};

test("only organizer moves the entire confirmed group, retaining guests, rosters and privacy",async()=>{
 const env=await initializeTestEnvironment({projectId:"demo-group-move",
   firestore:{host:"127.0.0.1",port:8089,rules}});
 try{
  await env.withSecurityRulesDisabled(async ctx=>{
    const db=ctx.firestore();
    for(const id of ["owner","fox","reus"])await setDoc(doc(db,"allowedUsers",id),{enabled:true});
    await setDoc(doc(db,"groupWishes","m1"),original);
    await setDoc(doc(db,"groupCalendar","m1"),{
      organizerUid:"owner",participantsUids:["owner","fox","reus"],
      participants:["Xwaran","Hell_Fox_X","Reus"],game:original.game,...oldTime});
    for(const id of ["owner","fox","reus"]){
      await setDoc(doc(db,"groupDiary",id,"items","m1"),{
        organizerUid:"owner",organizerName:"Xwaran",participants:["Xwaran","Hell_Fox_X","Reus"],
        game:original.game,...oldTime,status:"confirmed"
      });
      await setDoc(doc(db,"publicGroupCollabs",id,"items","m1"),{
        ...oldTime,type:"collab",game:id==="owner"?original.game:"",partner:""
      });
    }
    await setDoc(doc(db,"collabGuests","group_m1"),{
      ownerUid:"owner",...oldTime,game:original.game,
      guestNames:["Nero","Лиса"],updatedAt:Timestamp.now()});
  });
  const owner=env.authenticatedContext("owner").firestore();
  const recipient=env.authenticatedContext("fox").firestore();
  await assertFails(updateDoc(doc(recipient,"groupWishes","m1"),{
    options:[newTime],updatedAt:serverTimestamp()
  }));
  // A partial group move is prohibited: the public flat calendar must match.
  await assertFails(updateDoc(doc(owner,"groupWishes","m1"),{
    options:[newTime],updatedAt:serverTimestamp()
  }));
  const tx=writeBatch(owner);
  tx.update(doc(owner,"groupWishes","m1"),{options:[newTime],updatedAt:serverTimestamp()});
  tx.update(doc(owner,"groupCalendar","m1"),newTime);
  for(const id of ["owner","fox","reus"]){
    tx.update(doc(owner,"groupDiary",id,"items","m1"),newTime);
    tx.update(doc(owner,"publicGroupCollabs",id,"items","m1"),newTime);
  }
  tx.update(doc(owner,"collabGuests","group_m1"),{...newTime,updatedAt:serverTimestamp()});
  await assertSucceeds(tx.commit());
  const calendar=(await getDoc(doc(recipient,"groupCalendar","m1"))).data();
  assert.equal(calendar.date,newTime.date);
  assert.deepEqual(calendar.participantsUids,["owner","fox","reus"]);
  for(const id of ["owner","fox","reus"]){
    const diary=(await getDoc(doc(owner,"groupDiary",id,"items","m1"))).data();
    assert.equal(diary.start,newTime.start);
    const marker=(await getDoc(doc(owner,"publicGroupCollabs",id,"items","m1"))).data();
    assert.equal(marker.end,newTime.end);
    assert.equal(marker.game,id==="owner"?original.game:"");
  }
  assert.deepEqual((await getDoc(doc(owner,"collabGuests","group_m1"))).data().guestNames,["Nero","Лиса"]);
 }finally{await env.cleanup();}
});

test("accepted direct collab with two invitees moves atomically for everyone",async()=>{
 const env=await initializeTestEnvironment({projectId:"demo-direct-move",
   firestore:{host:"127.0.0.1",port:8089,rules}});
 try{
  await env.withSecurityRulesDisabled(async ctx=>{
    const db=ctx.firestore();
    for(const id of ["owner","fox","reus"])await setDoc(doc(db,"allowedUsers",id),{enabled:true});
    for(const [i,toUid] of ["fox","reus"].entries()){
      const id="lock"+i;
      await setDoc(doc(db,"proposals",id),{
        fromUid:"owner",toUid,fromName:"Xwaran",toName:toUid,
        game:"Тестовая игра",message:"Приватно",
        ...oldTime,status:"accepted",chosenIndex:0,
        createdAt:Timestamp.now(),respondedAt:Timestamp.now()
      });
      await setDoc(doc(db,"collabLocks",id),{
        fromUid:"owner",toUid,fromName:"Xwaran",toName:toUid,
        game:"Тестовая игра",...oldTime
      });
      for(const idOwner of ["owner",toUid])
        await setDoc(doc(db,"publicCollabs",idOwner,"items",id),{
          type:"collab",...oldTime,game:idOwner==="owner"?"Тестовая игра":"",
          partner:""
        });
    }
  });
  const owner=env.authenticatedContext("owner").firestore();
  const recipient=env.authenticatedContext("fox").firestore();
  await assertFails(updateDoc(doc(recipient,"collabLocks","lock0"),newTime));
  const tx=writeBatch(owner);
  for(const [i,toUid] of ["fox","reus"].entries()){
    const id="lock"+i;
    tx.update(doc(owner,"proposals",id),newTime);
    tx.update(doc(owner,"collabLocks",id),newTime);
    for(const idOwner of ["owner",toUid])
      tx.update(doc(owner,"publicCollabs",idOwner,"items",id),newTime);
  }
  await assertSucceeds(tx.commit());
  const lock=(await getDoc(doc(recipient,"collabLocks","lock0"))).data();
  assert.deepEqual({date:lock.date,start:lock.start,end:lock.end},newTime);
  const p=(await getDoc(doc(owner,"proposals","lock1"))).data();
  assert.equal(p.status,"accepted");
  assert.equal(p.date,newTime.date);
  assert.equal((await getDoc(doc(owner,"publicCollabs","reus","items","lock1"))).data().game,"");
  assert.equal((await getDoc(doc(owner,"publicCollabs","owner","items","lock1"))).data().game,"Тестовая игра");
 }finally{await env.cleanup();}
});
