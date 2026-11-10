// Accessible SVG charts built with the DOM (no innerHTML). Each chart has an aria summary and a table alternative.
import { h, t, num, time, day, utc } from "./core.js";

const W = 420;      // chart viewBox width: small enough that axis text stays readable on phones
const SW = 640;     // sparkline width

function scale(domainMin, domainMax, rangeMin, rangeMax) {
  const span = domainMax - domainMin || 1;
  return (v) => rangeMin + ((v - domainMin) / span) * (rangeMax - rangeMin);
}

function niceBounds(values, extra = []) {
  const all = values.concat(extra).filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  if (!all.length) return [0, 1];
  let min = Math.min(...all), max = Math.max(...all);
  const pad = (max - min) * 0.12 || Math.max(1, Math.abs(max) * 0.05);
  return [min - pad, max + pad];
}

// x-axis: every weekday for a week or less, otherwise first and last date.
function dayAxis(svg, valid, slot, height) {
  if (valid.length <= 8) {
    valid.forEach((d, i) => svg.append(h("text", { class: "axis", x: 52 + slot * i + slot / 2, y: height - 6, "text-anchor": "middle" }, day(d.day, { weekday: "short" }))));
    return;
  }
  svg.append(h("text", { class: "axis", x: 52, y: height - 6 }, day(valid[0].day, { day: "numeric", month: "short" })));
  svg.append(h("text", { class: "axis", x: W - 8, y: height - 6, "text-anchor": "end" }, day(valid[valid.length - 1].day, { day: "numeric", month: "short" })));
}

/** Small trend line for a tile. points: [{x: Date|number, y}] */
export function sparkline(points, { band, metric = "bpm", height = 64, label }) {
  const valid = points.filter((p) => p.y !== null && p.y !== undefined);
  const svg = h("svg", { class: ["spark", `spark-${metric}`], viewBox: `0 0 ${SW} ${height}`, preserveAspectRatio: "none",
    role: "img", "aria-label": label || t("heart.chart") });
  if (valid.length < 2) return svg;
  const xs = valid.map((p) => +p.x), ys = valid.map((p) => p.y);
  const [lo, hi] = niceBounds(ys, band ? [band.low, band.high].filter((v) => v !== undefined && v !== null) : []);
  const x = scale(Math.min(...xs), Math.max(...xs), 4, SW - 4), y = scale(lo, hi, height - 4, 4);
  const hasLow = band && band.low !== undefined && band.low !== null, hasHigh = band && band.high !== undefined && band.high !== null;
  if (hasLow && hasHigh) {
    const top = y(Math.min(band.high, hi)), bottom = y(Math.max(band.low, lo));
    svg.append(h("rect", { class: "band", x: 0, y: top, width: SW, height: Math.max(0, bottom - top) }));
  } else if (hasLow || hasHigh) {
    const v = hasLow ? band.low : band.high;
    if (v >= lo && v <= hi) svg.append(h("line", { class: "limit", x1: 0, x2: SW, y1: y(v), y2: y(v), "vector-effect": "non-scaling-stroke" }));
  }
  svg.append(h("polyline", { class: "line", pathLength: 1, points: valid.map((p) => `${x(+p.x)},${y(p.y)}`).join(" "), "vector-effect": "non-scaling-stroke" }));
  const last = valid[valid.length - 1];
  svg.append(h("circle", { class: "dot", cx: x(+last.x), cy: y(last.y), r: 3.5 }));
  return svg;
}

function tableFor(headers, rows) {
  return h("details", { class: "chart-table" },
    h("summary", null, t("trends.show_table")),
    h("div", { class: "table-wrap" },
      h("table", null,
        h("thead", null, h("tr", null, headers.map((head) => h("th", { scope: "col" }, head)))),
        h("tbody", null, rows.map((row) => h("tr", null, row.map((cell, i) => (i === 0 ? h("th", { scope: "row" }, cell) : h("td", null, cell)))))))));
}

