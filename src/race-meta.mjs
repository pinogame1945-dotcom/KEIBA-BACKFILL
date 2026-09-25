function cleanMeta(value){
  return String(value??"").replace(/\s+/g," ").trim();
}

export const RACE_META_CONTRACT_VERSION=1;
export const RACE_META_SAFE_RACE_PACK_VERSION=4;

export function raceMetaFields(value){
  const meta=cleanMeta(value);
  return {
    course_raw:meta||null,
    conditions_raw:meta||null,
    race_meta_raw:meta||null,
  };
}

export function selectRaceMeta($){
  const legacyIntro=cleanMeta($(".data_intro").first().text());
  if(legacyIntro)return legacyIntro;

  const legacyHead=cleanMeta($(".race_head").first().text());
  if(legacyHead)return legacyHead;

  const liveMeta=[
    cleanMeta($(".RaceData01").first().text()),
    cleanMeta($(".RaceData02").first().text()),
  ].filter(Boolean).join(" ");
  if(liveMeta)return liveMeta;

  return cleanMeta($.root().text());
}

export function classifyRaceDiscipline(meta,raceName=null){
  const text=cleanMeta(meta);
  const name=cleanMeta(raceName);
  if(name.includes("障害"))return "OBSTACLE";
  if(/(?:障害|障)\s*(?:芝|ダート|ダ)?\s*\d{3,4}\s*m/u.test(text)){
    return "OBSTACLE";
  }
  return "FLAT";
}
