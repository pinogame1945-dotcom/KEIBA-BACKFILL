import {mkdir,readFile,writeFile} from "node:fs/promises";

const [mode,startDate,endDate,runId]=process.argv.slice(2);
const dateRe=/^\d{4}-\d{2}-\d{2}$/;
if(!["prepare","mark-dispatched"].includes(mode))throw new Error("mode must be prepare or mark-dispatched");
if(!dateRe.test(startDate??"")||!dateRe.test(endDate??""))throw new Error("invalid date range");
if(startDate<endDate)throw new Error("start_date must be newest and >= end_date");

const control=JSON.parse(await readFile(".backfill/control.json","utf8"));
let state;
try{state=JSON.parse(await readFile(".backfill/state.json","utf8"));}
catch{state={schema_version:1,ranges:{}};}
state.schema_version=1;
state.ranges=state.ranges??{};

const key=`${startDate}..${endDate}`;
const now=new Date().toISOString();
const dayMs=86400000;
const parseDate=value=>{
  const [y,m,d]=value.split("-").map(Number);
  return new Date(Date.UTC(y,m-1,d));
};
const formatDate=date=>date.toISOString().slice(0,10);
const addDays=(value,delta)=>formatDate(new Date(parseDate(value).getTime()+delta*dayMs));

if(mode==="mark-dispatched"){
  const entry=state.ranges[key];
  if(!entry)throw new Error(`missing chain state for ${key}`);
  entry.next_dispatched=true;
  entry.dispatched_at=now;
  entry.dispatch_source_run_id=String(runId??"");
  await mkdir(".backfill",{recursive:true});
  await writeFile(".backfill/state.json",JSON.stringify(state,null,2)+"\n");
  console.log(JSON.stringify({action:"marked",key,next_start:entry.next_start,next_end:entry.next_end}));
  process.exit(0);
}

if(control.enabled!==true){
  console.log(JSON.stringify({action:"stop",reason:"disabled",key}));
  process.exit(0);
}
const stopDate=String(control.stop_date??"");
if(!dateRe.test(stopDate))throw new Error("invalid control stop_date");
const rangeDays=Number(control.range_days??14);
if(!Number.isInteger(rangeDays)||rangeDays<1||rangeDays>31)throw new Error("control range_days must be 1..31");

const existing=state.ranges[key];
if(existing?.next_dispatched===true){
  console.log(JSON.stringify({action:"already-dispatched",key,next_start:existing.next_start,next_end:existing.next_end}));
  process.exit(0);
}

const nextStart=addDays(endDate,-1);
if(nextStart<stopDate){
  state.ranges[key]={
    ...(existing??{}),
    completed_at:existing?.completed_at??now,
    source_run_id:String(runId??""),
    terminal:true,
    reason:"stop_date_reached",
    stop_date:stopDate,
    next_dispatched:false
  };
  await mkdir(".backfill",{recursive:true});
  await writeFile(".backfill/state.json",JSON.stringify(state,null,2)+"\n");
  console.log(JSON.stringify({action:"terminal",key,stop_date:stopDate}));
  process.exit(0);
}

let nextEnd=addDays(nextStart,-(rangeDays-1));
if(nextEnd<stopDate)nextEnd=stopDate;

state.ranges[key]={
  ...(existing??{}),
  completed_at:existing?.completed_at??now,
  source_run_id:String(runId??""),
  next_start:nextStart,
  next_end:nextEnd,
  next_dispatched:false,
  dispatch_prepared_at:now,
  stop_date:stopDate,
  range_days:rangeDays
};
await mkdir(".backfill",{recursive:true});
await writeFile(".backfill/state.json",JSON.stringify(state,null,2)+"\n");
console.log(JSON.stringify({action:"dispatch",key,next_start:nextStart,next_end:nextEnd,stop_date:stopDate}));
