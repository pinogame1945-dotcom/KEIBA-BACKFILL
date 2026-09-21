export const RESULT_PARSER_VERSION=4;

export function normalizeResultHeader(value){
  return String(value??"").replace(/\s+/g,"").trim();
}

export function findLast3fColumn(headers){
  const normalized=headers.map(normalizeResultHeader);
  const exactPatterns=[
    /^上り(?:3F|３F)?$/u,
    /^上がり(?:3F|３F)?$/u,
    /^後(?:3|３)F$/u,
  ];
  for(let i=0;i<normalized.length;i+=1){
    if(exactPatterns.some(pattern=>pattern.test(normalized[i])))return i;
  }
  return normalized.findIndex(header=>
    !header.includes("指数")&&(
      header.includes("上り")||
      header.includes("上がり")||
      header.includes("後3F")||
      header.includes("後３F")
    )
  );
}


export function parseLast3fSeconds(value){
  const text=String(value??"").replace(/\s+/g,"").replace(/[()]/g,"").trim();
  if(!text)return null;

  const colon=text.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/u);
  if(colon){
    const minutes=Number(colon[1]);
    const seconds=Number(colon[2]);
    if(!Number.isFinite(minutes)||!Number.isFinite(seconds)||seconds>=60)return null;
    return Number((minutes*60+seconds).toFixed(1));
  }

  if(!/^\d+(?:\.\d+)?$/u.test(text))return null;
  const numeric=Number(text);
  if(!Number.isFinite(numeric))return null;

  // netkeiba may render minute-based closing times without a colon,
  // e.g. "127.6" meaning 1:27.6 rather than 127.6 seconds.
  if(numeric>=100){
    const minutes=Math.floor(numeric/100);
    const seconds=numeric-minutes*100;
    if(minutes>=1&&seconds>=0&&seconds<60){
      return Number((minutes*60+seconds).toFixed(1));
    }
  }
  return numeric;
}
