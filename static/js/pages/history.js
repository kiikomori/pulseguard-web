import { h, t, api, num, time, utc, locale, icon } from "../core.js";

/** A symptom entry in words: the user's own text first, then any chosen ones ("Iets anders" is implied by own text). */
export function symptomTitle(item) {
  const chosen = (item.symptoms || []).filter((s) => !(item.custom && s === "other")).map((s) => t(`symptom.${s}`));
  return [item.custom, ...chosen].filter(Boolean).join(", ");
}
import { navigate } from "../main.js";

const FILTERS = ["all", "checkins", "symptoms", "mood", "medication", "alerts"];

function describe(item) {
  switch (item.type) {
    case "checkin": {
      const parts = [];
      if (item.bpm) parts.push(`${t("metric.bpm")} ${num(item.bpm)} ${t("unit.bpm")}`);
      if (item.spo2) parts.push(`${t("metric.spo2")} ${num(item.spo2)}${t("unit.spo2")}`);
      if (item.steps) parts.push(`${num(item.steps)} ${t("unit.steps")}`);
      if (item.sleep) parts.push(`${t("metric.sleep")} ${num(item.sleep, 1)} ${t("unit.sleep")}`);
      if (item.water) parts.push(`${t("metric.water")} ${num(item.water, 1)} L`);
      if (item.weight) parts.push(`${num(item.weight, 1)} kg`);
      return { iconName: "list", title: t("history.checkin"), text: parts.join(" · "), tag: t(`history.source_${item.source === "api" ? "api" : "human"}`), note: item.notes };
    }
    case "symptom":
      return { iconName: "alert", title: symptomTitle(item), text: `${t("log.severity")} ${item.severity}/5`, note: item.notes };
    case "mood":
      return { iconName: "face", title: t("metric.mood"),
        text: [item.stress ? `${t("metric.stress")} ${item.stress}/5` : null, item.mood ? `${t("metric.mood")} ${item.mood}/5` : null].filter(Boolean).join(" · "), note: item.notes };
    case "medication":
      return { iconName: "pill", title: `${item.name}${item.dose ? ` ${item.dose}` : ""}`, text: t(item.status === "taken" ? "tile.med_taken" : "tile.med_skip") };
    case "alert": {
      const unit = item.kind.startsWith("temp") ? "°C" : item.kind.startsWith("spo2") ? "%" : "bpm";
      return { iconName: "alert", title: t(`alert.${item.kind}`), text: `${num(item.value, item.kind.startsWith("temp") ? 1 : 0)} ${unit}`,
        tag: item.acknowledged_at ? t("history.acknowledged") : t(`alert.${item.severity}`), cls: `hist-${item.severity}` };
    }
    default:
      return { iconName: "list", title: item.type, text: "" };
  }
}

export async function historyPage({ careId }) {
  const params = new URLSearchParams(location.search);
  const filter = FILTERS.includes(params.get("type")) ? params.get("type") : "all";
  const base = careId ? `/api/care/${careId}` : "/api";
  const path = careId ? `/care/${careId}/history` : "/history";
  const page = await api(`${base}/history?type=${filter}`);
  const items = page.items;

  const groups = new Map();
  const dayKey = (item) => {
    const d = item.type === "checkin" ? new Date(`${item.entry_date}T12:00:00`) : utc(item.ts);
    return d ? d.toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long" }) : "";
  };
  const renderItem = (item) => {
    const d = describe(item);
    return h("li", { class: ["row", "hist", `hist-${item.type}`, d.cls] },
      h("span", { class: "hist-icon", aria: { hidden: "true" } }, icon(d.iconName, 22)),
      h("div", { class: "hist-main" },
        h("p", { class: "hist-title" }, h("strong", null, d.title), d.tag ? h("span", { class: "pill" }, d.tag) : null),
        d.text ? h("p", null, d.text) : null,
        d.note ? h("p", { class: "muted" }, d.note) : null),
      h("span", { class: "hist-time muted" }, item.type === "checkin" ? (item.entry_time || "") : time(item.ts)));
  };
  const list = h("div", { class: "stack" });
  // Items arrive newest first; append each into its day group, creating groups as new days appear.
  const addItems = (batch) => {
    for (const item of batch) {
      const key = dayKey(item);
      if (!groups.has(key)) {
        const ul = h("ul", { class: "rows" });
        groups.set(key, ul);
        list.append(h("section", { class: "panel day-group", aria: { label: key } }, h("h2", { class: "day-title" }, key), ul));
      }
      groups.get(key).append(renderItem(item));
    }
  };
  addItems(items);
  let offset = page.next_offset;
  const more = h("button", { type: "button", class: "btn btn-secondary load-more", hidden: !page.has_more, onclick: async () => {
    more.disabled = true;
    try {
      const next = await api(`${base}/history?type=${filter}&offset=${offset}`);
      addItems(next.items);
      offset = next.next_offset;
      more.hidden = !next.has_more;
    } finally { more.disabled = false; }
  } }, t("history.more"));

  const filters = h("div", { class: "segmented segmented-wide", role: "group", aria: { label: t("history.title") } },
    FILTERS.map((f) => h("button", { type: "button", class: ["seg", f === filter && "active"], aria: { pressed: f === filter },
      onclick: () => navigate(`${path}?type=${f}`, { replace: true }) }, t(`history.${f}`))));

  return h("div", { class: "page" },
    h("header", { class: "page-head" }, h("h1", null, t("history.title"))),
    filters,
    items.length ? [list, more] : h("section", { class: "panel" }, h("p", { class: "muted" }, t("history.empty"))));
}
