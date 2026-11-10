// API page (/api): the one API key for this account, how to connect, what arrived, and the latest readings.
// The watch, or any other device or program, sends data here with that key. There is no separate pairing code.
import { h, t, api, mount, icon, busy, notice, when, num } from "../core.js";

const DOCS = "/static/docs/API.html";
// The address of the site this page runs on, so the examples are always current.
const API_ORIGIN = location.origin;

function copyButton(getText, label = t("apiPage.copy")) {
  const said = h("span", { class: "small copy-said", aria: { live: "polite" } });
  const btn = h("button", { type: "button", class: "btn btn-small btn-secondary", onclick: async () => {
    try { await navigator.clipboard.writeText(getText()); said.textContent = t("apiPage.copied"); } catch { said.textContent = t("apiPage.copy_manual"); }
  } }, icon("copy", 18), h("span", null, label));
  return h("span", { class: "copy-wrap" }, btn, said);
}

function exampleTs() {
  const d = new Date(); d.setSeconds(0, 0);
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

// One line per shell, so it pastes as is. Quoting differs: Windows cmd has no single quotes,
// and Windows PowerShell 5.1 mangles quotes passed to curl.exe, so it gets Invoke-RestMethod instead.
const SHELLS = ["cmd", "powershell", "unix"];
function example(shell, key) {
  const body = JSON.stringify({ readings: [{ ts: exampleTs(), device: "horloge", bpm: 72, spo2: 97, temp_c: 36.6, steps: 120 }] });
  const url = `${API_ORIGIN}/api/v1/readings`;
  const bearer = `Bearer ${key || "pg_…"}`;
  if (shell === "cmd") return `curl -X POST ${url} -H "Authorization: ${bearer}" -H "Content-Type: application/json" -d "${body.replaceAll('"', '\\"')}"`;
  if (shell === "powershell") return `Invoke-RestMethod -Method Post -Uri "${url}" -Headers @{ Authorization = "${bearer}" } -ContentType "application/json" -Body '${body}'`;
  return `curl -X POST ${url} -H "Authorization: ${bearer}" -H "Content-Type: application/json" -d '${body}'`;
}
const defaultShell = () => (/Windows/i.test(navigator.userAgent) ? "cmd" : "unix");

// ---------- key ----------
function keySection(data, onKey) {
  const slot = h("div", { class: "stack" });
  const msg = h("div", { class: "form-msg", aria: { live: "polite" } });

  const showOnce = (token) => {
    onKey(token);
    mount(msg, h("div", { class: "code-box", role: "status" },
      h("p", { class: "code-title" }, t("apiPage.key_once")),
      h("p", { class: "code mono" }, token),
      copyButton(() => token, t("apiPage.copy_key"))));
  };
  const make = async (btn) => {
    const result = await busy(btn, msg, () => api("/api/keys", { method: "POST", body: {} }));
    if (result) { data.key = { prefix: result.prefix, created_at: new Date().toISOString(), last_used_at: null }; paint(); showOnce(result.key); }
  };
  const revoke = async (btn) => {
    const ok = await busy(btn, msg, () => api("/api/keys", { method: "DELETE" }));
    if (ok) { data.key = null; onKey(null); paint(); mount(msg, notice("ok", t("apiPage.revoked"))); }
  };
  // Replacing or revoking breaks devices that use the key, so both ask once, inline (no modal).
  const confirmRow = (text, yesLabel, yesClass, action) => {
    const yes = h("button", { type: "button", class: ["btn", yesClass] }, h("span", null, yesLabel));
    yes.onclick = () => action(yes);
    const box = h("div", { class: "confirm-row", role: "group", aria: { label: text } },
      h("p", null, text), h("div", { class: "btn-row" }, yes,
        h("button", { type: "button", class: "btn btn-ghost", onclick: () => paint() }, t("common.cancel"))));
    mount(slot, box);
    yes.focus();
  };

  function paint() {
    const k = data.key;
    if (!k) {
      const create = h("button", { type: "button", class: "btn btn-primary" }, icon("plus", 20), h("span", null, t("apiPage.create")));
      create.onclick = () => make(create);
      mount(slot, h("p", null, t("apiPage.no_key")), h("div", { class: "btn-row" }, create));
      return;
    }
    const renew = h("button", { type: "button", class: "btn btn-secondary" }, h("span", null, t("apiPage.renew")));
    renew.onclick = () => confirmRow(t("apiPage.renew_confirm"), t("apiPage.renew_yes"), "btn-primary", make);
    const stop = h("button", { type: "button", class: "btn btn-ghost btn-danger-text" }, h("span", null, t("apiPage.revoke")));
    stop.onclick = () => confirmRow(t("apiPage.revoke_confirm"), t("apiPage.revoke_yes"), "btn-danger", revoke);
    mount(slot,
      h("dl", { class: "key-facts" },
        h("div", null, h("dt", null, t("apiPage.key")), h("dd", { class: "mono" }, `${k.prefix}…`)),
        h("div", null, h("dt", null, t("apiPage.created")), h("dd", null, when(k.created_at))),
        h("div", null, h("dt", null, t("apiPage.last_used")), h("dd", null, k.last_used_at ? when(k.last_used_at) : t("apiPage.never")))),
      h("p", { class: "muted small" }, t("apiPage.key_hidden")),
      h("div", { class: "btn-row" }, renew, stop));
  }
  paint();
  return h("section", { class: "panel", id: "key", aria: { labelledby: "k-h" } },
    h("h2", { id: "k-h" }, t("apiPage.key_title")), slot, msg);
}

// ---------- connect ----------
function connectSection(data) {
  let shell = defaultShell();
  let currentKey = null;
  const pre = h("pre", { class: "code-sample", tabindex: "0", aria: { label: t("apiPage.example") } }, h("code", null, example(shell, null)));
  const show = () => mount(pre.firstChild, example(shell, currentKey));
  const setKey = (key) => { currentKey = key; show(); };
  const tabs = h("div", { class: "shell-pick", role: "group", aria: { label: t("apiPage.shell") } }, SHELLS.map((s) => {
    const b = h("button", { type: "button", class: "seg-btn", aria: { pressed: s === shell } }, t(`apiPage.shell_${s}`));
    b.onclick = () => { shell = s; tabs.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); show(); };
    return b;
  }));
  const url = `${API_ORIGIN}/api/v1/readings`;
  const section = h("section", { class: "panel", id: "connect", aria: { labelledby: "c-h" } },
    h("h2", { id: "c-h" }, t("apiPage.connect_title")),
    h("p", null, t("apiPage.connect_intro")),
    h("dl", { class: "key-facts connect-facts" },
      h("div", null, h("dt", null, t("apiPage.address")), h("dd", null, h("span", { class: "mono break" }, `POST ${url}`), " ", copyButton(() => url))),
      h("div", null, h("dt", null, t("apiPage.header")), h("dd", { class: "mono break" }, t("apiPage.header_value"))),
      h("div", null, h("dt", null, t("apiPage.limits")), h("dd", null, t("apiPage.limits_text", { batch: num(data.limits.max_batch), hour: num(data.limits.per_hour) })))),
    h("h3", null, t("apiPage.example")),
    tabs, pre, copyButton(() => pre.textContent, t("apiPage.copy_example")),
    h("p", { class: "small" }, h("a", { href: DOCS, target: "_blank", rel: "noopener" },
      h("span", null, t("apiPage.docs")), h("span", { class: "sr-only" }, ` (${t("nav.new_tab")})`), icon("external", 16))));
  return { section, setKey };
}

