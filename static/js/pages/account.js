import { h, t, api, field, busy, notice, mount, when, icon, state, daysAgoIso, todayIso, errorText } from "../core.js";
import { navigate, savePrefs } from "../main.js";

function panel(id, title, ...children) {
  return h("section", { class: "panel", id, aria: { labelledby: `${id}-h` } }, h("h2", { id: `${id}-h` }, title), ...children);
}

function profilePanel() {
  const name = h("input", { value: state.me.name, maxlength: 80, autocomplete: "name", required: true });
  const msg = h("div", { class: "form-msg", aria: { live: "polite" } });
  const btn = h("button", { type: "submit", class: "btn btn-primary" }, t("account.save"));
  return panel("profile", t("account.profile"),
    h("form", { class: "stack", onsubmit: async (e) => {
      e.preventDefault();
      const ok = await busy(btn, msg, () => api("/api/account/profile", { method: "POST", body: { name: name.value.trim() } }), t("account.saved"));
      if (ok) state.me.name = name.value.trim();
    } },
    field(t("account.username"), h("input", { value: state.me.username, readonly: true, autocomplete: "username" })),
    field(t("account.name"), name), msg, btn));
}

function choice(name, legend, options, current, onChange) {
  return h("fieldset", { class: "choice" }, h("legend", null, legend),
    h("div", { class: "choice-row" }, options.map(([value, label]) => {
      const id = `${name}-${value}`;
      return h("div", { class: "choice-opt" },
        h("input", { type: "radio", name, id, value, checked: value === current, onchange: () => onChange(value) }),
        h("label", { for: id }, label));
    })));
}

function displayPanel() {
  return panel("display", t("account.display"),
    choice("lang", t("prefs.language"), [["nl", "Nederlands"], ["en", "English"]], state.lang, (v) => savePrefs({ language: v })),
    choice("theme", t("prefs.theme"), [["system", t("prefs.theme_system")], ["light", t("prefs.theme_light")], ["dark", t("prefs.theme_dark")]],
      document.documentElement.dataset.theme || "system", (v) => savePrefs({ theme: v })),
    choice("size", t("prefs.size"), [["normal", t("prefs.size_normal")], ["large", t("prefs.size_large")], ["xlarge", t("prefs.size_xlarge")]],
      document.documentElement.dataset.size || "large", (v) => savePrefs({ text_size: v })));
}

function passwordPanel() {
  const current = h("input", { type: "password", autocomplete: "current-password", required: true });
  const next = h("input", { type: "password", autocomplete: "new-password", required: true, minlength: 12, maxlength: 128 });
  const msg = h("div", { class: "form-msg", aria: { live: "polite" } });
  const btn = h("button", { type: "submit", class: "btn btn-primary" }, t("account.change"));
  return panel("password", t("account.password"),
    h("form", { class: "stack", onsubmit: async (e) => {
      e.preventDefault();
      const ok = await busy(btn, msg, () => api("/api/account/password", { method: "POST", body: { current: current.value, new: next.value } }), t("account.pw_changed"));
      if (ok) { current.value = ""; next.value = ""; }
    } },
    h("input", { type: "text", autocomplete: "username", value: state.me.username, hidden: true, readonly: true, tabindex: "-1", aria: { hidden: "true" } }),
    field(t("account.current"), current), field(t("account.new"), next, { hint: t("account.pw_rules") }), msg, btn));
}

async function thresholdsPanel() {
  const data = await api("/api/thresholds");
  const msg = h("div", { class: "form-msg", aria: { live: "polite" } });
  const btn = h("button", { type: "submit", class: "btn btn-primary" }, t("account.save"));
  const inputs = {};
  const fields = ["bpm_low", "bpm_high", "spo2_low", "temp_high"].map((key) => {
    const [min, max] = data.limits[key];
    inputs[key] = h("input", { type: "number", inputmode: "decimal", min, max, step: key === "temp_high" ? 0.1 : 1, value: data[key], required: true });
    return field(t(`account.${key}`), inputs[key], { hint: t("account.default_hint", { d: data.defaults[key], min, max }) });
  });
  const reset = h("button", { type: "button", class: "btn btn-ghost", onclick: () => { for (const [k, el] of Object.entries(inputs)) el.value = data.defaults[k]; } }, t("account.defaults"));
  return panel("thresholds", t("account.thresholds"),
    h("p", { class: "muted" }, t("account.thresholds_intro")),
    h("p", { class: "small" }, data.custom ? t("account.custom_note") : t("account.default_note")),
    h("form", { class: "stack", onsubmit: async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, Number(el.value)]));
      await busy(btn, msg, () => api("/api/thresholds", { method: "PUT", body }), t("account.saved"));
    } }, h("div", { class: "grid-2" }, fields), msg, h("div", { class: "btn-row" }, btn, reset)));
}

