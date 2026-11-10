import { h, t, api, field, busy, notice, mount, icon, todayIso, errorText, state } from "../core.js";
import { navigate } from "../main.js";
import { enableReminders, reminderState } from "../reminders.js";
import { drawnCheck } from "./goals.js";

// ---------- acknowledgement after a check-in ----------
// Before and after a save we read the goals once, so the message can say what this check-in added.
async function goalSnapshot() {
  try {
    const data = await api("/api/goals");
    return { done: new Set(data.daily.filter((g) => g.complete).map((g) => g.key)), total: data.overview.totals.checkins };
  } catch {
    return null;
  }
}
let before = null;
const ordinal = (n) => {
  if (state.lang !== "en") return `${n}e`;
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
  return `${n}${s}`;
};
async function acknowledge(slot) {
  const prev = await before;
  const now = await goalSnapshot();
  before = Promise.resolve(now);
  const lines = [];
  if (now && prev && now.total > prev.total) lines.push(t("ack.nth", { n: ordinal(now.total) }));
  const fresh = now && prev ? [...now.done].filter((k) => !prev.done.has(k)) : [];
  fresh.forEach((k) => lines.push(t("ack.goal", { goal: t(`goal.${k}`) })));
  mount(slot, h("div", { class: "ack", role: "status" }, drawnCheck(28),
    h("div", { class: "ack-body" },
      h("p", { class: "ack-title" }, t("log.saved")),
      lines.map((line) => h("p", null, line)),
      h("a", { href: "/goals" }, t("ack.see_goals")))));
}

const SYMPTOMS = ["chest_pain", "palpitations", "short_breath", "dizziness", "fatigue", "headache", "nausea", "other"];
const TABS = ["feel", "own", "mood", "med", "measure"];

function scale(name, labelKey, prefix) {
  const legend = h("legend", null, t(labelKey));
  const options = [1, 2, 3, 4, 5].map((v) => {
    const id = `${name}-${v}`;
    return h("div", { class: "scale-opt" },
      h("input", { type: "radio", name, id, value: v }),
      h("label", { for: id }, h("span", { class: "scale-num" }, String(v)), prefix ? h("span", { class: "scale-word" }, t(`${prefix}_${v}`)) : null));
  });
  return h("fieldset", { class: "scale" }, legend, h("div", { class: "scale-row" }, options));
}
const radioValue = (form, name) => { const el = form.querySelector(`input[name="${name}"]:checked`); return el ? Number(el.value) : null; };

function feelForm() {
  const msg = h("div", { class: "form-msg", aria: { live: "polite" } });
  const submit = h("button", { type: "submit", class: "btn btn-primary" }, t("log.save"));
  const notes = h("textarea", { name: "notes", maxlength: 1000, rows: 3 });
  const form = h("form", { class: "stack", onsubmit: async (event) => {
    event.preventDefault();
    const symptoms = [...form.querySelectorAll('input[name="symptom"]:checked')].map((el) => el.value);
    const severity = radioValue(form, "severity");
    const result = await busy(submit, msg, () => api("/api/symptoms", { method: "POST", body: { symptoms, severity: severity ?? 0, notes: notes.value } }));
    if (result) {
      form.reset();
      await afterSymptom(msg, result);
    }
  } },
  h("fieldset", { class: "chips" }, h("legend", null, t("log.symptoms")),
    h("div", { class: "chip-row" }, SYMPTOMS.map((s) => h("div", { class: "chip" },
      h("input", { type: "checkbox", name: "symptom", value: s, id: `sym-${s}` }), h("label", { for: `sym-${s}` }, t(`symptom.${s}`)))))),
  scale("severity", "log.severity", null),
  h("p", { class: "hint" }, t("log.severity_hint")),
  field(t("log.notes"), notes), msg, submit);
  return form;
}

// Shown after saving a symptom: 112 advice stands alone when it applies, otherwise the normal acknowledgement.
async function afterSymptom(msg, result) {
  if (result.show_emergency) {
    mount(msg, h("div", { class: "alert alert-urgent", role: "alert" }, h("div", { class: "alert-icon" }, icon("alert", 28)),
      h("div", { class: "alert-body" }, h("h2", null, t("log.saved")), h("p", { class: "alert-emergency" }, t("alert.emergency")), h("p", { class: "alert-small" }, t("alert.not_diagnosis")))));
    before = goalSnapshot();
  } else {
    await acknowledge(msg);
  }
}

