import pathlib
p=pathlib.Path('app/recognize/pipeline.py'); s=p.read_bytes().decode()
crlf='\r\n' in s; s=s.replace('\r\n','\n')
old='''        return frame_fraction < 0.9 and 0.62 <= w / h <= 0.80'''
assert old in s
s=s.replace(old,'''        # Card-shaped frame (a flat scan / screenshot, 63:88 = 0.716; phone photos are 3:4 or 2:3, not this)
        # whose detected quad is not the whole frame: the quad may be a skewed or inner outline.
        return frame_fraction < constants.WHOLE_FRAME_TRY_BELOW and 0.69 <= w / h <= 0.74''')
if crlf: s=s.replace('\n','\r\n')
p.write_bytes(s.encode())
c=pathlib.Path('app/core/constants.py'); t=c.read_bytes().decode()
t=t.replace('INGEST_MAX_SIDE = 2000\r\n','INGEST_MAX_SIDE = 2000\r\n# A detected quad covering less than this fraction of a card-shaped frame also gets the whole frame tried.\r\nWHOLE_FRAME_TRY_BELOW = 0.985\r\n')
c.write_bytes(t.encode())
