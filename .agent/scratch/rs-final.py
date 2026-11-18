import json, sys
sys.path.insert(0, ".")
from app.eval import summarise_m2, current_params
runs = [json.loads(l) for l in open("data/logs/eval-m2.runs.jsonl", encoding="utf-8")]
s = summarise_m2(runs, current_params())
s["partial"] = True
s["note"] = "run cut short by time budget: first ~115 EN cards x 9 transforms; no JA, thresholds NOT re-tuned"
json.dump(s, open("data/logs/eval-m2.json", "w"), indent=1)
print(s["n"])
