"use strict";

/**
 * Integration tests for background.js: message routing, sender validation,
 * tab reloads, notices and badge updates, driven against an in-memory mock of
 * the Firefox extension APIs.
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const ROOT = path.join(__dirname, "..", "extension");
const EXT_ID = "chatgpt-account-switcher@tje3d.github.io";

function inDomain(host, domain) {
  return host === domain || host.endsWith("." + domain);
}

function makeCookies(initial) {
  let jar = initial.map((c) => ({ ...c }));
  return {
    jar: () => jar.map((c) => ({ ...c })),
    names: () => jar.map((c) => c.name).sort(),
    find: (name) => jar.find((c) => c.name === name),
    async getAll({ domain, storeId } = {}) {
      return jar
        .filter((c) => !domain || inDomain(c.domain.replace(/^\./, ""), domain))
        .filter((c) => !storeId || c.storeId === storeId)
        .map((c) => ({ ...c }));
    },
    async set(details) {
      const url = new URL(details.url);
      const cookie = {
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
        cookie.expirationDate = details.expirationDate;
      }
      const key = JSON.stringify([cookie.domain, cookie.path, cookie.name]);
      jar = jar.filter((c) => JSON.stringify([c.domain, c.path, c.name]) !== key);
      jar.push(cookie);
      return { ...cookie };
    },
    async remove({ url, name }) {
      const host = new URL(url).hostname;
      const before = jar.length;
      jar = jar.filter(
        (c) => !(c.name === name && c.domain.replace(/^\./, "") === host)
      );
      if (jar.length === before) throw new Error("cookie not found");
      return { name };
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

function makeHarness(initialCookies = A_COOKIES) {
  const storageData = {};
  const reloaded = [];
  const created = [];
  const badges = [];
  let tabs = [{ id: 7, url: "https://chatgpt.com/" }];
  let listener = null;

  const storage = {
    async get(key) {
      return key in storageData ? { [key]: storageData[key] } : {};
    },
    async set(patch) {
      Object.assign(storageData, patch);
    }
  };

  const cookies = makeCookies(initialCookies.map((c) => ({ ...c })));

  const browser = {
    storage: { local: storage },
    cookies,
    tabs: {
      async query() {
        return tabs.map((tab) => ({ ...tab }));
      },
      async reload(id) {
        reloaded.push(id);
      },
      async create(details) {
        created.push(details.url);
        return { id: 99, url: details.url };
      }
    },
    action: {
      async setBadgeText(details) {
        badges.push(details);
      },
      async setBadgeBackgroundColor() {}
    },
    runtime: {
      id: EXT_ID,
      onMessage: {
        addListener(fn) {
          listener = fn;
        }
      },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} }
    }
  };

  const sandbox = {
    browser,
    fetch: async () => ({ ok: false, status: 403 }),
    AbortSignal,
    console
  };
  vm.createContext(sandbox);
  for (const file of ["lib/core.js", "background.js"]) {
    const full = path.join(ROOT, file);
    vm.runInContext(fs.readFileSync(full, "utf8"), sandbox, { filename: full });
  }

  const send = (message, sender = { id: EXT_ID }) => listener(message, sender);
  return {
    storageData,
    reloaded,
    created,
    badges,
    cookies,
    send,
    core: sandbox.ChatGPTAccounts,
    setTabs: (value) => {
      tabs = value;
    }
  };
}

test("background refuses messages from other extensions", async () => {
  const harness = makeHarness();
  const response = await harness.send({ type: "list" }, { id: "evil@example.com" });
  assert.equal(response.ok, false);
  assert.match(response.error, /untrusted/i);
});

test("save, list and switch work through the message router", async () => {
  const harness = makeHarness();
  const saved = await harness.send({ type: "save", name: "A", email: "a@example.com" });
  assert.equal(saved.ok, true);
  assert.equal(saved.account.name, "A");
  assert.equal(harness.badges.at(-1).text, "A");

  // Log into B, then save it.
  const cookieApi = { cookies: harness.cookies };
  await harness.core.clearAll(cookieApi);
  await harness.core.restoreAll(cookieApi, B_COOKIES.map((c) => ({ ...c })));
  await harness.send({ type: "sessionInfo", email: "b@example.com" });
  const b = await harness.send({ type: "save", name: "B" });
  assert.equal(b.ok, true);
  assert.equal(b.account.email, "b@example.com");

  const list = await harness.send({ type: "list" });
  assert.equal(list.ok, true);
  assert.equal(list.accounts.length, 2);
  assert.equal(list.lastSeenEmail, "b@example.com");
  assert.equal(list.activeId, b.account.id);
  assert.ok(list.accounts.every((account) => account.lastUsedAt));

  const switched = await harness.send({ type: "switch", id: saved.account.id });
  assert.equal(switched.ok, true);
  assert.equal(switched.restored, A_COOKIES.length);
  assert.equal(harness.cookies.find("__Secure-next-auth.session-token").value, "AAA");
  assert.deepEqual(harness.reloaded, [7]);
  assert.equal(harness.storageData.notice.text, "Switched to A");

  const notice = await harness.send({ type: "consumeNotice" });
  assert.equal(notice.text, "Switched to A");
  assert.equal((await harness.send({ type: "consumeNotice" })).text, null);

  const after = await harness.send({ type: "list" });
  assert.equal(after.activeId, saved.account.id);
});

test("switching with no ChatGPT tab open creates one", async () => {
  const harness = makeHarness();
  const saved = await harness.send({ type: "save", name: "A" });
  harness.setTabs([]);
  const switched = await harness.send({ type: "switch", id: saved.account.id });
  assert.equal(switched.ok, true);
  assert.deepEqual(harness.created, ["https://chatgpt.com/"]);
  assert.deepEqual(harness.reloaded, []);
});

test("switching updates the cached email so the popup shows no false mismatch", async () => {
  const harness = makeHarness();
  const a = await harness.send({ type: "save", name: "A", email: "a@example.com" });

  // Manually sign in as B and save it, making B the active live session.
  const cookieApi = { cookies: harness.cookies };
  await harness.core.clearAll(cookieApi);
  await harness.core.restoreAll(cookieApi, B_COOKIES.map((c) => ({ ...c })));
  await harness.send({ type: "sessionInfo", email: "b@example.com" });
  const b = await harness.send({ type: "save", name: "B" });
  assert.equal(harness.storageData.lastSeenEmail, "b@example.com");

  const switched = await harness.send({ type: "switch", id: a.account.id });
  assert.equal(switched.ok, true);
  assert.equal(harness.storageData.lastSeenEmail, "a@example.com");

  const list = await harness.send({ type: "list" });
  assert.equal(list.activeId, a.account.id);
  assert.equal(list.lastSeenEmail, list.accounts.find((x) => x.id === a.account.id).email);
  assert.notEqual(b.account.id, list.activeId);
});

test("export and import work through the message router", async () => {
  const source = makeHarness();
  const saved = await source.send({ type: "save", name: "A", email: "a@example.com" });
  const exported = await source.send({ type: "export" });
  assert.equal(exported.ok, true);
  assert.equal(exported.data.format, "chatgpt-account-switcher");
  assert.equal(exported.data.accounts.length, 1);
  assert.equal(exported.data.accounts[0].cookies.length, A_COOKIES.length);

  const target = makeHarness([]);
  const imported = await target.send({ type: "import", data: exported.data });
  assert.equal(imported.ok, true);
  assert.equal(imported.added, 1);
  assert.equal(imported.skipped, 0);

  const list = await target.send({ type: "list" });
  assert.equal(list.accounts.length, 1);
  assert.equal(list.accounts[0].id, saved.account.id);
  assert.equal(list.accounts[0].email, "a@example.com");

  const switched = await target.send({ type: "switch", id: saved.account.id });
  assert.equal(switched.ok, true);
  assert.equal(target.cookies.find("__Secure-next-auth.session-token").value, "AAA");

  const bad = await target.send({ type: "import", data: { format: "nope" } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /export file/i);
});

test("unknown messages and bad input return errors instead of throwing", async () => {
  const harness = makeHarness();
  const unknown = await harness.send({ type: "nope" });
  assert.equal(unknown.ok, false);
  const badName = await harness.send({ type: "save", name: "   " });
  assert.equal(badName.ok, false);
  assert.match(badName.error, /name/i);
});

test("signOut clears the live jar and resets the active account", async () => {
  const harness = makeHarness();
  await harness.send({ type: "save", name: "A", email: "a@example.com" });

  const response = await harness.send({ type: "signOut" });
  assert.equal(response.ok, true);
  assert.equal(harness.cookies.jar().length, 0);
  assert.equal(harness.storageData.lastSeenEmail, null);
  assert.equal((await harness.send({ type: "list" })).activeId, null);
  assert.deepEqual(harness.reloaded, [7]);
  assert.match(harness.storageData.notice.text, /logged out/i);
});

test("signOut through the router refuses to discard an unsaved session", async () => {
  const harness = makeHarness();
  const response = await harness.send({ type: "signOut" });
  assert.equal(response.ok, false);
  assert.match(response.error, /save/i);
  assert.equal(harness.cookies.jar().length, A_COOKIES.length);
});

test("switching after logout ignores anonymous page cookies", async () => {
  const harness = makeHarness();
  const saved = await harness.send({ type: "save", name: "A", email: "a@example.com" });
  await harness.send({ type: "signOut" });

  // The reloaded login page sets a Cloudflare bot cookie but no session token.
  await harness.cookies.set({
    name: "__cf_bm",
    value: "bot-check",
    url: "https://chatgpt.com/",
    domain: "chatgpt.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "none"
  });

  const switched = await harness.send({ type: "switch", id: saved.account.id });
  assert.equal(switched.ok, true);
  assert.equal(harness.cookies.find("__Secure-next-auth.session-token").value, "AAA");
  assert.equal((await harness.send({ type: "list" })).activeId, saved.account.id);
});

test("probeSession reports a login failure without throwing", async () => {
  const harness = makeHarness();
  const response = await harness.send({ type: "probeSession" });
  assert.equal(response.ok, false);
  assert.match(response.error, /403/);
});