function niceStep(range) {
  const raw = range / 4;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

function niceDomain(lo, hi) {
  const step = niceStep(hi - lo);
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
}

// Round-number gridlines inside [lo, hi].
function axisLabels(svg, y, lo, hi) {
  const step = niceStep(hi - lo);
  const digits = step < 1 ? 1 : 0;
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
    svg.append(h("line", { class: "grid", x1: 44, x2: W, y1: y(v), y2: y(v) }));
    svg.append(h("text", { class: "axis", x: 38, y: y(v) + 5, "text-anchor": "end" }, num(v, digits)));
  }
}

// A limit or goal line is drawn after the data, with a halo in the ground colour, so bars and lines never hide it.
function limitLine(svg, yy, x0, x1, label) {
  svg.append(h("line", { class: "limit-halo", x1: x0, x2: x1, y1: yy, y2: yy }));
  svg.append(h("line", { class: "limit", x1: x0, x2: x1, y1: yy, y2: yy }));
  svg.append(h("text", { class: "limit-label", x: x1, y: yy - 7, "text-anchor": "end" }, label));
}

// The shaded band goes behind the data; a single limit line goes on top (call again with onTop after drawing).
function limitShapes(svg, y, band, x0, x1, onTop = false) {
  if (!band) return;
  const hasLow = band.low !== undefined && band.low !== null;
  const hasHigh = band.high !== undefined && band.high !== null;
  if (hasLow && hasHigh) { if (!onTop) svg.append(h("rect", { class: "band", x: x0, y: y(band.high), width: x1 - x0, height: Math.max(0, y(band.low) - y(band.high)) })); }
  else if ((hasLow || hasHigh) && onTop) {
    const value = hasLow ? band.low : band.high;
    limitLine(svg, y(value), x0, x1, t(hasLow ? "trends.lower" : "trends.upper", { v: num(value, value % 1 ? 1 : 0) }));
  }
}

/**
 * Time-series line (24h readings). points: [{ts, value}]
 */
