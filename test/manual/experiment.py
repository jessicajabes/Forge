#!/usr/bin/env python3
"""T27: runs one reference task in one configuration and prints its metrics as JSON.

  python3 test/manual/experiment.py --task is-number --config arena
  python3 test/manual/experiment.py --task slugify --config simple
  python3 test/manual/experiment.py --task slugify --config direct

Configurations:
  arena   forge-jj, complete run, 3 candidates
  simple  forge-jj, complete run, --no-arena
  direct  one `claude -p` call with the task text, no Forge

Everything happens in a throwaway copy under --work (default: a temp dir). It spends the
quota of your Claude Code plan: arena is about 20 model calls, simple about 11, direct 1.
Nothing is pushed anywhere. The Grill is answered by a script (`chega`, then `sim`), so
the interview is as short as it can be and the spec is thin: say so when you read results.
"""
import argparse, glob, json, os, pty, re, select, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

TASKS = {
    "is-number": {
        "repo": "https://github.com/jonschlinkert/is-number.git",
        "test": ["npx", "mocha"],
        "allowed": ["npx mocha"],
        "text": "Make isNumber return false for hexadecimal, octal and binary strings such as '0x1A', '0b11' and '0o7', while decimal and exponent strings such as '12', '-1.5' and '1e3' stay valid. Add tests for both groups.",
    },
    "slugify": {
        "repo": "https://github.com/sindresorhus/slugify.git",
        "test": ["npx", "ava"],
        "allowed": ["npx ava"],
        "text": "Add a maxLength option to slugify: when it is set, the slug is cut to at most that many characters and never ends with the separator. Update index.js, the TypeScript types in index.d.ts, the readme and the tests.",
    },
}

# What to type when the Forge asks something. The first match wins.
ANSWERS = [
    (r"Há um rascunho do Grill.*: $", "r"),
    (r"Confirma o resumo\?.*: $", "sim"),
    (r"aprovar \| editar \| cancelar \| rodar sem arena: $", "aprovar"),
    (r"Gravar\? \[sim / não / editar\]: $", "não"),
    (r"Números a remover.*: $", ""),
    (r"\n> $", "chega"),
]

def node_env():
    env = dict(os.environ)
    bins = sorted(glob.glob(os.path.expanduser("~/.nvm/versions/node/*/bin")))
    if bins:
        env["PATH"] = bins[-1] + ":" + env["PATH"]
    return env

def sh(cmd, cwd, env=None, check=True):
    return subprocess.run(cmd, cwd=cwd, env=env or node_env(), text=True, capture_output=True, check=check)

