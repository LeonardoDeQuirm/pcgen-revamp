"""Every safety check for an engine change, in one go (about 10 minutes).

Usage: python harness/run_all_gates.py [fingerprint-baseline.json]
Runs: engine build, export harness, sidecar test, API test, PCGen's own unit tests, and (if a baseline file is
given) compares the loaded-dataset fingerprint. Prints one PASS/FAIL line per gate and exits non-zero on any FAIL.
"""
import glob, os, re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
HARNESS = Path(__file__).resolve().parent
JDK = r"C:\Program Files\Eclipse Adoptium\jdk-25.0.4.101-hotspot"
env = dict(os.environ, JAVA_HOME=JDK)
results = []


def run(label, cmd, ok, timeout=3600, **kw):
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=timeout, env=env, **kw)
    out = p.stdout + p.stderr
    good = ok(p.returncode, out)
    results.append(good)
    tail = [l for l in out.strip().splitlines() if l.strip()][-1:] or [""]
    print(f"{'PASS' if good else 'FAIL'}  {label}  ({tail[0][:90]})", flush=True)
    return out


run("engine builds", [str(ROOT / "gradlew.bat"), "qbuild", "-x", "test"], lambda rc, o: rc == 0 and "BUILD SUCCESSFUL" in o)
run("sidecar builds", ["powershell", "-NoProfile", "-File", "revamp/sidecar/build.ps1"], lambda rc, o: rc == 0)
def all_ok(o, what="ok"):
    m = re.search(r"(\d+)/(\d+) " + what, o)
    return bool(m) and m.group(1) == m.group(2)


run("export harness", [sys.executable, str(HARNESS / "run_harness.py")], lambda rc, o: all_ok(o))
run("sidecar test", [sys.executable, str(HARNESS / "run_sidecar_test.py")], lambda rc, o: all_ok(o, "sidecars ok"))  # how many sidecars depends on which private characters exist
run("API test", [sys.executable, str(HARNESS / "run_api_test.py")],
    lambda rc, o: re.search(r"(\d+)/(\d+) checks passed", o) and re.search(r"(\d+)/(\d+) checks passed", o).group(1)
    == re.search(r"(\d+)/(\d+) checks passed", o).group(2))
if len(sys.argv) > 1:
    base = Path(sys.argv[1])
    new = base.with_name("fp_current.json")
    run("dataset fingerprint written", [sys.executable, str(HARNESS / "dataset_fingerprint.py"), str(new)],
        lambda rc, o: rc == 0)
    same = new.exists() and new.read_bytes() == base.read_bytes()
    results.append(same)
    print(f"{'PASS' if same else 'FAIL'}  dataset identical to baseline")
import time
started = time.time()
run("PCGen unit tests run", [str(ROOT / "gradlew.bat"), "cleanTest", "test", "--continue"], lambda rc, o: rc == 0, timeout=7200)
t = fail = 0
for f in glob.glob(str(ROOT / "build" / "test-results" / "test" / "*.xml")):
    if os.path.getmtime(f) < started:
        continue  # a result from an earlier run
    m = re.search(r'tests="(\d+)" skipped="(\d+)" failures="(\d+)" errors="(\d+)"',
                  open(f, encoding="utf-8", errors="replace").read(600))
    if m:
        t += int(m[1])
        fail += int(m[3]) + int(m[4])
ok = t > 17000 and fail == 0
results.append(ok)
print(f"{'PASS' if ok else 'FAIL'}  unit test results: {t} tests, {fail} failed")
sys.exit(0 if all(results) else 1)
