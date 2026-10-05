"""How long do everyday edits take? Times repeated edits on a running sidecar (port 8765) with a loaded character.

Usage: python harness/measure_edits.py [character id] [rounds]      (start the stack first; edits are undone each round)
Reports the server-side time (X-Time-Ms) per kind of edit: an ability score change, a skill rank, a name change, a
read of the whole character. Leaves the character as it found it.
"""
import json, sys, urllib.request

cid = sys.argv[1] if len(sys.argv) > 1 else "clarent"
rounds = int(sys.argv[2]) if len(sys.argv) > 2 else 5
B = f"http://127.0.0.1:8765/characters/{cid}"


def call(method, path, body=None):
    req = urllib.request.Request(B + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        raw = r.read()
        return int(r.headers.get("X-Time-Ms", "0")), json.loads(raw)


skills = call("GET", "/skills")[1]["skills"]
skill = next(s for s in skills if s["ranks"] > 0)["key"]
stat = call("GET", "")[1]["stats"][0]
rows = {"read whole character": [], "change a score": [], "skill rank +1": [], "skill rank -1": [], "rename": []}
name = call("GET", "")[1]["name"]
for _ in range(rounds):
    rows["read whole character"].append(call("GET", "")[0])
    rows["change a score"].append(call("PUT", f"/stats/{stat['key']}", {"base": stat["base"] + 1})[0])
    call("PUT", f"/stats/{stat['key']}", {"base": stat["base"]})
    rows["skill rank +1"].append(call("POST", "/skills", {"skill": skill, "points": 1})[0])
    rows["skill rank -1"].append(call("POST", "/skills", {"skill": skill, "points": -1})[0])
    rows["rename"].append(call("PATCH", "", {"name": name + "!"})[0])
    call("PATCH", "", {"name": name})
for k, v in rows.items():
    print(f"{k:24s} best {min(v):5d} ms   median {sorted(v)[len(v) // 2]:5d} ms")
