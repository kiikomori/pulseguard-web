import { h, t, api, icon } from "../core.js";
import { lineChart, rangeChart, barChart } from "../charts.js";
import { navigate } from "../main.js";

const RANGES = ["24h", "7d", "30d", "90d"];

function chartPanel(metric, iconName, chart) {
  return h("section", { class: ["panel", "chart-panel", `chart-panel-${metric}`], aria: { labelledby: `c-${metric}` } },
    h("h2", { id: `c-${metric}` }, icon(iconName, 22), t(`metric.${metric}`)), chart);
}

export async function trendsPage({ careId }) {
  const params = new URLSearchParams(location.search);
  const range = RANGES.includes(params.get("range")) ? params.get("range") : "7d";
  const base = careId ? `/api/care/${careId}` : "/api";
  const data = await api(`${base}/trends?range=${range}`);
  const th = data.thresholds;
  const path = careId ? `/care/${careId}/trends` : "/trends";

  const switcher = h("div", { class: "segmented", role: "group", aria: { label: t("trends.title") } },
    RANGES.map((r) => h("button", { type: "button", class: ["seg", r === range && "active"], aria: { pressed: r === range },
      onclick: () => navigate(`${path}?range=${r}`, { replace: true }) }, t(`trends.range_${r}`))));

  let panels;
  if (data.granularity === "reading") {
    const pts = data.points;
    const pick = (field) => pts.map((p) => ({ ts: p.ts, value: p[field] }));
    panels = [
      chartPanel("bpm", "heart", lineChart(pick("bpm"), { metric: "bpm", unit: t("unit.bpm"), band: { low: th.bpm_low, high: th.bpm_high } })),
      chartPanel("spo2", "drop", lineChart(pick("spo2"), { metric: "spo2", unit: t("unit.spo2"), band: { low: th.spo2_low } })),
      chartPanel("temp_c", "thermo", lineChart(pick("temp_c"), { metric: "temp_c", unit: t("unit.temp_c"), band: { high: th.temp_high }, digits: 1 })),
    ];
  } else {
    const days = data.days;
    panels = [
      chartPanel("bpm", "heart", rangeChart(days.map((d) => ({ day: d.day, min: d.bpm_min, avg: d.bpm_avg, max: d.bpm_max })),
        { metric: "bpm", unit: t("unit.bpm"), band: { low: th.bpm_low, high: th.bpm_high } })),
      chartPanel("spo2", "drop", rangeChart(days.map((d) => ({ day: d.day, min: d.spo2_min, avg: d.spo2, max: d.spo2 })),
        { metric: "spo2", unit: t("unit.spo2"), band: { low: th.spo2_low } })),
      chartPanel("temp_c", "thermo", rangeChart(days.map((d) => ({ day: d.day, min: d.temp, avg: d.temp, max: d.temp })),
        { metric: "temp_c", unit: t("unit.temp_c"), digits: 1, band: { high: th.temp_high } })),
      chartPanel("steps", "steps", barChart(days.map((d) => ({ day: d.day, value: d.steps || null })), { metric: "steps", unit: t("unit.steps"), goal: 8000 })),
      chartPanel("sleep", "moon", barChart(days.map((d) => ({ day: d.day, value: d.sleep || null })), { metric: "sleep", unit: t("unit.sleep"), digits: 1, goal: 7 })),
      chartPanel("stress", "face", barChart(days.map((d) => ({ day: d.day, value: d.stress ?? null })), { metric: "stress", unit: "/ 5", digits: 1, max: 5 })),
    ];
  }
  return h("div", { class: "page" },
    h("header", { class: "page-head page-head-row" }, h("h1", null, t("trends.title")), switcher),
    h("div", { class: "chart-grid" }, panels));
}
