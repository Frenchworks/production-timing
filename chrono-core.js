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
        { type: "fitUpReady", col: "1", label: "Fit up ready", button: "Fit up ready" },
        { type: "cabinIn", col: "2", label: "Cabin in position", button: "Cabin in position" },
        { type: "clampReleased", col: "3", label: "Clamp released", button: "Clamp released" },
        { type: "cabin1Ready", col: "4", label: "Cabin 1 ready", button: "Cabin 1 ready" },
        { type: "clampIn", col: "5", label: "Clamp in position", button: "Clamp in position" },
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
        { type: "pullEnd", col: "G", label: "Pull end", button: "Pull end" },
      ],
    },
  };
  const MODE_IDS = Object.keys(MODES);
  const DEFAULT_MODE = "onshore";

  function modeOf(doc) {
    return doc && MODE_IDS.indexOf(doc.mode) >= 0 ? doc.mode : DEFAULT_MODE;
  }

  function stepsOf(mode) {
    return MODES[MODE_IDS.indexOf(mode) >= 0 ? mode : DEFAULT_MODE].steps;
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
      const t = ev && typeof ev.t === "string" ? Date.parse(ev.t) : NaN;
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

    for (const ev of doc.events || []) {
      const t = Date.parse(ev.t);
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
      r.maxSec = values.length ? Math.max.apply(null, values) : null;
      // the longest step(s) of the weld are highlighted
      r.highlight = done.filter((k) => r.durations[k] >= r.maxSec);
    }

    const columns = {};
    for (const type of stepTypes) {
      const values = records.map((r) => r.durations[type]).filter((v) => typeof v === "number");
      const total = values.reduce((a, b) => a + b, 0);
      columns[type] = { total: values.length ? total : null, count: values.length, avg: values.length ? total / values.length : null };
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
      createdAt: opts.createdAt || new Date().toISOString(),
      exportedAt: new Date().toISOString(),
      events: opts.events || [],
    };
  }

  return { FORMAT, VERSION, MODES, MODE_IDS, DEFAULT_MODE, modeOf, stepsOf, stepTypesOf, validate, buildRecords, fmt, fmtWeld, fmtKp, undo, newId, makeDocument };
});
