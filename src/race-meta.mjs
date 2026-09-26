export const RACE_META_PARSER_VERSION=2;

const COURSE_LAYOUTS=new Set(["INNER","OUTER","NORMAL","UNKNOWN"]);
const RACE_CLASSES=new Set(["NEWCOMER","MAIDEN","ONE_WIN","TWO_WIN","THREE_WIN","OPEN","UNKNOWN"]);
const GRADES=new Set(["G1","G2","G3","JPN1","JPN2","JPN3","L","NONE","UNKNOWN"]);
const AGE_TYPES=new Set([
  "TWO_YEAR_ONLY","THREE_YEAR_ONLY","FOUR_YEAR_ONLY",
  "TWO_YEAR_PLUS","THREE_YEAR_PLUS","FOUR_YEAR_PLUS","OTHER","UNKNOWN",
]);
const SEX_CONDITIONS=new Set(["ANY","FEMALE_ONLY","MALE_ONLY","OTHER","UNKNOWN"]);
const WEIGHT_RULES=new Set(["WEIGHT_FOR_AGE","SET_WEIGHT","SPECIAL_WEIGHT","HANDICAP","UNKNOWN"]);

function cleanMeta(value){
  return String(value??"").replace(/\\s+/g," ").trim();
}

function normalizedText(value){
  return cleanMeta(value).normalize("NFKC");
}

function nullIfEmpty(value){
  const text=cleanMeta(value);
  return text||null;
}

export function extractCourseMetaRaw(value){
  const text=cleanMeta(value);
  if(!text)return null;
  const direct=text.match(
    /(?:障害?\\s*)?(?:芝|ダート|ダ)(?:\\s*(?:左|右|直線))?(?:\\s*(?:内|外)(?:回り)?)?(?:\\s*\\d+\\s*周)?\\s*\\d{3,4}\\s*m/u
  );
  if(direct)return cleanMeta(direct[0]);
  const chunk=text.split(/\\s*\\/\\s*/).find(part=>/\\d{3,4}\\s*m/i.test(part));
  return nullIfEmpty(chunk);
}

export function extractRaceConditionRaw(value){
  const text=cleanMeta(value);
  if(!text)return null;

  const afterMeeting=text.match(
    /(?:19|20)\\d{2}年\\s*\\d{1,2}月\\s*\\d{1,2}日\\s+\\d+回\\S+?\\d+日目\\s*(.+)$/u
  )?.[1];
  let condition=afterMeeting?cleanMeta(afterMeeting):"";

  if(!condition){
    const normalized=normalizedText(text);
    const index=normalized.search(/(?:障害\\s*)?[2-4]歳(?:以上)?/u);
    if(index>=0)condition=normalized.slice(index);
  }

  if(!condition)return null;
  condition=condition.split(/(?:結果\\/払戻|掲示板|着\\s*順)/u)[0];
  return nullIfEmpty(condition);
}

export function selectRaceMetaParts($){
  const liveCourse=cleanMeta($(".RaceData01").first().text());
  const liveCondition=cleanMeta($(".RaceData02").first().text());
  if(liveCourse||liveCondition){
    const raceMetaRaw=[liveCourse,liveCondition].filter(Boolean).join(" ");
    return {
      course_meta_raw:extractCourseMetaRaw(liveCourse||raceMetaRaw),
      race_condition_raw:nullIfEmpty(liveCondition)||extractRaceConditionRaw(raceMetaRaw),
      race_meta_raw:nullIfEmpty(raceMetaRaw),
    };
  }

  const legacyIntro=cleanMeta($(".data_intro").first().text());
  const legacyHead=cleanMeta($(".race_head").first().text());
  const fallback=legacyIntro||legacyHead||cleanMeta($.root().text());
  return {
    course_meta_raw:extractCourseMetaRaw(fallback),
    race_condition_raw:extractRaceConditionRaw(fallback),
    race_meta_raw:nullIfEmpty(fallback),
  };
}

export function selectRaceMeta($){
  return selectRaceMetaParts($).race_meta_raw??"";
}

export function classifyRaceDiscipline(meta,raceName=null){
  const text=cleanMeta(meta);
  const name=cleanMeta(raceName);
  if(name.includes("障害"))return "OBSTACLE";
  if(/(?:障害|障)\\s*(?:芝|ダート|ダ)?\\s*\\d{3,4}\\s*m/u.test(text)){
    return "OBSTACLE";
  }
  return "FLAT";
}

function normalizedRaceClass(condition){
  const text=normalizedText(condition);
  if(!text)return "UNKNOWN";
  if(text.includes("新馬"))return "NEWCOMER";
  if(text.includes("未勝利"))return "MAIDEN";
  if(/1勝クラス/u.test(text)||/500万下/u.test(text))return "ONE_WIN";
  if(/2勝クラス/u.test(text)||/(?:900|1000)万下/u.test(text))return "TWO_WIN";
  if(/3勝クラス/u.test(text)||/1600万下/u.test(text))return "THREE_WIN";
  if(text.includes("オープン"))return "OPEN";
  return "UNKNOWN";
}

