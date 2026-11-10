import { h, t, api, field, busy, notice, mount, when, icon, errorText } from "../core.js";
import { navigate } from "../main.js";

export async function sharingPage() {
  const data = await api("/api/care");
  const reload = () => navigate("/sharing", { replace: true });

  const grants = data.grants.length ? h("ul", { class: "rows" }, data.grants.map((g) => h("li", { class: "row" },
    h("div", null, h("strong", null, g.label), h("span", { class: "muted" }, ` · ${g.caregiver_name}`),
      h("p", { class: "muted small" }, g.last_viewed ? t("sharing.last_viewed", { time: when(g.last_viewed) }) : t("sharing.never_viewed"))),
    h("button", { type: "button", class: "btn btn-small btn-danger", onclick: async (event) => {
      if (!window.confirm(t("sharing.confirm_revoke", { label: g.label }))) return;
      event.currentTarget.disabled = true;
      await api(`/api/care/grants/${g.id}`, { method: "DELETE" }).catch(() => {});
      reload();
    } }, t("sharing.revoke"))))) : h("p", { class: "muted" }, t("sharing.none"));

  const pending = data.invites.length ? h("div", { class: "stack" }, h("h3", null, t("sharing.pending")),
    h("ul", { class: "rows" }, data.invites.map((inv) => h("li", { class: "row" },
      h("span", null, inv.label, h("span", { class: "muted small" }, ` · ${when(inv.expires_at)}`)),
      h("button", { type: "button", class: "btn btn-small btn-ghost", onclick: async () => { await api(`/api/care/invites/${inv.id}`, { method: "DELETE" }).catch(() => {}); reload(); } }, t("sharing.cancel")))))) : null;

  const label = h("input", { maxlength: 60, required: true, autocomplete: "off" });
  const inviteMsg = h("div", { class: "form-msg", aria: { live: "polite" } });
  const inviteBtn = h("button", { type: "submit", class: "btn btn-primary" }, icon("plus", 20), h("span", null, t("sharing.create")));
  const inviteForm = h("form", { class: "stack", onsubmit: async (event) => {
    event.preventDefault();
    const name = label.value.trim();
    const result = await busy(inviteBtn, inviteMsg, () => api("/api/care/invites", { method: "POST", body: { label: name } }));
    if (result) {
      mount(inviteMsg, h("div", { class: "code-box", role: "status" },
        h("p", { class: "code-title" }, t("sharing.code_title")),
        h("p", { class: "code" }, result.code),
        h("p", { class: "muted" }, t("sharing.code_help", { label: name, time: when(result.expires_at) }))));
      label.value = "";
    }
  } }, h("h3", null, t("sharing.invite")), field(t("sharing.label"), label), inviteBtn, inviteMsg);

  const patients = data.patients.length ? h("ul", { class: "rows" }, data.patients.map((p) => h("li", { class: "row" },
    h("strong", null, p.name),
    h("div", { class: "row-actions" },
      h("a", { class: "btn btn-small btn-primary", href: `/care/${p.id}` }, t("sharing.open")),
      h("button", { type: "button", class: "btn btn-small btn-ghost", onclick: async () => { await api(`/api/care/patients/${p.id}`, { method: "DELETE" }).catch(() => {}); reload(); } }, t("sharing.stop")))))) :
    h("p", { class: "muted" }, t("sharing.caring_none"));

  const code = h("input", { maxlength: 20, required: true, autocomplete: "off", autocapitalize: "characters", spellcheck: "false", class: "code-input" });
  const acceptMsg = h("div", { class: "form-msg", aria: { live: "polite" } });
  const acceptBtn = h("button", { type: "submit", class: "btn btn-secondary" }, t("sharing.accept_btn"));
  const acceptForm = h("form", { class: "stack", onsubmit: async (event) => {
    event.preventDefault();
    try {
      acceptBtn.disabled = true;
      await api("/api/care/accept", { method: "POST", body: { code: code.value.trim() } });
      reload();
    } catch (error) { mount(acceptMsg, notice("error", errorText(error))); } finally { acceptBtn.disabled = false; }
  } }, h("h3", null, t("sharing.accept")), field(t("sharing.code"), code), acceptBtn, acceptMsg);

  return h("div", { class: "page" },
    h("header", { class: "page-head" }, h("h1", null, t("sharing.title")), h("p", { class: "lead" }, t("sharing.intro"))),
    h("div", { class: "split" },
      h("section", { class: "panel", aria: { labelledby: "sh-who" } }, h("h2", { id: "sh-who" }, t("sharing.who")), grants, pending, inviteForm),
      h("section", { class: "panel", aria: { labelledby: "sh-care" } }, h("h2", { id: "sh-care" }, t("sharing.caring")), patients, acceptForm)));
}