export function lineChart(points, { metric, unit, band, digits = 0, height = 220 }) {
  const valid = points.filter((p) => p.value !== null && p.value !== undefined);
  if (!valid.length) return h("p", { class: "empty" }, t("trends.empty"));
  const xs = valid.map((p) => +utc(p.ts)), ys = valid.map((p) => p.value);
  const [lo, hi] = niceDomain(...niceBounds(ys, band ? [band.low, band.high].filter((v) => v !== undefined && v !== null) : []));
  const x = scale(Math.min(...xs), Math.max(...xs) || Math.min(...xs) + 1, 52, W - 8), y = scale(lo, hi, height - 28, 8);
  const avg = ys.reduce((a, b) => a + b, 0) / ys.length;
  const summary = t("trends.summary", { metric: t(`metric.${metric}`), avg: `${num(avg, digits)} ${unit}`, min: `${num(Math.min(...ys), digits)} ${unit}`, max: `${num(Math.max(...ys), digits)} ${unit}` });
  const svg = h("svg", { class: ["chart", `chart-${metric}`], viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": summary });
  axisLabels(svg, y, lo, hi);
  limitShapes(svg, y, band, 52, W - 8);
  svg.append(h("polyline", { class: "line", points: valid.map((p, i) => `${x(xs[i])},${y(p.value)}`).join(" ") }));
  const first = valid[0], last = valid[valid.length - 1];
  svg.append(h("text", { class: "axis", x: 52, y: height - 6 }, time(first.ts)));
  svg.append(h("text", { class: "axis", x: W - 8, y: height - 6, "text-anchor": "end" }, time(last.ts)));
  const out = band && valid.filter((p) => (band.high !== undefined && p.value > band.high) || (band.low !== undefined && p.value < band.low));
  for (const p of out || []) svg.append(h("circle", { class: "dot-out", cx: x(+utc(p.ts)), cy: y(p.value), r: 4 }));
  limitShapes(svg, y, band, 52, W - 8, true);
  const rows = valid.slice(-60).reverse().map((p) => [time(p.ts), `${num(p.value, digits)} ${unit}`]);
  return h("figure", { class: "chart-fig" }, svg, h("figcaption", { class: "sr-only" }, summary), tableFor([t("history.checkin"), t(`metric.${metric}`)], rows));
}

/**
 * Daily min–max range bars with an average dot (heart rate per day).
 * days: [{day, min, avg, max}]
 */
export function rangeChart(days, { metric, unit, band, digits = 0, height = 220 }) {
  const valid = days.filter((d) => d.avg !== null && d.avg !== undefined);
  if (!valid.length) return h("p", { class: "empty" }, t("trends.empty"));
  const values = valid.flatMap((d) => [d.min ?? d.avg, d.max ?? d.avg]);
  const [lo, hi] = niceBounds(values, band ? [band.low, band.high].filter((v) => v !== undefined) : []);
  const y = scale(lo, hi, height - 28, 8);
  const slot = (W - 60) / valid.length, barW = Math.max(3, Math.min(18, slot * 0.45));
  const avg = valid.reduce((a, d) => a + d.avg, 0) / valid.length;
  const summary = t("trends.summary", { metric: t(`metric.${metric}`), avg: `${num(avg, digits)} ${unit}`, min: `${num(Math.min(...values), digits)} ${unit}`, max: `${num(Math.max(...values), digits)} ${unit}` });
  const svg = h("svg", { class: ["chart", `chart-${metric}`], viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": summary });
  axisLabels(svg, y, lo, hi);
  limitShapes(svg, y, band, 52, W - 8);
  valid.forEach((d, i) => {
    const cx = 52 + slot * i + slot / 2;
    const top = y(d.max ?? d.avg), bottom = y(d.min ?? d.avg);
    svg.append(h("rect", { class: "range", x: cx - barW / 2, y: top, width: barW, height: Math.max(2, bottom - top), rx: barW / 2 }));
    svg.append(h("circle", { class: "avg-dot", cx, cy: y(d.avg), r: Math.min(5, barW / 2 + 1) }));
  });
  limitShapes(svg, y, band, 52, W - 8, true);
  dayAxis(svg, valid, slot, height);
  const rows = valid.slice().reverse().map((d) => [day(d.day), num(d.min, digits), num(d.avg, digits), num(d.max, digits)]);
  return h("figure", { class: "chart-fig" }, svg, h("figcaption", { class: "sr-only" }, summary),
    tableFor([t("trends.day"), t("trends.min"), t("heart.avg"), t("trends.max")], rows));
}

/** Daily bars (steps, sleep, stress). */
export function barChart(days, { metric, unit, digits = 0, height = 200, goal, max }) {
  const valid = days.filter((d) => d.value !== null && d.value !== undefined);
  if (!valid.length) return h("p", { class: "empty" }, t("trends.empty"));
  const values = valid.map((d) => d.value);
  const hi = max || niceDomain(0, Math.max(...values, goal || 0) * 1.08 || 1)[1];
  const y = scale(0, hi, height - 28, 8);
  const slot = (W - 60) / valid.length, barW = Math.max(3, Math.min(28, slot * 0.6));
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const summary = t("trends.summary", { metric: t(`metric.${metric}`), avg: `${num(avg, digits)} ${unit}`, min: `${num(Math.min(...values), digits)} ${unit}`, max: `${num(Math.max(...values), digits)} ${unit}` });
  const svg = h("svg", { class: ["chart", `chart-${metric}`], viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": summary });
  axisLabels(svg, y, 0, hi);
  valid.forEach((d, i) => {
    const cx = 52 + slot * i + slot / 2;
    svg.append(h("rect", { class: "bar", x: cx - barW / 2, y: y(d.value), width: barW, height: Math.max(1, y(0) - y(d.value)), rx: Math.min(6, barW / 2) }));
  });
  if (goal) limitLine(svg, y(goal), 52, W - 8, t("trends.goal", { v: `${num(goal)} ${unit}` }));
  dayAxis(svg, valid, slot, height);
  const rows = valid.slice().reverse().map((d) => [day(d.day), `${num(d.value, digits)} ${unit}`]);
  return h("figure", { class: "chart-fig" }, svg, h("figcaption", { class: "sr-only" }, summary), tableFor([t("trends.day"), t(`metric.${metric}`)], rows));
}
