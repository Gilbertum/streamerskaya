// Opt-in public roster snapshots. Only publicSchedules events carry these projections;
// private groupCalendar/collabGuests are NEVER read by anonymous viewers.
export const ROSTER_TYPE="collab-roster";
const unique=names=>[...new Set(names.map(n=>String(n||"").trim()).filter(Boolean))];
export const rosterKey=(kind,id)=>kind+":"+id;
export function rosterPreference(events,kind,id){
  return (Array.isArray(events)?events:[]).find(e=>
    e?.type===ROSTER_TYPE && e.kind===kind && e.sourceId===id) || null;
}
export function projectRoster(preference,{uid,groups=[],parties=[],guestRecords=[],members=[]}){
  if(!preference || preference.type!==ROSTER_TYPE)return null;
  const showGame=preference.showGame===true,showParticipants=preference.showParticipants===true;
  if(!showGame&&!showParticipants)return null;
  const {kind,sourceId}=preference;
  let event,otherNames=[],sourceIds=[];
  if(kind==="group"){
    event=groups.find(g=>g.id===sourceId && g.participantsUids?.includes(uid));
    if(!event)return null;
    otherNames=(event.participants||[]).filter((_,i)=>event.participantsUids?.[i]!==uid);
    const record=guestRecords.find(r=>r.id==="group_"+event.id &&
      r.ownerUid===event.organizerUid && r.date===event.date &&
      r.start===event.start && r.end===event.end && r.game===event.game);
    if(record && Array.isArray(record.guestNames))otherNames.push(...record.guestNames);
  }else if(kind==="party"){
    event=parties.find(p=>p.publicRosterId===sourceId && p.participantUids?.includes(uid));
    if(!event)return null;
    otherNames=(event.participantUids||[]).filter(id=>id!==uid)
      .map(id=>members.find(m=>m.id===id)?.nick ||
        event.participants?.[(event.participantUids||[]).indexOf(id)] || "");
    otherNames.push(...(event.manualGuests||[]));
    sourceIds=(event.locks||[]).map(l=>l.id).filter(Boolean);
    if(!sourceIds.length)return null;
  }else return null;
  return {type:ROSTER_TYPE,kind,sourceId,sourceIds,
    date:event.date,start:event.start,end:event.end,
    game:showGame?String(event.game||"").slice(0,90):"",
    partner:showParticipants?unique(otherNames).join(", "):"",
    showGame,showParticipants};
}
export function rebuildRosterProjections(oldEvents,context){
  const rows=(Array.isArray(oldEvents)?oldEvents:[]).filter(e=>e?.type===ROSTER_TYPE);
  return rows.map(row=>projectRoster(row,context)||row);
}
export function publicCollabEvents({slots=[],direct=[],groups=[],projections=[]}){
  const extra=projections.filter(p=>p?.type===ROSTER_TYPE);
  const used=new Set(),events=[];
  for(const group of groups){
    const overlay=rosterPreference(extra,"group",group.id);
    // The stable group ID, not the time, owns the opt-in. A reschedule only
    // changes the public marker time; the owner's privacy choice survives.
    const match=!!overlay;
    events.push({...group,type:"collab",
      game:match?overlay.game:(group.game||""),
      partner:match?overlay.partner:(group.partner||"")});
  }
  for(const projected of extra.filter(p=>p.kind==="party")){
    const found=direct.filter(e=>projected.sourceIds?.includes(e.id) &&
      e.date===projected.date && e.start===projected.start && e.end===projected.end);
    if(!found.length)continue; // Do not expose an orphaned public schedule entry.
    for(const entry of found)used.add(entry.id);
    events.push({type:"collab",date:projected.date,
      start:projected.start,end:projected.end,
      game:projected.game,partner:projected.partner});
  }
  return {slots,events,remainingDirect:direct.filter(e=>!used.has(e.id))};
}
