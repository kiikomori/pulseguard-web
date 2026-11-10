import { h, t, api, field, busy, notice, mount, state, applyPrefs, setFieldError, errorText } from "../core.js";
import { navigate, render } from "../main.js";

function authLayout(title, form, footer) {
  return h("div", { class: "auth" },
    h("section", { class: "auth-intro", aria: { label: t("auth.welcome") } },
      h("img", { src: "/static/img/pulseguard-shield.png", alt: "", width: 72, height: 80, class: "auth-shield" }),
      h("p", { class: "auth-lead" }, t("auth.welcome_body")),
      h("p", { class: "auth-medical" }, t("auth.medical"))),
    h("section", { class: "auth-card" }, h("h1", null, title), form, footer));
}

export function loginPage() {
  const username = h("input", { name: "username", autocomplete: "username", autocapitalize: "none", spellcheck: "false", required: true, maxlength: 40 });
  const password = h("input", { name: "password", type: "password", autocomplete: "current-password", required: true, maxlength: 128 });
  const msg = h("div", { class: "form-msg", aria: { live: "polite" } });
  const submit = h("button", { type: "submit", class: "btn btn-primary btn-wide" }, t("auth.login"));
  const form = h("form", { class: "stack", novalidate: true, onsubmit: async (event) => {
    event.preventDefault();
    await busy(submit, msg, async () => {
      await api("/api/login", { method: "POST", body: { username: username.value.trim(), password: password.value } });
      state.me = null;
      navigate("/");
    });
  } }, field(t("auth.username"), username), field(t("auth.password"), password), msg, submit);
  return authLayout(t("auth.login"), form,
    h("p", { class: "auth-switch" }, t("auth.no_account"), " ", h("a", { href: "/signup" }, t("auth.signup"))));
}

export function signupPage() {
  const name = h("input", { name: "name", autocomplete: "name", required: true, maxlength: 80 });
  const username = h("input", { name: "username", autocomplete: "username", autocapitalize: "none", spellcheck: "false", required: true, maxlength: 40 });
  const password = h("input", { name: "password", type: "password", autocomplete: "new-password", required: true, minlength: 12, maxlength: 128 });
  const consent = h("input", { type: "checkbox", name: "consent", id: "consent", required: true });
  const msg = h("div", { class: "form-msg", aria: { live: "polite" } });
  const submit = h("button", { type: "submit", class: "btn btn-primary btn-wide" }, t("auth.signup"));
  const fieldFor = { name, username, password };
  // Greyed out until consent is given, but still focusable: a click explains why instead of doing nothing.
  const syncConsent = () => {
    submit.setAttribute("aria-disabled", String(!consent.checked));
    if (consent.checked && msg.dataset.consent) { mount(msg); delete msg.dataset.consent; }
  };
  consent.addEventListener("change", syncConsent);
  syncConsent();
  const form = h("form", { class: "stack", novalidate: true, onsubmit: async (event) => {
    event.preventDefault();
    Object.values(fieldFor).forEach((input) => setFieldError(input, ""));
    if (!consent.checked) {
      mount(msg, notice("error", t("err.consent_required")));
      msg.dataset.consent = "1";
      consent.focus();
      return;
    }
    submit.disabled = true;
    mount(msg);
    try {
      await api("/api/signup", { method: "POST", body: {
        name: name.value.trim(), username: username.value.trim(), password: password.value, consent: consent.checked, language: state.lang } });
      state.me = null;
      navigate("/");
    } catch (error) {
      const code = error.code || "";
      const target = code.startsWith("password") ? password : code.includes("username") ? username : code.includes("name") ? name : null;
      if (target) { setFieldError(target, errorText(error)); target.focus(); } else mount(msg, notice("error", errorText(error)));
    } finally { submit.disabled = false; }
  } },
  field(t("auth.name"), name),
  field(t("auth.username"), username, { hint: t("auth.username_hint") }),
  field(t("auth.password"), password, { hint: t("account.pw_rules") }),
  h("div", { class: "check" }, consent, h("label", { for: "consent" }, t("auth.consent"), " ", h("a", { href: "/privacy", target: "_blank", rel: "noopener" }, t("auth.consent_link")))),
  msg, submit);
  return authLayout(t("auth.signup"), form,
    h("p", { class: "auth-switch" }, t("auth.have_account"), " ", h("a", { href: "/login" }, t("auth.login"))));
}

export function forcedPasswordPage() {
  const current = h("input", { type: "password", autocomplete: "current-password", required: true });
  const next = h("input", { type: "password", autocomplete: "new-password", required: true, minlength: 12 });
  const msg = h("div", { class: "form-msg", aria: { live: "polite" } });
  const submit = h("button", { type: "submit", class: "btn btn-primary" }, t("account.change"));
  return h("section", { class: "panel narrow" },
    h("h1", null, t("account.password")),
    notice("warn", t("account.must_change")),
    h("form", { class: "stack", onsubmit: async (event) => {
      event.preventDefault();
      const ok = await busy(submit, msg, () => api("/api/account/password", { method: "POST", body: { current: current.value, new: next.value } }));
      if (ok) { state.me = null; render(); }
    } }, field(t("account.current"), current), field(t("account.new"), next, { hint: t("account.pw_rules") }), msg, submit));
}

export { applyPrefs };
