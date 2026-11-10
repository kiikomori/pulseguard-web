// Doelen: gentle goals. Behaviour only (checking in, medication, water, sleep, moving, mood), never a health value to beat.
// A day without activity is a rest day, never a failure; nothing counts down and nobody is compared with anyone.
import { h, t, api, num, icon, day, todayIso } from "../core.js";

/** Default milestone names are stored in English in the DB; show them in the UI language. */
export function milestoneTitle(title) {
  const key = `milestone.${String(title || "").toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_|_$/g, "")}`;
  const text = t(key);
  return text === key ? title : text;
}

const KINDS = ["checkin", "mood", "medication", "water", "sleep", "movement"];
const KIND_ICON = { checkin: "list", mood: "face", medication: "pill", water: "drop", sleep: "moon", movement: "steps" };
const DIGITS = { steps: 0, checkins: 0, mood_logs: 0, water: 1, sleep: 1 };
const withUnit = (metric, value) => `${num(value, DIGITS[metric] ?? 1)} ${t(`unit.${metric}`)}`.trim();

/** A check mark that draws itself once (static under reduced motion). */
export function drawnCheck(size = 22) {
  return h("svg", { class: "drawn-check", width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true" },
    h("circle", { cx: 12, cy: 12, r: 10.5 }), h("path", { d: "M7 12.5l3.4 3.4L17.2 9" }));
}

function nextStep(next) {
  const copy = {
    checkin: ["goals.next_checkin_title", "goals.next_checkin_body", "goals.next_checkin_action"],
    checkin_more: ["goals.next_more_title", "goals.next_more_body", "goals.next_checkin_action"],
    mood: ["goals.next_mood_title", "goals.next_mood_body", "goals.next_mood_action"],
    water: ["goals.next_water_title", "goals.next_water_body", "goals.next_measure_action"],
    sleep: ["goals.next_sleep_title", "goals.next_sleep_body", "goals.next_measure_action"],
    done: ["goals.next_done_title", "goals.next_done_body", null],
    rest: ["goals.next_rest_title", "goals.next_rest_body", null],
  }[next.kind] || ["goals.next_done_title", "goals.next_done_body", null];
  const vars = { goal: next.goal ? t(`goal.${next.goal}`) : "", left: next.left != null ? withUnit(next.kind, next.left) : "" };
  const settled = next.kind === "done" || next.kind === "rest";
  return h("section", { class: ["next-step", settled && "next-step-done"], aria: { labelledby: "g-next" } },
    h("div", { class: "next-step-text" },
      settled ? drawnCheck(26) : null,
      h("div", null, h("h2", { id: "g-next" }, t(copy[0], vars)), h("p", null, t(copy[1], vars)))),
    copy[2] && next.href ? h("a", { class: "btn btn-primary", href: next.href }, icon("plus", 20), h("span", null, t(copy[2]))) : null);
}

function recapLine(recap) {
  const { days, days_last_week: last } = recap;
  if (!days) return t("goals.recap_none");
  const base = days === 1 ? t("goals.recap_one") : t("goals.recap_many", { n: days });
  const more = days - last;
  // Only compare when it is good news; otherwise the plain count stands on its own.
  if (more > 0 && last > 0) return `${base}${more === 1 ? t("goals.recap_more_one") : t("goals.recap_more_many", { n: more })}`;
  return `${base}.`;
}

function weekTable(week) {
  const today = todayIso();
  let row = 0;
  return h("figure", { class: "week" },
    h("table", { class: "week-table" },
      h("caption", { class: "sr-only" }, t("goals.week_caption")),
      h("thead", null, h("tr", null,
        h("th", { scope: "col" }, h("span", { class: "sr-only" }, t("goals.week_day"))),
        KINDS.map((k) => h("th", { scope: "col", class: `k-${k}`, title: t(`goals.kind_${k}`) },
          icon(KIND_ICON[k], 20), h("span", { class: "week-kind" }, t(`goals.kind_${k}`)))))),
      h("tbody", null, week.map((d) => {
        const isToday = d.day === today;
        const label = isToday ? t("goals.today") : day(d.day, { weekday: "short", day: "numeric" });
        const tr = h("tr", { class: [isToday && "is-today", !d.kinds.length && "is-rest"] },
          h("th", { scope: "row" }, label),
          d.kinds.length
            ? KINDS.map((k) => h("td", { class: `k-${k}` }, d.kinds.includes(k)
              ? [h("span", { class: "mark", "aria-hidden": "true" }), h("span", { class: "sr-only" }, t(`goals.kind_${k}`))]
              : null))
            : h("td", { colspan: KINDS.length, class: "rest" }, isToday ? t("goals.today_open") : t("goals.rest_day")));
        tr.style.setProperty("--row", String(row++));
        return tr;
      }))),
    h("figcaption", { class: "week-legend" },
      KINDS.map((k) => h("span", { class: `k-${k}` }, icon(KIND_ICON[k], 18), t(`goals.kind_${k}`))),
      h("span", { class: "week-note" }, t("goals.week_note"))));
}

function bar(metric, progress, target) {
  const ratio = Math.max(0, Math.min(1, progress / Math.max(target, 0.0001)));
  const el = h("div", { class: "fill-bar", role: "progressbar", aria: {
    valuemin: 0, valuemax: target, valuenow: Math.min(progress, target), label: t(`metric.${metric}`),
    valuetext: `${withUnit(metric, progress)} / ${withUnit(metric, target)}` } }, h("span", { class: "fill-bar-value" }));
  el.style.setProperty("--p", ratio.toFixed(3));
  return el;
}

function todayGoals(daily) {
  return h("ul", { class: "goals-today" }, daily.map((goal) => h("li", { class: ["goal-row", goal.complete && "is-done"] },
    h("div", { class: "goal-row-head" },
      goal.complete ? drawnCheck(24) : h("span", { class: "goal-dot", "aria-hidden": "true" }),
      h("strong", null, t(`goal.${goal.key}`)),
      goal.complete ? h("span", { class: "goal-state" }, t("goals.done")) : null),
    goal.requirements.map((req) => h("div", { class: ["goal-req", `m-${req.metric}`] },
      h("div", { class: "goal-req-text" },
        h("span", null, t(`metric.${req.metric}`)),
        h("span", { class: "num" }, req.done ? withUnit(req.metric, req.progress) : `${num(req.progress, DIGITS[req.metric] ?? 1)} / ${withUnit(req.metric, req.target)}`)),
      bar(req.metric, req.progress, req.target))))));
}

// Milestones on a ruler: equal steps between them, a line up to where you are. Totals, never "in a row".
function ruler(metric, items) {
  items.sort((a, b) => a.target - b.target);
  const progress = items[0]?.progress || 0;
  let pos = items.length;
  for (let i = 0; i < items.length; i++) {
    const prev = i ? items[i - 1].target : 0;
    if (progress < items[i].target) { pos = i + (progress - prev) / (items[i].target - prev); break; }
  }
  const nextItem = items.find((m) => !m.complete);
  const reached = items.filter((m) => m.complete);
  const track = h("div", { class: "ruler-track", "aria-hidden": "true" },
    h("span", { class: "ruler-fill" }),
    items.map((m, i) => {
      const tick = h("span", { class: ["ruler-tick", m.complete && "is-reached"] }, h("span", { class: "ruler-num num" }, num(m.target)));
      tick.style.setProperty("--x", ((i + 1) / items.length).toFixed(4));
      return tick;
    }));
  track.style.setProperty("--p", (pos / items.length).toFixed(4));
  const said = [];
  if (reached.length) said.push(t("goals.reached", { names: reached.map((m) => milestoneTitle(m.title)).join(", ") }));
  if (nextItem) said.push(t("goals.next_milestone", { name: milestoneTitle(nextItem.title), v: withUnit(metric, nextItem.target - progress) }));
  else said.push(t("goals.all_reached"));
  return h("li", { class: ["ruler", `m-${metric}`] },
    h("div", { class: "ruler-head" }, h("h3", null, t(`metric.${metric}`)), h("span", { class: "num ruler-total" }, withUnit(metric, progress))),
    track,
    h("p", { class: "ruler-note" }, said.join(" ")));
}

export async function goalsPage() {
  const data = await api("/api/goals");
  const o = data.overview;
  const groups = {};
  for (const m of data.milestones) (groups[m.metric] ||= []).push(m);
  const order = ["checkins", "water", "sleep", "steps"].filter((k) => groups[k]).concat(Object.keys(groups).filter((k) => !["checkins", "water", "sleep", "steps"].includes(k)));

  return h("div", { class: "page goals-page" },
    h("header", { class: "page-head" }, h("h1", null, t("goals.title")), h("p", { class: "goals-recap" }, recapLine(o.recap))),
    nextStep(o.next),
    h("div", { class: "goals-grid" },
      h("section", { class: "goals-week", aria: { labelledby: "g-week" } },
        h("h2", { id: "g-week" }, t("goals.week")), weekTable(o.week)),
      h("section", { class: "goals-today-sec", aria: { labelledby: "g-today" } },
        h("h2", { id: "g-today" }, t("goals.today")), todayGoals(data.daily))),
    h("section", { class: "goals-milestones", aria: { labelledby: "g-ms" } },
      h("div", { class: "goals-ms-head" },
        h("h2", { id: "g-ms" }, t("goals.milestones")),
        h("p", { class: "muted" }, t("goals.totals", { n: num(o.totals.checkins), d: num(o.totals.days) }))),
      h("ul", { class: "rulers" }, order.map((metric) => ruler(metric, groups[metric])))),
    h("p", { class: "goals-foot muted small" }, t("goals.intro")));
}