function rawRaceClass(condition){
  const text=normalizedText(condition);
  if(!text)return null;
  const match=text.match(
    /(?:障害\\s*)?(?:[2-4]歳(?:以上)?\\s*)?(?:新馬|未勝利|[123]勝クラス|500万下|900万下|1000万下|1600万下|オープン)/u
  );
  return match?cleanMeta(match[0]):null;
}

function normalizedGrade(raceName,condition,raceMetaRaw){
  const source=normalizedText([raceName,condition,raceMetaRaw].filter(Boolean).join(" ")).toUpperCase().replace(/\\s+/g,"");
  if(!source)return "UNKNOWN";
  if(source.includes("JPNIII")||source.includes("JPN3"))return "JPN3";
  if(source.includes("JPNII")||source.includes("JPN2"))return "JPN2";
  if(source.includes("JPNI")||source.includes("JPN1"))return "JPN1";
  if(source.includes("GIII")||source.includes("G3"))return "G3";
  if(source.includes("GII")||source.includes("G2"))return "G2";
  if(source.includes("GI")||source.includes("G1"))return "G1";
  if(source.includes("(L)")||source.includes("リステッド"))return "L";
  return "NONE";
}

function ageFields(condition){
  const text=normalizedText(condition);
  if(!text)return {age_condition_raw:null,age_min:null,age_max:null,age_condition_type:"UNKNOWN"};
  const plus=text.match(/([2-4])歳以上/u);
  if(plus){
    const age=Number(plus[1]);
    return {
      age_condition_raw:plus[0],
      age_min:age,
      age_max:null,
      age_condition_type:age===2?"TWO_YEAR_PLUS":age===3?"THREE_YEAR_PLUS":"FOUR_YEAR_PLUS",
    };
  }
  const only=text.match(/([2-4])歳/u);
  if(only){
    const age=Number(only[1]);
    return {
      age_condition_raw:only[0],
      age_min:age,
      age_max:age,
      age_condition_type:age===2?"TWO_YEAR_ONLY":age===3?"THREE_YEAR_ONLY":"FOUR_YEAR_ONLY",
    };
  }
  return {age_condition_raw:null,age_min:null,age_max:null,age_condition_type:"UNKNOWN"};
}

