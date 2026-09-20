import {load} from "cheerio";

function clean(value){
  return (value??"").replace(/\s+/g," ").trim();
}
function horseId(href){
  return href?.match(/\/horse\/(\d+)/)?.[1]??null;
}

function pedigreeRows(table,$){
  let rows=table.children("tbody").children("tr");
  if(!rows.length)rows=table.children("tr");
  if(rows.length)return rows;
  return table.find("tr").filter((_,tr)=>$(tr).closest("table").get(0)===table.get(0));
}

export function parsePedigreeV2(html){
  const $=load(html);
  const table=$("table.blood_table").first().length
    ?$("table.blood_table").first()
    :$("table[class*='blood']").first();
  if(!table.length)return [];

  const rows=pedigreeRows(table,$);
  const generationMap={16:1,8:2,4:3,2:4,1:5};
  const nodes=[];
  const seen=new Set();

  rows.each((rowIndex,tr)=>{
    $(tr).children("td").each((_,td)=>{
      const cell=$(td);
      const rowspan=Math.max(1,Number(cell.attr("rowspan")??"1"));
      const generation=generationMap[rowspan];
      if(!generation)return;
      const slot=Math.floor(rowIndex/rowspan);
      if(slot<0||slot>=Math.pow(2,generation))return;
      const key=generation+":"+slot;
      if(seen.has(key))throw new Error("pedigree position duplicate: "+key);

      const anchor=cell.find("a[href*='/horse/']").first();
      const name=clean(anchor.text())||clean(cell.clone().children().remove().end().text())||clean(cell.text()).split(" ")[0]||"";
      if(!name)return;

      seen.add(key);
      nodes.push({
        generation,
        slot,
        ancestor_id:horseId(anchor.attr("href")),
        ancestor_name:name,
        raw_text:clean(cell.text())
      });
    });
  });

  nodes.sort((a,b)=>a.generation-b.generation||a.slot-b.slot);
  if(nodes.length){
    const sire=nodes.find(node=>node.generation===1&&node.slot===0);
    const dam=nodes.find(node=>node.generation===1&&node.slot===1);
    if(!sire||!dam)throw new Error("pedigree parent pair missing");
  }
  return nodes;
}
