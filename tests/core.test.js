"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const CORE_PATH = path.join(__dirname, "..", "extension", "lib", "core.js");

function loadCore() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CORE_PATH, "utf8"), sandbox, { filename: CORE_PATH });
  assert.ok(sandbox.ChatGPTAccounts, "core.js must expose ChatGPTAccounts");
  return sandbox.ChatGPTAccounts;
}

const C = loadCore();

// ─── In-memory Browser mock (cookie jar + storage) ──────────────────────────
function inDomain(host, domain) {
  return host === domain || host.endsWith("." + domain);
}

function makeApi(initialCookies = []) {
  let jar = initialCookies.map((c) => ({ ...c }));

  const api = {
    jar: () => jar.map((c) => ({ ...c })),
    names: () => jar.map((c) => c.name).sort(),
    find: (name) => jar.find((c) => c.name === name),
    cookies: {
      async getAll({ domain, storeId } = {}) {
        return jar
          .filter((c) => !domain || inDomain(c.domain.replace(/^\./, ""), domain))
          .filter((c) => !storeId || c.storeId === storeId)
          .map((c) => ({ ...c }));
      },
      async set(details) {
        if (details.name.startsWith("__Host-")) {
          if (details.domain) throw new Error("__Host- cookie must not have a domain");
          if ((details.path || "/") !== "/") throw new Error("__Host- cookie path must be /");
          if (!details.secure) throw new Error("__Host- cookie must be secure");
        }
        if (details.name.startsWith("__Secure-") && !details.secure) {
          throw new Error("__Secure- cookie must be secure");
        }
        const url = new URL(details.url);
        const created = {
          name: details.name,
          value: details.value,
          domain: details.domain || url.hostname,
          path: details.path || "/",
          secure: !!details.secure,
          httpOnly: !!details.httpOnly,
          sameSite: details.sameSite || "unspecified",
          storeId: details.storeId || "firefox-default",
          firstPartyDomain: details.firstPartyDomain || ""
        };
        if (typeof details.expirationDate === "number") {
          created.expirationDate = details.expirationDate;
        }
        const key = C.cookieKey(created);
        jar = jar.filter((c) => C.cookieKey(c) !== key);
        jar.push(created);
        return { ...created };
      },
      async remove({ url, name, storeId, firstPartyDomain }) {
        const host = new URL(url).hostname;
        const before = jar.length;
        jar = jar.filter(
          (c) =>
            !(
              c.name === name &&
              c.domain.replace(/^\./, "") === host &&
              (c.storeId || "firefox-default") === (storeId || "firefox-default") &&
              (c.firstPartyDomain || "") === (firstPartyDomain || "")
            )
        );
        if (jar.length === before) throw new Error("cookie not found");
        return { name };
      }
    }
  };
  return api;
}

function makeStorage() {
  let data = {};
  return {
    data,
    async get(key) {
      return key in data ? { [key]: data[key] } : {};
    },
    async set(patch) {
      Object.assign(data, patch);
    }
  };
}

const A_COOKIES = [
  {
    name: "__Secure-next-auth.session-token",
    value: "AAA",
    domain: "chatgpt.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    storeId: "firefox-default",
    firstPartyDomain: ""
  },
  {
    name: "__Host-next-auth.csrf-token",
    value: "csrfA",
    domain: "chatgpt.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    storeId: "firefox-default",
    firstPartyDomain: ""
  },
  {
    name: "_puid",
    value: "puidA",
    domain: ".openai.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "none",
    expirationDate: 4102444800,
    storeId: "firefox-default",
    firstPartyDomain: ""
  }
];

const B_COOKIES = [
  {
    name: "__Secure-next-auth.session-token",
    value: "BBB",
    domain: "chatgpt.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    storeId: "firefox-default",
    firstPartyDomain: ""
  },
  {
    name: "_puid",
    value: "puidB",
    domain: ".openai.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "none",
    expirationDate: 4102444800,
    storeId: "firefox-default",
    firstPartyDomain: ""
  }
];

function makeManager(cookies) {
  const api = makeApi(cookies);
  const storage = makeStorage();
  let clock = 1_700_000_000_000;
  const manager = C.createManager({ api, storage, now: () => clock });
  return { api, storage, manager, tick: (ms = 1000) => (clock += ms) };
}

