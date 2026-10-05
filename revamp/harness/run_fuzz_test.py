"""Fuzz test: throw odd, empty, huge and hostile values at every route and check the sidecar never answers 5xx,
never hangs, never leaves an operation parked, and still serves normal requests afterwards.

Usage: python harness/run_fuzz_test.py [seed]
Works on temp copies; nothing of the repository or the user's characters is touched.
A 5xx answer is a bug in OUR code (it should have been a 4xx explaining what was wrong); the failures are listed
with the request that caused them so they can be turned into regression checks in run_api_test.py.
"""
import json, random, re, shutil, subprocess, sys, tempfile, threading, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

from run_harness import CHAR_DIRS, DEFAULT_JDK, PCGEN

PORT = 8898
SEED = int(sys.argv[1]) if len(sys.argv) > 1 else 1
rnd = random.Random(SEED)
CHAR = Path(tempfile.mkdtemp(prefix="fuzz-char-")) / "pf_Cleric.pcg"
shutil.copyfile(CHAR_DIRS[0] / "pf_Cleric.pcg", CHAR)
OUTDIR = tempfile.mkdtemp(prefix="fuzz-out-")

NASTY = ["", " ", "x" * 3000, "\u0000", "../../../etc/passwd", "..\\..\\x", "-1", "0", "1", "2", "99999999999", "-99999999999",
         "1e9", "NaN", "null", "true", "üñï©ode \U0001f600", "<script>alert(1)</script>", "%", "%zz",
         "'; DROP TABLE x;--", "Cleric", "Longsword", "Fireball", "Strength", "STR", "Human"]
JSONY = NASTY + [None, True, False, 0, -1, 7, 2**40, 1.5, [], {}, ["a"], {"a": 1}, [[[]]]]
FIELDS = ["item", "name", "category", "class", "level", "spell", "kit", "scheme", "skill", "points", "quantity", "node",
          "count", "path", "stat", "base", "rolled", "race", "deity", "alignment", "funds", "xp", "addXp", "gender",
          "handed", "age", "ageCategory", "template", "domain", "language", "text", "index", "title", "book", "set",
          "free", "customize", "all", "limit", "q", "character", "qualified", "kind", "dir", "format", "sheet", "select",
          "deselect", "cancel", "ok", "value", "field", "type", "xpTable", "characterType", "tabName", "playersName"]
INDEXES = ["0", "1", "5", "-1", "999", "x", "%00", ""]

results = {"calls": 0, "5xx": [], "hang": [], "bad_json": []}


