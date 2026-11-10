import { h, t, api, field, busy, notice, mount, when, num, icon, state, day, daysAgoIso, todayIso, errorText, locale } from "../core.js";
import { symptomTitle } from "./history.js";
import { rangeChart } from "../charts.js";
import { milestoneTitle } from "./goals.js";
import { navigate } from "../main.js";

// ---------- notifications ----------
function notificationText(n) {
  let payload = {};
  try { payload = JSON.parse(n.message); } catch { return n.message; }
  if ((n.kind || "").startsWith("alert_")) {
    const unit = payload.kind?.startsWith("temp") ? "°C" : payload.kind?.startsWith("spo2") ? "%" : "bpm";
    return t("notifications.alert", { metric: t(`alert.${payload.kind}`), value: `${num(payload.value, unit === "°C" ? 1 : 0)} ${unit}` });
  }
  if (n.kind === "milestone") return t("notifications.milestone", { title: milestoneTitle(payload.title) });
  if (n.kind === "care_granted") return t("notifications.care_granted", { name: payload.name });
  return typeof payload === "string" ? payload : n.message;
}

export async function notificationsPage() {
  const { notifications } = await api("/api/notifications");
  const readAll = h("button", { type: "button", class: "btn btn-secondary", onclick: async () => {
    await api("/api/notifications/read", { method: "POST" }).catch(() => {});
    if (state.me) state.me.unread = 0;
    navigate("/notifications", { replace: true });
  } }, icon("check", 20), h("span", null, t("notifications.read_all")));
  return h("div", { class: "page" },
    h("header", { class: "page-head page-head-row" }, h("h1", null, t("notifications.title")), notifications.some((n) => !n.read_at) ? readAll : null),
    h("section", { class: "panel" }, notifications.length ? h("ul", { class: "rows" }, notifications.map((n) => h("li", { class: ["row", !n.read_at && "row-new"] },
      h("div", null, !n.read_at ? h("span", { class: "pill pill-new" }, t("notifications.new")) : null, " ", notificationText(n)),
      h("span", { class: "muted small" }, when(n.created_at))))) : h("p", { class: "muted" }, t("notifications.empty"))));
}

