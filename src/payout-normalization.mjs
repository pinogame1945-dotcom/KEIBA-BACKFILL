export const RACE_PACK_VERSION = 2;
export const PAYOUT_PARSER_VERSION = 2;

const ARITY = Object.freeze({
  WIN: 1,
  PLACE: 1,
  BRACKET_QUINELLA: 2,
  QUINELLA: 2,
  WIDE: 2,
  EXACTA: 2,
  TRIO: 3,
  TRIFECTA: 3,
});

const ORDERED = new Set(["EXACTA","TRIFECTA"]);

function integerOrNull(value){
  const text=String(value??"").replace(/,/g,"");
  const match=text.match(/-?\d+/);
  if(!match)return null;
  const parsed=Number.parseInt(match[0],10);
  return Number.isFinite(parsed)?parsed:null;
}

function formatCombination(betType,selections){
  if(selections.length===1)return String(selections[0]);
  return selections.join(ORDERED.has(betType)?"→":"-");
}

function selectionsFromLines(lines){
  return (lines??[]).flatMap(line=>
    [...String(line??"").matchAll(/\d+/g)].map(match=>Number(match[0]))
  );
}

function collapseExtraValues(values,targetCount,arity,label){
  if(values.length<=targetCount)return values;
  if(targetCount===1&&values.every(value=>value===values[0]))return [values[0]];

  if(values.length===targetCount*arity){
    const grouped=[];
    let safe=true;
    for(let i=0;i<targetCount;i++){
      const group=values.slice(i*arity,(i+1)*arity);
      if(!group.every(value=>value===group[0])){safe=false;break;}
      grouped.push(group[0]);
    }
    if(safe)return grouped;
  }

  if(values.length%targetCount===0){
    const head=values.slice(0,targetCount);
    let repeated=true;
    for(let i=targetCount;i<values.length;i++){
      if(values[i]!==head[i%targetCount]){repeated=false;break;}
    }
    if(repeated)return head;
  }

  throw new Error(
    `payout ${label} count mismatch: expected ${targetCount}, got ${values.length}`
  );
}

function alignedIntegers(lines,targetCount,arity,label,{required=false}={}){
  let values=(lines??[]).map(integerOrNull).filter(value=>value!=null);
  values=collapseExtraValues(values,targetCount,arity,label);
  if(required&&values.length<targetCount){
    throw new Error(
      `payout ${label} missing: expected ${targetCount}, got ${values.length}`
    );
  }
  while(values.length<targetCount)values.push(null);
  return values.slice(0,targetCount);
}

export function normalizePayoutRows({
  raceId,
  betType,
  combinationLines,
  amountLines,
  popularityLines,
}){
  const arity=ARITY[betType];
  if(!arity)throw new Error(`unsupported payout bet type: ${betType}`);

  const rawLines=(combinationLines??[])
    .map(value=>String(value??"").trim())
    .filter(Boolean);
  const selections=selectionsFromLines(rawLines);

  let combinations=[];
  if(selections.length===0){
    // Preserve rare non-numeric payout labels (for example special payouts)
    // rather than inventing horse numbers.
    combinations=rawLines;
  }else{
    if(selections.length%arity!==0){
      throw new Error(
        `payout combination arity mismatch: ${betType} needs ${arity}, got ${selections.length} selections`
      );
    }
    for(let i=0;i<selections.length;i+=arity){
      combinations.push(formatCombination(betType,selections.slice(i,i+arity)));
    }
  }

  if(!combinations.length)return [];

  const amounts=alignedIntegers(
    amountLines,combinations.length,arity,"amount",{required:true},
  );
  const popularities=alignedIntegers(
    popularityLines,combinations.length,arity,"popularity",
  );

  return combinations.map((combination,index)=>({
    race_id:raceId,
    bet_type:betType,
    combination,
    payout_yen:amounts[index],
    popularity:popularities[index],
  }));
}
