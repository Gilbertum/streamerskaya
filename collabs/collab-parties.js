// One organizer may invite multiple streamers to the SAME game and Moscow time.
// Each invite remains its own Firestore proposal + collabLock (existing security
// rules), but all accepted locks are displayed as a single shared collaboration.
// Nothing here grants access: collabLocks are already member-only.
const text = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");

export function sameCollabSession(a, b) {
  return !!a && !!b && a.fromUid === b.fromUid &&
    a.date === b.date && a.start === b.start && a.end === b.end &&
    text(a.game) === text(b.game);
}

export function canJoinExistingSession(lock, organizerUid, request) {
  // Only the original ORGANIZER may reuse their reserved window; a recipient
  // with an unrelated booking must still be marked busy.
  return !!organizerUid && lock.fromUid === organizerUid &&
    sameCollabSession(lock, { ...request, fromUid: organizerUid });
}

export function partySessionId(party) {
  const s=[party.fromUid||party.organizerUid,party.date,party.start,party.end,
    String(party.game||"").trim().toLocaleLowerCase("ru-RU")].join("|");
  let n=2166136261;
  for(let i=0;i<s.length;i++)n=Math.imul(n^s.charCodeAt(i),16777619);
  return "session_"+(n>>>0).toString(16).padStart(8,"0");
}
export function collabParties(locks, nameOf = () => "", manualGuests = []) {
  const groups = [];
  for (const lock of locks) {
    if (!lock?.fromUid || !lock?.toUid || !lock?.date) continue;
    let party = groups.find(g => sameCollabSession(g, lock));
    if (!party) {
      party = {
        id: lock.id, fromUid: lock.fromUid, toUid: lock.toUid,
        date: lock.date, start: lock.start, end: lock.end, game: lock.game,
        fromName: lock.fromName, toName: lock.toName, type: "collab",
        organizerUid: lock.fromUid, locks: [], participantUids: [],
        participants: []
      };
      groups.push(party);
    }
    party.locks.push(lock);
  }
  for (const party of groups) {
    // Stable roster as people accept; existing attendees update via onSnapshot.
    const ids = [...new Set([party.fromUid, ...party.locks.map(lock => lock.toUid)])];
    party.participantUids = ids;
    party.participants = ids.map(uid => {
      const source = party.locks.find(lock => lock.toUid === uid || lock.fromUid === uid);
      const fallback = uid === party.fromUid ? source?.fromName : source?.toName;
      return String(nameOf(uid) || fallback || "Стример");
    });
    const guestRecord=manualGuests.find(g=>sameCollabSession(
      {fromUid:g.ownerUid,date:g.date,start:g.start,end:g.end,game:g.game},party));
    party.manualGuests=Array.isArray(guestRecord?.guestNames)?guestRecord.guestNames:[];
    party.participants.push(...party.manualGuests.map(name=>name+" (гость)"));
    party.locks.sort((a,b) => a.id.localeCompare(b.id));
    // Deterministic representative, even if Firestore snapshots arrive reordered.
    party.id = party.locks[0].id;
  }
  return groups;
}

export function partyForLock(locks, lockId, nameOf) {
  return collabParties(locks, nameOf).find(p => p.locks.some(l => l.id === lockId)) || null;
}
