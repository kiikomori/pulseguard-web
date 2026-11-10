// Overview ("cockpit"): the current reading and status on the left, the Pulse Plot on the right,
// one strip of other readings along the bottom. Fits a laptop screen without scrolling.
import { h, t, api, num, time, when, icon, mount, notice, errorText, state } from "../core.js";
import { pulsePlot } from "../pulseplot.js";
import { dueDoses, nextDose } from "../reminders.js";
import { render } from "../main.js";

export const STEP_TARGET = 8000;
export const SLEEP_TARGET = 7;

function greeting() {
  const hour = new Date().getHours();
  return t(`greet.${hour < 6 ? "night" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"}`);
}

function rangeText(metric, value, th) {
  if (value === null || value === undefined) return t("range.no_value");
  if (metric === "bpm") {
    if (value > th.bpm_high) return t("range.above", { high: num(th.bpm_high) });
    if (value < th.bpm_low) return t("range.below", { low: num(th.bpm_low) });
    return t("range.within", { low: num(th.bpm_low), high: num(th.bpm_high) });
  }
  if (metric === "spo2") return value < th.spo2_low ? t("range.below", { low: num(th.spo2_low) }) : t("range.min_ok", { low: num(th.spo2_low) });
  if (metric === "temp_c") return value > th.temp_high ? t("range.above", { high: num(th.temp_high, 1) }) : t("range.max_ok", { high: num(th.temp_high, 1) });
  return "";
}
function outOfRange(metric, value, th) {
  if (value === null || value === undefined) return false;
  return (metric === "bpm" && (value > th.bpm_high || value < th.bpm_low)) || (metric === "spo2" && value < th.spo2_low) || (metric === "temp_c" && value > th.temp_high);
}

export function alertBanner(alert, { readOnly, onAck, compact = false }) {
  const urgent = alert.severity === "urgent";
  const unit = t(`unit.${alert.kind.startsWith("bpm") ? "bpm" : alert.kind.startsWith("spo2") ? "spo2" : "temp_c"}`);
  const digits = alert.kind.startsWith("temp") ? 1 : 0;
  const ack = readOnly ? null : h("button", { type: "button", class: "btn btn-secondary", onclick: async (event) => {
    event.currentTarget.disabled = true;
    await api(`/api/alerts/${alert.id}/ack`, { method: "POST" }).catch(() => {});
    onAck?.();
  } }, icon("check", 20), h("span", null, t("alert.ack")));
  const title = t("alert.heading", { severity: urgent ? t("alert.urgent") : t("alert.warning"), what: t(`alert.${alert.kind}`).toLowerCase(), value: `${num(alert.value, digits)} ${unit}` });
  const advice = urgent ? t("alert.urgent_body") : t(alert.kind.endsWith("_low") ? "alert.warning_body_low" : "alert.warning_body_high");
  return h("section", { class: ["alert", urgent ? "alert-urgent" : "alert-warning", compact && "alert-compact"], role: urgent ? "alert" : "status" },
    h("div", { class: "alert-icon" }, icon("alert", compact ? 22 : 28)),
    h("div", { class: "alert-body" },
      h("h2", null, title),
      h("p", { class: "alert-when" }, `${when(alert.reading_ts || alert.created_at)}. ${advice}`),
      urgent ? h("p", { class: "alert-emergency" }, t("alert.emergency")) : null,
      compact ? null : h("p", { class: "alert-small" }, t("alert.not_diagnosis"))),
    ack ? h("div", { class: "alert-actions" }, ack) : null);
}

// Numbers move from the previous value to the new one when live data changes; never count up from zero.
const previous = new Map();
function liveNumber(key, value, digits = 0) {
  const span = h("span", { class: "num" }, value === null || value === undefined ? t("common.none") : num(value, digits));
  const before = previous.get(key);
  previous.set(key, value);
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (before !== undefined && before !== null && value !== null && value !== undefined && before !== value && !reduce) {
    const start = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - start) / 600);
      const eased = 1 - (1 - p) ** 3;
      span.textContent = num(before + (value - before) * eased, digits);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  return span;
}

function readout(metric, { label, iconName, value, unit, digits = 0, note, noteOut, href, extra, due }) {
  const body = [
    h("span", { class: "readout-label" }, icon(iconName, 18), label),
    h("span", { class: "readout-value" }, value === null || value === undefined ? t("common.none") : liveNumber(metric, value, digits), unit ? h("span", { class: "unit" }, ` ${unit}`) : null),
    note ? h("span", { class: ["readout-note", noteOut && "is-out"] }, note) : null,
    extra,
  ];
  const cls = ["readout", `tile-${metric}`, due && "is-due"];
  return href ? h("a", { class: cls, href }, body) : h("div", { class: cls }, body);
}

