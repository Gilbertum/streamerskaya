// Member-only birthday hints and grammatical availability labels.
// No birth year is collected or published on viewers' public schedules.
export const ADDRESS_FORMS=["neutral","male","female"];
const monthDays=[31,29,31,30,31,30,31,31,30,31,30,31];
export function validBirthday(month,day){
  if(month===0 && day===0)return true;
  return Number.isInteger(month)&&Number.isInteger(day)&&
    month>=1&&month<=12&&day>=1&&day<=monthDays[month-1];
}
export function formatBirthday(member){
  const month=member?.birthMonth,day=member?.birthDay;
  if(!validBirthday(month,day)||!month)return "";
  return new Date(Date.UTC(2000,month-1,day,12)).toLocaleDateString("ru-RU",{day:"numeric",month:"long",timeZone:"UTC"});
}
export function availabilityText(member,status){
  if(status==="maybe")return "Под вопросом";
  const form=ADDRESS_FORMS.includes(member?.addressForm)?member.addressForm:"neutral";
  const words={
    free:{male:"Свободен",female:"Свободна",neutral:"Свободное время"},
    busy:{male:"Занят",female:"Занята",neutral:"Время занято"},
    unavailable:{male:"Недоступен",female:"Недоступна",neutral:"Недоступно"}
  };
  return words[status]?.[form]||"Неизвестно";
}
export function nextBirthday(member,todayISO){
  const month=member?.birthMonth,day=member?.birthDay;
  if(!validBirthday(month,day)||!month||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(todayISO||""))return null;
  const [year,mm,dd]=todayISO.split("-").map(Number);
  const today=Date.UTC(year,mm-1,dd);
  if(!Number.isFinite(today))return null;
  for(let y=year;y<year+9;y++){
    const target=Date.UTC(y,month-1,day);
    const date=new Date(target);
    if(date.getUTCMonth()!==month-1||date.getUTCDate()!==day)continue;
    if(target>=today)return {date:date.toISOString().slice(0,10),days:Math.round((target-today)/86400000)};
  }
  return null;
}
export function upcomingBirthdays(members,todayISO,windowDays=7){
  return (Array.isArray(members)?members:[]).flatMap(member=>{
    const next=nextBirthday(member,todayISO);
    return next && next.days<=windowDays && next.days>=0?
      [{id:member.id,nick:String(member.nick||"Участник"),date:next.date,days:next.days}]:[];
  }).sort((a,b)=>a.days-b.days||a.nick.localeCompare(b.nick,"ru"));
}
