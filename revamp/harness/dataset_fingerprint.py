"""Fingerprint of everything a loaded source set offers, to prove a loading speed-up changed nothing.

Usage: python harness/dataset_fingerprint.py out.json [character.pcg]
Starts a sidecar on a copy of the character, reads every catalog (races, classes, skills, equipment, ...) and every
ability category in full, and writes the names and a short hash of each list. Two runs on the same character must
produce identical files.
"""
import hashlib, json, shutil, subprocess, sys, tempfile, threading, time, urllib.request
from pathlib import Path

from run_harness import DEFAULT_JDK, PCGEN

out = Path(sys.argv[1])
src = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parent.parent / "local" / "clarent.pcg"
work = Path(tempfile.mkdtemp(prefix="fp-"))
char = work / src.name
shutil.copyfile(src, char)
PORT = 8779
proc = subprocess.Popen(
    [str(DEFAULT_JDK / "bin" / "java.exe"), "-cp", "revamp/sidecar/build;build/libs/*", "pcgen.sidecar.Sidecar",
     "--settings-dir", tempfile.mkdtemp(prefix="fp-settings-"), "--from-character", str(char), "--port", str(PORT)],
    cwd=PCGEN, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
ready = threading.Event()
threading.Thread(target=lambda: [ready.set() for l in proc.stdout if l.startswith("READY")], daemon=True).start()
try:
    if not ready.wait(300):
        raise SystemExit("never ready")

    def get(path):
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=300) as r:
            return json.loads(r.read())

    summary = get("/dataset")
    result = {"gameMode": summary["gameMode"], "counts": summary["counts"], "lists": {}}
    kinds = list(summary["counts"])
    for kind in kinds:
        items = get(f"/dataset/{kind}?limit=100000")["items"]
        names = [f'{i.get("key")}|{i.get("name")}|{i.get("type")}|{i.get("source")}' for i in items]
        result["lists"][kind] = [len(names), hashlib.sha256("\n".join(names).encode()).hexdigest()[:16]]
    for cat in summary["abilityCategories"]:
        items = get("/dataset/abilities?category=" + urllib.request.quote(cat) + "&limit=100000")["items"]
        names = [f'{i.get("key")}|{i.get("name")}|{i.get("type")}|{i.get("source")}' for i in items]
        result["lists"]["ability:" + cat] = [len(names), hashlib.sha256("\n".join(names).encode()).hexdigest()[:16]]
    out.write_text(json.dumps(result, indent=1, sort_keys=True))
    print(f"wrote {out}: {len(result['lists'])} lists")
finally:
    proc.kill()