function medicationReadout(meds, readOnly, msg) {
  if (!meds.length) {
    return readout("medication", { label: t("metric.medication"), iconName: "pill", value: null, note: t("tile.med_none"), href: readOnly ? null : "/log?tab=med" });
  }
  const due = dueDoses(meds);
  if (due.length) {
    const first = due[0];
    return readout("medication", {
      label: t("reminders.due"), iconName: "pill", value: null, due: true,
      note: t("reminders.due_line", { name: `${first.med.name}${first.med.dose ? ` ${first.med.dose}` : ""}`, time: first.time }),
      extra: readOnly ? null : h("button", { type: "button", class: "btn btn-primary btn-small", onclick: async (event) => {
        event.currentTarget.disabled = true;
        try { await api(`/api/medications/${first.med.id}/log`, { method: "POST", body: { status: "taken" } }); render(); }
        catch (error) { mount(msg, notice("error", errorText(error))); event.currentTarget.disabled = false; }
      } }, t("tile.med_taken")),
    });
  }
  const expected = meds.reduce((a, m) => a + (m.times_per_day || 1), 0);
  const taken = meds.reduce((a, m) => a + Math.min(m.taken, m.times_per_day || 1), 0);
  const next = nextDose(meds);
  return readout("medication", {
    label: t("metric.medication"), iconName: "pill", value: taken, unit: `/ ${expected}`,
    note: next ? t("reminders.next", { name: next.med.name, time: next.time }) : t("tile.med_progress", { taken, total: expected }),
    href: readOnly ? null : "/log?tab=med",
  });
}

/** Shared by the overview, the caregiver view and the presenter view. */
export function cockpitParts(data, pulse, { readOnly, careId, animate, refresh, presenter = false }) {
  const th = data.thresholds;
  const latest = data.latest || {};
  const bpm = latest.bpm ?? null;
  const spo2 = data.latest_spo2?.value ?? null;
  const temp = data.latest_temp?.value ?? null;
  const today = data.today;
  const mood = data.mood;
  const msg = h("div", { class: "form-msg", aria: { live: "polite" } });

  let status;
  if (data.alerts.length) status = data.alerts.length === 1 ? t("status.attention_one") : t("status.attention_many", { n: data.alerts.length });
  else if (!data.last_sync) status = t("status.no_data");
  else if (data.stale) status = t("status.stale", { time: when(data.last_sync) });
  else status = t("status.ok");
  const calm = !data.alerts.length && data.last_sync && !data.stale;

  const now = h("section", { class: "now", aria: { label: t("metric.bpm") } },
    h("p", { class: "now-label" }, icon("heart", 20), t("metric.bpm"), latest.ts ? h("span", { class: "muted" }, ` ${t("tile.at", { time: time(latest.ts) })}`) : null),
    h("p", { class: ["now-bpm", outOfRange("bpm", bpm, th) && "is-out"] }, bpm === null ? h("span", { class: "num num-empty" }, t("common.none")) : liveNumber("bpm", bpm), bpm === null ? null : h("span", { class: "unit" }, t("unit.bpm"))),
    h("p", { class: ["status-line", calm ? "status-ok" : "status-attn"] }, calm ? icon("check", 22) : null, h("span", null, status)),
    h("p", { class: "now-meta" }, rangeText("bpm", bpm, th)),
    today.bpm_count ? h("p", { class: "now-meta" }, `${t("heart.summary", { min: num(today.bpm_min), max: num(today.bpm_max), avg: num(today.bpm_avg) })}${today.resting_bpm ? ` ${t("heart.resting_line", { v: num(today.resting_bpm) })}` : ""}`) : null,
    data.last_sync ? h("p", { class: "now-meta" }, t("status.last_sync", { time: when(data.last_sync) })) : null,
    presenter ? null : h("nav", { class: "now-links", aria: { label: t("nav.more") } },
      h("a", { href: readOnly ? `/care/${careId}/trends` : "/trends" }, icon("chart", 18), t("nav.trends")),
      readOnly ? h("a", { href: `/care/${careId}/report` }, icon("doc", 18), t("nav.report")) : h("a", { href: "/presentatie" }, icon("chart", 18), t("present.open"))));

  const plot = h("section", { class: "plot-area", aria: { labelledby: "plot-h" } },
    h("h2", { id: "plot-h" }, h("span", null, t("plot.title"))),
    pulsePlot(pulse.days, { thresholds: th, animate, beatBpm: data.stale ? null : bpm }));

  const moodNote = mood ? [mood.stress ? `${t("metric.stress").toLowerCase()} ${t(`log.stress_${mood.stress}`).toLowerCase()}` : null,
    mood.mood ? `${t("metric.mood").toLowerCase()} ${t(`log.mood_${mood.mood}`).toLowerCase()}` : null].filter(Boolean).join(", ") : t("tile.mood_none");

  const strip = h("section", { class: "strip", aria: { label: t("heart.today") } },
    readout("spo2", { label: t("metric.spo2"), iconName: "drop", value: spo2, unit: "%", note: rangeText("spo2", spo2, th), noteOut: outOfRange("spo2", spo2, th) }),
    readout("temp_c", { label: t("metric.temp_c"), iconName: "thermo", value: temp, unit: "°C", digits: 1, note: rangeText("temp_c", temp, th), noteOut: outOfRange("temp_c", temp, th) }),
    readout("steps", { label: t("metric.steps"), iconName: "steps", value: today.steps || null, note: t("tile.target", { target: num(STEP_TARGET), unit: t("unit.steps") }) }),
    readout("sleep", { label: t("metric.sleep"), iconName: "moon", value: today.sleep || null, unit: t("unit.sleep"), digits: 1, note: today.sleep ? t("tile.target", { target: num(SLEEP_TARGET), unit: t("unit.sleep") }) : t("tile.no_sleep") }),
    readout("stress", { label: t("tile.stress_mood"), iconName: "face", value: mood?.stress ?? null, unit: "/ 5", note: moodNote, href: readOnly || presenter ? null : "/log?tab=mood" }),
    medicationReadout(data.medication, readOnly || presenter, msg));

  const alerts = h("div", { class: "cockpit-alerts" }, data.alerts.map((a) => alertBanner(a, { readOnly: readOnly || presenter, onAck: refresh, compact: true })));
  return { alerts, now, plot, strip, msg };
}