// Own symptom: the user writes what they have, in their own words.
function ownForm() {
  const msg = h("div", { class: "form-msg", aria: { live: "polite" } });
  const submit = h("button", { type: "submit", class: "btn btn-primary" }, t("log.save"));
  const what = h("input", { name: "custom", maxlength: 80, required: true, autocomplete: "off" });
  const notes = h("textarea", { name: "notes", maxlength: 1000, rows: 3 });
  const form = h("form", { class: "stack", novalidate: true, onsubmit: async (event) => {
    event.preventDefault();
    if (!what.value.trim()) { mount(msg, notice("error", t("log.own_missing"))); what.focus(); return; }
    const severity = radioValue(form, "own-severity");
    const result = await busy(submit, msg, () => api("/api/symptoms", { method: "POST", body: { custom: what.value.trim(), severity: severity ?? 0, notes: notes.value } }));
    if (result) { form.reset(); await afterSymptom(msg, result); }
  } },
  h("p", { class: "muted" }, t("log.own_intro")),
  field(t("log.own_label"), what, { hint: t("log.own_hint") }),
  scale("own-severity", "log.severity", null),
  h("p", { class: "hint" }, t("log.severity_hint")),
  field(t("log.notes"), notes), msg, submit);
  return form;
}

function moodForm() {
  const msg = h("div", { class: "form-msg", aria: { live: "polite" } });
  const submit = h("button", { type: "submit", class: "btn btn-primary" }, t("log.save"));
  const notes = h("textarea", { maxlength: 1000, rows: 3 });
  const form = h("form", { class: "stack", onsubmit: async (event) => {
    event.preventDefault();
    const ok = await busy(submit, msg, () => api("/api/mood", { method: "POST", body: { stress: radioValue(form, "stress"), mood: radioValue(form, "mood"), notes: notes.value } }));
    if (ok) { form.reset(); await acknowledge(msg); }
  } }, scale("stress", "log.stress_q", "log.stress"), scale("mood", "log.mood_q", "log.mood"), field(t("log.notes"), notes), msg, submit);
  return form;
}

// Editable list of dose times; returns the element and a getter for the values.
function timeEditor(initial) {
  const list = h("div", { class: "time-list" });
  const addRow = (value = "") => {
    const input = h("input", { type: "time", value, aria: { label: t("reminders.times") } });
    const row = h("span", { class: "time-item" }, input,
      h("button", { type: "button", class: "icon-btn", aria: { label: t("reminders.remove_time", { time: value || "" }) }, onclick: () => row.remove() }, icon("x", 18)));
    list.append(row);
    return input;
  };
  (initial.length ? initial : []).forEach((v) => addRow(v));
  const add = h("button", { type: "button", class: "btn btn-small btn-secondary", onclick: () => addRow("").focus() }, icon("plus", 18), h("span", null, t("reminders.add_time")));
  return { el: h("div", { class: "stack" }, list, add), values: () => [...list.querySelectorAll("input")].map((i) => i.value).filter(Boolean) };
}

function reminderSwitch() {
  const slot = h("div", { class: "form-msg", aria: { live: "polite" } });
  const stateNow = reminderState();
  const describe = (st) => ({ on: t("reminders.enabled"), denied: t("reminders.denied"), unsupported: t("reminders.unsupported") }[st]);
  const btn = h("button", { type: "button", class: "btn btn-secondary", onclick: async () => {
    const result = await enableReminders();
    mount(slot, notice(result === "on" ? "ok" : "warn", describe(result) || t("reminders.note")));
    btn.hidden = result === "on" || result === "unsupported";
  } }, icon("bell", 20), h("span", null, t("reminders.enable")));
  btn.hidden = stateNow === "on" || stateNow === "unsupported";
  if (describe(stateNow)) mount(slot, notice(stateNow === "on" ? "ok" : "warn", describe(stateNow)));
  return h("div", { class: "stack" }, h("h3", null, t("reminders.title")), h("p", { class: "muted" }, t("reminders.note")), btn, slot);
}

