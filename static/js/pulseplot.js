// The Pulse Plot: each day's heart rate as one trace, stacked like a pulsar plot, newest at the front.
// Drawn into SVG at the container's real pixel size (crisp text), with an aria summary and a data table.
import { h, t, num, day, locale } from "./core.js";

const DRAWN = new WeakSet();

function stats(points) {
  const v = points.filter((p) => p !== null && p !== undefined);
  if (!v.length) return null;
  return { min: Math.min(...v), max: Math.max(...v), avg: v.reduce((a, b) => a + b, 0) / v.length, count: v.length };
}

function draw(svg, days, { thresholds, animate, beatBpm }) {
  const width = Math.max(320, svg.clientWidth || svg.parentElement.clientWidth || 640);
  const height = Math.max(220, svg.clientHeight || 320);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.replaceChildren();

  const all = days.flatMap((d) => d.points).filter((v) => v !== null && v !== undefined);
  const vmin = Math.min(...all, thresholds?.bpm_low ?? Infinity) - 2;
  const vmax = Math.max(...all) + 2;
  const n = days.length;
  const buckets = days[0].points.length;
  const left = 4, right = width < 480 ? 54 : 74, top = 8, bottom = 28;
  const plotW = width - left - right;
  const usable = height - top - bottom;
  const amp = usable * (n > 10 ? 0.34 : 0.42);
  const gap = n > 1 ? (usable - amp) / (n - 1) : 0;
  const x = (j) => left + (j * plotW) / (buckets - 1);
  const yOf = (base, v) => base - ((v - vmin) / (vmax - vmin || 1)) * amp;

  // Hour ticks along the bottom.
  for (const hour of [0, 6, 12, 18, 24]) {
    const xx = left + (hour / 24) * plotW;
    svg.append(h("line", { class: "hour-tick", x1: xx, x2: xx, y1: height - bottom + 4, y2: height - bottom + 9 }));
    svg.append(h("text", { class: "hour-label", x: xx, y: height - 6, "text-anchor": hour === 0 ? "start" : hour === 24 ? "end" : "middle" },
      `${String(hour % 24).padStart(2, "0")}:00`));
  }

  const labels = [];
  days.forEach((d, i) => {
    const base = top + amp + i * gap;
    const today = i === n - 1;
    // Today stops at its latest reading instead of dropping to the baseline for hours that haven't happened.
    let end = buckets - 1;
    if (today) {
      end = -1;
      d.points.forEach((v, j) => { if (v !== null && v !== undefined) end = j; });
      if (end < 1) end = 1;
    }
    const coords = d.points.slice(0, end + 1).map((v, j) => [x(j), v === null || v === undefined ? base : yOf(base, v)]);
    const line = coords.map(([px, py], j) => `${j ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
    const area = `${line}L${x(end).toFixed(1)},${height}L${left},${height}Z`;
    // Older days fade back so today's trace stands out: oldest faintest, yesterday clearest of the past days.
    const fade = today ? 1 : 0.03 + 0.08 * (n > 2 ? i / (n - 2) : 1);
    const style = { "--i": String(i), "--fade": fade.toFixed(2) };
    svg.append(h("path", { class: "occlude", d: area, style }));
    // Today gets a halo in the ground colour, so older lines that cross it are cut away and never run through the orange.
    if (today) svg.append(h("path", { class: "trace-halo", d: line, pathLength: 1, style }));
    svg.append(h("path", { class: ["trace", today && "trace-today"], d: line, pathLength: 1, style }));
    if (thresholds) {
      d.points.forEach((v, j) => {
        if (v !== null && v !== undefined && (v > thresholds.bpm_high || v < thresholds.bpm_low)) {
          svg.append(h("circle", { class: "out", cx: x(j), cy: yOf(base, v), r: today ? 3.5 : 2.5, style }));
        }
      });
    }
    // Each label goes where its own line ends (lines end at different heights), placed after the loop.
    const [endX, endY] = coords[coords.length - 1];
    labels.push({ today, endX, endY, text: today ? t("plot.today") : day(d.day, { weekday: "short", day: "numeric" }) });
    if (today && beatBpm) {
      let last = -1;
      d.points.forEach((v, j) => { if (v !== null && v !== undefined) last = j; });
      if (last >= 0) {
        const dot = h("circle", { class: "beat", cx: x(last), cy: yOf(base, d.points[last]), r: 4.5 });
        dot.style.setProperty("--beat", `${(60 / Math.max(30, Math.min(200, beatBpm))).toFixed(2)}s`);
        svg.append(dot);
      }
    }
  });
  placeLabels(svg, labels, { colX: width - right + 10, minY: top + 10, maxY: height - bottom - 2, gapY: width < 480 ? 13 : 15 });
  svg.classList.toggle("animate", Boolean(animate));
}

// Day labels sit at the height where each line ends, joined to it by a short leader, and never overlap.
// Today's label sits right next to the end of today's line, wherever in the day that is.
function placeLabels(svg, labels, { colX, minY, maxY, gapY }) {
  const todayItem = labels.find((l) => l.today);
  const todayInColumn = todayItem && todayItem.endX > colX - 70;  // late in the day: join the column instead
  const column = labels.filter((l) => !l.today || todayInColumn);
  column.forEach((l) => { l.y = l.endY; });
  for (let k = 1; k < column.length; k++) column[k].y = Math.max(column[k].y, column[k - 1].y + gapY);
  const overflow = column.length ? column[column.length - 1].y - maxY : 0;
  if (overflow > 0) column.forEach((l) => { l.y -= overflow; });
  for (let k = column.length - 2; k >= 0; k--) column[k].y = Math.min(column[k].y, column[k + 1].y - gapY);
  if (column.length && column[0].y < minY) {
    const shift = minY - column[0].y;
    column.forEach((l) => { l.y += shift; });
  }
  for (const l of column) {
    svg.append(h("path", { class: ["day-leader", l.today && "day-leader-today"], d: `M${(l.endX + 2).toFixed(1)},${l.endY.toFixed(1)}L${(colX - 4).toFixed(1)},${l.y.toFixed(1)}` }));
    svg.append(h("text", { class: ["day-label", l.today && "day-label-today"], x: colX, y: (l.y + 4).toFixed(1) }, l.text));
  }
  if (todayItem && !todayInColumn) {
    svg.append(h("text", { class: "day-label day-label-today day-label-inline", x: (todayItem.endX + 10).toFixed(1), y: (todayItem.endY + 4).toFixed(1) }, todayItem.text));
  }
}

/**
 * days: [{ day: "YYYY-MM-DD", points: [bpm|null, ...] }], oldest first.
 * Returns a <figure> that draws itself when it gets a size, and redraws on resize.
 */
export function pulsePlot(days, { thresholds, animate = true, beatBpm = null, example = false, label } = {}) {
  const usable = days.filter((d) => d.points.some((v) => v !== null && v !== undefined));
  if (usable.length === 0) return h("p", { class: "pulse-empty" }, t("plot.empty"));

  const todayStats = stats(days[days.length - 1].points);
  const weekStats = stats(days.flatMap((d) => d.points));
  const summary = label || t("plot.summary", { n: days.length, avg: todayStats ? num(todayStats.avg) : t("common.none"), week: weekStats ? num(weekStats.avg) : t("common.none") });
  const svg = h("svg", { class: "pulse-svg", role: "img", "aria-label": summary, preserveAspectRatio: "none" });

  const rows = days.slice().reverse().map((d) => {
    const s = stats(d.points);
    return [day(d.day, { weekday: "long", day: "numeric", month: "short" }), s ? num(s.avg) : t("common.none"), s ? num(s.min) : t("common.none"), s ? num(s.max) : t("common.none")];
  });
  const table = h("details", { class: "chart-table" },
    h("summary", null, t("trends.show_table")),
    h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, [t("plot.day"), `${t("plot.avg")} (bpm)`, t("plot.min"), t("plot.max")].map((c) => h("th", { scope: "col" }, c)))),
      h("tbody", null, rows.map((r) => h("tr", null, r.map((c, i) => (i ? h("td", null, c) : h("th", { scope: "row" }, c)))))))));

  const fig = h("figure", { class: "pulse-fig" }, svg, h("figcaption", { class: "sr-only" }, summary), example ? null : table);

  let lastSize = "";
  const redraw = () => {
    const size = `${svg.clientWidth}x${svg.clientHeight}`;
    if (size === lastSize || !svg.isConnected) return;
    lastSize = size;
    draw(svg, days, { thresholds, animate: animate && !DRAWN.has(fig), beatBpm });
    DRAWN.add(fig);
  };
  const observer = new ResizeObserver(() => requestAnimationFrame(redraw));
  observer.observe(svg);
  return fig;
}

/** Deterministic synthetic week for the landing page (clearly labelled as example data). */
export function exampleWeek(n = 7) {
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const points = [];
    for (let j = 0; j < 96; j++) {
      const hour = j / 4;
      const asleep = hour < 7 || hour >= 23;
      let v = asleep ? 56 + rand() * 4 : 68 + 6 * Math.sin(((hour - 8) / 24) * 2 * Math.PI) + rand() * 6;
      if (!asleep && rand() < 0.07) v += 18 + rand() * 22; // a walk or the stairs
      points.push(i === 0 && j > (new Date().getHours() * 4 + Math.floor(new Date().getMinutes() / 15)) ? null : Math.round(v));
    }
    out.push({ day: iso, points });
  }
  return out;
}

export { locale };
