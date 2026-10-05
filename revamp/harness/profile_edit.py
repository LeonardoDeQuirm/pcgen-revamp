"""Where does an everyday edit (change an ability score, spend a skill rank) spend its time? JFR on a running sidecar.

Usage: python harness/profile_pdf.py [character id]      (start the stack first with start-dev.ps1)
"""
import collections, re, subprocess, sys, tempfile, urllib.request
from pathlib import Path

from run_harness import DEFAULT_JDK

cid = sys.argv[1] if len(sys.argv) > 1 else "clarent"
java = DEFAULT_JDK / "bin"
out = subprocess.run(["powershell", "-NoProfile", "-Command",
                      "(Get-CimInstance Win32_Process -Filter \"Name='java.exe'\" | Where-Object { $_.CommandLine -match 'pcgen.sidecar.Sidecar' } | Select-Object -First 1).ProcessId"],
                     capture_output=True, text=True).stdout.strip()
pid = out.splitlines()[-1]
jfr = Path(tempfile.mkdtemp(prefix="pdfprof-")) / "pdf.jfr"  # temp paths have no spaces, which jcmd needs
subprocess.run([str(java / "jcmd.exe"), pid, "JFR.start", "name=pdf", "settings=profile"], capture_output=True)
import json
B = f"http://127.0.0.1:8765/characters/{cid}"


def call(method, path, body=None):
    req = urllib.request.Request(B + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=300).read())


stat = call("GET", "")["stats"][0]
skill = next(x for x in call("GET", "/skills")["skills"] if x["ranks"] > 0)["key"]
for _ in range(12):
    call("PUT", f"/stats/{stat['key']}", {"base": stat["base"] + 1})
    call("PUT", f"/stats/{stat['key']}", {"base": stat["base"]})
    call("POST", "/skills", {"skill": skill, "points": 1})
    call("POST", "/skills", {"skill": skill, "points": -1})
subprocess.run([str(java / "jcmd.exe"), pid, "JFR.dump", "name=pdf", f"filename={jfr}"], capture_output=True)
subprocess.run([str(java / "jcmd.exe"), pid, "JFR.stop", "name=pdf"], capture_output=True)
txt = subprocess.run([str(java / "jfr.exe"), "print", "--events", "jdk.ExecutionSample", "--stack-depth", "90", str(jfr)],
                     capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
events = txt.split("jdk.ExecutionSample")[1:]
n = len(events)
inc, selfc = collections.Counter(), collections.Counter()
for e in events:
    fr = re.findall(r"^\s+([\w.$<>]+)\(", e, re.M)
    if fr:
        selfc[fr[0]] += 1
    for f in set(fr):
        if f.startswith(("pcgen.", "plugin.", "org.apache.fop", "net.sf.saxon")):
            inc[f] += 1
print(f"{n} samples")
print("\nINCLUSIVE:")
for f, c in inc.most_common(40):
    print(f"  {100 * c / n:5.1f}%  {f}")
print("\nSELF:")
for f, c in selfc.most_common(12):
    print(f"  {100 * c / n:5.1f}%  {f}")
