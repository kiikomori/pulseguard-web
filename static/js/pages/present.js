// Presenter view: the overview for a projector or TV. No navigation chrome, large type, refreshes itself.
import { h, t, api, when } from "../core.js";
import { cockpitParts } from "./home.js";
import { render, navigate } from "../main.js";

let timer = null;
let first = true;

function onKey(event) {
  if (event.key === "Escape" && location.pathname === "/presentatie") navigate("/");
}

export async function presentPage() {
  const [data, pulse] = await Promise.all([api("/api/dashboard"), api("/api/pulse?days=7")]);
  const parts = cockpitParts(data, pulse, { readOnly: false, animate: first, refresh: () => render(), presenter: true });
  first = false;
  clearInterval(timer);
  timer = setInterval(() => {
    if (location.pathname !== "/presentatie") { clearInterval(timer); first = true; document.removeEventListener("keydown", onKey); return; }
    render({ live: true });
  }, 30000);
  document.removeEventListener("keydown", onKey);
  document.addEventListener("keydown", onKey);

  return h("div", { class: "present-shell" },
    h("header", { class: "present-bar" },
      h("a", { href: "/", class: "brand", aria: { label: "PulseGuard" } },
        h("img", { src: "/static/img/pulseguard-shield.png", alt: "", width: 34, height: 38 }), h("span", { class: "wordmark" }, "PulseGuard")),
      h("span", { class: "muted" }, `${t("present.refreshed", { time: when(new Date().toISOString().slice(0, 19)) })}. ${t("present.hint")}`),
      h("a", { href: "/" }, t("present.close"))),
    h("main", { id: "main", class: "present-main", tabindex: "-1" },
      h("h1", { class: "sr-only" }, t("present.title")),
      parts.alerts.childElementCount ? parts.alerts : null, parts.now, parts.plot, parts.strip));
}