def req(method, path, body=None, query=None, timeout=120):
    url = f"http://127.0.0.1:{PORT}{path}"
    if query:
        url += "?" + urllib.parse.urlencode(query, doseq=True, errors="surrogatepass") if True else ""
    data = None if body is None else (json.dumps(body) if not isinstance(body, bytes) else body)
    r = urllib.request.Request(url, data=data.encode() if isinstance(data, str) else data, method=method,
                               headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read(), resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get("Content-Type", "")


def settle(st, raw):
    """If the engine parked on a question, cancel it so the next request is not blocked."""
    for _ in range(6):
        if st != 202:
            break
        try:
            d = json.loads(raw)
        except Exception:
            break
        if "pendingChooser" in d:
            st, raw, _ = req("POST", f"/choosers/{d['pendingChooser']['id']}", {"cancel": True})
        elif "pendingConfirm" in d:
            st, raw, _ = req("POST", f"/confirms/{d['pendingConfirm']['id']}", {"ok": False})
        elif "pendingBuilder" in d:
            st, raw, _ = req("POST", "/builder/cancel", {})
        else:
            break
    return st, raw


def probe(method, path, body=None, query=None):
    results["calls"] += 1
    t0 = time.time()
    try:
        st, raw, ctype = req(method, path, body, query)
    except Exception as e:  # timeout or connection trouble: the sidecar hung or died
        results["hang"].append((method, path, str(body)[:200], str(query)[:200], repr(e)[:100]))
        return
    st, raw = settle(st, raw)
    if st >= 500:
        results["5xx"].append((method, path, str(body)[:200], str(query)[:200], st, raw[:200].decode("utf-8", "replace")))
    elif "json" in ctype:
        try:
            json.loads(raw)
        except Exception:
            results["bad_json"].append((method, path, st, raw[:100]))
    if time.time() - t0 > 60:
        results["hang"].append((method, path, str(body)[:100], str(query)[:100], f"slow {time.time() - t0:.0f}s"))


def start_sidecar():
    cmd = [str(DEFAULT_JDK / "bin" / "java.exe"), "-cp", "revamp/sidecar/build;build/libs/*", "pcgen.sidecar.Sidecar",
           "--settings-dir", tempfile.mkdtemp(prefix="fuzz-settings-"), "--from-character", str(CHAR), "--port", str(PORT)]
    proc = subprocess.Popen(cmd, cwd=PCGEN, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    ready = threading.Event()
    threading.Thread(target=lambda: [ready.set() for l in proc.stdout if l.startswith("READY")], daemon=True).start()
    if not ready.wait(180):
        proc.kill()
        raise RuntimeError("sidecar never reported READY")
    deadline = time.time() + 120
    while time.time() < deadline:
        try:
            if json.loads(req("GET", "/health")[1]).get("pdfWarmup") in ("done", "disabled"):
                break
        except Exception:
            pass
        time.sleep(0.5)
    return proc


def routes():
    st, raw, _ = req("GET", "/routes")
    d = json.loads(raw)
    items = d if isinstance(d, list) else d.get("routes", d)
    out = []
    for it in items:
        if isinstance(it, str):
            m, p = it.split(" ", 1)
        else:
            m, p = it["method"], it["path"]
        out.append((m.upper(), p))
    return out


def fill(path, cid):
    path = path.replace("{id}", urllib.parse.quote(cid))
    for key in ("index", "level", "stat"):
        path = path.replace("{" + key + "}", urllib.parse.quote(rnd.choice(INDEXES if key != "stat" else ["STR", "CON", "XYZ", "", "str"])))
    return re.sub(r"\{[^}]*\}", "x", path)


def main():
    proc = start_sidecar()
    try:
        st, raw, _ = req("POST", "/characters", {"path": str(CHAR)}, timeout=300)
        st, raw, _ = req("POST", "/characters/new", {"name": "Fuzz Fresh", "id": "fuzzfresh"})
        allr = [(m, p) for m, p in routes() if m in ("GET", "POST", "PUT", "PATCH", "DELETE")]
        skip = {"/shutdown", "/characters/{id}/export", "/characters/{id}", "/templates", "/characters/{id}/save"}
        dangerous_delete = ("DELETE", "/characters/{id}")
        print(f"{len(allr)} routes; seed {SEED}", flush=True)
        for rounds in range(3):
            for method, path in allr:
                if path in skip and (method, path) != ("GET", "/characters/{id}"):
                    continue
                for cid in ("pf_Cleric", "fuzzfresh", "nosuchcharacter"):
                    for _ in range(4):
                        body = {f: rnd.choice(JSONY) for f in rnd.sample(FIELDS, rnd.randint(0, 6))}
                        query = {f: str(rnd.choice(NASTY)) for f in rnd.sample(FIELDS, rnd.randint(0, 4))}
                        if method in ("GET", "DELETE"):
                            probe(method, fill(path, cid), None, {**query, **{k: str(v) for k, v in body.items()}})
                        else:
                            probe(method, fill(path, cid), body, query)
            # raw garbage bodies
            for cid in ("pf_Cleric", "fuzzfresh"):
                for junk in (b"{", b"[1,2", b'{"a":', b"\xff\xfe", b"null", b"[]", b'"str"', b"{" * 5000 + b"}" * 5000):
                    probe("POST", f"/characters/{cid}/abilities", junk)
                    probe("PATCH", f"/characters/{cid}", junk)
            print(f"round {rounds + 1} done: {results['calls']} calls, {len(results['5xx'])} 5xx", flush=True)
        # Still alive and sane?
        st, raw, _ = req("GET", "/health")
        health = json.loads(raw)
        alive = st == 200
        clean = not (health.get("pendingChooser") or health.get("pendingConfirm") or health.get("pendingBuilder"))
        st2, raw2, _ = req("GET", "/characters/pf_Cleric")
        readable = st2 == 200
    finally:
        proc.kill()
    seen = set()
    print(f"\n{results['calls']} requests")
    for kind in ("5xx", "hang", "bad_json"):
        rows = results[kind]
        uniq = []
        for r in rows:
            sig = (r[0], r[1], r[4] if kind == "5xx" else "")
            if sig not in seen:
                seen.add(sig)
                uniq.append(r)
        print(f"{'FAIL' if rows else 'PASS'}  {kind}: {len(rows)} ({len(uniq)} distinct)")
        for r in uniq[:25]:
            print("   ", r)
    print(f"{'PASS' if alive and clean and readable else 'FAIL'}  sidecar still healthy afterwards "
          f"(alive={alive}, nothing parked={clean}, character readable={readable})")
    bad = results["5xx"] or results["hang"] or results["bad_json"] or not (alive and clean and readable)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
