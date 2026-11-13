/*
 * Chrono core: the event log of a timing session, turned into records, weld numbers and totals.
 * Shared by the PC page (pages/chrono.html) and the mobile page (mobile-chrono).
 *
 * Two modes, each with its own step names: onshore (chrono sheet) and offshore (Mergeur sheet).
 * A session is a list of events, each with the time it was pressed (ISO text):
 *   start      : session starts, the first record begins
 *   weld       : "next weld", ends the current record and starts the next one
 *   stop       : ends the last record and the session
 *   step types : the step buttons of the mode, each stored as the time since the start of the current record
 * Cancel removes the last event (see undo).
 *
 * Weld numbers: a record gets its number when it is closed (at "weld" or "stop"), never at start.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ChronoCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FORMAT = "production-manager-chrono";
  const VERSION = 1;

  // Step buttons of each mode, in the order of the sheet columns. "col" is the column letter on the sheet.
  const MODES = {
    onshore: {
      label: "Onshore",
      steps: [
        // chrono workbook order, without backweld. Two chains: clamp (released, next clamp in, next fit up) and cabin (in position, cabin up N, cabin up N+1)
        { type: "fitUpReady", col: "1", label: "Fit up ready", button: "Fit up ready N" },
        // preheat of each weld: its start and its end, between Fit up ready and Cabin in position
        { type: "preheatStart", col: "1a", label: "Preheat start", button: "Preheat start", option: "preheat" },
        { type: "preheatEnd", col: "1b", label: "Preheat end", button: "Preheat end", option: "preheat" },
        { type: "cabinIn", col: "2", label: "Cabin in position", button: "Cabin in position" },
        { type: "clampReleased", col: "3", label: "Clamp released", button: "Clamp released" },
        // blasting: start and end, before Clamp in position (an option, shown when it is on)
        { type: "blastingStart", col: "3a", label: "Blasting start", button: "Blasting start", option: "blasting" },
        { type: "blastingEnd", col: "3b", label: "Blasting end", button: "Blasting end", option: "blasting" },
        { type: "clampIn", col: "4", label: "Clamp in position N+1", button: "Clamp in position" },
        { type: "cabinUpN", col: "5", label: "Cabin up N", button: "Cabin up N" },
        { type: "cabin1Ready", col: "6", label: "Cabin ready N+1", button: "Cabin ready N+1" },
        // further steps of the onshore sequence: to be added here, in order
      ],
    },
    offshore: {
      label: "Offshore",
      steps: [
        { type: "fitUpEnd", col: "C", label: "End of fit up", button: "End of fit up" },
        { type: "startWeld", col: "D", label: "Start weld", button: "Start weld" },
        { type: "readyWs1", col: "E", label: "Ready at WS1", button: "Ready at WS1" },
        { type: "finIvt", col: "F", label: "Fin IVT", button: "Fin IVT" },
        { type: "pullStart", col: "G", label: "Pull start", button: "Pull start" },
        { type: "pullEnd", col: "H", label: "Pull end", button: "Pull end" },
      ],
    },
  };
  const MODE_IDS = Object.keys(MODES);
  const DEFAULT_MODE = "onshore";

  function modeOf(doc) {
    return doc && MODE_IDS.indexOf(doc.mode) >= 0 ? doc.mode : DEFAULT_MODE;
  }

  // the options: defined once here, stored in each session (doc.options), shown in Settings (PC and phone)
  // a step with an "option" is shown only when that option is on
  const OPTION_DEFS = {
    preheat: { label: "Preheat (start and end, after Fit up ready)", default: false },
    blasting: { label: "Blasting (start and end, before Clamp in position)", default: false },
  };
  const OPTIONS = {};
  // the options of the open session: read from its document, or the default when it has none
  function applyOptions(o) {
    Object.keys(OPTION_DEFS).forEach((id) => {
      OPTIONS[id] = o && typeof o[id] === "boolean" ? o[id] : OPTION_DEFS[id].default;
    });
    return { ...OPTIONS };
  }
  function normalizeOptions(o) {
    const out = {};
    Object.keys(OPTION_DEFS).forEach((id) => { out[id] = !!(o && o[id]); });
    return out;
  }
  // the last options chosen on this device: the default of a new session
  const PREFERENCES_KEY = "chrono-options";
  function loadPreferences() {
    try { return normalizeOptions(JSON.parse(localStorage.getItem(PREFERENCES_KEY) || "{}")); } catch (e) { return normalizeOptions({}); }
  }
  function savePreferences(o) {
    try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(normalizeOptions(o))); } catch (e) { /* no storage */ }
  }
  applyOptions({});
  function stepsOf(mode) {
    return MODES[MODE_IDS.indexOf(mode) >= 0 ? mode : DEFAULT_MODE].steps.filter((s) => !s.option || OPTIONS[s.option]);
  }

  function stepTypesOf(mode) {
    return stepsOf(mode).map((s) => s.type);
  }

  function validate(doc) {
    const errors = [];
    if (!doc || typeof doc !== "object") return ["Fichier vide ou invalide."];
    if (doc.format !== FORMAT) errors.push("Ce fichier n'est pas un chrono Production Manager.");
    if (doc.version !== VERSION) errors.push("Version de fichier non prise en charge : " + doc.version + ".");
    if (doc.mode !== undefined && MODE_IDS.indexOf(doc.mode) < 0) errors.push("Mode inconnu : " + doc.mode + ".");
    if (!Array.isArray(doc.events)) {
      errors.push("Liste d'événements absente.");
      return errors;
    }
    const allowed = ["start", "weld", "stop", "skip"].concat(stepTypesOf(modeOf(doc)));
    let prev = null;
    doc.events.forEach((ev, i) => {
      const n = i + 1;
      if (!ev || allowed.indexOf(ev.type) < 0) errors.push("Événement " + n + " : type inconnu pour ce mode.");
      if (ev && ev.type === "skip" && stepTypesOf(modeOf(doc)).indexOf(ev.step) < 0) errors.push("Événement " + n + " : étape à passer inconnue.");
      const t = ev && typeof ev.t === "string" ? parseWall(ev.t) : NaN;
      if (isNaN(t)) {
        errors.push("Événement " + n + " : heure invalide.");
      } else {
        if (prev !== null && t < prev) errors.push("Événement " + n + " : l'heure recule.");
        prev = t;
      }
    });
    if (doc.events.length && doc.events[0].type !== "start") errors.push("La session doit commencer par Start.");
    return errors;
  }

  // Records, weld numbers, totals and per-column averages, from the event log.
  function buildRecords(doc) {
    const mode = modeOf(doc);
    const stepTypes = stepTypesOf(mode);
    const first = Number.isInteger(doc.firstWeldNumber) ? doc.firstWeldNumber : 1;
    const closed = [];
    let cur = null;
    let sessionStart = null;
    let sessionStop = null;

    function closeRecord(end) {
      const n = first + closed.length;
      closed.push({
        start: cur.start,
        end,
        steps: cur.steps,
        skipped: cur.skipped,
        weldNumber: n,
        weldLabel: fmtWeld(n),
        kp: fmtKp(doc.kp),
        open: false,
      });
      cur = null;
    }

    // onshore: a weld starts at its Fit up ready; the cabin cycle belongs to the weld where its Cabin in position was pressed
    if (mode === "onshore") {
      let cabinRec = null;
      const relTo = (rec, t) => (t - rec.start) / 1000;
      const openAt = (t) => { cur = { start: t, steps: {}, skipped: {} }; };
      for (const ev of doc.events || []) {
        const t = parseWall(ev.t);
        // the session Start only opens the session: the Fit up ready N of the first weld is pressed after it
        if (ev.type === "start") { sessionStart = t; openAt(t); cabinRec = null; continue; }
        if (ev.type === "stop") { if (cur) closeRecord(t); sessionStop = t; continue; }
        if (ev.type === "weld") { if (cur) { closeRecord(t); openAt(t); } continue; }
        if (ev.type === "skip") { if (cur && stepTypes.indexOf(ev.step) >= 0) cur.skipped[ev.step] = true; continue; }
        if (!cur) continue;
        if (ev.type === "fitUpReady") {
          // a second Fit up ready cuts the weld; the first weld of a session keeps its Fit up ready from the session Start (older sessions: a Fit up ready just after the Start)
          const firstOfSession = closed.length === 0 && Object.keys(cur.steps).length === 1;
          if (typeof cur.steps.fitUpReady === "number" && !firstOfSession) {
            // the next weld starts before Cabin up N is validated: Cabin ready N+1 is skipped (0:00); Cabin up N stays to validate
            const cr = cabinRec;
            if (cr && typeof cr.steps.cabinIn === "number" && typeof cr.steps.cabinUpN !== "number" && typeof cr.steps.cabin1Ready !== "number") { cr.steps.cabin1Ready = 0; cr.skipped.cabin1Ready = true; }
            closeRecord(t); openAt(t); cur.steps.fitUpReady = 0;
          }
          else cur.steps.fitUpReady = relTo(cur, t);
        } else if (ev.type === "cabinIn") {
          // a weld has one Cabin in position: a press before its Fit up ready does not change the weld before
          if (typeof cur.steps.cabinIn === "number") continue;
          cabinRec = cur;
          cur.steps.cabinIn = relTo(cur, t);
        } else if (ev.type === "cabinUpN" || ev.type === "cabin1Ready") {
          const target = cabinRec || cur;
          target.steps[ev.type] = relTo(target, t);
        } else if (stepTypes.indexOf(ev.type) >= 0) {
          cur.steps[ev.type] = relTo(cur, t);
        }
      }
    }
    for (const ev of mode === "onshore" ? [] : doc.events || []) {
      const t = parseWall(ev.t);
      if (ev.type === "start") {
        sessionStart = t;
        cur = { start: t, steps: {}, skipped: {} };
      } else if (ev.type === "weld") {
        if (!cur) continue;
        closeRecord(t);
        cur = { start: t, steps: {}, skipped: {} };
      } else if (ev.type === "stop") {
        if (cur) closeRecord(t);
        sessionStop = t;
      } else if (ev.type === "skip") {
        // "Pass": the step is left out of this weld, it has no time
        if (cur && stepTypes.indexOf(ev.step) >= 0) cur.skipped[ev.step] = true;
      } else if (cur && stepTypes.indexOf(ev.type) >= 0) {
        // a step pressed twice keeps its last time, as the sheet overwrote the cell
        cur.steps[ev.type] = (t - cur.start) / 1000;
      }
    }

    const records = closed.slice();
    if (cur) records.push({ start: cur.start, end: null, steps: cur.steps, skipped: cur.skipped, weldNumber: null, weldLabel: "open", kp: fmtKp(doc.kp), open: true });

    for (const r of records) {
      // duration of each step = its time minus the time of the step before it in the weld (the first one from the start of the weld)
      const done = stepTypes.filter((k) => typeof r.steps[k] === "number").sort((a, b) => r.steps[a] - r.steps[b]);
      r.durations = {};
      let prev = 0;
      for (const k of done) {
        r.durations[k] = r.steps[k] - prev;
        prev = r.steps[k];
      }
      const values = done.map((k) => r.durations[k]);
      // comment of the line: kept in the document, keyed by the start time of the weld (it does not move with the numbering)
      r.comment = (doc.comments && typeof doc.comments[String(r.start)] === "string") ? doc.comments[String(r.start)] : "";
      r.maxSec = values.length ? Math.max.apply(null, values) : null;
      // the longest step(s) of the weld are highlighted
      r.highlight = done.filter((k) => r.durations[k] >= r.maxSec);
      // offshore: fit up (weld start to End of fit up), pull (Pull start to Pull end) and arc (Start weld to Fin IVT)
      if (mode === "offshore") {
        r.fitSec = typeof r.steps.fitUpEnd === "number" ? r.steps.fitUpEnd : null;
        r.pullSec = typeof r.steps.pullStart === "number" && typeof r.steps.pullEnd === "number" ? r.steps.pullEnd - r.steps.pullStart : null;
        r.arcSec = typeof r.steps.startWeld === "number" && typeof r.steps.finIvt === "number" ? r.steps.finIvt - r.steps.startWeld : null;
      }
    }

    const columns = {};
    for (const type of stepTypes) {
      const values = records.map((r) => r.durations[type]).filter((v) => typeof v === "number");
      const total = values.reduce((a, b) => a + b, 0);
      columns[type] = { total: values.length ? total : null, count: values.length, avg: values.length ? total / values.length : null };
    }

    // time in the air: from "Cabin 1 finish" of a weld (cabin lifted) to "Cabin in position" of the next weld (cabin down again)
    if (mode === "onshore") {
      // Cabin 1 up: from Cabin up N to the Cabin in position of the next weld
      records.forEach((rec, i) => {
        if (typeof rec.steps.cabinUpN !== "number") { rec.airSec = null; return; }
        const nx = records.slice(i + 1).find((r) => typeof r.steps.cabinIn === "number");
        rec.airSec = nx ? (nx.start - rec.start) / 1000 + nx.steps.cabinIn - rec.steps.cabinUpN : null;
      });
    }
    for (let i = 0; mode !== "onshore" && i + 1 < records.length; i++) {
      const rec = records[i];
      const next = records[i + 1];
      if (typeof rec.steps.cabin1Ready === "number" && typeof next.steps.cabinIn === "number") {
        rec.airSec = (next.start - rec.start) / 1000 + next.steps.cabinIn - rec.steps.cabin1Ready;
      } else {
        rec.airSec = null;
      }
    }
    if (records.length) records[records.length - 1].airSec = null;

    // clamp movement: from "Clamp released" of a weld to "Clamp in position" of the next weld (clamp moved to the next joint)
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const next = records[i + 1];
      if (mode === "onshore") {
        rec.clampSec = typeof rec.steps.clampReleased === "number" && typeof rec.steps.clampIn === "number" ? rec.steps.clampIn - rec.steps.clampReleased : null;
        continue;
      }
      if (next && typeof rec.steps.clampReleased === "number" && typeof next.steps.clampIn === "number") {
        rec.clampSec = (next.start - rec.start) / 1000 + next.steps.clampIn - rec.steps.clampReleased;
      } else {
        rec.clampSec = null;
      }
    }

    const joints = closed.length;
    const totalSec = sessionStart !== null && sessionStop !== null ? (sessionStop - sessionStart) / 1000 : null;
    return {
      mode,
      records,
      joints,
      totalSeconds: totalSec,
      avgPerJoint: totalSec !== null && joints > 0 ? totalSec / joints : null,
      columns,
      firstWeldNumber: first,
      sessionStart,
      sessionStop,
    };
  }

  // weld number as FW0001, kilometre point as KP055 (null when not set)
  function fmtWeld(n) {
    return Number.isInteger(n) ? "FW" + String(n).padStart(4, "0") : "";
  }
  function fmtKp(kp) {
    return Number.isInteger(kp) ? "KP" + String(kp).padStart(3, "0") : "";
  }

  // m:ss, or h:mm:ss from one hour
  function fmt(sec) {
    if (sec === null || sec === undefined || isNaN(sec)) return "–";
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const p = (n) => String(n).padStart(2, "0");
    return h ? h + ":" + p(m) + ":" + p(s % 60) : m + ":" + p(s % 60);
  }

  function undo(events) {
    return (events || []).slice(0, -1);
  }

  function newId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    let s = "";
    for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }

  // Times are kept as wall-clock text, without zone, as the phone shows them: "2026-11-10T08:20:50.565".
  // In the code a time is the wall clock as milliseconds (read as UTC), so the same text gives the same time on any PC.
  const PARIS = "Europe/Paris";
  // a real instant (ms) -> the Paris wall clock as ms
  function parisWall(instant) {
    const p = {};
    new Intl.DateTimeFormat("en-GB", { timeZone: PARIS, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(instant)).forEach((x) => { p[x.type] = x.value; });
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second, ((instant % 1000) + 1000) % 1000);
  }
  // wall clock ms -> text "YYYY-MM-DDTHH:MM:SS" (no milliseconds in the files)
  function toWall(ms) {
    const d = new Date(ms); const q = (n, k) => String(n).padStart(k || 2, "0");
    return d.getUTCFullYear() + "-" + q(d.getUTCMonth() + 1) + "-" + q(d.getUTCDate()) + "T" + q(d.getUTCHours()) + ":" + q(d.getUTCMinutes()) + ":" + q(d.getUTCSeconds());
  }
  // now, on the Paris wall clock, as text
  function nowWall() { return toWall(parisWall(Date.now())); }
  // text -> wall clock ms. Text with a zone (old files, "Z") is converted to the Paris wall clock; text without zone is read as is.
  function parseWall(s) {
    if (typeof s !== "string") return NaN;
    if (/(Z|[+-]d{2}:?d{2})$/i.test(s)) return parisWall(Date.parse(s));
    return Date.parse(s + "Z");
  }

  function makeDocument(opts) {
    return {
      format: FORMAT,
      version: VERSION,
      mode: MODE_IDS.indexOf(opts.mode) >= 0 ? opts.mode : DEFAULT_MODE,
      sessionId: opts.sessionId || newId(),
      device: opts.device || "pc",
      title: opts.title || "",
      firstWeldNumber: Number.isInteger(opts.firstWeldNumber) ? opts.firstWeldNumber : 1,
      kp: Number.isInteger(opts.kp) ? opts.kp : null,
      comments: opts.comments || {},
      createdAt: opts.createdAt || nowWall(),
      exportedAt: nowWall(),
      events: opts.events || [],
      options: normalizeOptions(opts.options),
    };
  }

  // Weld number from a WTR weld alias: "FW0021", "21" and " 21 " all give 21 (null when there are no digits)
  function weldNumberOf(alias) {
    const digits = String(alias === null || alias === undefined ? "" : alias).replace(/\D/g, "");
    return digits ? parseInt(digits, 10) : null;
  }

  // Crosses the closed welds of a session with WTR cycles: { weld, start (ms), durationMs }.
  // A cycle belongs to a weld when it starts inside the weld (from a tolerance before its start to its end).
  // Each cycle is used once, weld by weld; a cycle with the same weld number is preferred.
  function matchWtr(doc, cycles, toleranceSec) {
    const tol = (toleranceSec === undefined ? 0 : toleranceSec) * 1000;
    const recs = buildRecords(doc).records.filter((r) => !r.open);
    const list = (cycles || []).slice().sort((a, b) => a.start - b.start);
    const used = new Set();
    return recs.map((r) => {
      const from = r.start - tol;
      const to = r.end;
      const inside = list.filter((c, i) => !used.has(i) && c.start >= from && c.start < to);
      // every cycle of the time slot belongs to this weld: their durations add up to the arc (welding) time
      inside.forEach((c) => used.add(list.indexOf(c)));
      const same = inside.find((c) => weldNumberOf(c.weld) === r.weldNumber);
      const cycle = same || inside[0] || null;
      let status = "none";
      if (cycle) status = weldNumberOf(cycle.weld) === r.weldNumber ? "same" : "other";
      const timingSec = (r.end - r.start) / 1000;
      const arcSec = inside.length ? inside.reduce((sum, c) => sum + (c.durationMs || 0), 0) / 1000 : null;
      return {
        weldLabel: r.weldLabel,
        start: r.start,
        timingSec,
        wtrWeld: cycle ? cycle.weld : "",
        wtrStart: cycle ? cycle.start : null,
        wtrSec: cycle ? cycle.durationMs / 1000 : null,
        cycles: inside.length,
        arcSec,
        nonArcSec: arcSec === null ? null : timingSec - arcSec,
        status,
      };
    });
  }

  // Idle times: the stretches of the window (from, to) without any welding cycle, longer than thresholdSec.
  // cycles: { start (ms), durationMs }. Returns [{ from, to, durationSec }] (ms for from and to).
  // Every stretch without a cycle is returned (no threshold when thresholdSec is 0), with the weld before and after it.
  function idleGaps(cycles, from, to, thresholdSec) {
    const min = (thresholdSec === undefined ? 0 : thresholdSec) * 1000;
    const list = (cycles || [])
      .map((c) => ({ s: c.start, e: c.start + (c.durationMs || 0), weld: c.weld }))
      .filter((c) => c.e >= from && c.s <= to)
      .sort((a, b) => a.s - b.s);
    const gaps = [];
    let cursor = from;
    let before = null;
    for (const c of list) {
      if (c.s - cursor > min) gaps.push({ from: cursor, to: c.s, durationSec: (c.s - cursor) / 1000, before, after: c.weld });
      if (c.e > cursor) { cursor = c.e; before = c.weld; }
    }
    if (to - cursor > min) gaps.push({ from: cursor, to, durationSec: (to - cursor) / 1000, before, after: null });
    return gaps;
  }

  // onshore: which steps may be pressed now. The clamp chain and the cabin chain are independent.
  function allowedSteps(doc) {
    if (modeOf(doc) !== "onshore") return null;
    const recs = buildRecords(doc).records;
    const open = recs.length && recs[recs.length - 1].open ? recs[recs.length - 1] : null;
    let cabin = null;
    let cabinIdx = -1;
    for (let i = recs.length - 1; i >= 0; i--) {
      const st = recs[i].steps;
      if (typeof st.cabinIn === "number" && !(typeof st.cabinUpN === "number" && typeof st.cabin1Ready === "number")) { cabin = st; cabinIdx = i; break; }
    }
    // the cabin of a weld starts only in that weld: after its Fit up ready (a new weld after the last cabin)
    let lastCabin = -1;
    recs.forEach((r, i) => { if (typeof r.steps.cabinIn === "number") lastCabin = i; });
    const openIdx = recs.length - 1;
    const has = (o, k) => !!o && typeof o.steps[k] === "number";
    return {
      fitUpReady: !open || !has(open, "fitUpReady") || has(open, "clampIn"),
      // a new weld whose Fit up ready is pressed before the Cabin ready N+1 of the weld before: that Cabin ready is off, and the Cabin in position of the new weld is on
      cabinIn: (!cabin || cabinIdx < openIdx) && has(open, "fitUpReady") && (lastCabin < 0 || openIdx > lastCabin),
      cabinUpN: !!cabin && typeof cabin.cabinUpN !== "number",
      cabin1Ready: !!cabin && cabinIdx === openIdx && typeof cabin.cabinUpN === "number" && typeof cabin.cabin1Ready !== "number",
      // Clamp released of a weld needs its Fit up ready first
      clampReleased: !!open && has(open, "fitUpReady") && !has(open, "clampReleased"),
      clampIn: has(open, "clampReleased") && !has(open, "clampIn"),
      // preheat: the end follows the start, both once per weld
      preheatStart: OPTIONS.preheat && !!open && has(open, "fitUpReady") && !has(open, "preheatStart"),
      preheatEnd: OPTIONS.preheat && has(open, "preheatStart") && !has(open, "preheatEnd"),
      // blasting: start and end once per weld, the start only before Clamp in position
      blastingStart: OPTIONS.blasting && !!open && !has(open, "blastingStart") && !has(open, "clampIn"),
      blastingEnd: OPTIONS.blasting && has(open, "blastingStart") && !has(open, "blastingEnd"),
    };
  }

  return { FORMAT, VERSION, OPTIONS, OPTION_DEFS, applyOptions, normalizeOptions, loadPreferences, savePreferences, allowedSteps, parisWall, toWall, nowWall, parseWall, MODES, MODE_IDS, DEFAULT_MODE, modeOf, stepsOf, stepTypesOf, validate, buildRecords, fmt, fmtWeld, fmtKp, undo, newId, makeDocument, weldNumberOf, matchWtr, idleGaps };
});
