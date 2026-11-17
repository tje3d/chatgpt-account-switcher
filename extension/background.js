/**
 * background.js — message router, badge, tab reloads.
 *
 * All cookie/state logic lives in lib/core.js. This file only wires it to the
 * extension APIs and validates that every message came from our own contexts.
 */
"use strict";

const api = browser;
const manager = ChatGPTAccounts.createManager({ api, storage: api.storage.local });

const CHATGPT_MATCHES = ["https://chatgpt.com/*"];
const BADGE_COLOR = "#10a37f";

async function refreshBadge() {
  try {
    const info = await manager.list();
    const active = info.accounts.find((account) => account.id === info.activeId);
    const text = active ? Array.from(active.name.trim())[0].toUpperCase() : "";
    await api.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    await api.action.setBadgeText({ text });
  } catch (err) {
    /* badge is cosmetic */
  }
}

async function reloadChatGPTTabs() {
  const tabs = await api.tabs.query({ url: CHATGPT_MATCHES });
  if (!tabs.length) {
    await api.tabs.create({ url: "https://chatgpt.com/" });
    return;
  }
  await Promise.all(
    tabs.map((tab) => api.tabs.reload(tab.id).catch(() => {}))
  );
}

async function probeSession() {
  try {
    const response = await fetch("https://chatgpt.com/api/auth/session", {
      credentials: "include",
      cache: "no-store",
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const data = await response.json();
    const email = ChatGPTAccounts.cleanEmail(data && data.user && data.user.email);
    if (!email) return { ok: false, error: "No active session" };
    await api.storage.local.set({ lastSeenEmail: email, lastSeenAt: Date.now() });
    return { ok: true, email };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

async function readLastSeenEmail() {
  const { lastSeenEmail } = await api.storage.local.get("lastSeenEmail");
  return lastSeenEmail || null;
}

/**
 * Prefer a live probe over the cached email: a stale cache could mis-attribute
 * the session to the wrong saved account and overwrite its snapshot.
 */
async function freshEmail() {
  const probe = await probeSession();
  return probe.ok ? probe.email : readLastSeenEmail();
}

async function handle(message) {
  const type = message && message.type;
  switch (type) {
    case "list": {
      const info = await manager.list();
      return { ok: true, ...info, lastSeenEmail: await readLastSeenEmail() };
    }
    case "save": {
      const account = await manager.saveCurrent(message.name, message.email || (await readLastSeenEmail()));
      await refreshBadge();
      return { ok: true, account };
    }
    case "update": {
      const account = await manager.update(message.id, message.email || (await readLastSeenEmail()));
      return { ok: true, account };
    }
    case "rename": {
      const account = await manager.rename(message.id, message.name);
      await refreshBadge();
      return { ok: true, account };
    }
    case "remove": {
      const result = await manager.remove(message.id);
      await refreshBadge();
      return { ok: true, ...result };
    }
    case "export": {
      return { ok: true, data: await manager.exportAll() };
    }
    case "import": {
      const result = await manager.importAll(message.data);
      await refreshBadge();
      return { ok: true, ...result };
    }
    case "switch": {
      const result = await manager.switchTo(message.id, await freshEmail());
      // Record the new session immediately. Otherwise the popup compares the
      // newly active account against the previous account's cached email and
      // shows a false "browser session is X" warning until a page probe runs.
      await api.storage.local.set({
        lastSeenEmail: result.account.email || null,
        lastSeenAt: Date.now(),
        notice: { text: `Switched to ${result.account.name}`, at: Date.now() }
      });
      await refreshBadge();
      await reloadChatGPTTabs();
      return { ok: true, ...result };
    }
    case "signOut": {
      const result = await manager.signOut(await freshEmail());
      await api.storage.local.set({
        lastSeenEmail: null,
        notice: {
          text: "Logged out. Sign in with the account you want to add, then save it.",
          at: Date.now()
        }
      });
      await refreshBadge();
      await reloadChatGPTTabs();
      return { ok: true, ...result };
    }
    case "probeSession": {
      return probeSession();
    }
    case "sessionInfo": {
      const email = ChatGPTAccounts.cleanEmail(message.email);
      if (!email) return { ok: false, error: "Invalid email" };
      await api.storage.local.set({ lastSeenEmail: email, lastSeenAt: Date.now() });
      return { ok: true };
    }
    case "consumeNotice": {
      const { notice } = await api.storage.local.get("notice");
      if (notice) await api.storage.local.set({ notice: null });
      if (!notice || Date.now() - notice.at > 60_000) return { ok: true, text: null };
      return { ok: true, text: notice.text };
    }
    default:
      return { ok: false, error: "Unknown message type" };
  }
}

api.runtime.onMessage.addListener((message, sender) => {
  if (!sender || sender.id !== api.runtime.id) {
    return Promise.resolve({ ok: false, error: "Untrusted sender" });
  }
  return handle(message).catch((err) => ({
    ok: false,
    error: err && err.message ? err.message : String(err)
  }));
});

api.runtime.onInstalled.addListener(() => {
  refreshBadge();
});

api.runtime.onStartup.addListener(() => {
  refreshBadge();
});

refreshBadge();
