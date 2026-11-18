import json
for l in open('data/logs/probe.runs.jsonl'):
    r=json.loads(l)
    if r['transform'] in ('rot90','rot180','rot270','skew_persp','photo1600') and (not r['top1'] or r['status']!='match'):
        c=r['cands'][:2]
        print(r['transform'],r['truth'],r['status'],r['conf'],'top',[(x['id'],x['hash'],x['embed'],x['ocr']) for x in c],'ocr',r['ocr'],'hyp',r['timing'].get('hypotheses'))
