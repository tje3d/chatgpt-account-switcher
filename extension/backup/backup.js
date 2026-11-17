"use strict";

/**
 * Export / import page. Opened in a tab from the popup so the native file
 * picker never tears down the popup mid-operation.
 */

const api = globalThis.browser ?? globalThis.chrome;

const els = {
  activeLine: document.getElementById("activeLine"),
  exportBtn: document.getElementById("exportBtn"),
  importBtn: document.getElementById("importBtn"),
  importFile: document.getElementById("importFile"),
  status: document.getElementById("status")
};

const MAX_FILE_BYTES = 10 * 1024 * 1024;
let busy = false;
let accountCount = 0;

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
  els.exportBtn.disabled = value || accountCount === 0;
  els.importBtn.disabled = value;
}

function plural(count) {
  return count + (count === 1 ? " account" : " accounts");
}

async function loadInfo() {
  const response = await send({ type: "list" });
  if (!response.ok) {
    els.activeLine.textContent = "Saved accounts";
    setStatus(response.error, "error");
    return;
  }
  accountCount = response.accounts.length;
  const active = response.accounts.find((account) => account.id === response.activeId);
  els.activeLine.textContent = accountCount
    ? plural(accountCount) + " saved" + (active ? " · active: " + active.name : "")
    : "No accounts saved yet";
  els.exportBtn.disabled = busy || accountCount === 0;
  els.exportBtn.textContent = accountCount ? "Export " + plural(accountCount) : "Nothing to export";
}

function download(backup) {
  const text = JSON.stringify(backup, null, 2);
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "chatgpt-accounts-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return backup.accounts.length;
}

els.exportBtn.addEventListener("click", async () => {
  if (busy || !accountCount) return;
  const ok = window.confirm(
    "This backup will contain live login cookies for " + plural(accountCount) +
    ". Anyone with the file can sign in as these accounts until the cookies expire.\n\n" +
    "Keep the file private. Continue?"
  );
  if (!ok) return;

  setBusy(true);
  setStatus("Preparing backup…");
  const response = await send({ type: "export" });
  if (!response.ok) {
    setBusy(false);
    setStatus(response.error, "error");
    return;
  }
  try {
    const count = download(response.data);
    setStatus(
      "Exported " + plural(count) + ". Keep the file private; it contains login cookies.",
      "success"
    );
  } catch (err) {
    setStatus("Could not save the file: " + (err && err.message ? err.message : err), "error");
  }
  setBusy(false);
});

els.importBtn.addEventListener("click", () => {
  if (busy) return;
  els.importFile.value = "";
  els.importFile.click();
});

els.importFile.addEventListener("change", async () => {
  const file = els.importFile.files && els.importFile.files[0];
  if (!file || busy) return;

  if (file.size > MAX_FILE_BYTES) {
    setStatus("That file is too large to be an account backup.", "error");
    els.importFile.value = "";
    return;
  }

  setBusy(true);
  setStatus("Reading " + file.name + "…");

  let data;
  try {
    const text = (await file.text()).replace(/^\uFEFF/, "");
    data = JSON.parse(text);
  } catch (err) {
    setBusy(false);
    setStatus("That file is not valid JSON.", "error");
    els.importFile.value = "";
    return;
  }

  const count = data && Array.isArray(data.accounts) ? data.accounts.length : 0;
  if (count) {
    const ok = window.confirm(
      "Import " + plural(count) + "?\n\n" +
      "Accounts with the same id will be replaced. Your current browser login is not changed."
    );
    if (!ok) {
      setBusy(false);
      setStatus("Import cancelled.");
      els.importFile.value = "";
      return;
    }
  }

  const response = await send({ type: "import", data });
  setBusy(false);
  els.importFile.value = "";

  if (!response.ok) {
    setStatus(response.error, "error");
    return;
  }

  const parts = ["Imported " + plural(response.imported) + "."];
  if (response.replaced) parts.push(plural(response.replaced) + " updated.");
  if (response.skipped) parts.push(plural(response.skipped) + " skipped as invalid.");
  setStatus(parts.join(" "), response.imported ? "success" : "error");

  await loadInfo();
});

loadInfo();
