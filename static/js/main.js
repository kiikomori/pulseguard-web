import { h, t, api, mount, icon, state, applyPrefs, effectiveTheme, watchLink, $ } from "./core.js";
import { loginPage, signupPage, forcedPasswordPage } from "./pages/auth.js";
import { homePage } from "./pages/home.js";
import { trendsPage } from "./pages/trends.js";
import { logPage } from "./pages/log.js";
import { goalsPage } from "./pages/goals.js";
import { historyPage } from "./pages/history.js";
import { sharingPage } from "./pages/sharing.js";
import { accountPage } from "./pages/account.js";
import { notificationsPage, adminPage, privacyPage, reportPage } from "./pages/misc.js";
import { presentPage } from "./pages/present.js";
import { landingPage } from "./pages/landing.js";
import { developerPage } from "./pages/developer.js";
import { startReminderLoop } from "./reminders.js";

const root = document.getElementById("app");
const PUBLIC = new Set(["/login", "/signup", "/privacy", "/home"]);

// Loggen is the primary action: a header button on desktop, the floating button on phones.
const TABS = [
  ["/", "home", "heart"],
  ["/trends", "trends", "chart"],
  ["/history", "history", "list"],
  ["/goals", "goals", "target"],
  ["/sharing", "sharing", "users"],
];
const MORE = [
  ["/notifications", "notifications", "bell"],
  ["/report", "report", "doc"],
  ["/api", "api", "key"],
  ["/account", "account", "gear"],
];

function routeFor(path) {
  const care = path.match(/^\/care\/(\d+)(?:\/(trends|history|report))?$/);
  if (care) {
    const id = Number(care[1]);
    const sub = care[2];
    if (sub === "trends") return () => trendsPage({ careId: id });
    if (sub === "history") return () => historyPage({ careId: id });
    if (sub === "report") return () => reportPage({ careId: id });
    return () => homePage({ careId: id });
  }
  return {
    "/": () => homePage({}), "/trends": () => trendsPage({}), "/log": logPage, "/goals": goalsPage,
    "/history": () => historyPage({}), "/sharing": sharingPage, "/account": accountPage,
    "/notifications": notificationsPage, "/admin": adminPage, "/report": () => reportPage({}), "/privacy": privacyPage,
    "/login": loginPage, "/signup": signupPage, "/presentatie": presentPage, "/home": landingPage, "/api": developerPage,
  }[path];
}

let focusMainNext = false;
export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, "", path); else history.pushState({}, "", path);
  focusMainNext = !replace; // move focus to the new page's content after a user navigation, never on first load
  render();
}
window.addEventListener("popstate", () => { focusMainNext = true; render(); });
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[href]");
  if (!link || link.target || link.hasAttribute("download") || event.metaKey || event.ctrlKey || event.shiftKey) return;
  if ((link.getAttribute("href") || "").startsWith("#")) return; // in-page anchors (skip link, table of contents)
  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/static/")) return;
  event.preventDefault();
  navigate(url.pathname + url.search);
});
window.addEventListener("pg:unauthorized", () => { state.me = null; if (!PUBLIC.has(location.pathname)) navigate("/login", { replace: true }); });
window.addEventListener("pg:password-change", () => { if (state.me) state.me.must_change_password = true; render(); });

function navLink([path, key, iconName], current, cls) {
  const active = path === "/" ? current === "/" : current.startsWith(path);
  return h("a", { href: path, class: [cls, active && "active"], aria: { current: active ? "page" : null } }, icon(iconName, 22), h("span", null, t(`nav.${key}`)));
}

