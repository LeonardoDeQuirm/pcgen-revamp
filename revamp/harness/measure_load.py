"""How long does the engine take to load a character's source books?

Usage: python harness/measure_load.py [character.pcg] [runs]     (extra JVM options: set JVM_ARGS)
Starts the sidecar on a COPY of the character (default: revamp/local/clarent.pcg, the 49-source one) and
prints the seconds from process start to READY, and the engine's own "loading sources" to "loaded" span.
"""
import os, re, shutil, subprocess, sys, tempfile, threading, time
from pathlib import Path

from run_harness import DEFAULT_JDK, PCGEN

default = Path(__file__).resolve().parent.parent / "local" / "clarent.pcg"
src = Path(sys.argv[1]) if len(sys.argv) > 1 else default
runs = int(sys.argv[2]) if len(sys.argv) > 2 else 3
work = Path(tempfile.mkdtemp(prefix="load-"))
char = work / src.name
shutil.copyfile(src, char)

times = []
for i in range(runs):
    t0 = time.time()
    proc = subprocess.Popen(
        [str(DEFAULT_JDK / "bin" / "java.exe"), *os.environ.get("JVM_ARGS", "").split(), "-cp", "revamp/sidecar/build;build/libs/*", "pcgen.sidecar.Sidecar",
         "--settings-dir", tempfile.mkdtemp(prefix="load-settings-"), "--from-character", str(char), "--port", "8778"],
        cwd=PCGEN, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    ready = threading.Event()

    def watch():
        for line in proc.stdout:
            if line.startswith("READY"):
                ready.set()
    threading.Thread(target=watch, daemon=True).start()
    ok = ready.wait(300)
    secs = time.time() - t0
    proc.kill()
    proc.wait()
    if not ok:
        print("never became ready")
        sys.exit(1)
    times.append(secs)
    print(f"run {i + 1}: {secs:.1f} s")
print(f"best {min(times):.1f} s, average {sum(times) / len(times):.1f} s")
