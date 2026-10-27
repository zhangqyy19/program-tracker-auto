/* Program Tracker front end.
 * Loads programs.json (config) and status.json (last server-side run), renders them,
 * and on "Check now" re-queries Greenhouse job boards live from the browser.
 */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (v !== null && v !== undefined) n.setAttribute(k, v);
    }
    for (const c of children) if (c !== null && c !== undefined) n.append(c);
    return n;
  };

  const state = { config: null, status: null, results: new Map(), live: new Set() };

  // ---------------------------------------------------------------- dates
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const MONTH_RE = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?";
  const DATE_MDY = new RegExp(`(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d\\d)`, "i");
  const DATE_DMY = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})\\s+(20\\d\\d)`, "i");
  const DEADLINE_CUE = /(deadline|apply by|applications?\s+(?:close|closes|closing|due|must be (?:submitted|received))|closes? on|due by)/gi;

  function toISO(y, m, d) {
    const mm = MONTHS[m.slice(0, 3).toLowerCase()];
    if (!mm) return null;
    return `${y}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  function findDeadline(text) {
    DEADLINE_CUE.lastIndex = 0;
    let m;
    while ((m = DEADLINE_CUE.exec(text))) {
      const window = text.slice(m.index, m.index + 160);
      let dm = DATE_MDY.exec(window);
      if (dm) return { date: toISO(dm[3], dm[1], dm[2]), text: window.slice(0, dm.index + dm[0].length) };
      dm = DATE_DMY.exec(window);
      if (dm) return { date: toISO(dm[3], dm[2], dm[1]), text: window.slice(0, dm.index + dm[0].length) };
    }
    return null;
  }

  function yearOfStudy(gradYear, today) {
    const ayEnd = today.getFullYear() + (today.getMonth() + 1 >= 7 ? 1 : 0);
    return Math.max(1, Math.min(4, 4 - (gradYear - ayEnd)));
  }

  function assessFit(text, gradYear) {
    if (!text) return { fit: "unknown", reason: "No eligibility text found." };
    const fits = [], misses = [];
    const season = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Winter|Spring|Summer|Fall|Autumn)[a-z]*\\.?";
    const rangeRx = new RegExp(`(?:graduat\\w*|class of)[^.]{0,80}?(?:${season}\\s+)?(20\\d\\d)\\s*(?:-|–|—|to|and|through)\\s*(?:${season}\\s+)?(20\\d\\d)`, "gi");
    for (const m of text.matchAll(rangeRx)) {
      const lo = Math.min(+m[1], +m[2]), hi = Math.max(+m[1], +m[2]);
      (lo <= gradYear && gradYear <= hi ? fits : misses).push(`graduation window ${lo}-${hi}`);
    }
    const singleRx = new RegExp(`graduat\\w*\\s+(?:in|by|during)?\\s*(?:${season}\\s+)?(20\\d\\d)|(20\\d\\d)\\s+graduates?|class of\\s+(20\\d\\d)`, "gi");
    for (const m of text.matchAll(singleRx)) {
      const y = +(m[1] || m[2] || m[3]);
      if (fits.concat(misses).some((f) => f.includes(String(y)))) continue;
      (y === gradYear ? fits : misses).push(`"${m[0].trim()}"`);
    }
    for (const m of text.matchAll(/penultimate[^.]{0,60}?(20\d\d)/gi)) {
      (+m[1] + 1 === gradYear ? fits : misses).push(`"${m[0].trim()}"`);
    }
    const yos = yearOfStudy(gradYear, new Date());
    const years = new Set();
    if (/first[\s-]*(?:and|or|\/|&)?[\s-]*(?:second)?[\s-]*year|freshm[ae]n|\b1st[\s-]*year/i.test(text)) years.add(1);
    if (/second[\s-]*year|sophomore|\b2nd[\s-]*year|rising junior/i.test(text)) years.add(2);
    if (/third[\s-]*year|\b3rd[\s-]*year|rising senior/i.test(text)) years.add(3);
    if (/final[\s-]*year|fourth[\s-]*year|senior/i.test(text)) years.add(4);
    if (years.size) {
      const label = { 1: "first-year", 2: "second-year", 3: "third-year", 4: "final-year" };
      const listed = [...years].sort().map((y) => label[y]).join(", ");
      (years.has(yos) ? fits : misses).push(`mentions ${listed} students (you are a ${label[yos]})`);
    }
    if (fits.length) return { fit: "fit", reason: fits.slice(0, 3).join("; ") };
    if (misses.length) return { fit: "unlikely", reason: misses.slice(0, 3).join("; ") };
    return { fit: "unknown", reason: "No graduation-year or year-of-study wording found." };
  }

  function stripHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
  }

  // ---------------------------------------------------------------- live Greenhouse check
  async function liveGreenhouse(program) {
    const cfg = program.check;
    const boards = [cfg.board, ...(cfg.extra_boards || [])];
    const titleRx = new RegExp(cfg.title, "i");
    const exclRx = cfg.title_exclude ? new RegExp(cfg.title_exclude, "i") : null;
    const usRx = new RegExp(state.config.us_location_regex, "i");
    const matches = [];
    for (const board of boards) {
      const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`, { cache: "no-store" });
      if (!r.ok) throw new Error(`Greenhouse ${board}: HTTP ${r.status}`);
      const data = await r.json();
      for (const job of data.jobs || []) {
        const loc = (job.location && job.location.name) || "";
        if (!titleRx.test(job.title) || (exclRx && exclRx.test(job.title))) continue;
        if (!usRx.test(`${job.title} ${loc}`)) continue;
        matches.push({ title: job.title, location: loc, url: job.absolute_url, text: stripHtml(job.content || ""), updated: job.updated_at });
      }
    }
    const out = {
      status: matches.length ? "open" : "closed",
      source: `Greenhouse board(s): ${boards.join(", ")} (live)`,
      matches: matches.map(({ title, location, url }) => ({ title, location, url })),
      checked_at: new Date().toISOString(),
    };
    if (matches.length) {
      const text = matches.map((m) => m.text).join(" ");
      Object.assign(out, { title: matches[0].title, location: matches[0].location, link: matches[0].url, posted_at: matches[0].updated });
      const dl = findDeadline(text);
      if (dl && dl.date) Object.assign(out, { deadline: dl.date, deadline_text: dl.text, deadline_source: "posting" });
      if (text.length > 40) {
        const f = assessFit(text, state.config.profile.grad_year);
        Object.assign(out, { fit: f.fit, fit_reason: f.reason, eligibility_excerpt: text.slice(0, 420) });
      }
    } else {
      out.note = "No US posting matching the program title is on the job board right now.";
    }
    return out;
  }

  async function checkNow() {
    const btn = $("#check-now");
    btn.disabled = true;
    setStatus("Checking Greenhouse job boards live…");
    const programs = state.config.programs.filter((p) => p.check.type === "greenhouse");
    let changed = 0, errors = 0;
    await Promise.all(programs.map(async (p) => {
      const prev = state.results.get(p.id) || {};
      try {
        const live = await liveGreenhouse(p);
        const merged = { ...prev, ...live, id: p.id, firm: p.firm, name: p.name, info_url: p.info_url, check_type: "greenhouse" };
        // Keep server-side deadline/eligibility when the live posting has no body text.
        if (!live.deadline && prev.deadline) { merged.deadline = prev.deadline; merged.deadline_text = prev.deadline_text; merged.deadline_source = prev.deadline_source; }
        if (!live.fit && prev.fit) { merged.fit = prev.fit; merged.fit_reason = prev.fit_reason; merged.eligibility_excerpt = prev.eligibility_excerpt; }
        if (live.status !== prev.status) { changed++; merged.last_change = live.checked_at; merged.previous_status = prev.status; }
        if (live.status === "open" && !merged.first_seen_open) merged.first_seen_open = live.checked_at;
        delete merged.error;
        state.results.set(p.id, merged);
        state.live.add(p.id);
      } catch (e) {
        errors++;
        state.results.set(p.id, { ...prev, id: p.id, firm: p.firm, name: p.name, status: prev.status || "error", error: String(e.message || e) });
      }
    }));
    render();
    const others = state.config.programs.length - programs.length;
    const when = state.status ? ` Other ${others} sources show the scheduled run from ${timeAgo(state.status.generated_at)}.` : "";
    setStatus(`Live check done: ${programs.length} boards queried, ${changed} status change${changed === 1 ? "" : "s"}${errors ? `, ${errors} error${errors === 1 ? "" : "s"}` : ""}.${when}`);
    btn.disabled = false;
  }

  // ---------------------------------------------------------------- GitHub Actions dispatch
  function settings() {
    let repo = "", branch = "main", token = "";
    try {
      repo = localStorage.getItem("pt.repo") || "";
      branch = localStorage.getItem("pt.branch") || "main";
      token = localStorage.getItem("pt.token") || "";
    } catch (_) { /* storage unavailable */ }
    if (!repo) {
      const host = location.hostname.match(/^([^.]+)\.github\.io$/);
      const seg = location.pathname.split("/").filter(Boolean)[0];
      if (host && seg) repo = `${host[1]}/${seg}`;
    }
    return { repo, branch, token };
  }

  async function runFull() {
    const { repo, branch, token } = settings();
    if (!repo || !token) {
      $("#settings").open = true;
      setStatus("Add the repository and a GitHub token in Settings to trigger the full check from here. Without a token, open the repository's Actions tab and run \"Check programs\" manually.");
      return;
    }
    const btn = $("#run-full");
    btn.disabled = true;
    setStatus("Dispatching GitHub Actions workflow…");
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/check.yml/dispatches`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ ref: branch }),
      });
      if (r.status !== 204) throw new Error(`GitHub API returned HTTP ${r.status}`);
    } catch (e) {
      setStatus(`Could not dispatch workflow: ${e.message}`);
      btn.disabled = false;
      return;
    }
    const before = state.status ? state.status.generated_at : null;
    const started = Date.now();
    const poll = async () => {
      const elapsed = Math.round((Date.now() - started) / 1000);
      setStatus(`Workflow running… waiting for a new status.json (${elapsed}s). Pages can take a minute or two to publish after the commit.`);
      try {
        const s = await loadStatus(true);
        if (s && s.generated_at !== before) {
          applyStatus(s);
          render();
          setStatus(`Full check finished at ${fmtTime(s.generated_at)}.`);
          btn.disabled = false;
          return;
        }
      } catch (_) { /* keep polling */ }
      if (Date.now() - started < 8 * 60 * 1000) setTimeout(poll, 20000);
      else { setStatus("Timed out waiting for the new result. Reload the page in a minute."); btn.disabled = false; }
    };
    setTimeout(poll, 30000);
  }

  // ---------------------------------------------------------------- rendering
  const fmtDate = (iso) => {
    if (!iso) return "";
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : "");
  function timeAgo(iso) {
    if (!iso) return "never";
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 90) return "just now";
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    if (s < 172800) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }
  function daysLeft(iso) {
    if (!iso) return null;
    const [y, m, d] = iso.split("-").map(Number);
    const end = new Date(y, m - 1, d, 23, 59, 59);
    return Math.ceil((end - Date.now()) / 86400000);
  }
  const statusBadge = (r) => {
    const cls = r.status === "open" ? "b-open" : r.status === "error" ? "b-error" : "b-closed";
    const label = r.status === "open" ? "Open" : r.status === "error" ? "Check failed" : "Not open";
    return el("span", { class: `badge ${cls}` }, label);
  };
  const fitBadge = (r) => {
    const f = r.fit || "unknown";
    const label = f === "fit" ? "Likely eligible" : f === "unlikely" ? "Likely not eligible" : "Eligibility unclear";
    return el("span", { class: `badge b-${f}`, title: r.fit_reason || "" }, label);
  };
  const liveBadge = (r) => (state.live.has(r.id) ? el("span", { class: "badge b-live" }, "live") : null);

  function deadlineCell(r) {
    if (!r.deadline) return el("span", { class: "small" }, r.status === "open" ? "Not stated on the source" : "—");
    const dl = daysLeft(r.deadline);
    const frag = document.createDocumentFragment();
    frag.append(el("span", { class: "deadline" }, fmtDate(r.deadline)));
    if (r.status === "open") {
      const extra = r.deadline_stale ? " (page may be stale)" : dl !== null && dl >= 0 ? ` (${dl} day${dl === 1 ? "" : "s"} left)` : " (passed)";
      frag.append(el("span", { class: "small" }, extra));
    }
    return frag;
  }

  function programFor(id) { return state.config.programs.find((p) => p.id === id) || {}; }

  function openCard(r) {
    const p = programFor(r.id);
    const card = el("div", { class: "card" });
    card.append(el("div", { class: "firm" }, r.firm));
    card.append(el("div", { class: "name" }, r.name));
    card.append(el("div", { class: "row" }, statusBadge(r), fitBadge(r), liveBadge(r)));
    const info = el("div", { class: "row" });
    info.append(el("span", {}, "Deadline: "), deadlineCell(r));
    card.append(info);
    if (r.program_dates) card.append(el("div", { class: "row small" }, `Program dates: ${r.program_dates}`));
    if (r.title && r.title !== r.name) card.append(el("div", { class: "row small" }, `Posting: ${r.title}${r.location ? ` · ${r.location}` : ""}`));
    const why = (r.fit && r.fit !== "unknown" && r.fit_reason) || p.eligibility_note || r.fit_reason;
    if (why) card.append(el("div", { class: "sub" }, why));
    const apply = el("div", { class: "apply" });
    if (r.link) apply.append(el("a", { class: "btn", href: r.link, target: "_blank", rel: "noopener" }, "Apply / posting"));
    if (p.info_url && p.info_url !== r.link) apply.append(el("a", { class: "link", href: p.info_url, target: "_blank", rel: "noopener" }, "Program page"));
    card.append(apply);
    return card;
  }

  function row(r) {
    const p = programFor(r.id);
    const tr = el("tr");
    const nameCell = el("td");
    nameCell.append(el("div", {}, el("b", {}, r.name)), el("span", { class: "small" }, r.firm));
    tr.append(nameCell);
    const st = el("td");
    st.append(statusBadge(r), " ", liveBadge(r) || "");
    if (r.note && r.status !== "open") st.append(el("span", { class: "small" }, r.note));
    if (r.error) st.append(el("span", { class: "small" }, r.error));
    if (r.last_change && r.previous_status) st.append(el("span", { class: "small" }, `Changed ${timeAgo(r.last_change)} (was ${r.previous_status})`));
    tr.append(st);
    tr.append(el("td", {}, deadlineCell(r)));
    const elig = el("td");
    elig.append(fitBadge(r), el("span", { class: "small" }, (r.fit && r.fit !== "unknown" && r.fit_reason) || p.eligibility_note || r.fit_reason || ""));
    tr.append(elig);
    const links = el("td");
    if (r.link) links.append(el("a", { class: "link", href: r.link, target: "_blank", rel: "noopener" }, r.status === "open" ? "Apply" : "Last posting"), el("br"));
    if (p.info_url) links.append(el("a", { class: "link", href: p.info_url, target: "_blank", rel: "noopener" }, "Program page"));
    tr.append(links);
    const chk = el("td");
    chk.append(timeAgo(r.checked_at), el("span", { class: "small" }, (r.source || "").replace(/^https?:\/\//, "")));
    tr.append(chk);
    return tr;
  }

  function render() {
    const results = state.config.programs.map((p) => state.results.get(p.id) || { id: p.id, firm: p.firm, name: p.name, status: "error", error: "Not checked yet. Run the GitHub Action or press Check now." });
    const open = results.filter((r) => r.status === "open");
    const fitOpen = open.filter((r) => r.fit === "fit");
    const pr = state.config.profile;
    $("#profile").textContent = `${pr.level === "undergraduate" ? "Undergraduate" : pr.level} · Class of ${pr.grad_year} · ${pr.region} programs · Last full check: ${state.status ? timeAgo(state.status.generated_at) : "none yet"}`;
    $("#summary").replaceChildren(
      el("span", { class: "pill" }, el("b", {}, String(open.length)), ` open`),
      el("span", { class: "pill" }, el("b", {}, String(fitOpen.length)), ` open and likely eligible`),
      el("span", { class: "pill" }, el("b", {}, String(results.length)), ` tracked`),
    );
    const cards = $("#open-cards");
    cards.replaceChildren();
    if (!open.length) cards.append(el("div", { class: "empty" }, "Nothing is open right now. The scheduled check runs every 6 hours; press Check now for a live look at the job boards."));
    else open.sort((a, b) => (a.deadline || "9999").localeCompare(b.deadline || "9999")).forEach((r) => cards.append(openCard(r)));

    const onlyOpen = $("#f-open").checked, onlyFit = $("#f-fit").checked;
    const tbody = $("#rows");
    tbody.replaceChildren();
    results
      .filter((r) => (!onlyOpen || r.status === "open") && (!onlyFit || r.fit === "fit"))
      .forEach((r) => tbody.append(row(r)));
  }

  function setStatus(msg) { $("#status-line").textContent = msg; }

  // ---------------------------------------------------------------- loading
  async function loadJSON(path, bust) {
    const r = await fetch(bust ? `${path}?t=${Date.now()}` : path, { cache: bust ? "no-store" : "default" });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  }
  async function loadStatus(bust) {
    try { return await loadJSON("status.json", bust); } catch (_) { return null; }
  }
  function applyStatus(s) {
    state.status = s;
    state.live.clear();
    if (s) for (const r of s.results || []) state.results.set(r.id, r);
  }

  function initSettings() {
    const { repo, branch, token } = settings();
    $("#gh-repo").value = repo; $("#gh-branch").value = branch; $("#gh-token").value = token;
    $("#save-settings").addEventListener("click", () => {
      try {
        localStorage.setItem("pt.repo", $("#gh-repo").value.trim());
        localStorage.setItem("pt.branch", $("#gh-branch").value.trim() || "main");
        localStorage.setItem("pt.token", $("#gh-token").value.trim());
        setStatus("Settings saved in this browser.");
      } catch (_) { setStatus("Could not save: browser storage is unavailable."); }
    });
    $("#clear-settings").addEventListener("click", () => {
      try { ["pt.repo", "pt.branch", "pt.token"].forEach((k) => localStorage.removeItem(k)); } catch (_) { /* ignore */ }
      $("#gh-token").value = ""; setStatus("Settings cleared.");
    });
  }

  async function init() {
    try {
      state.config = await loadJSON("programs.json");
    } catch (e) {
      setStatus(`Could not load programs.json: ${e.message}`);
      return;
    }
    applyStatus(await loadStatus(false));
    initSettings();
    render();
    if (!state.status) setStatus("No status.json yet. Press Check now for a live look, or run the GitHub Action once.");
    $("#check-now").addEventListener("click", checkNow);
    $("#run-full").addEventListener("click", runFull);
    $("#f-open").addEventListener("change", render);
    $("#f-fit").addEventListener("change", render);
    if (location.hash === "#check") checkNow(); // bookmarkable "open and check" link
  }

  init();
})();
