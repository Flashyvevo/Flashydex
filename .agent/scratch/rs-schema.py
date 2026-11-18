import sqlite3,sys
c=sqlite3.connect('file:tools/catalog-builder/dist-prod/catalog-en-2026.10.31.003.db?mode=ro',uri=True)
for r in c.execute("select name, sql from sqlite_master where type='table'"): print(r[0]); print((r[1] or '')[:600])
print(c.execute("select count(*) from cards").fetchone())
print(c.execute("select * from cards limit 2").fetchall())
