#!/usr/bin/env python3
"""Rounds and tokens report for an Agetor board (owner plan of 2026-10-14).

For one local day: token use by step and model (Claude Code transcripts in
~/.claude/projects, Codex sessions in ~/.codex/sessions, matched to cards by
worktree and to steps by time), Build/Review/Finish visits, what sent work
back to Build, and how often a Review finding came back. Read-only: it reads
the running core's /tasks over its HTTP API and the local logs.

  python3 scripts/rounds-report.py                      # today
  python3 scripts/rounds-report.py --day 2026-10-15 --baseline ~/.agetor/reports/2026-10-14.json
  python3 scripts/rounds-report.py --save               # also write ~/.agetor/reports/<day>.json
"""
import argparse, collections, datetime, glob, json, os, re, urllib.request

HOME = os.path.expanduser("~")


def tasks():
    core = json.load(open(f"{HOME}/.agetor/agetor-core.json"))
    port = core.get("port", 4317)
    req = urllib.request.Request(f"http://127.0.0.1:{port}/tasks?archived=all", headers={"Authorization": f"Bearer {core['token']}"})
    data = json.load(urllib.request.urlopen(req, timeout=60))
    return data if isinstance(data, list) else data["tasks"]


def iso(s):
    return datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))


def report(day):
    start = datetime.datetime.combine(day, datetime.time()).astimezone()
    end = start + datetime.timedelta(days=1)
    lo, hi = start.timestamp() * 1000, end.timestamp() * 1000
    ts = tasks()
    cards = {os.path.realpath(t["worktreePath"]): t for t in ts if not t.get("pipelineParentId") and t.get("worktreePath")}
    names = {}
    for t in ts:
        for s in (((t.get("pipelineRun") or {}).get("snapshot") or {}).get("graph") or {}).get("steps", []):
            names[s["id"]] = s["name"]

    def where(cwd, when):
        cwd = os.path.realpath(cwd or "")
        card = next((t for wp, t in cards.items() if cwd == wp or cwd.startswith(wp + "/")), None)
        if not card:
            return ("(not a card)", "-")
        ms = when.timestamp() * 1000
        step = "?"
        for h in card["pipelineRun"].get("history", []):
            if (h.get("startedAt") or 0) - 60000 <= ms <= (h.get("endedAt") or 9e15) + 60000:
                step = names.get(h["stepId"], h["stepId"])
        return (card["title"][:60], step)

    claude = collections.defaultdict(collections.Counter)
    for f in glob.glob(f"{HOME}/.claude/projects/*/*.jsonl") + glob.glob(f"{HOME}/.claude/projects/*/*/*.jsonl"):
        if os.path.getmtime(f) < start.timestamp():
            continue
        cwd = None
        for line in open(f, errors="ignore"):
            try:
                o = json.loads(line)
            except ValueError:
                continue
            cwd = o.get("cwd") or cwd
            m = o.get("message")
            u = m.get("usage") if isinstance(m, dict) else None
            if not u or not o.get("timestamp"):
                continue
            w = iso(o["timestamp"])
            if not (start <= w < end):
                continue
            card, step = where(cwd, w)
            c = claude[(step if card != "(not a card)" else card, m.get("model", "?"))]
            c["out"] += u.get("output_tokens", 0)
            c["cache_read"] += u.get("cache_read_input_tokens", 0)
            c["cache_write"] += u.get("cache_creation_input_tokens", 0)
            c["msgs"] += 1
    codex = collections.defaultdict(collections.Counter)
    for d in {start.date(), (end - datetime.timedelta(seconds=1)).date(), (start - datetime.timedelta(days=1)).date()}:
        for f in glob.glob(f"{HOME}/.codex/sessions/{d:%Y/%m/%d}/*.jsonl"):
            cwd = None
            for line in open(f, errors="ignore"):
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                p = o.get("payload") or {}
                if o.get("type") == "session_meta":
                    cwd = p.get("cwd")
                info = p.get("info") or {}
                if p.get("type") == "token_count" and info.get("last_token_usage"):
                    w = iso(o["timestamp"])
                    if not (start <= w < end):
                        continue
                    u = info["last_token_usage"]
                    card, step = where(cwd, w)
                    c = codex[step if card != "(not a card)" else card]
                    c["input"] += u.get("input_tokens", 0)
                    c["uncached"] += u.get("input_tokens", 0) - u.get("cached_input_tokens", 0)
                    c["out"] += u.get("output_tokens", 0) + u.get("reasoning_output_tokens", 0)
                    c["turns"] += 1

    visits = collections.Counter()
    causes = collections.Counter()
    finished_cards = set()
    for t in ts:
        r = t.get("pipelineRun") or {}
        if t.get("pipelineParentId") or not r.get("snapshot"):
            continue
        sn = {s["id"]: s["name"] for s in r["snapshot"]["graph"]["steps"]}
        h = r.get("history", [])
        for i, x in enumerate(h):
            if not (lo <= (x.get("startedAt") or 0) < hi):
                continue
            name = sn.get(x["stepId"], "?")
            visits[name] += 1
            finished_cards.add(t["id"])
            if name != "Build" or i == 0:
                continue
            p = h[i - 1]
            pn = sn.get(p["stepId"])
            s = (p.get("handoff") or {}).get("summary", "")
            if pn == "Review":
                causes["Review: changes requested"] += 1
            elif pn == "Build":
                causes["Build again (gate)"] += 1
            elif pn == "Finish":
                causes["Finish: CI failed" if re.search(r"CI failed", s) else "Finish: conflict" if re.search(r"conflict|no longer merges", s, re.I) else "after publishing (merge queue)"] += 1
            elif pn == "Understand":
                causes["first Build"] += 1

    rounds = collections.Counter()
    repeats = collections.Counter()
    new = collections.Counter()
    for d in glob.glob(f"{HOME}/.agetor/pipeline-runs/*/"):
        files = sorted(glob.glob(d + "handoff-*.json"), key=lambda f: int(re.search(r"-(\d+)-from", f).group(1)))
        seen, n = set(), 0
        for f in files:
            try:
                hh = json.load(open(f))
            except ValueError:
                continue
            ra = (hh.get("handoff", hh) or {}).get("reviewApproval") or {}
            if ra.get("verdict") != "changes-requested":
                continue
            n += 1
            ids = set()
            for x in ra.get("findings") or []:
                m = re.match(r"[\s*`_>#-]*([A-Za-z0-9][A-Za-z0-9._]*(?:-[A-Za-z0-9._]+)*)[*`_]*\s*(?::|—|–|-\s|\))", str(x))
                if m and re.search(r"\d", m.group(1)):
                    ids.add(m.group(1).upper())
            if start.timestamp() <= os.path.getmtime(f) < end.timestamp():
                k = str(min(n, 6))
                rounds[k] += 1
                new[k] += len(ids - seen)
                repeats[k] += len(ids & seen)
            seen |= ids

    merged = len([1 for t in ts if not t.get("pipelineParentId") and t.get("prUrl") and (t.get("pipelineRun") or {}).get("endedAt") and lo <= t["pipelineRun"]["endedAt"] < hi])
    builds = visits.get("Build", 0)
    firsts = causes.get("first Build", 0)
    return {
        "day": str(day),
        "cards_active": len(finished_cards),
        "runs_finished_with_pr": merged,
        "visits": dict(visits),
        "rework_rounds": builds - firsts,
        "rework_causes": dict(causes),
        "changes_requested_by_round": dict(sorted(rounds.items())),
        "new_findings_by_round": dict(sorted(new.items())),
        "repeated_findings_by_round": dict(sorted(repeats.items())),
        "claude": {f"{k[0]} / {k[1]}": dict(v) for k, v in sorted(claude.items(), key=lambda kv: -kv[1]["out"])},
        "codex": {k: dict(v) for k, v in sorted(codex.items(), key=lambda kv: -kv[1]["input"])},
    }


