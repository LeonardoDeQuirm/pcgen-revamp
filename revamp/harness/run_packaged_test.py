"""Packaged-mode test: the sidecar serves the built UI itself, picks its own free port, and demands a
secret token on every API call (what the desktop app will use).

Usage: python harness/run_packaged_test.py
Needs: the engine built, `powershell sidecar/build.ps1`, and `npm run build` in revamp/ui (makes ui/dist).
"""
import json, re, shutil, subprocess, sys, tempfile, threading, urllib.error, urllib.request
from pathlib import Path

from run_harness import CHAR_DIRS, DEFAULT_JDK, PCGEN

UI_DIST = Path(__file__).resolve().parent.parent / "ui" / "dist"
TOKEN = "test-secret-123"
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if ok or not detail else ' - ' + str(detail)}")


def get(base, path, headers=None):
    req = urllib.request.Request(base + path, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers


def main():
    if not (UI_DIST / "index.html").exists():
        print("ui/dist missing: run `npm run build` in revamp/ui first")
        return 2
    work = Path(tempfile.mkdtemp(prefix="pkg-char-"))
    char = work / "pf_Cleric.pcg"
    shutil.copyfile(CHAR_DIRS[0] / "pf_Cleric.pcg", char)
    cmd = [str(DEFAULT_JDK / "bin" / "java.exe"), "-cp", "revamp/sidecar/build;build/libs/*", "pcgen.sidecar.Sidecar",
           "--settings-dir", tempfile.mkdtemp(prefix="pkg-test-"), "--from-character", str(char),
           "--port", "0", "--ui-dir", str(UI_DIST), "--token", TOKEN]
    proc = subprocess.Popen(cmd, cwd=PCGEN, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    found = {}
    ready = threading.Event()

    def watch():
        for line in proc.stdout:
            m = re.match(r"READY http://127\.0\.0\.1:(\d+)", line)
            if m:
                found["port"] = int(m.group(1))
                ready.set()
    threading.Thread(target=watch, daemon=True).start()
    try:
        if not ready.wait(180):
            raise RuntimeError("sidecar never reported READY")
        port = found["port"]
        base = f"http://127.0.0.1:{port}"
        check("port 0 picks a real free port", port > 1024 and port != 8765, port)

        st, body, hdr = get(base, "/")
        check("the page is served at /", st == 200 and b"<div id=\"root\"" in body and "text/html" in hdr["Content-Type"], st)
        js = re.search(rb'src="(/assets/[^"]+\.js)"', body)
        st, body, hdr = get(base, js.group(1).decode()) if js else (0, b"", {})
        check("its script is served with the right type", st == 200 and "javascript" in hdr["Content-Type"], st)

        check("a path with .. cannot leave the UI folder", get(base, "/%2e%2e/%2e%2e/build.gradle")[0] in (400, 403, 404))
        check("the folder above is not reachable either", get(base, "/..%5c..%5cbuild.gradle")[0] in (400, 403, 404))

        check("API without the token is refused", get(base, "/api/health")[0] == 403)
        check("API with a wrong token is refused", get(base, "/api/health", {"X-Pcgen-Token": "nope"})[0] == 403)
        st, body, _ = get(base, "/api/health", {"X-Pcgen-Token": TOKEN})
        check("API with the token works under /api/", st == 200 and isinstance(json.loads(body), dict), st)
        check("the same call without /api/ also works", get(base, "/health", {"X-Pcgen-Token": TOKEN})[0] == 200)
        req = urllib.request.Request(base + "/api/characters", data=json.dumps({"path": str(char)}).encode(),
                                     headers={"X-Pcgen-Token": TOKEN, "Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=120) as r:
            opened = r.status
        st, body, _ = get(base, "/api/characters", {"X-Pcgen-Token": TOKEN})
        check("a character can be opened and is listed", opened == 200 and st == 200 and b"pf_Cleric" in body, (opened, st))
        check("a foreign Host is still refused", get(base, "/api/health", {"X-Pcgen-Token": TOKEN, "Host": "evil.example"})[0] == 403)

    finally:
        proc.kill()
    bad = [r for r in results if not r[1]]
    print(f"{len(results) - len(bad)}/{len(results)} checks passed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
