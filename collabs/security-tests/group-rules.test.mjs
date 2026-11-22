import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {initializeTestEnvironment,assertSucceeds,assertFails}
  from "@firebase/rules-unit-testing";
import {doc,setDoc,getDoc,updateDoc,writeBatch,serverTimestamp,arrayUnion,Timestamp}
  from "firebase/firestore";

// Uses ONLY local Firestore emulator. No real Firebase accounts, credentials or production data.
const projectId="demo-collab-room";
const slot={date:"2026-11-28",start:"20:00",end:"00:00"};
const groupData={
  organizerUid:"owner",organizerName:"Xwaran",
  inviteeUids:["fox","reus"],inviteeNames:["Fox","Reus"],
  game:"Far Far West",message:"Private group message",
  options:[slot],responses:{fox:[0],reus:[0]},
  status:"confirmed",chosenIndex:0,createdAt:Timestamp.now(),updatedAt:Timestamp.now()
};
const summary={organizerUid:"owner",organizerName:"Xwaran",
  participants:["Xwaran","Fox","Reus"],game:groupData.game,...slot,status:"confirmed"};
const publicMarker={...slot,type:"collab",game:"",partner:""};

test("rules: only a person can leave; their departure keeps the group, replacement requires consent", async()=>{
 const env=await initializeTestEnvironment({
   projectId,
   firestore:{host:"127.0.0.1",port:8089,
     rules:readFileSync(new URL("../firestore.rules",import.meta.url),"utf8")}
 });
 try{
   await env.withSecurityRulesDisabled(async context=>{
     const admin=context.firestore();
     for(const id of ["owner","fox","reus","new"])
       await setDoc(doc(admin,"allowedUsers",id),{enabled:true});
     await setDoc(doc(admin,"groupWishes","g1"),groupData);
     await setDoc(doc(admin,"groupCalendar","g1"),{
       organizerUid:"owner",participantsUids:["owner","fox","reus"],
       participants:["Xwaran","Fox","Reus"],game:groupData.game,...slot
     });
     for(const id of ["owner","fox","reus"]){
       await setDoc(doc(admin,"groupDiary",id,"items","g1"),summary);
       await setDoc(doc(admin,"publicGroupCollabs",id,"items","g1"),publicMarker);
     }
   });
   const owner=env.authenticatedContext("owner").firestore();
   const fox=env.authenticatedContext("fox").firestore();
   const reus=env.authenticatedContext("reus").firestore();
   const newcomer=env.authenticatedContext("new").firestore();

   await assertFails(updateDoc(doc(reus,"groupWishes","g1"),{
     status:"cancelled",updatedAt:serverTimestamp()
   }));

   const leaving=writeBatch(reus);
   leaving.update(doc(reus,"groupWishes","g1"),{
     departedUids:["reus"],updatedAt:serverTimestamp()
   });
   leaving.update(doc(reus,"groupCalendar","g1"),{
     participantsUids:["owner","fox"],participants:["Xwaran","Fox"]
   });
   for(const uid of ["owner","fox"])
     leaving.update(doc(reus,"groupDiary",uid,"items","g1"),{
       participants:["Xwaran","Fox"]
     });
   leaving.delete(doc(reus,"groupDiary","reus","items","g1"));
   leaving.delete(doc(reus,"publicGroupCollabs","reus","items","g1"));
   await assertSucceeds(leaving.commit());
   const afterLeave=(await getDoc(doc(owner,"groupCalendar","g1"))).data();
   assert.deepEqual(afterLeave.participantsUids,["owner","fox"]);
   assert.equal((await getDoc(doc(owner,"groupWishes","g1"))).data().status,"confirmed");

   await assertSucceeds(setDoc(doc(owner,"groupJoinRequests","jr1"),{
     groupId:"g1",organizerUid:"owner",toUid:"new",toName:"Новый",
     game:groupData.game,...slot,status:"pending",
     createdAt:serverTimestamp(),updatedAt:serverTimestamp()
   }));
   const join=writeBatch(newcomer);
   join.update(doc(newcomer,"groupJoinRequests","jr1"),{
     status:"accepted",updatedAt:serverTimestamp()
   });
   join.update(doc(newcomer,"groupWishes","g1"),{
     inviteeUids:arrayUnion("new"),inviteeNames:arrayUnion("Новый"),
     lastJoinId:"jr1",updatedAt:serverTimestamp()
   });
   join.update(doc(newcomer,"groupCalendar","g1"),{
     participantsUids:["owner","fox","new"],participants:["Xwaran","Fox","Новый"]
   });
   for(const uid of ["owner","fox"])
     join.update(doc(newcomer,"groupDiary",uid,"items","g1"),{
       participants:["Xwaran","Fox","Новый"]
     });
   join.set(doc(newcomer,"groupDiary","new","items","g1"),{
     organizerUid:"owner",organizerName:"Xwaran",
     participants:["Xwaran","Fox","Новый"],
     game:groupData.game,...slot,status:"confirmed"
   });
   join.set(doc(newcomer,"publicGroupCollabs","new","items","g1"),publicMarker);
   await assertSucceeds(join.commit());
   const afterJoin=(await getDoc(doc(fox,"groupCalendar","g1"))).data();
   assert.deepEqual(afterJoin.participantsUids,["owner","fox","new"]);
   assert.deepEqual(afterJoin.participants,["Xwaran","Fox","Новый"]);

   // Existing participants must still NOT be able to cancel the entire group.
   await assertFails(updateDoc(doc(fox,"groupWishes","g1"),{
     status:"cancelled",updatedAt:serverTimestamp()
   }));
 }finally{
   await env.cleanup();
 }
});