// ---------- admin ----------
export async function adminPage() {
  if (!state.me?.admin) return h("section", { class: "panel" }, h("h1", null, "403"));
  const data = await api("/api/admin/config");
  const selected = new Set(data.selected);
  const dailyMsg = h("div", { class: "form-msg", aria: { live: "polite" } });
  const dailyBtn = h("button", { type: "submit", class: "btn btn-primary" }, t("admin.save"));
  const daily = h("form", { class: "stack", onsubmit: async (e) => {
    e.preventDefault();
    const keys = [...daily.querySelectorAll("input[name=goal]:checked")].map((el) => el.value);
    if (keys.length > 3) { mount(dailyMsg, notice("error", t("admin.too_many"))); return; }
    await busy(dailyBtn, dailyMsg, () => api("/api/admin/daily-goals", { method: "POST", body: { keys } }), t("account.saved"));
  } },
  h("p", { class: "muted" }, t("admin.daily_intro")),
  h("div", { class: "chip-row" }, data.pool.map((g) => h("div", { class: "chip" },
    h("input", { type: "checkbox", name: "goal", id: `g-${g.key}`, value: g.key, checked: selected.has(g.key) }),
    h("label", { for: `g-${g.key}` }, t(`goal.${g.key}`))))), dailyMsg, dailyBtn);

  const m = {
    title: h("input", { required: true, maxlength: 100 }), category: h("input", { maxlength: 60, value: "Custom" }),
    metric: h("select", null, ["steps", "sleep", "water", "checkins"].map((k) => h("option", { value: k }, t(`metric.${k}`)))),
    target: h("input", { type: "number", min: 0.1, step: 0.1, required: true }), reward: h("input", { type: "number", min: 0, step: 1, value: 0 }),
  };
  const msMsg = h("div", { class: "form-msg", aria: { live: "polite" } });
  const msBtn = h("button", { type: "submit", class: "btn btn-primary" }, t("admin.milestone_add"));
  const milestone = h("form", { class: "stack", onsubmit: async (e) => {
    e.preventDefault();
    const ok = await busy(msBtn, msMsg, () => api("/api/admin/milestones", { method: "POST", body: {
      title: m.title.value, category: m.category.value, metric: m.metric.value, target: Number(m.target.value), reward: Number(m.reward.value) } }), t("account.saved"));
    if (ok) m.title.value = "";
  } }, h("div", { class: "grid-2" }, field(t("admin.m_title"), m.title), field(t("admin.m_category"), m.category),
    field(t("admin.m_metric"), m.metric), field(t("admin.m_target"), m.target), field(t("admin.m_reward"), m.reward)), msMsg, msBtn);

  const userMsg = h("div", { class: "form-msg", aria: { live: "polite" } });
  const users = h("div", { class: "table-wrap" }, h("table", null,
    h("thead", null, h("tr", null, [t("account.name"), t("account.username"), t("admin.last_login"), ""].map((x) => h("th", { scope: "col" }, x)))),
    h("tbody", null, data.users.map((u) => h("tr", null,
      h("th", { scope: "row" }, u.name, u.is_admin ? h("span", { class: "pill" }, " admin") : null), h("td", null, u.username),
      h("td", null, u.last_login_at ? when(u.last_login_at) : t("admin.never")),
      h("td", null, u.is_admin ? null : h("button", { type: "button", class: "btn btn-small btn-secondary", onclick: async (e) => {
        const result = await busy(e.currentTarget, userMsg, () => api(`/api/admin/users/${u.id}/reset-password`, { method: "POST" }));
        if (result) mount(userMsg, h("div", { class: "code-box", role: "status" }, h("p", null, t("admin.temp_pw", { name: u.name })), h("p", { class: "code mono" }, result.temporary_password)));
      } }, t("admin.reset"))))))));

  return h("div", { class: "page" },
    h("header", { class: "page-head" }, h("h1", null, t("admin.title"))),
    h("section", { class: "panel" }, h("h2", null, t("admin.daily")), daily),
    h("section", { class: "panel" }, h("h2", null, t("admin.milestone_add")), milestone),
    h("section", { class: "panel" }, h("h2", null, t("admin.users")), userMsg, users));
}

// ---------- privacy ----------
export function privacyPage() {
  return h("article", { class: "page prose" },
    h("h1", null, t("privacy.title")),
    ["p1", "p2", "p3", "p4"].map((k) => h("p", null, t(`privacy.${k}`))),
    h("p", { class: "muted small" }, t("privacy.version", { v: "2026-11-04" })),
    h("p", null, h("a", { href: state.me ? "/" : "/signup" }, t("common.back"))));
}

