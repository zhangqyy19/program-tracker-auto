#!/usr/bin/env python3
"""Program tracker: checks whether early-career programs are open for US students.

Reads docs/programs.json, checks each program's source (Greenhouse job board,
HTML page, or Google Careers search), and writes docs/status.json. The static
site in docs/ renders that file and can also re-run the Greenhouse checks live
in the browser.

Usage:
    python tracker/tracker.py            # write docs/status.json
    python tracker/tracker.py --dry-run  # print results, do not write
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import re
import sys
import time
from pathlib import Path

from bs4 import BeautifulSoup
from curl_cffi import requests

ROOT = Path(__file__).resolve().parent.parent
PROGRAMS_PATH = ROOT / "docs" / "programs.json"
STATUS_PATH = ROOT / "docs" / "status.json"

GREENHOUSE_API = "https://boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true"

MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}
MONTH_RE = r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?"
DAY_RE = r"(\d{1,2})(?:st|nd|rd|th)?"
YEAR_RE = r"(20\d\d)"
# "November 15th, 2026" / "Nov 15, 2026" / "15 November 2026"
DATE_MDY = re.compile(rf"({MONTH_RE})\s+{DAY_RE},?\s+{YEAR_RE}", re.I)
DATE_DMY = re.compile(rf"{DAY_RE}\s+({MONTH_RE})\s+{YEAR_RE}", re.I)
DEADLINE_CUE = re.compile(
    r"(deadline|apply by|applications?\s+(?:close|closes|closing|due|must be (?:submitted|received))|closes? on|due by)",
    re.I,
)

session = requests.Session(impersonate="chrome")
TIMEOUT = 40


# ----------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------
def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def fetch(url: str, retries: int = 2):
    last = None
    for attempt in range(retries + 1):
        try:
            r = session.get(url, timeout=TIMEOUT)
            if r.status_code == 200:
                return r
            last = RuntimeError(f"HTTP {r.status_code}")
        except Exception as exc:  # noqa: BLE001
            last = exc
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"fetch failed for {url}: {last}")


def html_to_text(raw: str) -> str:
    soup = BeautifulSoup(raw, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg"]):
        tag.decompose()
    text = soup.get_text(" ")
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def parse_date(match: re.Match, dmy: bool) -> dt.date | None:
    try:
        if dmy:
            day, mon, year = match.group(1), match.group(2), match.group(3)
        else:
            mon, day, year = match.group(1), match.group(2), match.group(3)
        m = MONTHS.get(mon[:4].lower().rstrip(".")) or MONTHS.get(mon[:3].lower())
        if not m:
            return None
        return dt.date(int(year), m, int(day))
    except (ValueError, KeyError):
        return None


def find_deadline(text: str) -> tuple[dt.date | None, str | None]:
    """Find the first date that follows a deadline cue. Returns (date, raw snippet)."""
    best: tuple[int, dt.date, str] | None = None
    for cue in DEADLINE_CUE.finditer(text):
        window = text[cue.start(): cue.start() + 160]
        for rx, dmy in ((DATE_MDY, False), (DATE_DMY, True)):
            m = rx.search(window)
            if m:
                d = parse_date(m, dmy)
                if d:
                    snippet = re.sub(r"\s+", " ", window[: m.end()]).strip()
                    if best is None or cue.start() < best[0]:
                        best = (cue.start(), d, snippet)
                break
    if best:
        return best[1], best[2]
    return None, None


def find_program_dates(text: str) -> str | None:
    m = re.search(
        rf"(?:When|Program Dates?|Event Dates?|Dates?)\s*:\s*([^.]{{0,120}}?{YEAR_RE})", text, re.I
    )
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else None


def year_of_study(grad_year: int, today: dt.date) -> int:
    """1 = first-year ... 4 = final year, assuming a four-year degree."""
    academic_year_end = today.year + (1 if today.month >= 7 else 0)
    remaining = grad_year - academic_year_end
    return max(1, min(4, 4 - remaining))


def assess_fit(text: str, grad_year: int, today: dt.date) -> tuple[str, str]:
    """Return ("fit"|"unlikely"|"unknown", reason) for the profile's graduation year."""
    if not text:
        return "unknown", "No eligibility text found."
    fits: list[str] = []
    misses: list[str] = []

    # Graduation-date ranges such as "December 2028 – June 2030" or "Winter 2027 and Spring 2028".
    season = r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Winter|Spring|Summer|Fall|Autumn)[a-z]*\.?"
    range_rx = re.compile(
        rf"(?:graduat\w*|class of)[^.]{{0,80}}?(?:{season}\s+)?{YEAR_RE}\s*(?:-|–|—|to|and|through)\s*(?:{season}\s+)?{YEAR_RE}"
        rf"|(?:{season}\s+)?{YEAR_RE}\s*(?:-|–|—|to|and|through)\s*(?:{season}\s+)?{YEAR_RE}[^.]{{0,40}}graduat",
        re.I,
    )
    for m in range_rx.finditer(text):
        years = [int(y) for y in m.groups() if y]
        if len(years) >= 2:
            lo, hi = min(years), max(years)
            snippet = text[m.start(): m.end()].strip()
            (fits if lo <= grad_year <= hi else misses).append(f"graduation window {lo}-{hi}: \"{snippet}\"")

    # Single graduation years: "graduating in 2029", "2029 graduates", "class of 2029".
    single_rx = re.compile(
        rf"(?:graduat\w*\s+(?:in|by|during)?\s*(?:{season}\s+)?{YEAR_RE})|(?:{YEAR_RE}\s+graduates?)|(?:class of\s+{YEAR_RE})",
        re.I,
    )
    for m in single_rx.finditer(text):
        y = int(next(g for g in m.groups() if g))
        if any(str(y) in f for f in fits + misses):
            continue
        snippet = text[m.start(): m.end()].strip()
        (fits if y == grad_year else misses).append(f"\"{snippet}\"")

    # Penultimate-year phrasing: "penultimate year in Summer 2027" => graduating the next year.
    for m in re.finditer(rf"penultimate[^.]{{0,60}}?{YEAR_RE}", text, re.I):
        y = int(m.group(1))
        snippet = text[m.start(): m.end()].strip()
        (fits if y + 1 == grad_year else misses).append(f"\"{snippet}\"")

    # Year-of-study phrasing.
    yos = year_of_study(grad_year, today)
    years_mentioned: set[int] = set()
    if re.search(r"first[\s-]*(?:and|or|/|&)?[\s-]*(?:second)?[\s-]*year|freshm[ae]n|\b1st[\s-]*year", text, re.I):
        years_mentioned.add(1)
    if re.search(r"second[\s-]*year|sophomore|\b2nd[\s-]*year|rising junior", text, re.I):
        years_mentioned.add(2)
    if re.search(r"third[\s-]*year|junior(?!s? (?:year|and))|\b3rd[\s-]*year|rising senior", text, re.I):
        years_mentioned.add(3)
    if re.search(r"final[\s-]*year|fourth[\s-]*year|senior", text, re.I):
        years_mentioned.add(4)
    if years_mentioned:
        label = {1: "first-year", 2: "second-year", 3: "third-year", 4: "final-year"}
        listed = ", ".join(label[y] for y in sorted(years_mentioned))
        if yos in years_mentioned:
            fits.append(f"mentions {listed} students (you are a {label[yos]})")
        else:
            misses.append(f"mentions {listed} students only (you are a {label[yos]})")

    if fits:
        return "fit", "; ".join(fits[:3])
    if misses:
        return "unlikely", "; ".join(misses[:3])
    return "unknown", "No graduation-year or year-of-study wording found."


