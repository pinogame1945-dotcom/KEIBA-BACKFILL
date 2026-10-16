"""149-feature as-of ledger audit copied from verified KEIBA-ML pre-race audit."""
import re,json
EXPECTED=14
URL=""
def audit(catalog,rows,raw):
    assert len(catalog["features"])==149
    entry_mapping={
      "entry.horse_id":"horse_id","entry.horse_number":"horse_number","entry.gate":"gate",
      "entry.sex":"sex","entry.age":"age","entry.carried_weight":"carried_weight",
      "entry.jockey_id":"jockey_id","entry.trainer_id":"trainer_id",
      "entry.body_weight":"body_weight","entry.body_weight_diff":"body_weight_diff"}
    report=[]
    for f in catalog["features"]:
        fid=f["feature_id"]
        boundary=f["history_boundary"]
        item={"feature_id":fid,"catalog_status":f["status"],"domain":f["domain"],
              "available_at_contract":f["available_at"],"source_field":f["source_field"],
              "history_boundary":boundary,"source_checked":URL,
              "checked_from":"ACTUAL_2026_FUJI_NETKEIBA_PRE_RACE_PAGE",
              "status":None,"observed_value":None,"coverage":None,"reason":None}
        if boundary=="CURRENT_RACE_RESULT":
            item.update(status="NOT_YET_PUBLISHED",reason="Result only after actual race. No pseudo-result.")
        elif boundary=="CURRENT_RACE_MARKET":
            item.update(status="POST_RACE_FINAL_ONLY",reason="Final odds/popularity/payout unavailable before race; live odds source is JRA, not netkeiba.")
        elif boundary=="STRICT_PRIOR_DATE_ONLY":
            item.update(status="BACKFILL_HISTORY_REQUIRED",reason="Not a raw feature on current card. Historical source/point-in-time feature computation not executed by page probe.")
        elif boundary=="STATIC_FACT":
            item.update(status="HORSE_PROFILE_REQUIRED",reason="Horse or pedigree profile pack is a separate source, not the live race table. Presence for all 14 not yet checked.")
        elif boundary=="CURRENT_RACE_KNOWN_FACT":
            if fid=="race.actual_start_time":
                item.update(status="NOT_YET_PUBLISHED",reason="Actual start not known until race started; scheduled post time is not actual start.")
            elif fid in entry_mapping:
                key=entry_mapping[fid];vals=[r.get(key) for r in rows];found=sum(v is not None and v!="" for v in vals)
                item["coverage"]={"present":found,"expected":EXPECTED}
                if found==EXPECTED:
                    item["status"]="OBSERVED_NETKEIBA_PAGE"
                    item["observed_value"]=[{"horse_id":r["horse_id"],"value":r[key]} for r in rows]
                elif found==0 and key in ("body_weight","body_weight_diff"):
                    item.update(status="NOT_YET_PUBLISHED",reason="Body weight not published in fetched pre-race page")
                else:
                    item.update(status="PARTIAL_OR_NOT_EXTRACTED",reason=f"Only {found}/{EXPECTED} values parsed; cannot claim source absence")
            else:
                val=raw.get(fid)
                if val is not None:
                    item["status"]="OBSERVED_OR_DERIVED_FROM_PAGE"
                    item["observed_value"]=val
                    if fid=="race.designated" and val:
                        item["reason"]="NOTICE: legacy BACKFILL normalizer only recognizes [指]; current netkeiba has (指). This is a normalization difference, not a page absence."
                elif fid in ("race.weather","race.track_condition"):
                    item.update(status="NOT_YET_PUBLISHED_OR_NOT_VISIBLE",reason="No verified page value at observation time; check JRA current conditions separately.")
                else:item.update(status="NOT_VISIBLE_OR_UNPROVEN",reason="Not observed in current HTML with a safe source mapping; not assumed false or zero.")
        else:
            item.update(status="UNCLASSIFIED_BLOCKED",reason="Unknown catalog boundary; stop on novel category")
        report.append(item)
    assert len(report)==len({x["feature_id"] for x in report})==149
    return report

