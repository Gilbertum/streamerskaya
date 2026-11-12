// Firestore REST adapter for Cloudflare Workers Free, no Firebase Admin SDK.
// Google service-account credentials exist only in Worker encrypted secrets.
let cachedToken = null;
let keyPromise = null;
const enc = new TextEncoder();
export const base = env => "projects/" + env.FIREBASE_PROJECT_ID + "/databases/(default)/documents";
const pathName=(env,path)=>base(env)+"/"+path.split("/").map(encodeURIComponent).join("/");
const b64url=bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const utf64=value=>b64url(enc.encode(JSON.stringify(value)));
export function toValue(value){
  if(value===null||value===undefined)return {nullValue:null};
  if(value instanceof Date)return {timestampValue:value.toISOString()};
  if(Array.isArray(value))return {arrayValue:{values:value.map(toValue)}};
  switch(typeof value){
    case "string":return {stringValue:value};
    case "boolean":return {booleanValue:value};
    case "number":return Number.isInteger(value)?{integerValue:String(value)}:{doubleValue:value};
    case "object":return {mapValue:{fields:toFields(value)}};
    default:throw new Error("Unsupported Firestore type");
  }
}
export function toFields(object){return Object.fromEntries(Object.entries(object).map(([k,v])=>[k,toValue(v)]));}
export function fromValue(v){
  if(!v)return null;
  if("stringValue" in v)return v.stringValue;
  if("integerValue" in v)return Number(v.integerValue);
  if("doubleValue" in v)return v.doubleValue;
  if("booleanValue" in v)return v.booleanValue;
  if("timestampValue" in v)return v.timestampValue;
  if("nullValue" in v)return null;
  if("arrayValue" in v)return (v.arrayValue.values||[]).map(fromValue);
  if("mapValue" in v)return fromFields(v.mapValue.fields||{});
  return null;
}
export function fromFields(fields){return Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,fromValue(v)]));}
export function decodeDoc(document){
  if(!document)return null;
  return {...fromFields(document.fields||{}),id:document.name.split("/").pop(),__updateTime:document.updateTime};
}
async function bearer(env){
  if(cachedToken && cachedToken.expires > Date.now()+180000)return cachedToken.token;
  const service=JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON||"null");
  if(!service || service.project_id!==env.FIREBASE_PROJECT_ID ||
    !service.private_key || !service.client_email)throw new Error("Service account secret missing or wrong project");
  if(!keyPromise){
    const binary=atob(service.private_key.replace(/-----[^-]+-----/g,"").replace(/\s+/g,""));
    const key=Uint8Array.from(binary,c=>c.charCodeAt(0));
    keyPromise=crypto.subtle.importKey("pkcs8",key,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);
  }
  const seconds=Math.floor(Date.now()/1000);
  const head=utf64({alg:"RS256",typ:"JWT"});
  const body=utf64({iss:service.client_email,scope:"https://www.googleapis.com/auth/datastore",
    aud:"https://oauth2.googleapis.com/token",iat:seconds,exp:seconds+3300});
  const signed=head+"."+body;
  const signature=b64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5",await keyPromise,enc.encode(signed))));
  const response=await fetch("https://oauth2.googleapis.com/token",{
    method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:signed+"."+signature})
  });
  if(!response.ok)throw new Error("Unable to authorize Firestore service account ("+response.status+")");
  const json=await response.json();
  cachedToken={token:json.access_token,expires:Date.now()+Math.min(3300,Number(json.expires_in||3300))*1000};
  return cachedToken.token;
}
export class StoreError extends Error {
  constructor(status,desc){super("Firestore HTTP "+status+(desc?": "+String(desc).slice(0,160):""));this.status=status;}
}
async function call(env,suffix,method="GET",body){
  const response=await fetch("https://firestore.googleapis.com/v1/"+suffix,{
    method,headers:{"Authorization":"Bearer "+await bearer(env),"Content-Type":"application/json"},
    ...(body!==undefined?{body:JSON.stringify(body)}:{})
  });
  if(!response.ok){
    if(response.status===404)return null;
    let detail="";try{detail=(await response.json()).error?.status||"";}catch{}
    throw new StoreError(response.status,detail);
  }
  if(response.status===204)return {};
  return response.json();
}
export const get=async(env,path,transaction)=>{
  const q=transaction?"?transaction="+encodeURIComponent(transaction):"";
  return decodeDoc(await call(env,pathName(env,path)+q));
};
export const query=async(env,collection,field,value,{limit=150,transaction}={})=>{
  const req={structuredQuery:{from:[{collectionId:collection}],where:{
    fieldFilter:{field:{fieldPath:field},op:"EQUAL",value:toValue(value)}
  },limit}};
  if(transaction)req.transaction=transaction;
  const json=await call(env,base(env)+":runQuery","POST",req);
  return (json||[]).filter(x=>x.document).map(x=>decodeDoc(x.document));
};
export const queryAll=async(env,collection,{limit=150,transaction}={})=>{
  const req={structuredQuery:{from:[{collectionId:collection}],limit}};
  if(transaction)req.transaction=transaction;
  const json=await call(env,base(env)+":runQuery","POST",req);
  return (json||[]).filter(x=>x.document).map(x=>decodeDoc(x.document));
};
export async function patch(env,path,data,{updateTime,createOnly=false}={}){
  const name=pathName(env,path),mask=new URLSearchParams();
  for(const key of Object.keys(data))mask.append("updateMask.fieldPaths",key);
  if(updateTime)mask.set("currentDocument.updateTime",updateTime);
  if(createOnly)mask.set("currentDocument.exists","false");
  return call(env,name+"?"+mask.toString(),"PATCH",{name,fields:toFields(data)});
}
export async function create(env,path,data){
  const parts=path.split("/"),documentId=parts.pop(),collection=parts.join("/");
  return call(env,pathName(env,collection)+"?documentId="+encodeURIComponent(documentId),
    "POST",{fields:toFields(data)});
}
export async function del(env,path){
  return call(env,pathName(env,path),"DELETE");
}
export async function begin(env){
  const data=await call(env,base(env)+":beginTransaction","POST",{options:{readWrite:{}}});
  return data.transaction;
}
export const write=(env,path,fields,{mask,exists,updateTime}={})=>({
  update:{name:pathName(env,path),fields:toFields(fields)},
  ...(mask?{updateMask:{fieldPaths:mask}}:{}),
  ...(exists!==undefined?{currentDocument:{exists}}:updateTime?{currentDocument:{updateTime}}:{})
});
export const remove=(env,path)=>({delete:pathName(env,path)});
export const commit=(env,writes,transaction)=>call(env,base(env)+":commit","POST",{
  writes,...(transaction?{transaction}:{})
});
export async function verifyUser(env,idToken){
  if(!idToken||idToken.length>6000)throw new Error("Firebase authentication required");
  const res=await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key="+
    encodeURIComponent(env.FIREBASE_API_KEY),{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({idToken})
  });
  if(!res.ok)throw new Error("Firebase session is invalid or expired");
  const json=await res.json(),user=json.users?.[0];
  if(!user?.localId||user.disabled)throw new Error("Firebase session is disabled");
  const permit=await get(env,"allowedUsers/"+user.localId);
  if(permit?.enabled!==true)throw new Error("You are not allowed in Collab Room");
  return user.localId;
}