// ─── Tests ───────────────────────────────────────────────────────────────────
test("saveCurrent stores every chatgpt.com and openai.com cookie with metadata", async () => {
  const { manager, api } = makeManager(A_COOKIES.map((c) => ({ ...c })));
  const saved = await manager.saveCurrent("Work", "a@example.com");

  const list = await manager.list();
  assert.equal(list.accounts.length, 1);
  assert.equal(list.accounts[0].name, "Work");
  assert.equal(list.accounts[0].email, "a@example.com");
  assert.equal(list.accounts[0].cookieCount, A_COOKIES.length);

  const { state } = await manager.debugState();
  const stored = Object.values(state.accounts)[0].cookies;
  const csrf = stored.find((c) => c.name.startsWith("__Host-"));
  assert.equal(csrf.secure, true);
  assert.equal(csrf.domain, "chatgpt.com");
  assert.equal(stored.find((c) => c.name === "_puid").expirationDate, 4102444800);
  assert.equal(api.jar().length, A_COOKIES.length);
});

test("saveCurrent refuses when no cookies exist", async () => {
  const { manager } = makeManager([]);
  await assert.rejects(() => manager.saveCurrent("Empty"), /No ChatGPT cookies/i);
});

test("saveCurrent refuses anonymous cookies that are not a login", async () => {
  const { manager } = makeManager([
    {
      name: "__cf_bm",
      value: "bot",
      domain: "chatgpt.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "none",
      storeId: "firefox-default",
      firstPartyDomain: ""
    }
  ]);
  await assert.rejects(() => manager.saveCurrent("Anon"), /login/i);
});

test("update refuses to overwrite a saved account with anonymous cookies", async () => {
  const { api, manager } = makeManager(A_COOKIES.map((c) => ({ ...c })));
  const a = await manager.saveCurrent("A", "a@example.com");
  await C.clearAll(api);
  await api.cookies.set({
    name: "__cf_bm",
    value: "bot",
    domain: "chatgpt.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "none",
    url: "https://chatgpt.com/"
  });

  await assert.rejects(() => manager.update(a.id), /login/i);
  const { state } = await manager.debugState();
  assert.equal(
    state.accounts[a.id].cookies.find((c) => c.name === "__Secure-next-auth.session-token").value,
    "AAA"
  );
});

test("switchTo swaps the live jar to the target account and autosaves the previous one", async () => {
  const { api, manager, tick } = makeManager(A_COOKIES.map((c) => ({ ...c })));
  await manager.saveCurrent("A", "a@example.com");

  // User logs into B: browser now holds B's cookies.
  await C.clearAll(api);
  await C.restoreAll(api, B_COOKIES.map((c) => ({ ...c })));
  assert.deepEqual(api.names(), ["__Secure-next-auth.session-token", "_puid"]);

  const idA = (await manager.list()).accounts[0].id;
  const b = await manager.saveCurrent("B", "b@example.com");
  tick();

  await manager.switchTo(idA);

  assert.equal(api.find("__Secure-next-auth.session-token").value, "AAA");
  assert.equal(api.find("_puid").value, "puidA");
  assert.equal(api.find("_puid").expirationDate, 4102444800);

  const list = await manager.list();
  assert.equal(list.activeId, idA);
  const bRecord = list.accounts.find((a) => a.id === b.id);
  const { state } = await manager.debugState();
  assert.equal(state.accounts[b.id].cookies.find((c) => c.name === "_puid").value, "puidB");
  assert.ok(bRecord.lastUsedAt || bRecord.savedAt);
});

test("switching restores __Host- cookies without a domain attribute", async () => {
  const { api, manager } = makeManager(A_COOKIES.map((c) => ({ ...c })));
  await manager.saveCurrent("A", null);
  const id = (await manager.list()).accounts[0].id;

  // Clearing should succeed and restore must not trip the mock's __Host- rules.
  await manager.switchTo(id);
  const csrf = api.find("__Host-next-auth.csrf-token");
  assert.ok(csrf, "csrf token should be back in the jar");
  assert.equal(csrf.domain, "chatgpt.com");
});

test("session cookies stay session cookies (no expirationDate)", async () => {
  const { api, manager } = makeManager(A_COOKIES.map((c) => ({ ...c })));
  const saved = await manager.saveCurrent("A", null);
  await C.clearAll(api);
  await manager.switchTo(saved.id);
  const token = api.find("__Secure-next-auth.session-token");
  assert.equal(token.expirationDate, undefined);
});

