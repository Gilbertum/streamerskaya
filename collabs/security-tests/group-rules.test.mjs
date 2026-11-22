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

   // A manual collaboration can become a genuine group after invitees consent.
   const manualGame="Ручная коллаба";
   await env.withSecurityRulesDisabled(async context=>{
     await setDoc(doc(context.firestore(),"slots","manual1"),{
       ownerUid:"owner",...slot,type:"collab",title:manualGame,guestNick:"Nero, Лиса",
       showGame:false,showGuest:false,public:true,details:"",updatedAt:Timestamp.now()
     });
   });
   const newWish=writeBatch(owner);
   newWish.set(doc(owner,"groupWishes","g2"),{
     organizerUid:"owner",organizerName:"Xwaran",
     inviteeUids:["new"],inviteeNames:["Новый"],game:manualGame,
     message:"Пойдём играть",options:[slot],responses:{},
     chosenIndex:-1,status:"collecting",sourceSlotId:"manual1",
     createdAt:serverTimestamp(),updatedAt:serverTimestamp()
   });
   for(const id of ["owner","new"])
     newWish.set(doc(owner,"groupDiary",id,"items","g2"),{
       organizerUid:"owner",organizerName:"Xwaran",participants:["Xwaran","Новый"],
       game:manualGame,...slot,status:"collecting"
     });
   await assertSucceeds(newWish.commit());
   await assertSucceeds(updateDoc(doc(newcomer,"groupWishes","g2"),{
     responses:{new:[0]},updatedAt:serverTimestamp()
   }));
   const convert=writeBatch(owner);
   convert.update(doc(owner,"groupWishes","g2"),{
     status:"confirmed",chosenIndex:0,updatedAt:serverTimestamp()
   });
   convert.set(doc(owner,"groupCalendar","g2"),{
     organizerUid:"owner",participantsUids:["owner","new"],
     participants:["Xwaran","Новый"],game:manualGame,...slot
   });
   for(const id of ["owner","new"]){
     convert.update(doc(owner,"groupDiary",id,"items","g2"),{
       status:"confirmed",participants:["Xwaran","Новый"],...slot
     });
     convert.set(doc(owner,"publicGroupCollabs",id,"items","g2"),publicMarker);
   }
   convert.set(doc(owner,"collabGuests","group_g2"),{
     ownerUid:"owner",...slot,game:manualGame,
     guestNames:["Nero","Лиса"],updatedAt:serverTimestamp()
   });
   convert.delete(doc(owner,"slots","manual1"));
   await assertSucceeds(convert.commit());
   assert.equal((await getDoc(doc(owner,"slots","manual1"))).exists(),false);
   assert.deepEqual((await getDoc(doc(owner,"collabGuests","group_g2"))).data().guestNames,
     ["Nero","Лиса"]);
   assert.deepEqual((await getDoc(doc(owner,"groupCalendar","g2"))).data().participantsUids,
     ["owner","new"]);

   // The same one-person refusal must also work BEFORE the organizer chooses a date.
   await env.withSecurityRulesDisabled(async ctx=>{
     const admin=ctx.firestore();
     await setDoc(doc(admin,"groupWishes","g3"),{
       ...groupData,status:"collecting",chosenIndex:-1,responses:{}
     });
     for(const id of ["owner","fox","reus"]){
       await setDoc(doc(admin,"groupDiary",id,"items","g3"),{
         ...summary,status:"collecting"
       });
     }
   });
   const beforeFinal=writeBatch(reus);
   beforeFinal.update(doc(reus,"groupWishes","g3"),{
     departedUids:["reus"],updatedAt:serverTimestamp()
   });
   beforeFinal.update(doc(reus,"groupDiary","owner","items","g3"),{
     participants:["Xwaran","Fox"]
   });
   beforeFinal.update(doc(reus,"groupDiary","fox","items","g3"),{
     participants:["Xwaran","Fox"]
   });
   beforeFinal.delete(doc(reus,"groupDiary","reus","items","g3"));
   await assertSucceeds(beforeFinal.commit());
   assert.equal((await getDoc(doc(owner,"groupWishes","g3"))).data().status,
     "collecting");
   assert.equal((await getDoc(doc(owner,"groupDiary","reus","items","g3"))).exists(),
     false);
 }finally{
   await env.cleanup();
 }
});
