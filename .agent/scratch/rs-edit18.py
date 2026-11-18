import pathlib
p=pathlib.Path('app/api/app.py'); s=p.read_bytes().decode()
old='ready = bool(index is not None and len(index) > 0 and set(settings.langs) <= set(counts) and warm)'
assert old in s
s=s.replace(old,'ready = bool(index is not None and warm and all(counts.get(lang, 0) > 0 for lang in settings.langs))')
p.write_bytes(s.encode())