// ---------- doctor report ----------
export async function reportPage({ careId }) {
  const params = new URLSearchParams(location.search);
  const start = params.get("start") || daysAgoIso(29);
  const end = params.get("end") || todayIso();
  const base = careId ? `/api/care/${careId}` : "/api";
  const path = careId ? `/care/${careId}/report` : "/report";
  let data;
  try { data = await api(`${base}/report?start=${start}&end=${end}`); }
  catch (error) { return h("section", { class: "panel" }, h("h1", null, t("report.title")), notice("error", errorText(error))); }

  const from = h("input", { type: "date", value: start, max: todayIso() });
  const to = h("input", { type: "date", value: end, max: todayIso() });
  const controls = h("form", { class: "report-controls no-print", onsubmit: (e) => { e.preventDefault(); navigate(`${path}?start=${from.value}&end=${to.value}`); } },
    field(t("account.from"), from), field(t("account.to"), to),
    h("button", { type: "submit", class: "btn btn-secondary" }, t("report.make")),
    h("button", { type: "button", class: "btn btn-primary", onclick: () => window.print() }, icon("print", 20), h("span", null, t("report.print"))));

  const th = data.thresholds;
  const heart = data.heart;
  const row = (label, value) => h("tr", null, h("th", { scope: "row" }, label), h("td", null, value));
  return h("article", { class: "page report" },
    controls,
    h("header", { class: "report-head" },
      h("div", null, h("h1", null, t("report.title")),
        h("p", null, `${t("report.patient")}: `, h("strong", null, data.patient.name)),
        h("p", null, `${t("report.period")}: ${day(data.start, { day: "numeric", month: "long", year: "numeric" })} ${t("common.to")} ${day(data.end, { day: "numeric", month: "long", year: "numeric" })}`),
        h("p", { class: "muted small" }, t("report.generated", { time: new Date().toLocaleString(locale(), { dateStyle: "long", timeStyle: "short" }) }))),
      h("img", { src: "/static/img/pulseguard-wordmark.png", alt: "PulseGuard", class: "report-logo", width: 180, height: 84 })),
    h("section", { class: "report-sec" }, h("h2", null, t("report.heart")),
      h("table", { class: "kv" }, h("tbody", null,
        row(t("report.avg"), heart.av ? `${num(heart.av)} bpm` : t("common.none")),
        row(t("trends.min"), heart.mn ? `${num(heart.mn)} bpm` : t("common.none")),
        row(t("trends.max"), heart.mx ? `${num(heart.mx)} bpm` : t("common.none")),
        row(t("report.count"), num(heart.n)),
        row(t("report.oxygen"), heart.spo2 ? `${num(heart.spo2)} % (${t("report.lowest")} ${num(heart.spo2min)} %)` : t("common.none")),
        row(t("report.temperature"), heart.tmax ? `${num(heart.tmax, 1)} °C` : t("common.none")))),
      h("h3", null, t("report.daily")),
      rangeChart(data.days.map((d) => ({ day: d.day, min: d.bpm_min, avg: d.bpm_avg, max: d.bpm_max })), { metric: "bpm", unit: "bpm", band: { low: th.bpm_low, high: th.bpm_high }, height: 200 })),
    h("section", { class: "report-sec" }, h("h2", null, t("report.alerts")),
      data.alerts.length ? h("table", null, h("thead", null, h("tr", null, [t("report.time"), t("report.what"), t("report.value")].map((x) => h("th", { scope: "col" }, x)))),
        h("tbody", null, data.alerts.map((a) => h("tr", null, h("td", null, when(a.reading_ts || a.created_at)), h("td", null, t(`alert.${a.kind}`)),
          h("td", null, `${num(a.value, a.kind.startsWith("temp") ? 1 : 0)} (${t(`alert.${a.severity}`)})`))))) : h("p", null, t("report.no_alerts"))),
    h("section", { class: "report-sec" }, h("h2", null, t("report.symptoms")),
      data.symptoms.length ? h("ul", null, data.symptoms.map((s) => h("li", null, `${when(s.ts)}: ${symptomTitle(s)} (${s.severity}/5)${s.notes ? `: ${s.notes}` : ""}`))) : h("p", null, t("report.no_symptoms"))),
    h("section", { class: "report-sec" }, h("h2", null, t("report.mood")),
      h("table", { class: "kv" }, h("tbody", null, row(t("report.avg_stress"), data.mood.n ? `${num(data.mood.stress, 1)} / 5` : t("common.none")),
        row(t("report.avg_mood"), data.mood.n ? `${num(data.mood.mood, 1)} / 5` : t("common.none"))))),
    h("section", { class: "report-sec" }, h("h2", null, t("report.medication")),
      data.medication.length ? h("ul", null, data.medication.map((m) => h("li", null, h("strong", null, m.name), m.dose ? ` ${m.dose}: ` : ": ",
        t("report.adherence", { taken: m.taken, expected: m.expected, skipped: m.skipped })))) : h("p", null, t("tile.med_none"))),
    h("section", { class: "report-sec" }, h("h2", null, t("report.thresholds")),
      h("p", null, `${t("metric.bpm")} ${num(th.bpm_low)} ${t("common.to")} ${num(th.bpm_high)} bpm · ${t("metric.spo2")} ≥ ${num(th.spo2_low)} % · ${t("metric.temp_c")} ≤ ${num(th.temp_high, 1)} °C`)),
    h("p", { class: "report-foot muted small" }, t("report.disclaimer")));
}
