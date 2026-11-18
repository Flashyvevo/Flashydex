import json, sys
sys.path.insert(0, ".")
from app.eval import summarise_m2, current_params, TRANSFORMS

path = sys.argv[1]
runs = [json.loads(l) for l in open(path, encoding="utf-8")]
params = current_params()
for kv in sys.argv[2:]:
    k, v = kv.split("=")
    params[k] = float(v)
s = summarise_m2(runs, params)
print(params)
print(f"{'transform':12} {'n':>4} {'top1':>6} {'top3':>6} {'match':>6} {'cand':>6} {'nomat':>6} {'FM':>4}")
for name, r in s["perTransform"].items():
    print(f"{name:12} {r['n']:>4} {r['top1']:>6} {r['top3']:>6} {r['matchRate']:>6} {r['candidatesRate']:>6} {r['noMatchRate']:>6} {r['falseMatches']:>4}")
print("overall", s["overall"], "removed", s["cardRemoved"])
print(json.dumps(s["latencyMs_photo1600"]))