function sexFields(condition){
  const raw=cleanMeta(condition);
  if(!raw)return {sex_condition_raw:null,sex_condition:"UNKNOWN"};
  const text=normalizedText(raw);
  if(/牝馬限定/u.test(text)){
    return {sex_condition_raw:"牝馬限定",sex_condition:"FEMALE_ONLY"};
  }
  if(/(?:^|[\\s　])牝(?=$|[\\s　(\\[])/u.test(text)){
    return {sex_condition_raw:"牝",sex_condition:"FEMALE_ONLY"};
  }
  if(/牡馬限定/u.test(text)){
    return {sex_condition_raw:"牡馬限定",sex_condition:"MALE_ONLY"};
  }
  if(text.includes("牡")&&!text.includes("牝")){
    return {sex_condition_raw:"牡",sex_condition:"MALE_ONLY"};
  }
  return {sex_condition_raw:null,sex_condition:"ANY"};
}

function weightFields(condition){
  const text=normalizedText(condition);
  if(!text)return {weight_rule_raw:null,weight_rule:"UNKNOWN"};
  if(text.includes("ハンデ"))return {weight_rule_raw:"ハンデ",weight_rule:"HANDICAP"};
  if(text.includes("別定"))return {weight_rule_raw:"別定",weight_rule:"SPECIAL_WEIGHT"};
  if(text.includes("定量"))return {weight_rule_raw:"定量",weight_rule:"SET_WEIGHT"};
  if(text.includes("馬齢"))return {weight_rule_raw:"馬齢",weight_rule:"WEIGHT_FOR_AGE"};
  return {weight_rule_raw:null,weight_rule:"UNKNOWN"};
}

function restrictionFlag(condition,pattern){
  if(!cleanMeta(condition))return null;
  return pattern.test(normalizedText(condition));
}

export function normalizeRaceMeta({
  course_meta_raw:courseMetaRaw=null,
  race_condition_raw:raceConditionRaw=null,
  race_meta_raw:raceMetaRaw=null,
  race_name:raceName=null,
}={}){
  const course=cleanMeta(courseMetaRaw);
  const condition=cleanMeta(raceConditionRaw);
  const courseLayout=!course
    ?"UNKNOWN"
    :course.includes("外")
      ?"OUTER"
      :course.includes("内")
        ?"INNER"
        :"NORMAL";
  const lapsMatch=normalizedText(course).match(/(\\d+)\\s*周/u);
  const courseLaps=lapsMatch?Number(lapsMatch[1]):null;
  const age=ageFields(condition);
  const sex=sexFields(condition);
  const weight=weightFields(condition);

  return {
    course_layout:courseLayout,
    course_laps:courseLaps,
    course_meta_raw:nullIfEmpty(courseMetaRaw),
    race_class_raw:rawRaceClass(condition),
    race_class_normalized:normalizedRaceClass(condition),
    grade:normalizedGrade(raceName,condition,raceMetaRaw),
    ...age,
    ...sex,
    ...weight,
    mixed:restrictionFlag(condition,/\\(混\\)/u),
    international:restrictionFlag(condition,/\\(国際\\)/u),
    special_designated:restrictionFlag(condition,/\\(特指\\)/u),
    designated:restrictionFlag(condition,/\\[指\\]/u),
    race_condition_raw:nullIfEmpty(raceConditionRaw),
    race_meta_raw:nullIfEmpty(raceMetaRaw),
  };
}

export function validateRaceMetaFields(race){
  if(!race||typeof race!=="object")throw new Error("race meta requires race object");
  if(!COURSE_LAYOUTS.has(String(race.course_layout??"UNKNOWN"))){
    throw new Error("invalid course_layout: "+String(race.course_layout));
  }
  if(!RACE_CLASSES.has(String(race.race_class_normalized??"UNKNOWN"))){
    throw new Error("invalid race_class_normalized: "+String(race.race_class_normalized));
  }
  if(!GRADES.has(String(race.grade??"UNKNOWN"))){
    throw new Error("invalid grade: "+String(race.grade));
  }
  if(!AGE_TYPES.has(String(race.age_condition_type??"UNKNOWN"))){
    throw new Error("invalid age_condition_type: "+String(race.age_condition_type));
  }
  if(!SEX_CONDITIONS.has(String(race.sex_condition??"UNKNOWN"))){
    throw new Error("invalid sex_condition: "+String(race.sex_condition));
  }
  if(!WEIGHT_RULES.has(String(race.weight_rule??"UNKNOWN"))){
    throw new Error("invalid weight_rule: "+String(race.weight_rule));
  }

  const laps=race.course_laps;
  if(laps!=null&&(!Number.isInteger(Number(laps))||Number(laps)<=0)){
    throw new Error("invalid course_laps: "+String(laps));
  }
  const min=race.age_min;
  const max=race.age_max;
  if(min!=null&&(!Number.isInteger(Number(min))||Number(min)<=0)){
    throw new Error("invalid age_min: "+String(min));
  }
  if(max!=null&&(!Number.isInteger(Number(max))||Number(max)<=0)){
    throw new Error("invalid age_max: "+String(max));
  }
  if(min!=null&&max!=null&&Number(min)>Number(max)){
    throw new Error("age_min > age_max");
  }
  for(const key of ["mixed","international","special_designated","designated"]){
    if(race[key]!=null&&typeof race[key]!=="boolean"){
      throw new Error("invalid "+key+": "+String(race[key]));
    }
  }
  return true;
}

function metric(total,known){
  return {
    known,
    unknown:Math.max(0,total-known),
    coverage_pct:total?Number((known/total*100).toFixed(1)):100,
  };
}

export function summarizeRaceMetaCoverage(rows){
  const races=(rows??[]).map(row=>row?.race??row).filter(Boolean);
  const total=races.length;
  const known={
    course_layout:races.filter(r=>r.course_layout&&r.course_layout!=="UNKNOWN").length,
    race_class:races.filter(r=>r.race_class_normalized&&r.race_class_normalized!=="UNKNOWN").length,
    grade:races.filter(r=>r.grade&&r.grade!=="UNKNOWN").length,
    age_condition:races.filter(r=>r.age_min!=null).length,
    sex_condition:races.filter(r=>r.sex_condition&&r.sex_condition!=="UNKNOWN").length,
    weight_rule:races.filter(r=>r.weight_rule&&r.weight_rule!=="UNKNOWN").length,
    race_condition_raw:races.filter(r=>Boolean(cleanMeta(r.race_condition_raw))).length,
    course_meta_raw:races.filter(r=>Boolean(cleanMeta(r.course_meta_raw))).length,
  };
  return {
    total_races:total,
    course_layout:metric(total,known.course_layout),
    race_class:metric(total,known.race_class),
    grade:metric(total,known.grade),
    age_condition:metric(total,known.age_condition),
    sex_condition:metric(total,known.sex_condition),
    weight_rule:metric(total,known.weight_rule),
    race_condition_raw:metric(total,known.race_condition_raw),
    course_meta_raw:metric(total,known.course_meta_raw),
  };
}
