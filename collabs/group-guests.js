// Guest-only roster for an already confirmed group collaboration.
// Reuses collabGuests collection and its existing organizer-owned Firestore Rules.
export function groupGuestRecordId(groupId) {
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(String(groupId||"")))
    throw new Error("Неверный ID групповой коллабы.");
  return "group_"+groupId;
}

export function parseGroupGuestNames(value) {
  const original=String(value||"").split(/\r?\n/).map(name=>name.trim()).filter(Boolean);
  if(original.length>15 || original.some(name=>name.length>40 || /[\r\n\t\x00-\x1f]/.test(name)))
    throw new Error("Не больше 15 гостей, ник каждого — до 40 символов.");
  const seen=new Set();
  return original.filter(name=>{
    const key=name.toLocaleLowerCase("ru-RU");
    if(seen.has(key))return false;
    seen.add(key);
    return true;
  });
}

export function groupGuestNames(group,records=[]) {
  if(!group?.id||!group?.organizerUid)return [];
  const guestRecord=records.find(record=>record.id===groupGuestRecordId(group.id) &&
    record.ownerUid===group.organizerUid &&
    record.date===group.date && record.start===group.start &&
    record.end===group.end && record.game===group.game);
  return Array.isArray(guestRecord?.guestNames)?guestRecord.guestNames.filter(x=>typeof x==="string"):[];
}

export function groupGuestRecord(group,guestNames,updatedAt) {
  if(!group?.organizerUid||!group.date||!group.start||!group.end||!group.game)
    throw new Error("Групповая коллаба не найдена.");
  return {
    ownerUid:group.organizerUid,
    date:group.date,start:group.start,end:group.end,game:group.game,
    guestNames,updatedAt
  };
}
