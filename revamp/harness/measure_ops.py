"""How long do the bigger operations take (change race, level up, remove a level, add/remove a feat, buy gear)?

Usage: python harness/measure_ops.py [character id] [rounds]    (start the stack first; every change is undone)
Engine questions are answered with the first option / yes, so this measures the whole operation as the UI sees it.
Needs a character whose game data has a Fighter class and the Dodge feat (the Pathfinder core books).
"""
import json, sys, time, urllib.request, urllib.error

cid = sys.argv[1] if len(sys.argv) > 1 else "clarent"
rounds = int(sys.argv[2]) if len(sys.argv) > 2 else 3
B = "http://127.0.0.1:8765"


def call(method, path, body=None):
    req = urllib.request.Request(B + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def settle(st, d):
    while st == 202:
        if "pendingConfirm" in d:
            st, d = call("POST", f"/confirms/{d['pendingConfirm']['id']}", {"ok": True})
        elif "pendingChooser" in d:
            ch = d["pendingChooser"]
            n = max(ch.get("choicesRequired", 1), 1)
            st, d = call("POST", f"/choosers/{ch['id']}", {"select": list(range(n))})
        else:
            break
    return st, d


def timed(label, fn, rows):
    t0 = time.time()
    st, d = fn()
    rows.setdefault(label, []).append((time.time() - t0) * 1000)
    if st >= 400:
        print(f"  note: {label} answered {st}: {str(d)[:120]}")
    return st, d


C = f"/characters/{cid}"
rows = {}
race = call("GET", C)[1]["race"]
for _ in range(rounds):
    timed("level up (Fighter)", lambda: settle(*call("POST", C + "/levels", {"class": "Fighter"})), rows)
    timed("remove last level", lambda: settle(*call("DELETE", C + "/levels")), rows)
    timed("add a feat", lambda: settle(*call("POST", C + "/abilities", {"category": "FEAT", "name": "Dodge"})), rows)
    timed("remove a feat", lambda: settle(*call("DELETE", C + "/abilities", {"category": "FEAT", "name": "Dodge"})), rows)
    timed("change race to Human", lambda: settle(*call("PATCH", C, {"race": "Human"})), rows)
    timed("change race back", lambda: settle(*call("PATCH", C, {"race": race})), rows)
    timed("buy a Dagger", lambda: settle(*call("POST", C + "/equipment/buy", {"item": "Dagger", "quantity": 1})), rows)
    timed("sell the Dagger", lambda: settle(*call("POST", C + "/equipment/sell", {"item": "Dagger", "quantity": 1})), rows)
for k, v in rows.items():
    print(f"{k:24s} best {min(v):6.0f} ms   median {sorted(v)[len(v) // 2]:6.0f} ms")
print("(race restored to", call("GET", C)[1]["race"] + ")")