function prefsControls() {
  // Accessible name starts with the visible text (WCAG 2.5.3 label in name).
  const langBtn = h("button", { type: "button", class: "chip-btn", lang: state.lang === "nl" ? "en" : "nl",
    aria: { label: state.lang === "nl" ? "EN, English" : "NL, Nederlands" }, title: t("prefs.language"),
    onclick: () => savePrefs({ language: state.lang === "nl" ? "en" : "nl" }) }, state.lang === "nl" ? "EN" : "NL");
  const dark = effectiveTheme() === "dark";
  const themeBtn = h("button", { type: "button", class: "icon-btn", aria: { label: t("prefs.toggle_theme"), pressed: dark },
    onclick: () => savePrefs({ theme: dark ? "light" : "dark" }) }, icon(dark ? "sun" : "moon", 20));
  const sizes = ["normal", "large", "xlarge"];
  const current = document.documentElement.dataset.size || "large";
  const sizeBtn = h("button", { type: "button", class: "chip-btn size-btn", aria: { label: `${t("prefs.size")}: ${t(`prefs.size_${current}`)}` },
    onclick: () => savePrefs({ text_size: sizes[(sizes.indexOf(current) + 1) % sizes.length] }) },
  h("span", { class: "a-small", "aria-hidden": "true" }, "A"), h("span", { class: "a-big", "aria-hidden": "true" }, "A"));
  return [langBtn, sizeBtn, themeBtn];
}

export async function savePrefs(prefs) {
  applyPrefs(prefs);
  if (state.me) {
    Object.assign(state.me, prefs);
    api("/api/account/profile", { method: "POST", body: prefs }).catch(() => {});
  }
  render();
}

function shell(content) {
  const current = location.pathname;
  const me = state.me;
  const moreLinks = MORE.concat(me?.admin ? [["/admin", "admin", "shield"]] : []);
  const unread = me?.unread ? h("span", { class: "count", aria: { hidden: "true" } }, String(me.unread)) : null;
  const menuLabel = me?.unread ? `${t("nav.more")} (${me.unread} ${t("notifications.new").toLowerCase()})` : t("nav.more");
  const menu = h("details", { class: "menu" },
    // Name comes from content (sr-only text), so the visible count is part of it (WCAG 2.5.3).
    h("summary", { class: "icon-btn" }, icon("gear", 22), h("span", { class: "sr-only" }, menuLabel), unread),
    h("div", { class: "menu-panel" },
      h("p", { class: "menu-name" }, me?.name || ""),
      moreLinks.map((link) => navLink(link, current, "menu-link")),
      watchLink("menu-link menu-external"),
      h("button", { type: "button", class: "menu-link", onclick: logout }, icon("logout", 22), h("span", null, t("nav.logout")))));
  return [
    h("a", { class: "skip", href: "#main" }, t("nav.skip")),
    h("header", { class: "topbar" },
      h("a", { href: "/", class: "brand", aria: { label: "PulseGuard" } },
        h("img", { src: "/static/img/pulseguard-shield.png", alt: "", width: 34, height: 38 }),
        h("span", { class: "wordmark" }, "PulseGuard")),
      h("nav", { class: "topnav", aria: { label: t("nav.main") } }, TABS.map((tab) => navLink(tab, current, "topnav-link"))),
      h("div", { class: "topbar-tools" },
        h("a", { href: "/log", class: ["btn", "btn-primary", "log-btn", current.startsWith("/log") && "active"], aria: { current: current.startsWith("/log") ? "page" : null } },
          icon("plus", 20), h("span", null, t("nav.log"))),
        prefsControls(), menu)),
    h("main", { id: "main", tabindex: "-1" }, content),
    h("nav", { class: "tabbar", aria: { label: t("nav.main") } }, TABS.map((tab) => navLink(tab, current, "tab-link"))),
    h("div", { id: "session-warning", class: "session-warning", hidden: true, role: "alertdialog", aria: { live: "assertive", labelledby: "sw-text" } }),
  ];
}