def eligibility_excerpt(text: str, limit: int = 420) -> str:
    strong = re.compile(
        r"(eligib|qualif|requirement|who:|open to|must be|graduat\w*\s+(?:in|by|between|date)|first[- ]year|second[- ]year)", re.I
    )
    weak = re.compile(r"(undergraduate|students? (?:who|in their))", re.I)
    m = strong.search(text) or weak.search(text)
    if not m:
        return text[:limit]
    start = max(0, m.start() - 40)
    return text[start: start + limit].strip()


# ----------------------------------------------------------------------------
# checkers
# ----------------------------------------------------------------------------
def check_greenhouse(program: dict, cfg: dict, us_rx: re.Pattern) -> dict:
    boards = [cfg["board"], *cfg.get("extra_boards", [])]
    title_rx = re.compile(cfg["title"], re.I)
    excl_rx = re.compile(cfg["title_exclude"], re.I) if cfg.get("title_exclude") else None
    matches = []
    for board in boards:
        data = fetch(GREENHOUSE_API.format(board=board)).json()
        for job in data.get("jobs", []):
            title = job.get("title", "")
            loc = (job.get("location") or {}).get("name", "") or ""
            if not title_rx.search(title) or (excl_rx and excl_rx.search(title)):
                continue
            if not us_rx.search(f"{title} {loc}"):
                continue
            matches.append({"job": job, "board": board, "text": html_to_text(html.unescape(job.get("content") or ""))})
    result = {
        "source": f"Greenhouse board(s): {', '.join(boards)}",
        "status": "open" if matches else "closed",
        "matches": [
            {"title": m["job"]["title"], "location": (m["job"].get("location") or {}).get("name"), "url": m["job"]["absolute_url"]}
            for m in matches
        ],
    }
    if matches:
        first = matches[0]
        result["title"] = first["job"]["title"]
        result["location"] = (first["job"].get("location") or {}).get("name")
        result["link"] = first["job"]["absolute_url"]
        result["posted_at"] = first["job"].get("updated_at")
        text = " ".join(m["text"] for m in matches)
        result["text"] = text
    else:
        result["note"] = "No US posting matching the program title is on the job board right now."
    return result