async function medPanel() {
  const data = await api("/api/medications");
  const msg = h("div", { class: "form-msg", aria: { live: "polite" } });
  const active = data.medications.filter((m) => m.active);
  const reload = () => navigate("/log?tab=med", { replace: true });

  const rows = active.map((m) => {
    const editor = timeEditor(m.times || []);
    const rowMsg = h("div", { class: "form-msg", aria: { live: "polite" } });
    const save = h("button", { type: "button", class: "btn btn-small btn-primary", onclick: async () => {
      await busy(save, rowMsg, () => api(`/api/medications/${m.id}/times`, { method: "PUT", body: { times: editor.values() } }), t("log.saved"));
    } }, t("reminders.save_times"));
    return h("li", { class: "med-row" },
      h("div", { class: "row" },
        h("div", null, h("strong", null, m.name), m.dose ? h("span", { class: "muted" }, ` · ${m.dose}`) : null),
        h("button", { type: "button", class: "btn btn-small btn-ghost", onclick: async () => { await api(`/api/medications/${m.id}`, { method: "DELETE" }).catch(() => {}); reload(); } }, t("log.med_archive"))),
      h("fieldset", { class: "stack" }, h("legend", null, t("reminders.times")), editor.el),
      h("div", { class: "btn-row" }, save), rowMsg);
  });

  const name = h("input", { maxlength: 80, required: true, autocomplete: "off" });
  const dose = h("input", { maxlength: 60, autocomplete: "off" });
  const newTimes = timeEditor(["08:00"]);
  const submit = h("button", { type: "submit", class: "btn btn-primary" }, icon("plus", 20), h("span", null, t("log.med_add")));
  return h("div", { class: "stack" },
    h("h2", null, t("log.med_list")),
    rows.length ? h("ul", { class: "rows" }, rows) : h("p", { class: "muted" }, t("log.med_none")),
    reminderSwitch(),
    h("form", { class: "stack", onsubmit: async (event) => {
      event.preventDefault();
      const times = newTimes.values();
      const ok = await busy(submit, msg, () => api("/api/medications", { method: "POST", body: { name: name.value, dose: dose.value, times, times_per_day: Math.max(1, times.length) } }));
      if (ok) reload();
    } }, h("h3", null, t("log.med_add")), field(t("log.med_name"), name), field(t("log.med_dose"), dose),
    h("fieldset", { class: "stack" }, h("legend", null, t("reminders.times")), h("p", { class: "hint" }, t("reminders.times_hint")), newTimes.el),
    msg, submit));
}

function measureForm() {
  const msg = h("div", { class: "form-msg", aria: { live: "polite" } });
  const submit = h("button", { type: "submit", class: "btn btn-primary" }, t("log.save"));
  const inputs = {
    date: h("input", { type: "date", value: todayIso(), max: todayIso(), required: true }),
    time: h("input", { type: "time" }),
    bpm: h("input", { type: "number", inputmode: "numeric", min: 20, max: 250, step: 1 }),
    steps: h("input", { type: "number", inputmode: "numeric", min: 0, max: 100000, step: 1 }),
    sleep: h("input", { type: "number", inputmode: "decimal", min: 0, max: 24, step: 0.1 }),
    spo2: h("input", { type: "number", inputmode: "numeric", min: 50, max: 100, step: 1 }),
    water: h("input", { type: "number", inputmode: "decimal", min: 0, max: 15, step: 0.1 }),
    weight: h("input", { type: "number", inputmode: "decimal", min: 20, max: 400, step: 0.1 }),
    notes: h("textarea", { maxlength: 2000, rows: 2 }),
  };
  const form = h("form", { class: "stack", onsubmit: async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]).filter(([, v]) => v !== ""));
    const ok = await busy(submit, msg, () => api("/api/entries", { method: "POST", body }));
    if (ok) { Object.entries(inputs).forEach(([k, el]) => { if (k !== "date") el.value = ""; }); await acknowledge(msg); }
  } },
  h("p", { class: "muted" }, t("log.measure_intro")),
  h("div", { class: "grid-2" },
    field(t("log.date"), inputs.date), field(t("log.time"), inputs.time),
    field(`${t("metric.bpm")} (${t("unit.bpm")})`, inputs.bpm), field(`${t("metric.spo2")} (${t("unit.spo2")})`, inputs.spo2),
    field(t("metric.steps"), inputs.steps),
    field(`${t("metric.sleep")} (${t("unit.sleep")})`, inputs.sleep), field(`${t("metric.water")} (${t("unit.water")})`, inputs.water),
    field(`${t("metric.weight")} (${t("unit.weight")})`, inputs.weight)),
  field(t("log.notes"), inputs.notes), msg, submit);
  return form;
}

export async function logPage() {
  const params = new URLSearchParams(location.search);
  const tab = TABS.includes(params.get("tab")) ? params.get("tab") : "feel";
  const tabKeys = { feel: "tab_feel", own: "tab_own", mood: "tab_mood", med: "tab_med", measure: "tab_measure" };
  if (tab !== "med") before = goalSnapshot();
  let content;
  try {
    content = tab === "feel" ? feelForm() : tab === "own" ? ownForm() : tab === "mood" ? moodForm() : tab === "med" ? await medPanel() : measureForm();
  } catch (error) { content = notice("error", errorText(error)); }
  return h("div", { class: "page" },
    h("header", { class: "page-head" }, h("h1", null, t("log.title")), h("p", { class: "muted" }, t("log.intro"))),
    h("nav", { class: "segmented segmented-wide", aria: { label: t("log.title") } },
      TABS.map((key) => h("a", { href: `/log?tab=${key}`, class: ["seg", key === tab && "active"], aria: { current: key === tab ? "page" : null } }, t(`log.${tabKeys[key]}`)))),
    h("section", { class: "panel" }, content));
}
