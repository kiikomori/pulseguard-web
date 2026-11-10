// Core utilities: DOM builder, i18n, API client, formatting, icons, preferences.
import nl from "./i18n/nl.js";
import en from "./i18n/en.js";

const DICTS = { nl, en };
export const state = { lang: document.documentElement.lang === "en" ? "en" : "nl", me: null };

// ---------- i18n ----------
export function t(key, vars = {}) {
  // Walks nested keys; falls back to a dotted leaf key (e.g. audit."login.ok").
  const pick = (dict) => {
    const parts = key.split(".");
    let node = dict;
    for (let i = 0; i < parts.length; i++) {
      if (!node || typeof node !== "object") return undefined;
      if (parts[i] in node) { node = node[parts[i]]; continue; }
      return node[parts.slice(i).join(".")];
    }
    return node;
  };
  let text = pick(DICTS[state.lang]);
  if (typeof text !== "string") text = pick(DICTS.nl);
  if (typeof text !== "string") return key;
  return text.replace(/\{(\w+)\}/g, (_, name) => (vars[name] ?? `{${name}}`));
}
export const locale = () => (state.lang === "en" ? "en-GB" : "nl-NL");

// ---------- DOM ----------
// h("div", { class: "x", onclick: fn, aria: { label: "..." } }, child, "text", [more])
export function h(tag, attrs, ...children) {
  const svg = ["svg", "path", "circle", "line", "polyline", "polygon", "rect", "g", "text", "title", "defs", "linearGradient", "stop"].includes(tag);
  const el = svg ? document.createElementNS("http://www.w3.org/2000/svg", tag) : document.createElement(tag);
  if (attrs && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (name.startsWith("on") && typeof value === "function") el.addEventListener(name.slice(2), value);
    else if (name === "aria") for (const [k, v] of Object.entries(value)) { if (v !== null && v !== undefined) el.setAttribute(`aria-${k}`, String(v)); }
    else if (name === "data") for (const [k, v] of Object.entries(value)) el.dataset[k] = v;
    else if (name === "class" && Array.isArray(value)) el.setAttribute("class", value.filter(Boolean).join(" "));
    else if (name === "style" && typeof value === "object") for (const [k, v] of Object.entries(value)) el.style.setProperty(k, v); // CSSOM: allowed by CSP
    else if (value === true) el.setAttribute(name, "");
    else el.setAttribute(name, String(value));
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}
export const $ = (sel, root = document) => root.querySelector(sel);
export function mount(el, ...children) { el.replaceChildren(); append(el, children); return el; }

// ---------- API ----------
export class ApiError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
export async function api(path, { method = "GET", body, poll = false } = {}) {
  const headers = { "X-PulseGuard": "1" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (poll) headers["X-PulseGuard-Poll"] = "1";
  let response;
  try {
    response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  } catch {
    throw new ApiError("offline", 0);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = data.error || "error";
    if (response.status === 401 && code === "auth_required") window.dispatchEvent(new CustomEvent("pg:unauthorized"));
    if (response.status === 403 && code === "password_change_required") window.dispatchEvent(new CustomEvent("pg:password-change"));
    throw new ApiError(code, response.status);
  }
  return data;
}
export function errorText(error) {
  const code = error?.code || "error";
  if (code === "offline") return t("common.offline");
  const text = t(`err.${code}`);
  if (!text.startsWith("err.")) return text;
  if (code.startsWith("out_of_range") || code.startsWith("missing_") || code.startsWith("invalid_")) return t("err.out_of_range");
  return t("common.error");
}

// ---------- formatting ----------
export function num(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return t("common.none");
  return Number(value).toLocaleString(locale(), { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}
// Server timestamps are naive UTC ("2026-11-04T10:05:00").
export function utc(ts) { return ts ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts}Z`) : null; }
export function time(ts) { const d = utc(ts); return d ? d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) : ""; }
export function when(ts) {
  const d = utc(ts);
  if (!d) return "";
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  const clock = d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  if (same(d, today)) return `${t("common.today")} ${clock}`;
  if (same(d, yesterday)) return `${t("common.yesterday")} ${clock}`;
  return d.toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
export function day(isoDate, opts = { weekday: "short", day: "numeric", month: "short" }) {
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString(locale(), opts);
}
export const todayIso = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
export function daysAgoIso(n) { const d = new Date(); d.setDate(d.getDate() - n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }

// ---------- icons (authored, 24px grid, 1.8 stroke) ----------
const ICONS = {
  heart: "M12 20.5s-7.5-4.6-9.2-9.5C1.6 7.4 3.9 4 7.4 4c2 0 3.6 1.1 4.6 2.7C13 5.1 14.6 4 16.6 4c3.5 0 5.8 3.4 4.6 7-1.7 4.9-9.2 9.5-9.2 9.5z",
  drop: "M12 3.2c3 3.6 6.5 7.7 6.5 11.2a6.5 6.5 0 0 1-13 0c0-3.5 3.5-7.6 6.5-11.2z M9.3 15.2a2.8 2.8 0 0 0 2.7 2.4",
  thermo: "M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z M12 9v8",
  steps: "M8.5 21c-1.8 0-2.6-1.6-2.4-3.4l.6-4.5c.2-1.5 2.4-1.6 2.8-.1l1.3 4.6c.6 2-.5 3.4-2.3 3.4z M7 9.5C6.4 7.3 7 4 8.8 4s2 3.4 1.5 5.4 M15.5 16c1.8 0 2.6-1.6 2.4-3.4l-.6-4.5c-.2-1.5-2.4-1.6-2.8-.1l-1.3 4.6c-.6 2 .5 3.4 2.3 3.4z M17 4.5c.6-2.2 0-2.5-1.8-2.5",
  moon: "M20 14.6A8.3 8.3 0 1 1 9.4 4a6.6 6.6 0 0 0 10.6 10.6z",
  face: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8.6 14.2c.9 1.1 2.1 1.7 3.4 1.7s2.5-.6 3.4-1.7 M9 9.5h.01 M15 9.5h.01",
  pill: "M10.5 20.5 3.5 13.5a4.9 4.9 0 0 1 7-7l7 7a4.9 4.9 0 0 1-7 7z M7 10l7 7",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z M12 12.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1z",
  alert: "M12 4 2.8 19.5h18.4z M12 10v4.5 M12 17h.01",
  check: "M4.5 12.5l4.5 4.5L19.5 6.5",
  x: "M6 6l12 12 M18 6 6 18",
  chart: "M4 20V4 M4 20h16 M7.5 15l3.5-4 3 2.5 5-6",
  plus: "M12 5v14 M5 12h14",
  users: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M2.5 20c.6-3.5 3.2-5.5 6.5-5.5s5.9 2 6.5 5.5 M16 4.3a3.5 3.5 0 0 1 0 6.4 M18.5 14.8c1.7.8 2.7 2.6 3 5.2",
  // Gear: symmetric outline from Lucide "settings" (ISC licence, lucide.dev); the old hand-drawn one sat 0.7 units right of centre.
  gear: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  bell: "M6 10a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 15 6 10z M10 19.5a2.2 2.2 0 0 0 4 0",
  logout: "M14.5 4.5h4.5v15h-4.5 M10 8l-4 4 4 4 M6 12h10",
  sun: "M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z M12 2v2 M12 20v2 M4.2 4.2l1.4 1.4 M18.4 18.4l1.4 1.4 M2 12h2 M20 12h2 M4.2 19.8l1.4-1.4 M18.4 5.6l1.4-1.4",
  list: "M8.5 6.5H20 M8.5 12H20 M8.5 17.5H20 M4 6.5h.01 M4 12h.01 M4 17.5h.01",
  doc: "M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 16h6",
  shield: "M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z",
  chevron: "M9 6l6 6-6 6",
  print: "M7 9V3h10v6 M7 17H4v-7h16v7h-3 M7 14h10v7H7z",
  download: "M12 4v11 M7.5 10.5 12 15l4.5-4.5 M4.5 19.5h15",
  copy: "M9 9h11v11H9z M5 15H4V4h11v1",
  external: "M14 4h6v6 M20 4l-8.5 8.5 M18 13.5V20H4V6h6.5",
  key: "M14.5 3.5a6 6 0 1 1-5.2 9L3.5 18.3V21h3v-2h2v-2h2l1.2-1.2A6 6 0 0 1 14.5 3.5z M16.5 7.5h.01",
};
// The watch's own website. Opens in a new tab; the accessible name starts with the visible text and says so.
export const WATCH_SITE = "https://www.pulseguard-technologies.nl";
export function watchLink(cls) {
  return h("a", { href: WATCH_SITE, target: "_blank", rel: "noopener", class: cls },
    h("span", null, t("nav.watch")), h("span", { class: "sr-only" }, ` (${t("nav.new_tab")})`), icon("external", 18));
}

export function icon(name, size = 22, label) {
  const parts = (ICONS[name] || ICONS.list).split(/ (?=M)/);
  return h("svg", { class: "icon", width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", role: label ? "img" : null,
    "aria-hidden": label ? null : "true", "aria-label": label || null },
    parts.map((d) => h("path", { d })));
}

// ---------- preferences ----------
function store(key, value) { try { localStorage.setItem(`pg.${key}`, value); } catch { /* private mode */ } }
export function applyPrefs({ language, theme, text_size } = {}) {
  const root = document.documentElement;
  if (language && DICTS[language]) { state.lang = language; root.lang = language; store("lang", language); }
  if (theme) { root.dataset.theme = theme; store("theme", theme); }
  if (text_size) { root.dataset.size = text_size; store("size", text_size); }
}
export function effectiveTheme() {
  const theme = document.documentElement.dataset.theme;
  if (theme === "light" || theme === "dark") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// ---------- small UI helpers ----------
export function field(label, input, { hint, error, id } = {}) {
  const inputId = id || input.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = inputId;
  const hintId = hint ? `${inputId}-hint` : null;
  const errId = `${inputId}-err`;
  const describedBy = [hintId, error ? errId : null].filter(Boolean).join(" ");
  if (describedBy) input.setAttribute("aria-describedby", describedBy);
  return h("div", { class: "field" },
    h("label", { for: inputId }, label),
    hint ? h("p", { class: "hint", id: hintId }, hint) : null,
    input,
    h("p", { class: "field-error", id: errId, hidden: !error }, error || ""));
}
export function setFieldError(input, message) {
  const err = document.getElementById(`${input.id}-err`);
  if (!err) return;
  err.textContent = message || "";
  err.hidden = !message;
  if (message) {
    input.setAttribute("aria-invalid", "true");
    const ids = new Set((input.getAttribute("aria-describedby") || "").split(" ").filter(Boolean));
    ids.add(err.id);
    input.setAttribute("aria-describedby", [...ids].join(" "));
  } else input.removeAttribute("aria-invalid");
}
export function notice(kind, text) { return h("p", { class: ["notice", `notice-${kind}`], role: kind === "error" ? "alert" : "status" }, text); }
export function button(label, opts = {}) {
  const { variant = "secondary", iconName, onclick, type = "button", ...rest } = opts;
  return h("button", { type, class: ["btn", `btn-${variant}`], onclick, ...rest }, iconName ? icon(iconName, 20) : null, h("span", null, label));
}
// Runs an async action with a busy state and an error/status message slot.
export async function busy(btn, slot, fn, successText) {
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  if (slot) mount(slot);
  try {
    const result = await fn();
    if (slot && successText) mount(slot, notice("ok", successText));
    return result;
  } catch (error) {
    if (slot) mount(slot, notice("error", errorText(error)));
    return undefined;
  } finally {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  }
}
export function section(title, ...children) {
  const id = `s-${title.replace(/\W+/g, "-").toLowerCase()}`;
  return h("section", { class: "panel", aria: { labelledby: id } }, h("h2", { id }, title), ...children);
}
