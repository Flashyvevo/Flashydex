import subprocess,sys,pathlib
root=pathlib.Path('../..')
for f in subprocess.check_output(['git','-C','../..','diff','--name-only'],text=True).split():
    p=root/f
    if not f.startswith('services') and not f.startswith('packages'): continue
    head=subprocess.check_output(['git','-C','../..','show','HEAD:'+f])
    cur=p.read_bytes()
    if b'\r\n' not in head and b'\r\n' in cur:
        p.write_bytes(cur.replace(b'\r\n',b'\n')); print('lf-fixed',f)
    elif b'\r\n' in head: print('crlf in head',f, head.count(b'\r\n'), head.count(b'\n'))
