import re,pathlib
src=pathlib.Path('../../.agent/scratch/rs-edit14.py').read_text(encoding='utf-8')
# replace first rep(...) call's old text with marker-based replacement
i=src.index("rep('''Auth rule")
j=src.index("', '''Auth rule: a valid")
new_first = "s0 = s.index('Auth rule: token set')\ne0 = s.index('(503 `BUSY`).') + len('(503 `BUSY`).')\ns = s[:s0] + '@@AUTH@@' + s[e0:]\nrep('@@AUTH@@"
src = src[:i] + new_first + src[j:]
pathlib.Path('../../.agent/scratch/rs-edit14b.py').write_text(src,encoding='utf-8')