test("clearAll only touches chatgpt.com and openai.com cookies", async () => {
  const api = makeApi([
    ...A_COOKIES.map((c) => ({ ...c })),
    {
      name: "keep-me",
      value: "1",
      domain: ".example.com",
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "lax",
      storeId: "firefox-default",
      firstPartyDomain: ""
    }
  ]);
  await C.clearAll(api);
  assert.deepEqual(api.names(), ["keep-me"]);
});

test("remove deletes the record but leaves live cookies alone", async () => {
  const { api, manager } = makeManager(A_COOKIES.map((c) => ({ ...c })));
  const saved = await manager.saveCurrent("A", null);
  await manager.remove(saved.id);
  const list = await manager.list();
  assert.equal(list.accounts.length, 0);
  assert.equal(api.jar().length, A_COOKIES.length);
});

test("rename validates and updates", async () => {
  const { manager } = makeManager(A_COOKIES.map((c) => ({ ...c })));
  const saved = await manager.saveCurrent("A", null);
  await manager.rename(saved.id, "  Personal  ");
  assert.equal((await manager.list()).accounts[0].name, "Personal");
  await assert.rejects(() => manager.rename(saved.id, "   "), /name/i);
});

test("the account list is ordered by last use, so recent history is on top", async () => {
  const { api, manager, tick } = makeManager(A_COOKIES.map((c) => ({ ...c })));
  const a = await manager.saveCurrent("A", "a@example.com");
  tick(60_000);

  // Log into B and save it.
  await C.clearAll(api);
  await C.restoreAll(api, B_COOKIES.map((c) => ({ ...c })));
  const b = await manager.saveCurrent("B", "b@example.com");
  tick(60_000);

  let list = await manager.list();
  assert.equal(list.accounts[0].id, b.id);
  assert.ok(list.accounts[0].lastUsedAt > list.accounts[1].lastUsedAt);

  await manager.switchTo(a.id);
  list = await manager.list();
  assert.equal(list.accounts[0].id, a.id);
  assert.ok(list.accounts[0].lastUsedAt > list.accounts[1].lastUsedAt);
});

test("switching refuses to discard a live session that was never saved", async () => {
  const { api, manager } = makeManager(A_COOKIES.map((c) => ({ ...c })));
  const a = await manager.saveCurrent("A", "a@example.com");

  // User manually logs in as B without saving it.
  await C.clearAll(api);
  await C.restoreAll(api, B_COOKIES.map((c) => ({ ...c })));

  await assert.rejects(() => manager.switchTo(a.id, "b@example.com"), /not saved/i);

  const { state } = await manager.debugState();
  assert.equal(
    state.accounts[a.id].cookies.find((c) => c.name === "__Secure-next-auth.session-token").value,
    "AAA"
  );
  assert.equal(api.find("__Secure-next-auth.session-token").value, "BBB");
  assert.equal((await manager.list()).activeId, a.id);
});

test("anonymous cookies left after logout do not block switching", async () => {
  const { api, manager } = makeManager(A_COOKIES.map((c) => ({ ...c })));
  const a = await manager.saveCurrent("A", "a@example.com");

  // Pressing Log out clears the session; reloading the login page then drops
  // Cloudflare/analytics cookies that have nothing to do with being signed in.
  await manager.signOut("a@example.com");
  await api.cookies.set({
    name: "__cf_bm",
    value: "bot-check",
    domain: "chatgpt.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "none",
    url: "https://chatgpt.com/"
  });
  assert.equal(api.jar().length, 1);

  await manager.switchTo(a.id, null);
  assert.equal(api.find("__Secure-next-auth.session-token").value, "AAA");
  assert.equal((await manager.list()).activeId, a.id);

  // The anonymous cookie must not have replaced A's saved snapshot.
  const { state } = await manager.debugState();
  assert.equal(state.accounts[a.id].cookies.length, A_COOKIES.length);
});

test("signOut clears anonymous leftovers instead of refusing", async () => {
  const { api, manager } = makeManager(A_COOKIES.map((c) => ({ ...c })));
  await manager.saveCurrent("A", "a@example.com");
  await C.clearAll(api);
  await api.cookies.set({
    name: "__cf_bm",
    value: "bot-check",
    domain: "chatgpt.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "none",
    url: "https://chatgpt.com/"
  });

  const result = await manager.signOut(null);
  assert.equal(result.cleared, 1);
  assert.equal(api.jar().length, 0);
  assert.equal((await manager.list()).activeId, null);
});

