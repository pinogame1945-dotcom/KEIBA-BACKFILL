const HORSE_ID_ALIASES=new Map([
  // 2008-04-19 Nakayama Grand Jump overseas invitees.
  // Legacy race-result links expose temporary ids, while netkeiba DB uses
  // canonical horse ids for the same named horses.
  ["000a011226","2000190015"], // Alarm Call / アラームコール
  ["000a011220","2000190016"], // Gliding / グライディング
]);

export function canonicalNetkeibaHorseId(value){
  const raw=String(value??"").trim();
  if(!raw)return null;
  return HORSE_ID_ALIASES.get(raw)??raw;
}

export function extractNetkeibaHorseId(href){
  const raw=String(href??"").match(/\/horse\/([0-9A-Za-z]+)/)?.[1]??null;
  return raw?canonicalNetkeibaHorseId(raw):null;
}

export function knownHorseIdAlias(value){
  const raw=String(value??"").trim();
  const canonical=HORSE_ID_ALIASES.get(raw)??null;
  return canonical?{source_id:raw,canonical_id:canonical}:null;
}