def show(r, base=None):
    def cmp(key, val):
        b = base and base.get(key)
        return f"{val}" + (f"   (baseline {b})" if b is not None else "")
    M = 1e6
    print(f"Rounds report for {r['day']}")
    print("  cards active:", cmp("cards_active", r["cards_active"]))
    print("  visits:", r["visits"])
    print("  rework rounds:", cmp("rework_rounds", r["rework_rounds"]))
    print("  per active card:", round(r["rework_rounds"] / max(1, r["cards_active"]), 1),
          f"   (baseline {round(base['rework_rounds'] / max(1, base['cards_active']), 1)})" if base else "")
    print("  causes:", r["rework_causes"])
    print("  changes requested by review round:", r["changes_requested_by_round"])
    print("  new findings by round:", r["new_findings_by_round"])
    print("  repeated findings by round:", r["repeated_findings_by_round"])
    co = sum(v.get("out", 0) for v in r["claude"].values())
    cx = sum(v.get("input", 0) for v in r["codex"].values())
    bco = base and sum(v.get("out", 0) for v in base["claude"].values())
    bcx = base and sum(v.get("input", 0) for v in base["codex"].values())
    print(f"  Claude output {co / M:.2f}M" + (f" (baseline {bco / M:.2f}M)" if base else ""),
          f"| Codex input {cx / M:.0f}M" + (f" (baseline {bcx / M:.0f}M)" if base else ""))
    for k, v in list(r["claude"].items())[:6]:
        print(f"    claude {k:40s} out {v.get('out', 0) / M:5.2f}M  cache-read {v.get('cache_read', 0) / M:6.0f}M")
    for k, v in list(r["codex"].items())[:5]:
        print(f"    codex  {k:40s} in {v.get('input', 0) / M:5.0f}M  uncached {v.get('uncached', 0) / M:5.1f}M  turns {v.get('turns', 0)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--day", type=datetime.date.fromisoformat, default=datetime.date.today())
    ap.add_argument("--baseline", help="a report saved with --save to compare against")
    ap.add_argument("--save", action="store_true", help=f"write {HOME}/.agetor/reports/<day>.json")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    r = report(a.day)
    if a.save:
        os.makedirs(f"{HOME}/.agetor/reports", exist_ok=True)
        json.dump(r, open(f"{HOME}/.agetor/reports/{a.day}.json", "w"), indent=1)
    base = json.load(open(os.path.expanduser(a.baseline))) if a.baseline else None
    print(json.dumps(r, indent=1) if a.json else "", end="") if a.json else show(r, base)
