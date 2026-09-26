export const MARGIN_PARSER_VERSION=1;

const MARGIN_TYPES=new Set([
  "LENGTHS","NOSE","HEAD","NECK","LARGE","DEAD_HEAT","OTHER",
]);

function cleanMargin(value){
  return String(value??"").normalize("NFKC").replace(/\s+/g," ").trim();
}

function validFraction(numerator,denominator){
  return Number.isFinite(numerator)&&Number.isFinite(denominator)&&
    numerator>=0&&denominator>0;
}

export function normalizeMarginRaw(value){
  const raw=cleanMargin(value);
  if(!raw)return {margin_type:null,margin_lengths:null};

  const compact=raw.replace(/\s+/g,"");
  const categorical=new Map([
    ["ハナ","NOSE"],
    ["アタマ","HEAD"],
    ["クビ","NECK"],
    ["大差","LARGE"],
    ["同着","DEAD_HEAT"],
  ]);
  if(categorical.has(compact)){
    return {margin_type:categorical.get(compact),margin_lengths:null};
  }

  // netkeiba mixed fractions are commonly rendered as "1.1/2".
  // Also accept "1 1/2" and "1・1/2" without inventing an
  // approximate value for categorical margins such as ハナ or クビ.
  const mixed=raw.match(/^(\d+)(?:[.\s・])(\d+)\/(\d+)$/u);
  if(mixed){
    const whole=Number(mixed[1]);
    const numerator=Number(mixed[2]);
    const denominator=Number(mixed[3]);
    if(validFraction(numerator,denominator)&&numerator<denominator){
      return {
        margin_type:"LENGTHS",
        margin_lengths:Number((whole+numerator/denominator).toFixed(6)),
      };
    }
  }

  const fraction=compact.match(/^(\d+)\/(\d+)$/u);
  if(fraction){
    const numerator=Number(fraction[1]);
    const denominator=Number(fraction[2]);
    if(validFraction(numerator,denominator)&&numerator<denominator){
      return {
        margin_type:"LENGTHS",
        margin_lengths:Number((numerator/denominator).toFixed(6)),
      };
    }
  }

  if(/^\d+(?:\.\d+)?$/u.test(compact)){
    const numeric=Number(compact);
    if(Number.isFinite(numeric)&&numeric>=0){
      return {margin_type:"LENGTHS",margin_lengths:numeric};
    }
  }

  return {margin_type:"OTHER",margin_lengths:null};
}

export function validateMarginFields(result){
  if(!result||typeof result!=="object")throw new Error("margin normalization requires result object");
  const type=result.margin_type??null;
  const lengths=result.margin_lengths??null;
  if(type!=null&&!MARGIN_TYPES.has(String(type))){
    throw new Error("invalid margin_type: "+String(type));
  }
  if(lengths!=null&&(!Number.isFinite(Number(lengths))||Number(lengths)<0)){
    throw new Error("invalid margin_lengths: "+String(lengths));
  }
  if(type==="LENGTHS"&&lengths==null){
    throw new Error("LENGTHS margin requires margin_lengths");
  }
  if(type!=="LENGTHS"&&lengths!=null){
    throw new Error("categorical margin must not set margin_lengths");
  }
  return true;
}