def prepare(task_id, work):
    t = TASKS[task_id]
    base = os.path.join(work, f"{task_id}-base")
    if not os.path.isdir(base):
        sh(["git", "clone", "-q", "--depth", "1", t["repo"], base], work)
        sh(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"], base)
        sh(["git", "checkout", "-q", "-b", "feature/reference"], base)
        with open(os.path.join(base, ".workflow.yml"), "w") as f:
            f.write("dev:\n  allowed_commands: [%s]\n" % ", ".join(t["allowed"]))
        sh(["git", "-c", "user.email=ref@example.test", "-c", "user.name=ref", "add", "-A"], base)
        sh(["git", "-c", "user.email=ref@example.test", "-c", "user.name=ref", "commit", "-q", "-m", "reference baseline"], base)
        sh(["git", "config", "user.email", "ref@example.test"], base)
        sh(["git", "config", "user.name", "ref"], base)
    return base

def drive(cmd, cwd, env, log_path, timeout):
    """Runs cmd in a pseudo terminal and answers its prompts from ANSWERS."""
    master, slave = pty.openpty()
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    buf, transcript, deadline = "", "", time.time() + timeout
    while proc.poll() is None and time.time() < deadline:
        ready, _, _ = select.select([master], [], [], 1.0)
        if not ready:
            continue
        try:
            chunk = os.read(master, 4096).decode("utf-8", "replace")
        except OSError:
            break
        transcript += chunk
        buf += chunk
        clean = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", buf).replace("\r", "")
        for pattern, answer in ANSWERS:
            if re.search(pattern, clean):
                time.sleep(0.3)
                os.write(master, (answer + "\n").encode())
                buf = ""
                break
    if proc.poll() is None:
        proc.kill()
    with open(log_path, "w") as f:
        f.write(re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", transcript))
    return proc.returncode

def metrics(task_id, config, repo, seconds, exit_code, extra=None):
    t = TASKS[task_id]
    tests = sh(t["test"], repo, check=False)
    diff = sh(["git", "diff", "--stat", "feature/reference"], repo, check=False).stdout.strip().splitlines()
    out = {
        "task": task_id, "config": config, "exit_code": exit_code, "seconds": round(seconds),
        "tests_pass": tests.returncode == 0,
        "diff_summary": diff[-1].strip() if diff else "no changes",
    }
    calls = sorted(glob.glob(os.path.join(repo, ".workflow", "runs", "*", "calls.jsonl")))
    if calls:
        rows = [json.loads(l) for p in calls for l in open(p) if l.strip()]
        out.update(calls=len(rows), prompt_chars=sum(r["promptChars"] for r in rows),
                   output_chars=sum(r["outputChars"] for r in rows), failed_calls=sum(1 for r in rows if not r["ok"]))
    reviews = sorted(glob.glob(os.path.join(repo, ".workflow", "runs", "*", "review.md")))
    if reviews:
        text = open(reviews[-1]).read()
        m = re.search(r"Ciclos realizados\*\*: (\d+) de (\d+)", text)
        v = re.search(r"Veredito\*\*: (.+)", text)
        out.update(review_cycles=int(m.group(1)) if m else None, review_verdict=v.group(1).strip() if v else None)
    out.update(extra or {})
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", choices=sorted(TASKS), required=True)
    ap.add_argument("--config", choices=["arena", "simple", "direct"], required=True)
    ap.add_argument("--work", default=None, help="directory for the throwaway copies")
    ap.add_argument("--timeout", type=int, default=2400)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    t = TASKS[a.task]
    if a.dry_run:
        print(json.dumps({"task": a.task, "config": a.config, "repo": t["repo"], "text": t["text"]}, indent=2))
        return
    work = a.work or os.path.join(tempfile.gettempdir(), "forge-t27")
    os.makedirs(work, exist_ok=True)
    base = prepare(a.task, work)
    run = os.path.join(work, f"{a.task}-{a.config}")
    shutil.rmtree(run, ignore_errors=True)
    shutil.copytree(base, run, symlinks=True)
    env = node_env()
    started = time.time()
    extra = {}
    if a.config == "direct":
        allowed = "Read Grep Glob Edit Write " + " ".join("Bash(%s:*)" % c for c in t["allowed"])
        p = sh(["claude", "-p", t["text"], "--permission-mode", "acceptEdits", "--allowedTools", allowed,
                "--max-turns", "60", "--output-format", "json"], run, env, check=False)
        code = p.returncode
        try:
            j = json.loads(p.stdout)
            extra = {"calls": 1, "turns": j.get("num_turns"), "claude_reported_ms": j.get("duration_ms")}
        except ValueError:
            extra = {"calls": 1}
    else:
        flags = ["--arena", "3"] if a.config == "arena" else ["--no-arena"]
        cmd = ["node", os.path.join(ROOT, "dist", "index.js"), t["text"], "--size", "completo", "--review", "final"] + flags
        code = drive(cmd, run, env, os.path.join(work, f"{a.task}-{a.config}.log"), a.timeout)
    print(json.dumps(metrics(a.task, a.config, run, time.time() - started, code, extra), indent=2))

if __name__ == "__main__":
    main()
