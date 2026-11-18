import os, signal, sys
for pid in sys.argv[1:]:
    try:
        os.kill(int(pid), signal.SIGTERM); print("killed", pid)
    except OSError as e:
        print("fail", pid, e)
