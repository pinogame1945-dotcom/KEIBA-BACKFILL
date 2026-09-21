export const FLAT_LAST3F_MIN_SECONDS=20;
export const FLAT_LAST3F_MAX_SECONDS=60;

export function isFlatRace(race){
  return race?.discipline==="FLAT";
}

function isFinished(result){
  return result?.result_status==="FINISHED"&&result?.official_finish_position!=null;
}

function isTimed(result){
  return isFinished(result)&&result?.finish_time_ms!=null;
}

export function isSuspiciousFlatLast3f(result){
  if(result?.last_3f==null)return false;
  const value=Number(result.last_3f);
  return !Number.isFinite(value)||value<FLAT_LAST3F_MIN_SECONDS||value>FLAT_LAST3F_MAX_SECONDS;
}

export function flatLast3fDayQuality(records){
  const flatRows=(records??[]).filter(row=>isFlatRace(row?.race));
  const finished=flatRows.flatMap(row=>row?.results??[]).filter(isFinished);
  const timed=finished.filter(result=>result?.finish_time_ms!=null);
  const present=timed.filter(result=>result?.last_3f!=null).length;
  const suspicious=timed.filter(isSuspiciousFlatLast3f).length;
  return {
    scope:"FLAT",
    flatRaces:flatRows.length,
    finishedResults:finished.length,
    timedResults:timed.length,
    present,
    suspicious,
    finishTimeCoverage:finished.length?timed.length/finished.length:0,
    last3fCoverage:timed.length?present/timed.length:1,
  };
}

export function raceFlatLast3fQuality(row){
  if(!isFlatRace(row?.race)){
    return {eligible:false,scope:"FLAT",timed:0,bad:0};
  }
  const timed=(row?.results??[]).filter(isTimed);
  const bad=timed.filter(result=>
    result?.last_3f==null||isSuspiciousFlatLast3f(result)
  ).length;
  return {eligible:true,scope:"FLAT",timed:timed.length,bad};
}


export function listSuspiciousFlatLast3f(records){
  const out=[];
  for(const row of records??[]){
    if(!isFlatRace(row?.race))continue;
    for(const result of row?.results??[]){
      if(!isTimed(result)||!isSuspiciousFlatLast3f(result))continue;
      out.push({
        race_id:row?.race?.race_id??result?.race_id??null,
        race_name:row?.race?.race_name??null,
        horse_id:result?.horse_id??null,
        official_finish_position:result?.official_finish_position??null,
        finish_time_ms:result?.finish_time_ms??null,
        last_3f:result?.last_3f??null,
        source_url:row?.race?.source_url??null,
      });
    }
  }
  return out;
}