function keysPanel() {
  // Keys live on the API page now: one key per account, with a log of what arrived.
  return panel("keys", t("account.keys"),
    h("p", { class: "muted" }, t("account.keys_intro")),
    h("p", null, h("a", { class: "btn btn-secondary", href: "/api" }, icon("key", 20), h("span", null, t("account.keys_go")))));
}

function dataPanel() {
  const from = h("input", { type: "date", value: daysAgoIso(29), max: todayIso() });
  const to = h("input", { type: "date", value: todayIso(), max: todayIso() });
  const q = () => `start=${from.value}&end=${to.value}`;
  const csv = h("a", { class: "btn btn-secondary", href: "#", download: "" }, icon("download", 20), h("span", null, t("account.csv")));
  const sync = () => { csv.href = `/api/export.csv?${q()}`; report.href = `/report?${q()}`; };
  const report = h("a", { class: "btn btn-primary", href: "/report" }, icon("doc", 20), h("span", null, t("account.report")));
  from.addEventListener("change", sync); to.addEventListener("change", sync);
  sync();
  return panel("data", t("account.data"),
    h("p", { class: "muted" }, t("account.data_intro")),
    h("div", { class: "grid-2" }, field(t("account.from"), from), field(t("account.to"), to)),
    h("div", { class: "btn-row" }, report, csv,
      h("a", { class: "btn btn-secondary", href: "/api/export.json", download: "" }, icon("download", 20), h("span", null, t("account.json")))));
}

async function securityPanel() {
  const { events } = await api("/api/account/audit");
  const logoutAll = h("button", { type: "button", class: "btn btn-secondary", onclick: async () => {
    await api("/api/account/logout-everywhere", { method: "POST" }).catch(() => {});
    state.me = null; navigate("/login");
  } }, icon("logout", 20), h("span", null, t("account.logout_all")));
  return panel("security", t("account.security"), logoutAll,
    h("h3", null, t("account.activity")),
    h("ul", { class: "rows compact" }, events.slice(0, 25).map((ev) => h("li", { class: "row" },
      h("span", null, t(`audit.${ev.action}`).startsWith("audit.") ? ev.action : t(`audit.${ev.action}`),
        ev.actor_name && ev.action.startsWith("care.") ? h("span", { class: "muted" }, ` · ${ev.actor_name}`) : null),
      h("span", { class: "muted small" }, when(ev.created_at))))));
}

function deletePanel() {
  if (state.me.admin) return null;
  const pw = h("input", { type: "password", autocomplete: "current-password", required: true });
  const msg = h("div", { class: "form-msg", aria: { live: "polite" } });
  const btn = h("button", { type: "submit", class: "btn btn-danger" }, t("account.delete_btn"));
  return h("section", { class: "panel panel-danger", id: "delete", aria: { labelledby: "delete-h" } },
    h("h2", { id: "delete-h" }, t("account.delete")),
    h("p", null, t("account.delete_intro")),
    h("form", { class: "stack", onsubmit: async (e) => {
      e.preventDefault();
      const ok = await busy(btn, msg, () => api("/api/account/delete", { method: "POST", body: { password: pw.value } }));
      if (ok) { state.me = null; navigate("/login"); }
    } }, field(t("account.delete_confirm"), pw), msg, btn));
}

export async function accountPage() {
  let extra;
  try { extra = await Promise.all([thresholdsPanel(), Promise.resolve(keysPanel()), securityPanel()]); }
  catch (error) { extra = [notice("error", errorText(error))]; }
  const [thresholds, keys, security] = extra;
  const tocItems = [["thresholds", "account.thresholds"], ["keys", "account.keys"], ["data", "account.data"], ["display", "account.display"],
    ["profile", "account.profile"], ["password", "account.password"], ["security", "account.security"]];
  const page = h("div", { class: "page" },
    h("header", { class: "page-head" }, h("h1", null, t("account.title"))),
    h("nav", { class: "toc", aria: { label: t("account.title") } }, tocItems.map(([id, key]) => h("a", { href: `#${id}` }, t(key)))),
    thresholds, keys, dataPanel(), displayPanel(), profilePanel(), passwordPanel(), security, deletePanel());
  if (location.hash) requestAnimationFrame(() => document.querySelector(location.hash)?.scrollIntoView());
  return page;
}
