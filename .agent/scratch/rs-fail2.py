import json,sys
want=sys.argv[2].split(',')
for l in open(sys.argv[1]):
    r=json.loads(l)
    if r['transform'] in want and (not r['top1'] or r['status']!='match'):
        c=r['cands'][:2]
        d=r.get('detection') or {}
        print(r['transform'],r['lang'],r['truth'],r['status'],r['conf'],'|',[(x['id'],x['hash'],x['embed'],x['ocr']) for x in c],'|',d.get('quadFound'),d.get('hypothesis'),d.get('fitUpright'),d.get('fit'),'ocr',(r['ocr'] or {}).get('number'))
