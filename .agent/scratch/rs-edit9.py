import pathlib
p=pathlib.Path('app/recognize/pipeline.py'); s=p.read_bytes().decode()
crlf = '\r\n' in s
s=s.replace('\r\n','\n')
s=s.replace('''        n_hypotheses = len(hypotheses)
        if best_top <''','''        n_hypotheses = len(hypotheses)
        fit_upright = best_top
        if best_top <''')
s=s.replace('''            "fallback": "none" if quad is not None and chosen_label in ("quad", "rot180") else "centre"},''','''            "fallback": "none" if quad is not None and chosen_label in ("quad", "rot180") else "centre",
            "hypothesis": chosen_label, "fitUpright": round(fit_upright, 4), "fit": round(best_top, 4)},''')
if crlf: s=s.replace('\n','\r\n')
p.write_bytes(s.encode())
e=pathlib.Path('app/eval.py'); t=e.read_bytes().decode()
t=t.replace('"cands": cands, "ocr": res.get("ocr"), "timing": res["timingMs"]}','"cands": cands, "ocr": res.get("ocr"), "timing": res["timingMs"],\n            "detection": res.get("detection")}')
e.write_bytes(t.encode())
