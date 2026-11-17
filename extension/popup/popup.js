"use strict";

const api = globalThis.browser ?? globalThis.chrome;

const els = {
  activeLine: document.getElementById("activeLine"),
  warning: document.getElementById("warning"),
  list: document.getElementById("accountList"),
  empty: document.getElementById("empty"),
  status: document.getElementById("status"),
  saveForm: document.getElementById("saveForm"),
  nameInput: document.getElementById("nameInput"),
  cancelSave: document.getElementById("cancelSave"),
  addBtn: document.getElementById("addBtn"),
  signOutBtn: document.getElementById("signOutBtn"),
  backupBtn: document.getElementById("backupBtn")
};

let state = {
  accounts: [],
  activeId: null,
  lastSeenEmail: null
};
let busy = false;

async function send(message) {
  try {
    const response = await api.runtime.sendMessage(message);
    return response || { ok: false, error: "No response from background" };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

function setStatus(text, kind) {
  els.status.textContent = text || "";
  els.status.className = "status" + (kind ? " " + kind : "");
}

function setBusy(value) {
  busy = value;
  document.body.classList.toggle("busy", value);
}

function relativeTime(timestamp) {
  if (!timestamp) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.round(hours / 24);
  if (days < 7) return days + "d ago";
  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(
    undefined,
    sameYear
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" }
  );
}

function button(label, className, onClick, title) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "btn " + className;
  element.textContent = label;
  element.addEventListener("click", onClick);
  element.title = title || label;
  return element;
}

async function refresh() {
  const response = await send({ type: "list" });
  if (!response.ok) {
    setStatus(response.error, "error");
    return false;
  }
  state = response;
  return true;
}

function renderHeader() {
  const active = state.accounts.find((account) => account.id === state.activeId);

  if (active) {
    const suffix = active.email ? " · " + active.email : "";
    els.activeLine.textContent = "Active: " + active.name + suffix;
  } else {
    els.activeLine.textContent = "No active account";
  }

  if (active && active.email && state.lastSeenEmail && active.email !== state.lastSeenEmail) {
    els.warning.textContent =
      "Browser session is " + state.lastSeenEmail + ", but this account saved " +
      active.email + ". If the page looks wrong, log in and press Update.";
    els.warning.classList.remove("hidden");
  } else {
    els.warning.classList.add("hidden");
  }
}

function startRename(id, record, nameEl) {
  const input = document.createElement("input");
  input.className = "input inline";
  input.maxLength = 64;
  input.value = record.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const finish = async (save) => {
    if (!input.isConnected) return;
    if (!save) {
      render();
      return;
    }
    const name = input.value.trim();
    if (!name) {
      render();
      return;
    }
    setBusy(true);
    const response = await send({ type: "rename", id, name });
    setBusy(false);
    if (!response.ok) setStatus(response.error, "error");
    await refresh();
    render();
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true), { once: true });
}