def extract_block(text: str, cfg: dict) -> str | None:
    if not cfg.get("block_start"):
        return text
    m = re.search(cfg["block_start"], text, re.I)
    if not m:
        return None
    rest = text[m.start():]
    if cfg.get("block_end"):
        e = re.search(cfg["block_end"], rest[m.end() - m.start():], re.I)
        if e:
            rest = rest[: (m.end() - m.start()) + e.start()]
    return rest


def pick_link(soup: BeautifulSoup, base_url: str, pattern: str | None) -> str | None:
    if not pattern:
        return None
    rx = re.compile(pattern, re.I)
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if rx.search(href):
            if href.startswith("/"):
                from urllib.parse import urljoin
                href = urljoin(base_url, href)
            return href
    return None


def check_html(program: dict, cfg: dict) -> dict:
    r = fetch(cfg["url"])
    soup = BeautifulSoup(r.text, "html.parser")
    text = html_to_text(r.text)
    block = extract_block(text, cfg)
    result = {"source": cfg["url"]}
    if block is None:
        result.update(status="closed", note="The US section was not found on the page.")
        return result
    flags = 0 if cfg.get("case_sensitive") else re.I
    open_rx = re.compile(cfg["open_regex"], flags) if cfg.get("open_regex") else None
    closed_rx = re.compile(cfg["closed_regex"], re.I) if cfg.get("closed_regex") else None
    window = int(cfg.get("closed_window", 400))
    opened = False
    hit_text = None
    for m in (open_rx.finditer(block) if open_rx else []):
        look = block[m.start(): m.end() + window]
        if closed_rx and closed_rx.search(look):
            continue
        opened = True
        hit_text = look
        break
    if opened:
        result["status"] = "open"
        result["text"] = block
        result["hit"] = (hit_text or "")[:200]
        result["link"] = pick_link(soup, cfg["url"], cfg.get("apply_link")) or cfg["url"]
        if cfg.get("eligibility_regex"):
            em = re.search(cfg["eligibility_regex"], text, re.I | re.S)
            if em:
                result["eligibility_text"] = em.group(0)
    else:
        result["status"] = "closed"
        result["note"] = (
            "Page mentions the program but marks applications closed."
            if closed_rx and open_rx and open_rx.search(block) else
            "No open-application wording found on the page."
        )
        result["text"] = block
    return result


def check_google_careers(program: dict, cfg: dict) -> dict:
    r = fetch(cfg["search_url"])
    slugs = sorted(set(re.findall(r"jobs/results/(\d+-[a-z0-9-]+)", r.text)))
    rx = re.compile(cfg["slug"], re.I)
    hits = [s for s in slugs if rx.search(s)]
    result = {"source": "Google Careers search", "matches": []}
    if hits:
        base = "https://www.google.com/about/careers/applications/jobs/results/"
        result["status"] = "open"
        result["link"] = base + hits[0]
        result["title"] = hits[0].split("-", 1)[1].replace("-", " ").title()
        result["matches"] = [{"title": h, "url": base + h} for h in hits]
        try:
            result["text"] = html_to_text(fetch(result["link"]).text)[:6000]
        except Exception as exc:  # noqa: BLE001
            result["text_error"] = str(exc)
    else:
        result["status"] = "closed"
        result["note"] = f"No matching intern posting among {len(slugs)} search results."
    return result


def run_check(program: dict, us_rx: re.Pattern) -> dict:
    cfg = program["check"]
    kind = cfg["type"]
    if kind == "greenhouse":
        return check_greenhouse(program, cfg, us_rx)
    if kind == "html":
        return check_html(program, cfg)
    if kind == "google_careers":
        return check_google_careers(program, cfg)
    raise ValueError(f"unknown check type {kind}")


# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------
def evaluate(program: dict, profile: dict, us_rx: re.Pattern, today: dt.date, previous: dict | None) -> dict:
    checked_at = now_utc().isoformat(timespec="seconds")
    out = {
        "id": program["id"],
        "firm": program["firm"],
        "name": program["name"],
        "info_url": program.get("info_url"),
        "check_type": program["check"]["type"],
        "checked_at": checked_at,
    }
    try:
        res = run_check(program, us_rx)
    except Exception as exc:  # noqa: BLE001
        log(f"  ! {program['id']}: {exc}")
        out.update(status="error", error=str(exc))
        if previous:
            for k in ("deadline", "deadline_text", "link", "fit", "fit_reason", "first_seen_open", "last_change"):
                if k in previous:
                    out[k] = previous[k]
        return out

    status = res["status"]
    out["status"] = status
    out["source"] = res.get("source")
    for k in ("title", "location", "link", "note", "matches", "posted_at"):
        if res.get(k) is not None:
            out[k] = res[k]

    # Deadline / eligibility from the status source, then from details_url.
    texts: list[tuple[str, str]] = []
    if res.get("text"):
        texts.append(("posting", res["text"]))
    if program.get("details_url"):
        try:
            texts.append(("details", html_to_text(fetch(program["details_url"]).text)))
        except Exception as exc:  # noqa: BLE001
            out["details_error"] = str(exc)

    deadline = None
    for origin, text in texts:
        d, raw = find_deadline(text)
        if d:
            deadline = d
            out["deadline"] = d.isoformat()
            out["deadline_text"] = raw
            out["deadline_source"] = origin
            break
    for origin, text in texts:
        dates = find_program_dates(text)
        if dates:
            out["program_dates"] = dates
            break

    elig_text = res.get("eligibility_text") or " ".join(t for _, t in texts)
    fit, reason = assess_fit(elig_text, int(profile["grad_year"]), today)
    out["fit"] = fit
    out["fit_reason"] = reason
    if elig_text:
        out["eligibility_excerpt"] = eligibility_excerpt(res.get("eligibility_text") or elig_text)

    # A deadline that already passed closes an HTML-only source; a Greenhouse posting still
    # listed is authoritative, so only flag the stale deadline there.
    if deadline and deadline < today:
        if out["check_type"] == "html" and status == "open":
            out["status"] = "closed"
            out["note"] = f"Application deadline {deadline.isoformat()} has passed."
        elif status == "open":
            out["deadline_stale"] = True

    # Change tracking.
    if out["status"] == "open":
        out["first_seen_open"] = (previous or {}).get("first_seen_open") if (previous or {}).get("status") == "open" else checked_at
        out["first_seen_open"] = out["first_seen_open"] or checked_at
    if previous and previous.get("status") != out["status"]:
        out["last_change"] = checked_at
        out["previous_status"] = previous.get("status")
    elif previous and previous.get("last_change"):
        out["last_change"] = previous["last_change"]
        out["previous_status"] = previous.get("previous_status")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", help="comma-separated program ids")
    args = ap.parse_args()

    config = json.loads(PROGRAMS_PATH.read_text())
    profile = config["profile"]
    us_rx = re.compile(config["us_location_regex"], re.I)
    today = dt.date.today()

    previous_results: dict[str, dict] = {}
    if STATUS_PATH.exists():
        try:
            for r in json.loads(STATUS_PATH.read_text()).get("results", []):
                previous_results[r["id"]] = r
        except json.JSONDecodeError:
            pass

    only = set(args.only.split(",")) if args.only else None
    results = []
    for program in config["programs"]:
        if only and program["id"] not in only:
            continue
        log(f"checking {program['id']} ...")
        results.append(evaluate(program, profile, us_rx, today, previous_results.get(program["id"])))
        r = results[-1]
        log(f"  -> {r['status']}" + (f" | deadline {r.get('deadline')}" if r.get("deadline") else "") + f" | fit: {r.get('fit')}")

    if only:
        # keep untouched programs from the previous run
        kept = [previous_results[p["id"]] for p in config["programs"] if p["id"] not in only and p["id"] in previous_results]
        order = {p["id"]: i for i, p in enumerate(config["programs"])}
        results = sorted(results + kept, key=lambda r: order.get(r["id"], 999))

    payload = {
        "generated_at": now_utc().isoformat(timespec="seconds"),
        "profile": profile,
        "open_count": sum(1 for r in results if r["status"] == "open"),
        "results": results,
    }
    if args.dry_run:
        print(json.dumps(payload, indent=2))
        return 0
    STATUS_PATH.write_text(json.dumps(payload, indent=2) + "\n")
    log(f"wrote {STATUS_PATH} ({payload['open_count']} open)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
