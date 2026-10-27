# Program Tracker

Tracks whether early-career quant / tech programs are **open to US undergraduates**, and shows the
**application deadline and link** when they are. Built for an undergraduate graduating in 2029; the
profile lives in `docs/programs.json` and drives the eligibility check.

Live site: GitHub Pages serves the `docs/` folder (setup below).

## What it tracks

| Firm | Program | How it is checked |
|---|---|---|
| Jane Street | FOCUS (NYC), INSIGHT (NYC), Bridge | Hidden Greenhouse events board `jshiddenevents`; deadline from the janestreet.com invite page |
| Optiver | FutureFocus (Chicago) | Greenhouse board `optiverus` |
| Hudson River Trading | Explore HRT, Inside HRT (NYC) | Greenhouse boards `wehrtyou`, `hrttalentcommunity` |
| IMC Trading | Launchpad (Chicago) | Greenhouse board `imc` |
| Google | ASDI / STEP internship (US) | Google Careers search results |
| Citadel, Citadel Securities | Discover (US) | Program page, "Discover – U.S." block |
| D. E. Shaw | Discovery / Latitude / Nexus / Momentum fellowships | Campus recruiting page |
| Two Sigma | New Seekers Summit | Program page |

Add a program by appending an entry to `docs/programs.json`. Three check types exist:

- `greenhouse`: `board`, `title` regex, optional `title_exclude`, optional `extra_boards`. A program is open when a posting matches the title and a US location.
- `html`: `url`, optional `block_start` / `block_end` regexes to isolate the US section, `open_regex`, optional `closed_regex` (+ `closed_window` chars), optional `apply_link` href regex, optional `case_sensitive`.
- `google_careers`: `search_url` and a `slug` regex matched against result URLs.

Optional per program: `details_url` (an extra page scanned for the deadline and eligibility) and
`eligibility_note` (shown on the site when the source has no eligibility text).

## How it works

1. `tracker/tracker.py` checks every program, extracts the deadline, program dates and eligibility
   wording, judges whether the class-of-2029 profile fits, and writes `docs/status.json`.
2. `.github/workflows/check.yml` runs the script every 6 hours (and on demand) and commits
   `status.json` when it changes.
3. `docs/index.html` + `docs/app.js` render the result. The **Check now** button re-queries the
   Greenhouse job boards live from the browser (they allow cross-origin requests). Company pages
   that block browser requests show the latest scheduled result. **Run full check** triggers the
   GitHub Action from the page if you save a fine-grained GitHub token in Settings (stored only in
   your browser's local storage; permission needed: Actions read/write on this repo).

Open `index.html#check` to auto-run the live check on load.

## Run locally

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python tracker/tracker.py            # writes docs/status.json
.venv/bin/python tracker/tracker.py --dry-run  # print only
.venv/bin/python tracker/tracker.py --only citadel-discover-us,janestreet-focus-nyc
python3 -m http.server -d docs 8000            # then open http://localhost:8000
```

The script uses `curl_cffi` with Chrome TLS impersonation because Citadel's pages sit behind
Cloudflare and reject plain `requests`.

## Publish to GitHub Pages

```bash
git init -b main
git add .
git commit -m "Program tracker"
gh repo create program-tracker-auto --public --source=. --push
```

Then in the repository: **Settings → Pages → Build and deployment → Source: Deploy from a branch →
Branch: `main`, folder `/docs`**. The site appears at `https://<user>.github.io/program-tracker-auto/`.
The workflow needs no extra secrets; `GITHUB_TOKEN` has write permission via the `permissions` block.
Run it once from the Actions tab ("Check programs → Run workflow") to confirm it commits.

## Caveats

- Status detection is heuristic. A firm can change page wording or board names at any time; when a
  program shows "Not open" for a suspiciously long stretch, open the program page and adjust the
  regexes in `programs.json`.
- Jane Street postings on the hidden board have no body text, so the deadline comes from the
  firm's invite page. If that page is stale, the site flags the deadline as "page may be stale".
- Eligibility is judged from wording such as "December 2028 – June 2030 graduation date" or
  "first-year students". It is a hint, not a ruling; read the posting.
- GitHub's scheduled workflows can be delayed by tens of minutes and are paused on repos with no
  activity for 60 days.
