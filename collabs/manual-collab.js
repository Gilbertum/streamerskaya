// Single source of truth for public manual-collab visibility.
// Only the owner explicitly authorizes disclosing a game or guest nickname.
export function publicSlotEvent(e) {
  const base = {date:e.date,start:e.start,end:e.end,type:e.type};
  if (e.type === "collab") {
    return {...base,
      game:e.showGame===true ? String(e.title||"").trim().slice(0,90) : "",
      partner:e.showGuest===true ? String(e.guestNick||"").trim().slice(0,80) : ""};
  }
  return {...base,title:e.type === "off" ? "" : String(e.title||"").slice(0,90)};
}
export function manualCollabTwitchTitle(e) {
  const game=e.showGame===true ? String(e.title||"").trim().slice(0,90) : "";
  const guest=e.showGuest===true ? String(e.guestNick||"").trim().slice(0,80) : "";
  if(game && guest)return "Коллаба: "+game+" — с "+guest;
  if(game)return "Коллаба: "+game;
  if(guest)return "Коллаба с "+guest;
  return "Коллаба";
}