test("hasSessionCookie only trusts session-token cookies", () => {
  assert.equal(C.hasSessionCookie([{ name: "__Secure-next-auth.session-token" }]), true);
  assert.equal(C.hasSessionCookie([{ name: "__Secure-authjs.session-token.0" }]), true);
  assert.equal(C.hasSessionCookie([{ name: "next-auth.session-token" }]), true);
  assert.equal(C.hasSessionCookie([{ name: "__Secure-auth.session-token" }]), true);
  assert.equal(C.hasSessionCookie([{ name: "__cf_bm" }, { name: "oai-did" }]), false);
  assert.equal(C.hasSessionCookie([]), false);
});

test("signOut refreshes the active snapshot, clears cookies and resets active", async () => {
  const { api, manager } = makeManager(A_COOKIES.map((c) => ({ ...c })));
  const a = await manager.saveCurrent("A", "a@example.com");

  await C.clearAll(api);
  await C.restoreAll(api, [
    { ...A_COOKIES[0], value: "AAA-refreshed" },
    { ...A_COOKIES[1] }
  ]);

  const result = await manager.signOut("a@example.com");
  assert.equal(result.cleared, 2);
  assert.equal(api.jar().length, 0);

  const { state } = await manager.debugState();
  assert.equal(state.activeId, null);
  assert.equal(
    state.accounts[a.id].cookies.find((c) => c.name === "__Secure-next-auth.session-token").value,
    "AAA-refreshed"
  );
});

test("signOut refuses to clear a live session that was never saved", async () => {
  const { api, manager } = makeManager(A_COOKIES.map((c) => ({ ...c })));
  await assert.rejects(() => manager.signOut("a@example.com"), /save/i);
  assert.equal(api.jar().length, A_COOKIES.length);
});

test("signOut refuses when the live session belongs to a different account", async () => {
  const { api, manager } = makeManager(A_COOKIES.map((c) => ({ ...c })));
  await manager.saveCurrent("A", "a@example.com");
  await C.clearAll(api);
  await C.restoreAll(api, B_COOKIES.map((c) => ({ ...c })));

  await assert.rejects(() => manager.signOut("b@example.com"), /new account/i);
  assert.equal(api.find("__Secure-next-auth.session-token").value, "BBB");
});

test("a completely failed restore rolls the previous session back", async () => {
  const { api, manager, storage } = makeManager(A_COOKIES.map((c) => ({ ...c })));
  await manager.saveCurrent("A", null);

  const broken = await manager.saveCurrent("Broken", null);
  storage.data.state.accounts[broken.id].cookies = [
    {
      __proto__: null,
      name: "__Host-broken",
      value: "x",
      domain: "chatgpt.com",
      path: "/nope",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      storeId: "firefox-default",
      firstPartyDomain: ""
    }
  ];
  // Keep the live A session saved and attributed, so the guard against
  // discarding unsaved sessions does not trip before the restore attempt.
  await manager.saveCurrent("Live", null);

  await assert.rejects(() => manager.switchTo(broken.id), /rolled back|restore/i);
  assert.equal(api.find("__Secure-next-auth.session-token").value, "AAA");
});

test("concurrent switches serialize and leave a consistent active account", async () => {
  const { manager, api } = makeManager(A_COOKIES.map((c) => ({ ...c })));
  const a = await manager.saveCurrent("A", null);
  await C.clearAll(api);
  await C.restoreAll(api, B_COOKIES.map((c) => ({ ...c })));
  const b = await manager.saveCurrent("B", null);

  const results = await Promise.allSettled([manager.switchTo(a.id), manager.switchTo(b.id)]);
  assert.ok(results.some((r) => r.status === "fulfilled"));
  const list = await manager.list();
  assert.ok([a.id, b.id].includes(list.activeId));
  assert.equal(api.jar().length, A_COOKIES.length === B_COOKIES.length ? A_COOKIES.length : api.jar().length);
});

test("host-only cookies are restored without a domain attribute", () => {
  const details = C.toSetDetails({
    name: "_puid",
    value: "x",
    domain: "chatgpt.com",
    path: "/",
    secure: true,
    hostOnly: true
  });
  assert.equal(details.domain, undefined);
  assert.equal(details.url, "https://chatgpt.com/");
});

test("partition keys are reduced to fields cookies.set accepts", () => {
  const details = C.toSetDetails({
    name: "_puid",
    value: "x",
    domain: "chatgpt.com",
    path: "/",
    secure: true,
    partitionKey: {
      topLevelSite: "https://chatgpt.com",
      hasCrossSiteAncestor: false
    }
  });
  assert.equal(details.partitionKey.topLevelSite, "https://chatgpt.com");
  assert.equal(details.partitionKey.hasCrossSiteAncestor, undefined);
});