function renderAccount(record) {
  let armed = false;
  const isActive = record.id === state.activeId;
  const row = document.createElement("div");
  row.className = "account";

  const body = document.createElement("div");
  body.className = "account-body";

  const nameEl = document.createElement("span");
  nameEl.className = "account-name";
  nameEl.textContent = record.name;

  const meta = document.createElement("span");
  meta.className = "account-meta";
  const parts = [];
  if (record.email) parts.push(record.email);
  if (isActive) {
    parts.push("in use now");
  } else if (record.lastUsedAt) {
    parts.push("last used " + relativeTime(record.lastUsedAt));
  } else {
    parts.push("saved " + relativeTime(record.savedAt));
  }
  meta.textContent = parts.join(" · ");
  meta.title = [
    record.email || "No email recorded",
    "Last used: " + (record.lastUsedAt ? new Date(record.lastUsedAt).toLocaleString() : "never"),
    "Saved: " + (record.savedAt ? new Date(record.savedAt).toLocaleString() : "unknown"),
    record.cookieCount + " cookies"
  ].join("\n");

  body.appendChild(nameEl);
  body.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "account-actions";

  const switchBtn = button(isActive ? "Active" : "Switch", "small primary", async () => {
    if (busy || isActive) return;
    setBusy(true);
    setStatus("Switching to " + record.name + "…");
    const response = await send({ type: "switch", id: record.id });
    setBusy(false);
    if (response.ok) {
      setStatus("Switched to " + response.account.name, "success");
    } else {
      setStatus(response.error, "error");
    }
    await refresh();
    render();
  });
  switchBtn.disabled = isActive;

  const updateBtn = button("Update", "small ghost", async () => {
    if (busy) return;
    setBusy(true);
    const response = await send({ type: "update", id: record.id });
    setBusy(false);
    if (response.ok) {
      setStatus("Saved " + response.account.cookieCount + " cookies for " + record.name, "success");
    } else {
      setStatus(response.error, "error");
    }
    await refresh();
    render();
  }, "Overwrite this account with the session currently in the browser");

  const renameBtn = button("Rename", "small ghost", () => startRename(record.id, record, nameEl));

  const removeBtn = button("Delete", "small danger", async () => {
    if (!armed) {
      armed = true;
      removeBtn.textContent = "Sure?";
      removeBtn.classList.add("armed");
      setTimeout(() => {
        if (!removeBtn.isConnected) return;
        armed = false;
        removeBtn.textContent = "Delete";
        removeBtn.classList.remove("armed");
      }, 3000);
      return;
    }
    if (busy) return;
    setBusy(true);
    const response = await send({ type: "remove", id: record.id });
    setBusy(false);
    if (response.ok) {
      setStatus("Deleted " + record.name + " (live cookies untouched)", "success");
    } else {
      setStatus(response.error, "error");
    }
    await refresh();
    render();
  }, "Delete this saved account. Does not log you out.");

  actions.appendChild(switchBtn);
  actions.appendChild(updateBtn);
  actions.appendChild(renameBtn);
  actions.appendChild(removeBtn);

  row.appendChild(body);
  row.appendChild(actions);
  return row;
}

function render() {
  renderHeader();

  els.list.textContent = "";
  if (!state.accounts.length) {
    els.empty.classList.remove("hidden");
  } else {
    els.empty.classList.add("hidden");
    state.accounts.forEach((record) => {
      els.list.appendChild(renderAccount(record));
    });
  }
}

async function boot() {
  await refresh();
  render();
  if (!state.accounts.length && state.lastSeenEmail) {
    setStatus("Detected session: " + state.lastSeenEmail, "info");
  }
}

els.addBtn.addEventListener("click", () => {
  els.saveForm.classList.remove("hidden");
  els.addBtn.classList.add("hidden");
  if (state.lastSeenEmail) {
    const local = state.lastSeenEmail.split("@")[0];
    els.nameInput.value = local;
  }
  els.nameInput.focus();
  els.nameInput.select();
});

els.cancelSave.addEventListener("click", () => {
  els.saveForm.classList.add("hidden");
  els.addBtn.classList.remove("hidden");
  setStatus("");
});

els.saveForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const name = els.nameInput.value.trim();
  if (!name) {
    setStatus("Give the account a name first", "error");
    return;
  }
  setBusy(true);
  const response = await send({ type: "save", name, email: state.lastSeenEmail });
  setBusy(false);
  if (!response.ok) {
    setStatus(response.error, "error");
    return;
  }
  els.saveForm.classList.add("hidden");
  els.addBtn.classList.remove("hidden");
  els.nameInput.value = "";
  setStatus("Saved " + response.account.name + " (" + response.account.cookieCount + " cookies)", "success");
  await refresh();
  render();
});

els.signOutBtn.addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  setStatus("Logging out of the browser session…");
  const response = await send({ type: "signOut" });
  setBusy(false);
  if (!response.ok) {
    setStatus(response.error, "error");
    return;
  }
  setStatus("Logged out. Sign in with the other account, then save it.", "success");
  await refresh();
  render();
});

els.backupBtn.addEventListener("click", async () => {
  try {
    await api.runtime.openOptionsPage();
  } catch (err) {
    try {
      await api.tabs.create({ url: api.runtime.getURL("backup/backup.html") });
    } catch (fallbackErr) {
      setStatus("Could not open the backup page.", "error");
    }
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) boot();
});

boot();
