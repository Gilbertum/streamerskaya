import test from "node:test";
import assert from "node:assert/strict";
import {toValue,fromValue,toFields,fromFields,decodeDoc,write} from "../src/store.js";
test("nested Firestore fields round-trip",()=>{
 const value={uid:"person123",enabled:true,answers:[0,2],date:new Date("2026-11-21T12:00:00.000Z"),
  nested:{guestNames:["Reus","HellFox"]},empty:null};
 const encoded=toFields(value),decoded=fromFields(encoded);
 assert.equal(decoded.uid,"person123");
 assert.deepEqual(decoded.answers,[0,2]);
 assert.equal(decoded.date,"2026-11-21T12:00:00.000Z");
 assert.deepEqual(decoded.nested.guestNames,["Reus","HellFox"]);
 assert.equal(decoded.empty,null);
});
test("document identity and updateTime are preserved",()=>{
 const d=decodeDoc({name:"projects/p/databases/(default)/documents/proposals/xyz",
  updateTime:"2026-11-12T12:00:00Z",fields:{status:{stringValue:"pending"}}});
 assert.equal(d.id,"xyz");
 assert.equal(d.status,"pending");
 assert.equal(d.__updateTime,"2026-11-12T12:00:00Z");
});
test("write helper restricts status changes to a mask",()=>{
 const w=write({FIREBASE_PROJECT_ID:"p"},"proposals/xyz",{status:"accepted",respondedAt:new Date()},{mask:["status","respondedAt"],exists:true});
 assert.deepEqual(w.updateMask.fieldPaths,["status","respondedAt"]);
 assert.equal(w.currentDocument.exists,true);
});
test("empty arrays encode cleanly",()=>{
 assert.deepEqual(fromValue(toValue([])),[]);
});
