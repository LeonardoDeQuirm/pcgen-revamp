"""How long does a PDF character sheet take? Times repeated exports on a running sidecar (default port 8765).

Usage: python harness/measure_pdf.py [character id] [runs]      (start the stack first with start-dev.ps1)
Reports the server-side time of each export (the X-Time-Ms header), so network and browser overhead are excluded.
"""
import json, sys, urllib.request

cid = sys.argv[1] if len(sys.argv) > 1 else "clarent"
runs = int(sys.argv[2]) if len(sys.argv) > 2 else 6
times = []
for i in range(runs):
    req = urllib.request.Request(f"http://127.0.0.1:8765/characters/{cid}/export", data=b'{"format": "pdf"}', method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        body = r.read()
        ms = int(r.headers.get("X-Time-Ms", "0"))
    times.append(ms)
    print(f"export {i + 1}: {ms} ms, {len(body) // 1024} KB, {r.headers.get('Content-Type')}")
print(f"best {min(times)} ms, median {sorted(times)[len(times) // 2]} ms")
