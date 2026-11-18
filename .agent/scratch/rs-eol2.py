import subprocess
import pathlib

root = pathlib.Path("../..")
files = subprocess.check_output(["git", "-C", "../..", "diff", "--name-only"], text=True).split()
for f in files:
    if not (f.startswith("services") or f.startswith("packages")):
        continue
    p = root / f
    head = subprocess.check_output(["git", "-C", "../..", "show", "HEAD:" + f])
    cur = p.read_bytes()
    head_crlf = b"\r\n" in head
    norm = cur.replace(b"\r\n", b"\n")
    want = norm.replace(b"\n", b"\r\n") if head_crlf else norm
    if want != cur:
        p.write_bytes(want)
        print("fixed", f, "crlf" if head_crlf else "lf")
