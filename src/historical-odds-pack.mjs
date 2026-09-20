export const ODDS_PACK_VERSION=1;
export const ODDS_DECODER_CONTRACT_VERSION=1;
export const ODDS_SOURCE="NETKEIBA_FINAL";
export const NETKEIBA_ODDS_START_DATE="2007-07-28";

const VALID_GROUPS=new Set(["1","2","3","4","5","6","7","8"]);
const RANGE_GROUPS=new Set(["2","5"]);

function numberValue(value){
  if(typeof value==="number")return Number.isFinite(value)?value:null;
  if(typeof value!=="string")return null;
  const n=Number(value.replace(/,/g,"").trim());
  return Number.isFinite(n)?n:null;
}

export function finalOddsTuple(raw){
  if(!Array.isArray(raw)||raw.length<3)return null;
  return raw.length>=6?raw.slice(3,6):raw.slice(0,3);
}

export function parseNetkeibaOddsResponse(text){
  try{return JSON.parse(text);}
  catch{
    const m=String(text).match(/^[^(]+\((.*)\)\s*;?\s*$/s);
    if(!m)throw new Error("netkeiba odds response is not JSON/JSONP");
    return JSON.parse(m[1]);
  }
}

export function summarizeOddsGroups(odds){
  const summary={};
  for(const [group,map] of Object.entries(odds??{})){
    if(!VALID_GROUPS.has(group)||!map||typeof map!=="object"||Array.isArray(map))continue;
    const slotLengths={};
    let priced=0,invalidShape=0;
    for(const raw of Object.values(map)){
      if(!Array.isArray(raw)){
        invalidShape+=1;
        continue;
      }
      slotLengths[String(raw.length)]=(slotLengths[String(raw.length)]??0)+1;
      const tuple=finalOddsTuple(raw);
      if(!tuple){
        invalidShape+=1;
        continue;
      }
      const first=numberValue(tuple[0]);
      const second=numberValue(tuple[1]);
      if(RANGE_GROUPS.has(group)){
        if(first!=null&&second!=null&&first>0&&second>=first)priced+=1;
      }else if(first!=null&&first>0){
        priced+=1;
      }
    }
    summary[group]={
      rows:Object.keys(map).length,
      priced_rows:priced,
      status:priced>0?"PRICED":"UNAVAILABLE",
      slot_lengths:slotLengths,
      invalid_shapes:invalidShape,
    };
  }
  return summary;
}

export function archiveHistoricalOddsPayload({
  raceId,payload,sourceUrl,fetchedAt=new Date().toISOString(),
}){
  if(!/^\d{12}$/.test(String(raceId)))throw new Error("invalid race id: "+raceId);
  if(!payload||typeof payload!=="object")throw new Error("odds payload missing");
  if(payload.status!=="result"){
    throw new Error("historical odds not final: status="+String(payload.status??"missing"));
  }
  const odds=payload?.data?.odds;
  if(!odds||typeof odds!=="object"||Array.isArray(odds)){
    throw new Error("historical odds groups missing");
  }
  const groupSummary=summarizeOddsGroups(odds);
  if(!Object.keys(groupSummary).length)throw new Error("historical odds groups empty");
  const invalid=Object.entries(groupSummary)
    .filter(([,item])=>item.invalid_shapes>0)
    .map(([group,item])=>group+":"+item.invalid_shapes);
  if(invalid.length){
    throw new Error("unsupported historical odds row shape: "+invalid.join(","));
  }
  return {
    schema_version:1,
    odds_pack_version:ODDS_PACK_VERSION,
    decoder_contract_version:ODDS_DECODER_CONTRACT_VERSION,
    race_id:String(raceId),
    odds_kind:"FINAL",
    source:ODDS_SOURCE,
    source_url:sourceUrl??null,
    source_status:payload.status,
    source_official_datetime:payload?.data?.official_datetime??null,
    fetched_at:fetchedAt,
    group_summary:groupSummary,
    odds,
  };
}