// ---------- log ----------
function statusPill(r) {
  const kind = r.status >= 200 && r.status < 300 ? (r.rejected ? "warn" : "ok") : "error";
  return h("span", { class: ["status-pill", `status-${kind}`] }, icon(kind === "ok" ? "check" : "alert", 16), h("span", null, String(r.status)));
}

function resultText(r) {
  if (r.error) {
    const key = `apiPage.err_${r.error}`;
    const text = t(key);
    return text === key ? r.error : text;
  }
  if (r.path.endsWith("/status")) return t("apiPage.res_status");
  const parts = [t("apiPage.res_saved", { n: num(r.accepted) })];
  if (r.duplicates) parts.push(t("apiPage.res_dupes", { n: num(r.duplicates) }));
  if (r.rejected) parts.push(t("apiPage.res_rejected", { n: num(r.rejected) }));
  return parts.join(" · ");
}

// Validation codes from the server, in plain words; the code itself stays visible for developers.
function readingError(code) {
  const range = /^out_of_range_(\w+)$/.exec(code);
  const invalid = /^invalid_(\w+)$/.exec(code);
  const field = (f) => { const label = t(`apiPage.col_${f}`); return label.startsWith("apiPage.") ? f : label; };
  const plain = range ? t("apiPage.verr_range", { f: field(range[1]) })
    : invalid ? t("apiPage.verr_invalid", { f: field(invalid[1]) })
    : t(`apiPage.verr_${code}`);
  return plain.startsWith("apiPage.") ? code : `${plain} (${code})`;
}

