import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const day=await readFile(".github/workflows/historical-day-production.yml","utf8");
const week=await readFile(".github/workflows/historical-week-production.yml","utf8");
const control=JSON.parse(await readFile(".backfill/control.json","utf8"));
const oddsSwitch=(await readFile(".backfill/odds-auto-enabled","utf8")).trim();
const odds=await readFile(".github/workflows/historical-odds-backfill.yml","utf8");
const pushHelper=await readFile("scripts/push-main-with-retry.sh","utf8");

assert.ok(day.includes("workflow_dispatch:"),"day backfill must be manual-dispatch capable");
assert.ok(!day.includes("\n  push:\n"),"day backfill must not auto-run on repository push");
assert.ok(day.includes("Verify one-day production contract"),"day backfill must use full production verification");
assert.ok(day.includes("force_recollect_current:"),"one-day workflow must expose explicit force-recollect probe input");
assert.ok(day.includes("type: boolean"),"force-recollect probe input must be boolean");
assert.ok(day.includes("default: false"),"force-recollect probe must default off");
assert.ok(
  day.includes("FORCE_RECOLLECT_CURRENT: ${{ inputs.force_recollect_current && '1' || '0' }}"),
  "one-day workflow must pass force-recollect only from explicit input",
);
assert.ok(day.includes('node src/verify-range.mjs "$DATE" "$DATE"'),"day verification must use verify-range");
assert.ok(!day.includes("if: always()"),"failed day verification must not commit data");
assert.ok(
  day.indexOf("Verify one-day production contract")<day.indexOf("Commit historical data"),
  "day must verify before commit",
);

for(const token of [
  "allow_odds_followup:",
  "allow_self_chain:",
  "type: boolean",
  "default: false",
  "Staged test mode is limited to 7 calendar days.",
  'node src/verify-range.mjs "$DATE" "$DATE"',
  "Verify completed range",
  "inputs.allow_odds_followup",
  "inputs.allow_self_chain",
  '-f allow_self_chain="true"',
  '-f allow_odds_followup="true"',
]){
  assert.ok(week.includes(token),"week staged-safety token missing: "+token);
}
assert.ok(!week.includes("\n  push:\n"),"week backfill must not auto-run on repository push");
assert.ok(week.includes("bash scripts/push-main-with-retry.sh"),"week writes must use retry-safe main push");
assert.ok(odds.includes("bash scripts/push-main-with-retry.sh"),"odds writes must use retry-safe main push");
assert.ok(pushHelper.includes("git fetch \"$REMOTE\" \"$BRANCH\""),"push helper must refresh remote before push");
assert.ok(pushHelper.includes("git rebase \"$REMOTE/$BRANCH\""),"push helper must rebase onto latest main");
assert.ok(pushHelper.includes("Rebase conflict detected. Refusing automatic conflict resolution."),"push helper must fail closed on data conflicts");
assert.ok(
  week.indexOf('node src/verify-range.mjs "$DATE" "$DATE"')<
  week.indexOf("git add data/manifest.json data/daily/ data/horses/ data/debug/"),
  "each week day must pass full verification before commit",
);
assert.match(
  week,
  /name: Kick independent odds catch-up[\s\S]*?if: \$\{\{ github\.event_name == 'workflow_dispatch' && \(inputs\.allow_odds_followup \|\| inputs\.allow_self_chain\) \}\}/,
  "odds follow-up must require explicit odds request or production self-chain",
);
assert.match(
  week,
  /name: Self-chain next historical range[\s\S]*?if: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.allow_self_chain \}\}/,
  "self-chain must require explicit workflow input",
);
assert.ok(
  week.includes('ODDS_AUTO=$(cat .backfill/odds-auto-enabled 2>/dev/null || true)')&&
  week.includes('if [ "$ODDS_AUTO" != "enabled" ]; then'),
  "odds auto-follow must have repository-side kill switch",
);
assert.equal(typeof control.enabled,"boolean","historical self-chain repository control must be boolean");
assert.ok(["enabled","disabled"].includes(oddsSwitch),"historical odds auto-follow repository switch must be enabled or disabled");
assert.equal(control.stop_date,"2006-09-01","historical self-chain stop date changed unexpectedly");
assert.equal(control.range_days,14,"historical self-chain batch size changed unexpectedly");

console.log("workflow production safety smoke ok");