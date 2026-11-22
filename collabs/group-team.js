// Active group membership, safe candidate lookup and conversion of a manual collab.
// The original invitee list remains an audit trail: departedUids controls active membership.
export function departed(group){return Array.isArray(group?.departedUids)?group.departedUids:[];}
export function activeInvitees(group){
  const gone=new Set(departed(group));
  return (group.inviteeUids||[]).filter(uid=>!gone.has(uid));
}
export function activeGroupMembers(group){
  const gone=new Set(departed(group));
  const ids=[group.organizerUid],names=[group.organizerName];
  (group.inviteeUids||[]).forEach((id,index)=>{
    if(!gone.has(id)){ids.push(id);names.push(group.inviteeNames?.[index]||"Участник");}
  });
  return {ids,names};
}
export function groupAttendance(group,uid){
  if(uid===group.organizerUid)return "organizer";
  if(departed(group).includes(uid))return "departed";
  return (group.inviteeUids||[]).includes(uid)?"active":"outsider";
}
export function groupCandidateList(group,members,availability){
  const involved=new Set([group.organizerUid,...(group.inviteeUids||[])]);
  const slots=group.status==="confirmed"?[group.options?.[group.chosenIndex]]:group.options||[];
  if(!slots.length)return [];
  return (members||[]).filter(m=>m.id&&!involved.has(m.id)).map(m=>{
    const statuses=slots.filter(Boolean).map(slot=>availability(m.id,slot));
    return {...m,availability:statuses.includes("free")?"free":
      statuses.includes("maybe")?"maybe":"busy"};
  }).filter(m=>m.availability==="free"||m.availability==="maybe")
    .sort((a,b)=>(a.availability==="free"?0:1)-(b.availability==="free"?0:1)||
      String(a.nick).localeCompare(String(b.nick),"ru"));
}
export function manualGuestNames(text,registeredNames=[]){
  const known=new Set(registeredNames.map(n=>String(n||"").trim().toLocaleLowerCase("ru-RU")));
  const guests=[...new Set(String(text||"").split(/[,;\n]+/).map(n=>n.trim())
    .filter(Boolean).filter(n=>!known.has(n.toLocaleLowerCase("ru-RU"))))];
  if(guests.length>15||guests.some(n=>n.length>40))
    throw new Error("Не больше 15 гостей, каждый ник — до 40 символов. Исправь ручной список перед подтверждением.");
  return guests;
}
export function matchingManualSlot(slot,group,chosen){
  return !!slot && !!group && slot.id===group.sourceSlotId &&
    slot.ownerUid===group.organizerUid && slot.type==="collab" &&
    String(slot.title||"").trim()===String(group.game||"").trim() &&
    slot.date===chosen.date && slot.start===chosen.start && slot.end===chosen.end;
}
