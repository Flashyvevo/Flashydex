import pathlib
p=pathlib.Path('app/recognize/pipeline.py'); s=p.read_text()
s=s.replace('        hypotheses = hypotheses[:1] * n_hypotheses  # only the count is used below\n','')
s=s.replace('"fallback": "none" if quad is not None and chosen_label == "quad" else "centre"}','"fallback": "none" if quad is not None and chosen_label in ("quad", "rot180") else "centre"}')
p.write_text(s)