let refreshTimer = null;
let painted = false;

export async function homePage({ careId }) {
  const base = careId ? `/api/care/${careId}` : "/api";
  const live = painted && (careId ? location.pathname === `/care/${careId}` : location.pathname === "/");
  const [data, pulse] = await Promise.all([
    api(`${base}/dashboard`, { poll: live }),
    api(`${base}/pulse?days=7`, { poll: live }).catch(() => ({ days: [] })),
  ]);
  const readOnly = Boolean(careId);
  const parts = cockpitParts(data, pulse, { readOnly, careId, animate: !live, refresh: () => render() });
  painted = true;

  // Live refresh while the overview is open and nobody is typing.
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    const onOverview = careId ? location.pathname === `/care/${careId}` : location.pathname === "/";
    if (!onOverview) { clearInterval(refreshTimer); painted = false; return; }
    if (document.visibilityState === "visible" && !document.activeElement?.closest("form")) render({ live: true });
  }, 60000);

  const careBar = readOnly ? h("div", { class: "care-bar", role: "note" },
    h("span", null, icon("users", 22), " ", t("care.viewing", { name: data.patient.name })),
    h("span", { class: "pill" }, t("care.read_only")),
    h("nav", { class: "care-links", aria: { label: data.patient.name } },
      h("a", { href: `/care/${careId}/history` }, t("nav.history")), h("a", { href: "/" }, t("care.back")))) : null;

  // Two ways in: log by hand right now (works without a watch), or connect the watch through the API.
  const onboarding = !readOnly && !data.last_sync ? h("section", { class: "panel onboarding", aria: { labelledby: "ob-h" } },
    h("h2", { id: "ob-h" }, t("onboarding.title")),
    h("div", { class: "onboarding-routes" },
      h("div", { class: "onboarding-route" },
        h("h3", null, icon("plus", 20), t("onboarding.log_title")), h("p", null, t("onboarding.log_body")),
        h("a", { class: "btn btn-primary", href: "/log" }, icon("plus", 20), h("span", null, t("onboarding.log_cta")))),
      h("div", { class: "onboarding-route" },
        h("h3", null, icon("key", 20), t("onboarding.watch_title")), h("p", null, t("onboarding.body")),
        h("a", { class: "btn btn-secondary", href: "/api" }, t("onboarding.cta"))))) : null;

  const name = readOnly ? data.patient.name : `${greeting()}, ${state.me?.name?.split(" ")[0] || ""}`;
  parts.now.prepend(h("h1", { class: "now-greeting" }, name));

  return h("div", { class: "page home" },
    careBar, onboarding,
    h("div", { class: "cockpit" }, parts.alerts, parts.now, parts.plot, parts.strip),
    parts.msg,
    readOnly ? null : h("a", { href: "/log", class: "fab btn btn-primary" }, icon("plus", 22), h("span", null, t("nav.log"))));
}
