import assert from "node:assert/strict";
import {parsePedigreeV2} from "../src/pedigree-parser.mjs";

const spans={1:16,2:8,3:4,4:2,5:1};
let html="<table class=\"blood_table\"><tbody>";
for(let row=0;row<32;row+=1){
  html+="<tr>";
  for(const generation of [1,2,3,4,5]){
    const rowspan=spans[generation];
    if(row%rowspan!==0)continue;
    const slot=row/rowspan;
    const id=String(generation).padStart(2,"0")+String(slot).padStart(8,"0");
    const nested=generation===2&&slot===1
      ?"<table><tbody><tr><td rowspan=\"1\"><a href=\"/horse/9999999999/\">WRONG</a></td></tr></tbody></table>"
      :"";
    html+=`<td rowspan="${rowspan}"><a href="/horse/${id}/">G${generation}S${slot}</a>${nested}</td>`;
  }
  html+="</tr>";
}
html+="</tbody></table>";

const nodes=parsePedigreeV2(html);
assert.equal(nodes.length,62);
for(const generation of [1,2,3,4,5]){
  const group=nodes.filter(n=>n.generation===generation);
  assert.equal(group.length,2**generation);
  for(let slot=0;slot<group.length;slot+=1){
    assert.equal(group[slot].slot,slot);
    assert.equal(group[slot].ancestor_name,`G${generation}S${slot}`);
  }
}
assert.equal(nodes.some(n=>n.ancestor_name==="WRONG"),false);
console.log("pedigree v2 smoke passed");