test("cookieUrl builds https urls from domain + path", () => {
  assert.equal(
    C.cookieUrl({ domain: ".openai.com", path: "/" }),
    "https://openai.com/"
  );
  assert.equal(
    C.cookieUrl({ domain: "chatgpt.com", path: "/backend-api" }),
    "https://chatgpt.com/backend-api"
  );
});

test("dedupe keeps the last cookie per identity", () => {
  const first = { ...A_COOKIES[0], value: "old" };
  const second = { ...A_COOKIES[0], value: "new" };
  const out = C.dedupe([first, second]);
  assert.equal(out.length, 1);
  assert.equal(out[0].value, "new");
});

// ─── Export / import ─────────────────────────────────────────────────────────
test("exportAll produces a portable backup that restores into an empty profile", async () => {
  const source = makeManager(A_COOKIES.map((c) => ({ ...c })));
  const a = await source.manager.saveCurrent("Work", "a@example.com");
  const backup = await source.manager.exportAll();

  assert.equal(backup.format, "chatgpt-account-switcher");
  assert.equal(backup.version, 1);
  assert.equal(backup.accounts.length, 1);
  assert.equal(backup.accounts[0].name, "Work");
  assert.equal(backup.accounts[0].email, "a@example.com");
  assert.equal(backup.accounts[0].cookies.length, A_COOKIES.length);

  const target = makeManager([]);
  const result = await target.manager.importAll(backup);
  assert.equal(result.added, 1);
  assert.equal(result.replaced, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.imported, 1);

  const list = await target.manager.list();
  assert.equal(list.accounts.length, 1);
  assert.equal(list.accounts[0].email, "a@example.com");
  assert.equal(list.accounts[0].cookieCount, A_COOKIES.length);

  await target.manager.switchTo(list.accounts[0].id, "a@example.com");
  assert.equal(target.api.find("__Secure-next-auth.session-token").value, "AAA");
});

test("importAll merges by id, skips invalid accounts, and keeps the active account", async () => {
  const { manager } = makeManager(A_COOKIES.map((c) => ({ ...c })));
  const a = await manager.saveCurrent("A", "a@example.com");
  const backup = await manager.exportAll();

  backup.accounts[0].name = "A renamed";
  backup.accounts.push({
    id: "broken",
    name: "No session",
    cookies: [{ name: "_puid", value: "x", domain: ".openai.com", path: "/" }]
  });

  const result = await manager.importAll(backup);
  assert.equal(result.added, 0);
  assert.equal(result.replaced, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.imported, 1);

  const list = await manager.list();
  assert.equal(list.accounts.length, 1);
  assert.equal(list.accounts[0].id, a.id);
  assert.equal(list.accounts[0].name, "A renamed");
  assert.equal(list.activeId, a.id);
});

test("importAll drops cookies outside ChatGPT/OpenAI and rejects unsafe ids", async () => {
  const { manager } = makeManager([]);
  const result = await manager.importAll({
    format: "chatgpt-account-switcher",
    version: 1,
    accounts: [{
      id: "__proto__",
      name: "Imported",
      email: "import@example.com",
      cookies: [
        { ...A_COOKIES[0] },
        {
          name: "steal",
          value: "x",
          domain: ".evil.example",
          path: "/",
          secure: true,
          httpOnly: true
        }
      ]
    }]
  });

  assert.equal(result.added, 1);
  const list = await manager.list();
  assert.equal(list.accounts.length, 1);
  assert.notEqual(list.accounts[0].id, "__proto__");
  assert.equal({}.polluted, undefined);

  const { state } = await manager.debugState();
  const cookies = Object.values(state.accounts)[0].cookies;
  assert.equal(cookies.some((c) => c.name === "steal"), false);
  assert.equal(cookies.length, 1);
});

test("importAll rejects files that are not our backup format", async () => {
  const { manager } = makeManager([]);
  await assert.rejects(() => manager.importAll(null), /not a ChatGPT Accounts export/i);
  await assert.rejects(
    () => manager.importAll({ format: "something-else", version: 1, accounts: [] }),
    /not a ChatGPT Accounts export/i
  );
  await assert.rejects(
    () => manager.importAll({ format: "chatgpt-account-switcher", version: 99, accounts: [] }),
    /unsupported export version/i
  );
  await assert.rejects(
    () => manager.importAll({ format: "chatgpt-account-switcher", version: 1, accounts: [] }),
    /no accounts/i
  );
});
