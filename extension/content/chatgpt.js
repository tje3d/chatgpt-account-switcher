"use strict";

const api = globalThis.browser ?? globalThis.chrome;

const PROBE_INTERVAL_MS = 60_000;

function toast(text) {
  const element = document.createElement("div");
  element.textContent = text;
  element.setAttribute("role", "status");
  element.style.cssText = [
    "position:fixed",
    "right:20px",
    "bottom:20px",
    "z-index:2147483647",
    "padding:10px 16px",
    "border-radius:10px",
    "background:#10a37f",
    "color:#fff",
    "font:500 13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    "box-shadow:0 8px 24px rgba(0,0,0,.25)",
    "opacity:0",
    "transition:opacity .2s ease"
  ].join(";");
  document.documentElement.appendChild(element);
  requestAnimationFrame(() => {
    element.style.opacity = "1";
  });
  setTimeout(() => {
    element.style.opacity = "0";
    setTimeout(() => element.remove(), 250);
  }, 3500);
}

async function reportSession() {
  try {
    const response = await api.runtime.sendMessage({ type: "probeSession" });
    if (response && response.ok) return;

    // Background fetch can be refused; fall back to a same-origin probe.
    const local = await fetch("/api/auth/session", {
      credentials: "include",
      cache: "no-store"
    });
    if (!local.ok) return;
    const data = await local.json();
    const email = data && data.user && data.user.email;
    if (email) await api.runtime.sendMessage({ type: "sessionInfo", email });
  } catch (err) {
    /* logged out or endpoint unavailable */
  }
}

async function showNotice() {
  try {
    const response = await api.runtime.sendMessage({ type: "consumeNotice" });
    if (response && response.text) toast(response.text);
  } catch (err) {
    /* no notice */
  }
}

(async function init() {
  await reportSession();
  await showNotice();
  setInterval(reportSession, PROBE_INTERVAL_MS);
})();
