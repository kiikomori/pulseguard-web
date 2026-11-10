// Medication reminders: "due now" logic shared by the overview, plus browser notifications
// while PulseGuard is open. The on/off switch is per device (localStorage); dose times live on the server.
import { t, api } from "./core.js";

const DUE_WINDOW_MIN = 60;

function at(timeText, base = new Date()) {
  const [hh, mm] = timeText.split(":").map(Number);
  const d = new Date(base);
  d.setHours(hh, mm, 0, 0);
  return d;
}

/** Doses due now: within an hour after their time and not yet taken or skipped. */
export function dueDoses(meds, now = new Date()) {
  const due = [];
  for (const med of meds) {
    const handled = (med.taken || 0) + (med.skipped || 0);
    (med.times || []).forEach((time, index) => {
      const when = at(time, now);
      const minutes = (now - when) / 60000;
      if (minutes >= 0 && minutes < DUE_WINDOW_MIN && handled <= index) due.push({ med, time });
    });
  }
  return due;
}

export function nextDose(meds, now = new Date()) {
  let best = null;
  for (const med of meds) {
    for (const time of med.times || []) {
      const when = at(time, now);
      if (when > now && (!best || when < best.when)) best = { med, time, when };
    }
  }
  return best;
}

function store(key, value) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* private mode */ } }
function read(key) { try { return localStorage.getItem(key); } catch { return null; } }

export function reminderState() {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return read("pg.reminders") === "on" && Notification.permission === "granted" ? "on" : "off";
}

export async function enableReminders() {
  if (!("Notification" in window)) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission === "granted") { store("pg.reminders", "on"); startReminderLoop(); return "on"; }
  return permission === "denied" ? "denied" : "off";
}

export function disableReminders() { store("pg.reminders", null); }

let timer = null;
async function tick() {
  if (reminderState() !== "on") return;
  let data;
  try { data = await api("/api/medications", { poll: true }); } catch { return; }
  const today = new Date().toISOString().slice(0, 10);
  for (const { med, time } of dueDoses(data.today)) {
    const key = `pg.notified.${today}.${med.id}.${time}`;
    if (read(key)) continue;
    store(key, "1");
    try {
      new Notification(t("reminders.notif_title"), { body: t("reminders.notif_body", { name: med.name, dose: med.dose || "", time }), tag: key, icon: "/static/img/pulseguard-shield.png" });
    } catch { /* some browsers only allow notifications from a service worker */ }
  }
}

export function startReminderLoop() {
  if (timer || reminderState() !== "on") return;
  tick();
  timer = setInterval(tick, 60000);
}
