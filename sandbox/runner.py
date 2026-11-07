"""Sandbox runner: the only component that can start containers.

The app never gets the Docker socket. It POSTs {"job": name, "params": {...}} here; the runner accepts only
allowlisted job names with small, typed parameters, and runs each job in a fresh, disposable container:
no network, read-only filesystem, all Linux capabilities dropped, no privilege escalation, an unprivileged user,
64 processes, 128 MB of memory, half a CPU, and a 10-second limit. Jobs are fixed Python scripts in jobs/.
"""
import json
import os
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

JOBS_DIR = os.environ.get("JOBS_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "jobs"))
IMAGE = os.environ.get("SANDBOX_IMAGE", "python:3.12-alpine")
RUNTIME = os.environ.get("SANDBOX_RUNTIME", "runc")
TIMEOUT_S = 10
MAX_OUT = 64 * 1024

# job name -> allowed parameters and their types
JOBS = {
    "hotel_block": {"airport": str, "guests": int},
    "meal_vouchers": {"airport": str, "guests": int},
    "crew_rest": {"airport": str, "crews": int},
    "position_crew": {"airport": str, "now": int},
}
AIRPORTS = {"HUB", "DWC", "SHJ", "AAN", "BAH"}

LIMITS = [
    "--rm", "-i", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "128m", "--cpus", "0.5",
    "--user", "65534:65534", "--tmpfs", "/tmp:size=8m",
]


def validate(body):
    job, params = body.get("job"), body.get("params")
    if job not in JOBS or not isinstance(params, dict) or set(params) != set(JOBS[job]):
        return None, "unknown job or wrong parameters"
    for key, typ in JOBS[job].items():
        if type(params[key]) is not typ:
            return None, f"{key} must be {typ.__name__}"
    if params["airport"] not in AIRPORTS:
        return None, "unknown airport"
    return (job, params), None


def run(job, params):
    cmd = ["docker", "run", *LIMITS, "--runtime", RUNTIME, "-v", f"{JOBS_DIR}:/jobs:ro", IMAGE, "python", f"/jobs/{job}.py"]
    started = time.monotonic()
    try:
        p = subprocess.run(cmd, input=json.dumps(params).encode(), capture_output=True, timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "timed out"}
    ms = round((time.monotonic() - started) * 1000)
    if p.returncode != 0:
        return {"ok": False, "error": p.stderr.decode()[-300:].strip() or f"exit {p.returncode}", "ms": ms}
    try:
        result = json.loads(p.stdout[:MAX_OUT])
    except ValueError:
        return {"ok": False, "error": "job output was not JSON", "ms": ms}
    return {"ok": True, "result": result, "ms": ms, "image": IMAGE, "runtime": RUNTIME,
            "limits": "no network · read-only · no capabilities · 128 MB · 0.5 CPU · 10 s"}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/run":
            return self.reply(404, {"ok": False, "error": "not found"})
        size = int(self.headers.get("Content-Length") or 0)
        if size > 4096:
            return self.reply(413, {"ok": False, "error": "request too large"})
        try:
            body = json.loads(self.rfile.read(size) or b"{}")
        except ValueError:
            return self.reply(400, {"ok": False, "error": "bad JSON"})
        valid, err = validate(body if isinstance(body, dict) else {})
        if err:
            return self.reply(400, {"ok": False, "error": err})
        self.reply(200, run(*valid))

    def do_GET(self):
        self.reply(200 if self.path == "/health" else 404, {"ok": self.path == "/health"})

    def reply(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8090"))), Handler).serve_forever()
