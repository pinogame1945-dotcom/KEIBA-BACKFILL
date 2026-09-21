export const RESULT_PARSER_VERSION=2;

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
