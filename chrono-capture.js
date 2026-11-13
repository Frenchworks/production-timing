/*
 * Chrono screen, shared by the PC page and the mobile page.
 *   ChronoUI.mountCapture(el, { device, title, storage }) -> { getDoc, refresh }
 *   ChronoUI.renderReport(el, doc)
 * storage: { load() -> doc|null, save(doc) } (may return a promise).
 * The mode (onshore or offshore) is chosen before Start; it sets the step buttons, columns and chart.
 */
(function (root) {
  "use strict";
  const C = root.ChronoCore;

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // times are shown in UTC, the zone they are recorded in: the same on every PC, whatever its clock
  const clock = (t) => new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });

  // Step times: the duration of each step (PC, default), or the time since the start of the weld (cumulative, as the chrono workbook)
  let cumulativeSteps = false;

  function stepHeader(s) {
    return '<th title="' + esc(s.label) + '">' + esc(s.col) + "<br><small>" + esc(s.label) + "" + "</small></th>";
  }

  // Table of the records: one row per weld, the largest step of each row is highlighted
  function tableHtml(r) {
    // offshore: the last columns are Fit up, Pull and Arc; onshore keeps Cabin 1 up and Clamp move
    const off = r.mode === "offshore";
    const tailHead = off ? '<th class="fit col-air">Fit up</th><th class="fit col-clamp">Pull</th><th class="fit col-air">Arc</th>' : '<th class="fit col-air">Cabin 1 up</th><th class="fit col-clamp">Clamp move</th>';
    const tailRow = (rec) => off ? '<td class="fit col-air">' + C.fmt(rec.fitSec) + '</td><td class="fit col-clamp">' + C.fmt(rec.pullSec) + '</td><td class="fit col-air">' + C.fmt(rec.arcSec) + '</td>' : '<td class="fit col-air">' + C.fmt(rec.airSec) + '</td><td class="fit col-clamp">' + C.fmt(rec.clampSec) + '</td>';
    const tailTotals = (k) => (off ? ["fitSec", "pullSec", "arcSec"].map((f) => agg(f)) : [agg("airSec"), agg("clampSec")]).map((a) => "<td>" + C.fmt(a[k]) + "</td>").join("");
    // onshore: the Fit up ready column is the Start column (the weld start), so the step is not repeated
    // offshore: the Fit up ready column is not shown (the weld starts at it, the Start column gives the time)
    const steps = C.stepsOf(r.mode).filter((s) => !(r.mode === "onshore" && s.type === "fitUpReady") && !(r.mode === "offshore" && s.type === "fitUpEnd"));
    // KP, Weld, Start and Max take the width of their content (class fit); the step columns share the rest equally
    const head = '<tr><th class="fit">KP</th><th class="fit">Weld</th><th class="fit wrap">' + "1<br><small>Fit up ready</small>" + '</th>' + steps.map(stepHeader).join("") + tailHead + '<th class="fit col-max">Max</th><th class="col-comment">Comment</th></tr>';
    const rows = r.records
      .map((rec) => {
        const label = rec.open ? "open" : rec.weldLabel;
        const cells = steps
          .map((s) => {
            // the duration of the step is the main figure (the longest one is highlighted); the cumulative time from the start of the run is under it
            const d = rec.durations[s.type];
            const cum = rec.steps[s.type];
            const hl = rec.highlight.indexOf(s.type) >= 0 ? ' class="chrono-max"' : "";
            return "<td" + hl + ">" + (typeof d === "number" ? C.fmt(d) : "") + (cumulativeSteps && typeof cum === "number" && !(rec.skipped && rec.skipped[s.type]) ? "<br><small>" + C.fmt(cum) + "</small>" : "") + "</td>";
          })
          .join("");
        return '<tr><td class="fit">' + esc(rec.kp) + '</td><td class="fit">' + esc(label) + '</td><td class="fit">' + clock(rec.start) + "</td>" + cells + tailRow(rec) + '<td class="fit col-max">' + C.fmt(rec.maxSec) + '</td><td class="col-comment"><input type="text" class="chrono-comment" data-start="' + rec.start + '" value="' + esc(rec.comment) + '" placeholder="Comment"></td></tr>';
      })
      .join("");
    // totals and averages of the Cabin 1 up and Clamp move columns, over the welds where they are known
    const agg = (key) => { const vals = r.records.map((x) => x[key]).filter((v) => typeof v === "number"); const t = vals.reduce((a, b) => a + b, 0); return { total: vals.length ? t : null, avg: vals.length ? t / vals.length : null }; };
    const airAgg = agg("airSec"), clampAgg = agg("clampSec");
    const total = '<tr class="chrono-sum"><td colspan="3">Total</td>' + steps.map((s) => "<td>" + C.fmt(r.columns[s.type].total) + "</td>").join("") + tailTotals("total") + "</tr>";
    const avg = '<tr class="chrono-sum"><td colspan="3">Average</td>' + steps.map((s) => "<td>" + C.fmt(r.columns[s.type].avg) + "</td>").join("") + tailTotals("avg") + "</tr>";
    return '<div class="chrono-table-wrap"><table class="chrono-table' + (off ? ' chrono-offshore' : '') + '"><thead>' + head + "</thead><tbody>" + rows + total + avg + "</tbody></table></div>" + (cumulativeSteps ? '<p class="small chrono-legend-note">Big figure: duration of the step. Small figure: cumulative time from the start of the run. The longest step of each run is highlighted.</p>' : "");
  }

  // Bars: average and total per step, like the chart of the sheet
  function chartHtml(r) {
    // onshore: the Fit up ready column is the Start column (the weld start), so the step is not repeated
    // onshore: the first bar is Fit up ready, the time from the Clamp in position of the previous weld to the start of this one (as the Fit up column of the table)
    const fitItem = { type: "fitUpIntv", col: "1", label: "Fit up ready" };
    const steps = (r.mode === "onshore" ? [fitItem] : []).concat(C.stepsOf(r.mode).filter((s) => !(r.mode === "onshore" && s.type === "fitUpReady")));
    const fitStats = () => {
      const vals = [];
      const recs = r.records || [];
      for (let i = 1; i < recs.length; i++) {
        const prev = recs[i - 1], rec = recs[i];
        if (prev.steps && typeof prev.steps.clampIn === "number") {
          const v = (rec.start - prev.start) / 1000 - prev.steps.clampIn;
          if (v >= 0) vals.push(v);
        }
      }
      const total = vals.reduce((a, b) => a + b, 0);
      return { total: vals.length ? total : null, avg: vals.length ? total / vals.length : null };
    };
    const statsOf = (s) => (s.type === "fitUpIntv" ? fitStats() : r.columns[s.type]);
    // the bottom margin holds the step names, written on a slope under each bar
    const W = 640, H = 248, M = { l: 48, r: 12, t: 16, b: 72 };
    // a name longer than 16 characters is split in two lines, at the middle word
    const labelLines = (text) => {
      const words = text.split(" ");
      if (text.length <= 16 || words.length < 2) return [text];
      const half = Math.ceil(words.length / 2);
      return [words.slice(0, half).join(" "), words.slice(half).join(" ")];
    };
    const plotW = W - M.l - M.r, plotH = H - M.t - M.b;
    const totals = steps.map((s) => statsOf(s).total || 0);
    const avgs = steps.map((s) => statsOf(s).avg || 0);
    const max = Math.max(1, ...totals, ...avgs);
    const slot = plotW / steps.length;
    const barW = slot * 0.36;
    let out = '<svg class="chrono-chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Average and total per step">';
    for (let i = 0; i <= 4; i++) {
      const y = M.t + (plotH * i) / 4;
      out += '<line x1="' + M.l + '" x2="' + (W - M.r) + '" y1="' + y + '" y2="' + y + '" stroke="#d7d8d9" stroke-dasharray="3 3"/>';
      out += '<text x="' + (M.l - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + C.fmt(max * (1 - i / 4)) + "</text>";
    }
    steps.forEach((s, i) => {
      const x0 = M.l + i * slot + slot * 0.15;
      const hT = (totals[i] / max) * plotH;
      const hA = (avgs[i] / max) * plotH;
      out += '<rect x="' + x0 + '" y="' + (M.t + plotH - hT) + '" width="' + barW + '" height="' + hT + '" fill="#6A99AD"><title>' + esc(s.label) + " total " + C.fmt(totals[i]) + "</title></rect>";
      out += '<rect x="' + (x0 + barW + 2) + '" y="' + (M.t + plotH - hA) + '" width="' + barW + '" height="' + hA + '" fill="#C8DC1B"><title>' + esc(s.label) + " average " + C.fmt(avgs[i]) + "</title></rect>";
      // the number and the name of the step, on a slope under the bar
      const ax = M.l + i * slot + slot / 2;
      const ay = M.t + plotH + 14;
      // a long name goes on two lines (each line starts at the same x, the second one 11 px lower)
      const nameLines = labelLines(s.col + " " + s.label).map((l, k) => '<tspan x="' + ax + '" dy="' + (k ? 11 : 0) + '">' + esc(l) + "</tspan>").join("");
      out += '<text x="' + ax + '" y="' + ay + '" text-anchor="end" transform="rotate(-45 ' + ax + " " + ay + ')">' + nameLines + "</text>";
    });
    out += '<rect x="' + M.l + '" y="2" width="10" height="10" fill="#6A99AD"/><text x="' + (M.l + 14) + '" y="11">Total</text>';
    out += '<rect x="' + (M.l + 70) + '" y="2" width="10" height="10" fill="#C8DC1B"/><text x="' + (M.l + 84) + '" y="11">Average</text>';
    // a small title above the chart
    return '<div class="chrono-chart-title">Total and average per step</div>' + out + "</svg>";
  }

  function summaryHtml(r) {
    return '<div class="chrono-summary"><span>Joints <b>' + r.joints + "</b></span>" + (r.sessionStart ? '<span>Start session <b>' + clock(r.sessionStart) + "</b></span>" : "") + "<span>Total <b>" + C.fmt(r.totalSeconds) + "</b></span><span>Average per joint <b>" + C.fmt(r.avgPerJoint) + "</b></span></div>";
  }

  // noChart: the chart is shown elsewhere (from the menu), not under the table
  // noSummary: the summary (joints, total, average) is shown above the buttons instead
  function renderReport(el, doc, noChart, noSummary) {
    const r = C.buildRecords(doc);
    el.innerHTML =
      '<div class="chrono-report">' +
      (noSummary ? "" : summaryHtml(r)) +
      (r.records.length ? tableHtml(r) + (noChart ? "" : chartHtml(r)) : '<p class="small">No weld recorded yet.</p>') +
      "</div>";
  }

  function mountCapture(el, opts) {
    let doc = null;
    const storage = opts.storage;

    function newDoc(keepFromCurrent) {
      return C.makeDocument({
        device: opts.device,
        title: opts.title || "",
        mode: keepFromCurrent && doc ? doc.mode : C.DEFAULT_MODE,
        // a new session continues the numbering: its first weld is the next one after the last weld of the previous session
        firstWeldNumber: keepFromCurrent && doc ? C.buildRecords(doc).firstWeldNumber + C.buildRecords(doc).joints : 1,
        // a new session takes the options of the open one, or the last ones chosen on this device
        options: keepFromCurrent && doc ? doc.options : C.loadPreferences(),
      });
    }

    async function persist() {
      try {
        await storage.save(doc);
      } catch (e) {
        console.error("chrono save failed", e);
      }
    }

    function state() {
      const r = C.buildRecords(doc);
      const started = doc.events.some((e) => e.type === "start");
      const stopped = r.sessionStop !== null;
      return { r, started, running: started && !stopped, stopped };
    }

    function render() {
      const s = state();
      const mode = C.modeOf(doc);
      const next = s.r.firstWeldNumber + s.r.joints;
      // on the phone the mode is chosen from a menu in the page header (opts.modeMenu), not here
      // the mode is a pill of two choices on the PC; on the phone it is in the header menu (opts.modeMenu)
      const modes = opts.modeMenu
        ? ""
        : '<div class="chrono-mode-pill' + (s.started ? " disabled" : "") + '" role="group" aria-label="Mode">' +
          C.MODE_IDS.map((id) => '<span data-mode="' + id + '" role="button" aria-pressed="' + (id === mode) + '" class="' + (id === mode ? "active" : "") + '">' + esc(C.MODES[id].label) + "</span>").join("") +
          "</div>";
      const allSteps = C.stepsOf(mode);
      const allowed = C.allowedSteps(doc);
      const lastRec = s.r.records.length ? s.r.records[s.r.records.length - 1] : null;
      const openRec = lastRec && lastRec.open ? lastRec : null;
      const pressed = openRec ? openRec.steps : {};
      const passed = openRec ? openRec.skipped || {} : {};
      const isLeft = (st) => typeof pressed[st.type] !== "number" && !passed[st.type];
      const nextStep = allSteps.find(isLeft);
      let stepButtons;
      // every step is always there, in any order: the log records each action, there is no fixed order to follow
      if (false) {
        // one step at a time: the steps done or passed of this weld, then the next one with a small "Pass" button
        const chips = allSteps
          .filter((st) => typeof pressed[st.type] === "number" || passed[st.type])
          .map((st) => '<span class="chrono-done">' + esc(st.button) + " <b>" + (typeof pressed[st.type] === "number" ? C.fmt(openRec.durations[st.type]) : "pass") + "</b></span>")
          .join("");
        stepButtons = '<div class="chrono-done-list">' + chips + "</div>" +
          (nextStep
            ? '<div class="chrono-next-row"><button type="button" class="chrono-btn step next" data-type="' + nextStep.type + '">' + esc(nextStep.button) + '</button>' +
              '<button type="button" class="chrono-btn pass" data-type="skip" data-step="' + nextStep.type + '">Pass</button></div>'
            : "");
      } else {
        // on the PC every step is shown; any order, all optional
        stepButtons = allSteps
          .map((st) => '<button type="button" class="chrono-btn step" data-type="' + st.type + '"' + (s.running && (!allowed || allowed[st.type]) ? "" : " disabled") + ">" + esc(st.button) + "</button>")
          .join("");
      }
      // on the phone, while the weld is running, Next weld sits to the right of Cancel last
      const onshoreMode = C.modeOf(doc) === "onshore";
      // no Next weld button: a weld closes by itself at its last step (both modes)
      const weldInRow = false;
      const body =
        '<div class="chrono-head">' +
        '<label class="chrono-field">Title<input type="text" class="chrono-title" value="' + esc(doc.title) + '"' + (s.started ? " disabled" : "") + "></label>" +
        // KP and first weld side by side on one line
        '<div class="chrono-pair">' +
        '<label class="chrono-field">KP<input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" class="chrono-kp" value="' + (doc.kp === null || doc.kp === undefined ? "" : doc.kp) + '"' + (s.started ? " disabled" : "") + "></label>" +
        '<label class="chrono-field">First weld<input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" class="chrono-first" value="' + doc.firstWeldNumber + '"' + (s.started ? " disabled" : "") + "></label>" +
        "</div>" +
        "</div>" +
        (opts.modeSlot ? "" : '<div class="chrono-modes" role="group" aria-label="Mode">' + modes + "</div>") +
        '<div class="chrono-status">' +
        (s.running ? "Running · next weld n° " + next : s.stopped ? "Stopped · " + s.r.joints + " welds" : "Not started") +
        "</div>" +
        summaryHtml(s.r) +
        '<div class="chrono-main">' +
        // on the PC the first row holds Start (or Next weld) and Stop over the KP, Weld and Start columns; the steps sit over the table columns
        // Cancel last on the left and New session on the right, above the buttons
        '<div class="chrono-row">' +
        // Cancel last appears only once the session has started
        (doc.events.length ? '<button type="button" class="chrono-btn secondary" data-type="cancel">Cancel last</button>' : "") +
        (weldInRow ? '<button type="button" class="chrono-btn weld' + (s.running && !nextStep ? " next" : "") + (s.running && nextStep ? " secondary" : "") + '" data-type="weld"' + (s.running ? "" : " disabled") + ">Next weld</button>" : "") +
        (s.stopped ? '<button type="button" class="chrono-btn secondary next" data-type="new">New session</button>' : "") +
        "</div>" +
        '<div class="chrono-steps" style="--n:' + allSteps.length + '">' +
        (weldInRow ? "" : s.started ? "" : s.started
          ? '<button type="button" class="chrono-btn weld' + (opts.sequential && s.running && !nextStep ? " next" : "") + (opts.sequential && s.running && nextStep ? " secondary" : "") + '" data-type="weld"' + (s.running ? "" : " disabled") + ">Next weld</button>"
          : '<button type="button" class="chrono-btn start solo" data-type="start">' + (C.modeOf(doc) === "onshore" ? "Start at clamp in position" : "Start at the End of last pull") + '</button>') +
        // once the session has started, Stop takes the place of the Start: it spans the KP, Weld and Start columns
        // no Stop button before the session starts (it replaces the Start button), in both modes
        (s.started ? '<button type="button" class="chrono-btn stop' + (s.started ? " solo" : "") + '" data-type="stop"' + (s.running ? "" : " disabled") + ">Stop</button>" : "") +
        stepButtons +
        "</div></div>" +
        '<div class="chrono-report-slot"></div>';
      // the mode pill goes into the slot given by the page, when there is one
      if (opts.modeSlot) opts.modeSlot.innerHTML = modes;
      el.innerHTML = '<div class="chrono">' + body + "</div>";
      renderReport(el.querySelector(".chrono-report-slot"), doc, !!opts.chartInMenu, true);
    }

    const onClick = async (ev) => {
      const modeBtn = ev.target.closest("[data-mode]");
      if (modeBtn) {
        // the mode can change only before Start
        if (doc.events.length) return;
        doc.mode = modeBtn.dataset.mode;
        await persist();
        return render();
      }
      const b = ev.target.closest("button[data-type]");
      if (!b || b.disabled) return;
      const type = b.dataset.type;
      if (type === "cancel") doc.events = C.undo(doc.events);
      else if (type === "new") doc = newDoc(true);
      else {
        const t = C.nowWall();
        const stepType = type === "skip" ? b.dataset.step : type;
        if (type === "skip") doc.events.push({ type: "skip", step: stepType, t });
        else doc.events.push({ type, t });
        // one step at a time: the last step of the cycle (pressed or passed) closes the weld, and the next weld starts
        const steps = C.stepsOf(C.modeOf(doc));
        // on the PC as on the phone: the last step of the cycle closes the weld, and the next weld starts
        if (C.modeOf(doc) !== "onshore" && stepType === steps[steps.length - 1].type) doc.events.push({ type: "weld", t });
      }
      await persist();
      render();
    };
    el.addEventListener("click", onClick);
    // the mode pill can sit in another place of the page (the title row): it works the same way
    if (opts.modeSlot) opts.modeSlot.addEventListener("click", onClick);

    el.addEventListener("change", async (ev) => {
      // a comment of a line: saved in the document, without redrawing the page (the typing keeps its place)
      if (ev.target.classList.contains("chrono-comment")) {
        doc.comments = doc.comments || {};
        doc.comments[ev.target.dataset.start] = ev.target.value;
        await persist();
        return;
      }
      if (ev.target.classList.contains("chrono-mode-select")) {
        // the mode can change only before Start
        if (doc.events.length) return render();
        doc.mode = ev.target.value;
      }
      if (ev.target.classList.contains("chrono-title")) doc.title = ev.target.value;
      // KP and first weld are numbers only: anything else is removed
      if (ev.target.classList.contains("chrono-kp")) {
        // the KP applies to the welds closed from now on
        const digits = ev.target.value.replace(/\D/g, "");
        doc.kp = digits === "" ? null : parseInt(digits, 10);
      }
      if (ev.target.classList.contains("chrono-first")) {
        const digits = ev.target.value.replace(/\D/g, "");
        doc.firstWeldNumber = digits === "" ? 1 : parseInt(digits, 10);
      }
      await persist();
      render();
    });

    (async function init() {
      let loaded = null;
      try {
        loaded = await storage.load();
      } catch (e) {
        console.error("chrono load failed", e);
      }
      doc = loaded && loaded.format === C.FORMAT ? loaded : newDoc(false);
      // the steps of this session follow its own options
      C.applyOptions(doc.options);
      render();
    })();

    return {
      getDoc: () => doc,
      refresh: render,
      // the options of the open session: saved in the session, and kept as the default of the next ones
      setOptions: async function (o) {
        doc.options = C.normalizeOptions(Object.assign({}, doc.options, o));
        C.applyOptions(doc.options);
        C.savePreferences(doc.options);
        await persist();
        render();
        return doc.options;
      },
      // returns false when the mode cannot change (the session has started)
      setMode: async function (mode) {
        if (doc.events.length) return false;
        doc.mode = C.MODE_IDS.indexOf(mode) >= 0 ? mode : C.DEFAULT_MODE;
        await persist();
        render();
        return true;
      },
    };
  }

  // the chart alone, for the menu of the phone page
  function renderChart(doc) {
    const r = C.buildRecords(doc);
    return r.records.length ? chartHtml(r) : '<p class="small">No weld recorded yet.</p>';
  }

  // the mobile page shows the cumulative step times; the PC keeps the durations
  root.ChronoUI = { mountCapture, renderReport, renderChart, setCumulativeSteps(on) { cumulativeSteps = !!on; } };
})(typeof self !== "undefined" ? self : this);
