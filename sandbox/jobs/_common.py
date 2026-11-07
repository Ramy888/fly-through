# Shared helpers for sandbox jobs. Each job reads JSON on stdin and prints one JSON result on stdout.
import hashlib, json, sys

def read_params():
    return json.loads(sys.stdin.read() or "{}")

def finish(summary, manifest_rows, extra=None):
    text = "\n".join(",".join(str(c) for c in row) for row in manifest_rows)
    out = {"summary": summary, "rows": len(manifest_rows) - 1, "checksum": hashlib.sha256(text.encode()).hexdigest()[:16], "preview": manifest_rows[:4]}
    if extra:
        out.update(extra)
    print(json.dumps(out))
