// Public landing page (/home, where logged-out visitors land): what PulseGuard does, shown with the Pulse Plot on clearly labelled example data.
import { h, t, icon, watchLink } from "../core.js";
import { pulsePlot, exampleWeek } from "../pulseplot.js";

export function landingPage() {
  const points = [
    ["s1", "alert"], ["s2", "pill"], ["s3", "users"], ["s4", "shield"],
  ];
  return h("div", { class: "page landing" },
    h("section", { class: "landing-hero", aria: { labelledby: "landing-h" } },
      h("div", { class: "stack" },
        h("h1", { id: "landing-h" }, t("landing.title")),
        h("p", { class: "landing-lead" }, t("landing.lead")),
        h("div", { class: "landing-actions" },
          h("a", { class: "btn btn-primary", href: "/signup" }, t("landing.signup")),
          h("a", { class: "btn btn-secondary", href: "/login" }, t("landing.login"))),
        watchLink("landing-watch")),
      h("figure", { class: "landing-plot" },
        pulsePlot(exampleWeek(7), { thresholds: { bpm_low: 45, bpm_high: 120 }, animate: true, beatBpm: 68, example: true, label: t("landing.plot_caption") }),
        h("figcaption", { class: "small muted" }, h("span", { class: "example-tag" }, t("plot.example")), " ", t("landing.plot_caption")))),
    h("div", { class: "landing-points" }, points.map(([key, iconName]) => h("section", { class: "landing-point", aria: { labelledby: `lp-${key}` } },
      h("h2", { id: `lp-${key}` }, icon(iconName, 22), " ", t(`landing.${key}_title`)),
      h("p", null, t(`landing.${key}_body`))))),
    h("p", { class: "landing-medical" }, t("landing.medical"), " ", h("a", { href: "/privacy" }, t("nav.privacy"))));
}
