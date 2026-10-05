"""Where does the engine spend its time loading a character's source books? (Java Flight Recorder sampling)

Usage: python harness/profile_load.py [character.pcg]     -> prints hot spots; keeps revamp/.run/load.jfr
"""
import collections, re, shutil, subprocess, sys, tempfile, threading
from pathlib import Path

from run_harness import DEFAULT_JDK, PCGEN

src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "local" / "clarent.pcg"
run = Path(__file__).resolve().parent.parent / ".run"
char = Path(tempfile.mkdtemp(prefix="prof-")) / src.name
shutil.copyfile(src, char)
jfr = run / "load.jfr"
jfr.unlink(missing_ok=True)
java = DEFAULT_JDK / "bin"
proc = subprocess.Popen(
    [str(java / "java.exe"), "-XX:StartFlightRecording=settings=profile", "-cp", "revamp/sidecar/build;build/libs/*",
     "pcgen.sidecar.Sidecar", "--settings-dir", tempfile.mkdtemp(prefix="prof-settings-"), "--from-character", str(char),
     "--port", "8777"], cwd=PCGEN, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
ready = threading.Event()
threading.Thread(target=lambda: [ready.set() for l in proc.stdout if l.startswith("READY")], daemon=True).start()
ready.wait(300)
r = subprocess.run([str(java / "jcmd.exe"), str(proc.pid), "JFR.dump", f'filename="{jfr}"'], capture_output=True, text=True, cwd=PCGEN); print("jcmd:", (r.stdout + r.stderr).strip()[-200:])
proc.kill()
txt = subprocess.run([str(java / "jfr.exe"), "print", "--events", "jdk.ExecutionSample", "--stack-depth", "60", str(jfr)],
                     capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
events = txt.split("jdk.ExecutionSample")[1:]
frames_of = lambda e: re.findall(r"^\s+([\w.$<>]+)\(", e, re.M)
n = len(events)
print(f"{n} samples (about 20 ms each)")
inclusive, selfc, selfpc = collections.Counter(), collections.Counter(), collections.Counter()
for e in events:
    fr = frames_of(e)
    if not fr:
        continue
    selfc[fr[0]] += 1
    pc = [f for f in fr if f.startswith(("pcgen.", "plugin."))]
    if pc:
        selfpc[pc[0]] += 1
    for f in set(f for f in fr if f.startswith(("pcgen.", "plugin."))):
        inclusive[f] += 1
print("\nINCLUSIVE (PCGen methods on the stack):")
for f, c in inclusive.most_common(28):
    print(f"  {100 * c / n:5.1f}%  {f}")
print("\nSELF (where the CPU actually is):")
for f, c in selfc.most_common(12):
    print(f"  {100 * c / n:5.1f}%  {f}")
print("\nSELF by nearest PCGen method:")
for f, c in selfpc.most_common(15):
    print(f"  {100 * c / n:5.1f}%  {f}")