function publicShell(content) {
  const path = location.pathname;
  return [
    h("a", { class: "skip", href: "#main" }, t("nav.skip")),
    h("header", { class: "topbar topbar-public" },
      h("a", { href: "/home", class: "brand", aria: { label: "PulseGuard" } },
        h("img", { src: "/static/img/pulseguard-shield.png", alt: "", width: 34, height: 38 }),
        h("span", { class: "wordmark" }, "PulseGuard")),
      h("div", { class: "topbar-tools" },
        path !== "/login" ? h("a", { href: "/login", class: "btn btn-primary log-btn" }, t("auth.login")) : null,
        prefsControls())),
    h("main", { id: "main", tabindex: "-1", class: "main-public" }, content),
  ];
}

async function logout() {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  state.me = null;
  navigate("/login");
}

async function loadMe() {
  try {
    state.me = await api("/api/me");
    applyPrefs({ language: state.me.language, theme: state.me.theme, text_size: state.me.text_size });
    startReminderLoop();
  } catch {
    state.me = null;
  }
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let firstRender = true;
let renderToken = 0;
export async function render({ live = false } = {}) {
  const token = ++renderToken;
  const path = location.pathname;
  if (state.me === null && !PUBLIC.has(path)) await loadMe();
  if (token !== renderToken) return;
  const view = routeFor(path);
  const titleBase = "PulseGuard";
  if (!state.me && !PUBLIC.has(path)) { navigate(path === "/" ? "/home" : "/login", { replace: true }); return; }
  if (state.me && (path === "/login" || path === "/signup")) { navigate("/", { replace: true }); return; }

  let content;
  try {
    if (state.me?.must_change_password && path !== "/privacy") content = await forcedPasswordPage();
    else content = view ? await view() : h("section", { class: "panel" }, h("h1", null, "404"));
  } catch (error) {
    content = h("section", { class: "panel" }, h("h1", null, t("common.error")), h("p", null, String(error?.code || "")));
  }
  if (token !== renderToken) return;
  const cockpit = path === "/" || /^\/care\/\d+$/.test(path);
  const paint = () => {
    if (path === "/presentatie" && state.me) mount(root, content);
    else mount(root, state.me ? shell(content) : publicShell(content));
    const main = $("#main");
    if (main) main.classList.toggle("main-cockpit", cockpit);
  };
  // Page changes cross-fade (View Transitions API); live refreshes and the first paint don't animate.
  if (!live && !firstRender && document.startViewTransition && !reducedMotion()) document.startViewTransition(paint);
  else paint();
  firstRender = false;
  if (live) return;
  const h1 = root.querySelector("h1");
  document.title = h1 && h1.textContent !== titleBase ? `${h1.textContent} · ${titleBase}` : titleBase;
  if (!location.hash) window.scrollTo(0, 0);
  if (focusMainNext) $("#main")?.focus({ preventScroll: true });
  focusMainNext = false;
}

// ---------- idle session warning (server logs out after 60 idle minutes) ----------
let lastActivity = Date.now();
["click", "keydown", "pointerdown"].forEach((type) => document.addEventListener(type, () => { lastActivity = Date.now(); }, { passive: true }));
setInterval(() => {
  if (!state.me) return;
  if (location.pathname === "/presentatie") { lastActivity = Date.now(); return; } // a presentation on screen counts as use
  const idleMinutes = (Date.now() - lastActivity) / 60000;
  const limit = state.me.session?.idle_minutes || 60;
  const box = document.getElementById("session-warning");
  if (!box) return;
  if (idleMinutes >= limit) { state.me = null; navigate("/login", { replace: true }); return; }
  if (idleMinutes >= limit - 5 && box.hidden) {
    const stay = h("button", { type: "button", class: "btn btn-primary", onclick: async () => {
      await api("/api/session/ping", { method: "POST" }).catch(() => {});
      lastActivity = Date.now(); box.hidden = true;
    } }, t("session.stay"));
    mount(box, h("p", { id: "sw-text" }, t("session.warning", { n: Math.max(1, Math.round(limit - idleMinutes)) })), stay);
    box.hidden = false;
    stay.focus();
  }
}, 30000);

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (document.documentElement.dataset.theme === "system") render(); });
render();