function logList(data) {
  if (!data.requests.length) return h("p", { class: "muted" }, t("apiPage.log_empty"));
  return h("ul", { class: "rows api-log" }, data.requests.map((r) => {
    const content = [];
    if (r.fields) content.push(t("apiPage.fields", { list: r.fields.split(",").join(", ") }));
    if (r.devices) content.push(t("apiPage.devices", { list: r.devices.split(",").join(", ") }));
    if (r.first_ts) content.push(r.first_ts === r.last_ts ? t("apiPage.span_one", { a: when(r.first_ts) }) : t("apiPage.span", { a: when(r.first_ts), b: when(r.last_ts) }));
    return h("li", { class: "api-log-row" },
      h("div", { class: "api-log-head" },
        h("span", { class: "mono api-log-time" }, when(r.ts)),
        h("span", { class: "mono api-log-req" }, `${r.method} ${r.path}`),
        statusPill(r)),
      h("p", { class: "api-log-result" }, resultText(r)),
      content.length ? h("p", { class: "muted small" }, content.join(" · ")) : null,
      r.errors.length ? h("details", { class: "api-log-errors" }, h("summary", null, t("apiPage.why")),
        h("ul", null, r.errors.map((e) => h("li", { class: "mono small" }, t("apiPage.err_item", { i: num(e.index + 1), e: readingError(e.error) }))))) : null);
  }));
}

function logSection(data, reload) {
  const body = h("div", { class: "stack" });
  const msg = h("div", { class: "form-msg", aria: { live: "polite" } });
  const refresh = h("button", { type: "button", class: "btn btn-small btn-secondary" }, h("span", null, t("apiPage.refresh")));
  refresh.onclick = () => busy(refresh, msg, reload);
  const clear = h("button", { type: "button", class: "btn btn-small btn-ghost" }, h("span", null, t("apiPage.clear")));
  clear.onclick = async () => { if (await busy(clear, msg, () => api("/api/developer/requests", { method: "DELETE" }))) reload(); };
  const fill = (d) => mount(body,
    h("p", { class: "muted" }, t("apiPage.last24", { n: num(d.last_24h.requests), a: num(d.last_24h.accepted) })),
    logList(d));
  fill(data);
  return { fill, section: h("section", { class: "panel", id: "log", aria: { labelledby: "l-h" } },
    h("div", { class: "section-head" }, h("h2", { id: "l-h" }, t("apiPage.log_title")), h("div", { class: "btn-row" }, refresh, clear)),
    h("p", { class: "muted small" }, t("apiPage.log_note")), body, msg) };
}

// ---------- readings ----------
function readingsTable(rows) {
  if (!rows.length) return h("p", { class: "muted" }, t("apiPage.readings_empty"));
  const cell = (v, d = 0) => (v == null ? t("common.none") : num(v, d));
  return h("div", { class: "table-scroll", tabindex: "0", role: "region", aria: { label: t("apiPage.readings_title") } },
    h("table", { class: "data-table" },
      h("thead", null, h("tr", null, ["time", "device", "bpm", "spo2", "temp_c", "steps", "activity"].map((c) => h("th", { scope: "col" }, t(`apiPage.col_${c}`))))),
      h("tbody", null, rows.map((r) => h("tr", null,
        h("td", { class: "mono" }, `${when(r.ts)}`), h("td", null, r.device || ""),
        h("td", { class: "num" }, cell(r.bpm)), h("td", { class: "num" }, cell(r.spo2)), h("td", { class: "num" }, cell(r.temp_c, 1)),
        h("td", { class: "num" }, cell(r.steps)), h("td", null, r.activity ? t(`apiPage.act_${r.activity}`) : ""))))));
}

let timer = null;
export async function developerPage() {
  const data = await api("/api/developer");
  const readingsBody = h("div", null, readingsTable(data.readings));
  const connect = connectSection(data);
  let log;
  const reload = async () => {
    const fresh = await api("/api/developer");
    log.fill(fresh);
    mount(readingsBody, readingsTable(fresh.readings));
    return fresh;
  };
  log = logSection(data, reload);
  // Quietly keep the log current while this page is open.
  clearInterval(timer);
  timer = setInterval(() => {
    if (location.pathname !== "/api") { clearInterval(timer); return; }
    if (document.visibilityState === "visible") reload().catch(() => {});
  }, 20000);

  return h("div", { class: "page api-page" },
    h("header", { class: "page-head" }, h("h1", null, t("apiPage.title")), h("p", { class: "lead" }, t("apiPage.intro"))),
    keySection(data, connect.setKey),
    connect.section,
    log.section,
    h("section", { class: "panel", id: "readings", aria: { labelledby: "r-h" } },
      h("h2", { id: "r-h" }, t("apiPage.readings_title")), readingsBody));
}

