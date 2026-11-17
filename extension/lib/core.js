/**
 * core.js — cookie snapshot engine for ChatGPT Account Switcher.
 *
 * Loaded as a classic script before background.js. Also loaded by the Node
 * test suite through `vm`, so it must not touch DOM or extension globals.
 *
 * Design rules:
 *  - Every read/write of the account state goes through createManager(), which
 *    serializes operations behind a single promise queue. One writer.
 *  - Cookie objects are copied verbatim so restore is lossless.
 *  - Only the default cookie store is touched, so container tabs stay intact.
 */
(function (root) {
  "use strict";

  var DOMAINS = ["chatgpt.com", "openai.com"];
  var DEFAULT_STORE = "firefox-default";
  var HOST_PREFIX = "__Host-";
  var MAX_NAME = 64;
  var EXPORT_FORMAT = "chatgpt-account-switcher";
  var EXPORT_VERSION = 1;
  var MAX_IMPORT_ACCOUNTS = 200;
  var MAX_IMPORT_COOKIES = 300;
  var MAX_COOKIE_NAME = 256;
  var MAX_COOKIE_VALUE = 65536;
  var IMPORT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
  var SAME_SITE = ["no_restriction", "lax", "strict", "unspecified"];

  // ─── Cookie helpers ───────────────────────────────────────────────────────

  function keyPart(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  function cookieKey(cookie) {
    var partition = cookie.partitionKey ? JSON.stringify(cookie.partitionKey) : "";
    return [
      keyPart(cookie.storeId) || DEFAULT_STORE,
      keyPart(cookie.domain),
      keyPart(cookie.path),
      keyPart(cookie.name),
      keyPart(cookie.firstPartyDomain),
      partition
    ].join("|");
  }

  function dedupe(cookies) {
    var byKey = new Map();
    for (var i = 0; i < cookies.length; i++) {
      byKey.set(cookieKey(cookies[i]), cookies[i]);
    }
    return Array.from(byKey.values());
  }

  function cookieUrl(cookie) {
    var host = String(cookie.domain || "").replace(/^\./, "");
    var path = cookie.path || "/";
    return "https://" + host + path;
  }

  /**
   * Convert a stored cookie back into the details object accepted by
   * browser.cookies.set(). __Host- cookies must not carry a domain attribute,
   * host-only cookies must not either, and session cookies must not carry an
   * expirationDate. Partition keys are reduced to the fields cookies.set
   * accepts (getAll can include extra bookkeeping fields).
   */
  function toSetDetails(cookie) {
    var details = {
      url: cookieUrl(cookie),
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || "/",
      secure: !!cookie.secure,
      httpOnly: !!cookie.httpOnly,
      sameSite: cookie.sameSite || "unspecified",
      storeId: cookie.storeId || DEFAULT_STORE
    };

    if (cookie.name.indexOf(HOST_PREFIX) !== 0 && cookie.hostOnly !== true) {
      details.domain = cookie.domain;
    }
    if (typeof cookie.expirationDate === "number") {
      details.expirationDate = cookie.expirationDate;
    }
    if (cookie.firstPartyDomain) {
      details.firstPartyDomain = cookie.firstPartyDomain;
    }
    if (cookie.partitionKey && cookie.partitionKey.topLevelSite) {
      var partitionKey = { topLevelSite: cookie.partitionKey.topLevelSite };
      if (cookie.partitionKey.firstPartyDomain) {
        partitionKey.firstPartyDomain = cookie.partitionKey.firstPartyDomain;
      }
      details.partitionKey = partitionKey;
    }
    return details;
  }

  // ─── Browser primitives ───────────────────────────────────────────────────

  async function snapshot(api) {
    var all = [];
    for (var i = 0; i < DOMAINS.length; i++) {
      var list = await api.cookies.getAll({ domain: DOMAINS[i], storeId: DEFAULT_STORE });
      all = all.concat(list);
    }
    return dedupe(all);
  }

  async function clearAll(api) {
    var removed = 0;
    for (var i = 0; i < DOMAINS.length; i++) {
      var list = await api.cookies.getAll({ domain: DOMAINS[i], storeId: DEFAULT_STORE });
      var unique = dedupe(list);
      for (var j = 0; j < unique.length; j++) {
        var cookie = unique[j];
        var details = {
          url: cookieUrl(cookie),
          name: cookie.name,
          storeId: cookie.storeId || DEFAULT_STORE
        };
        if (cookie.firstPartyDomain) details.firstPartyDomain = cookie.firstPartyDomain;
        if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
        try {
          await api.cookies.remove(details);
          removed++;
        } catch (err) {
          /* cookie vanished or is protected; keep going */
        }
      }
    }
    return removed;
  }

  async function restoreAll(api, cookies) {
    var ok = 0;
    var failed = [];
    var unique = dedupe(cookies || []);
    for (var i = 0; i < unique.length; i++) {
      try {
        await api.cookies.set(toSetDetails(unique[i]));
        ok++;
      } catch (err) {
        failed.push({ name: unique[i].name, error: String(err && err.message ? err.message : err) });
      }
    }
    return { ok: ok, failed: failed };
  }

  // ─── Validation ───────────────────────────────────────────────────────────

  function cleanName(value) {
    if (typeof value !== "string") return null;
    var name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME);
    return name.length ? name : null;
  }

  function cleanEmail(value) {
    if (typeof value !== "string") return null;
    var email = value.trim().slice(0, 254);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
  }

  // ChatGPT keeps its login in a next-auth / auth.js session cookie. Other
  // cookies (Cloudflare bot checks, analytics) survive logout and must not be
  // mistaken for a signed-in session.
  var SESSION_COOKIE = /session-token(?:\.\d+)?$/;

  function hasSessionCookie(cookies) {
    return (cookies || []).some(function (cookie) {
      return SESSION_COOKIE.test(cookie.name || "");
    });
  }

  function newId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "acc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function domainAllowed(domain) {
    var bare = String(domain || "").replace(/^\./, "").toLowerCase();
    return DOMAINS.some(function (allowed) {
      return bare === allowed || bare.slice(-(allowed.length + 1)) === "." + allowed;
    });
  }

  /**
   * Rebuild a cookie from imported JSON, keeping only fields cookies.set()
   * understands. Anything pointing outside chatgpt.com/openai.com is dropped so
   * a malicious import file cannot plant cookies on unrelated sites.
   */
  function sanitizeImportedCookie(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.name !== "string" || !raw.name || raw.name.length > MAX_COOKIE_NAME) return null;
    if (typeof raw.value !== "string" || raw.value.length > MAX_COOKIE_VALUE) return null;
    if (typeof raw.domain !== "string" || !domainAllowed(raw.domain)) return null;

    var cookie = {
      name: raw.name,
      value: raw.value,
      domain: raw.domain,
      path: typeof raw.path === "string" && raw.path.charAt(0) === "/" ? raw.path : "/",
      storeId: DEFAULT_STORE,
      secure: !!raw.secure,
      httpOnly: !!raw.httpOnly,
      hostOnly: !!raw.hostOnly,
      sameSite: SAME_SITE.indexOf(raw.sameSite) >= 0 ? raw.sameSite : "unspecified"
    };
    if (typeof raw.expirationDate === "number" && isFinite(raw.expirationDate) && raw.expirationDate > 0) {
      cookie.expirationDate = raw.expirationDate;
    }
    if (typeof raw.firstPartyDomain === "string") {
      cookie.firstPartyDomain = raw.firstPartyDomain;
    }
    if (raw.partitionKey && typeof raw.partitionKey === "object" &&
        typeof raw.partitionKey.topLevelSite === "string") {
      cookie.partitionKey = { topLevelSite: raw.partitionKey.topLevelSite };
      if (typeof raw.partitionKey.firstPartyDomain === "string") {
        cookie.partitionKey.firstPartyDomain = raw.partitionKey.firstPartyDomain;
      }
    }
    return cookie;
  }

  function timestampOr(value, fallback) {
    return typeof value === "number" && isFinite(value) && value > 0 ? value : fallback;
  }

  function sanitizeImportedAccount(raw, timestamp) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.cookies)) return null;
    if (raw.cookies.length > MAX_IMPORT_COOKIES) return null;

    var cookies = [];
    for (var i = 0; i < raw.cookies.length; i++) {
      var cookie = sanitizeImportedCookie(raw.cookies[i]);
      if (cookie) cookies.push(cookie);
    }
    cookies = dedupe(cookies);
    if (!cookies.length || !hasSessionCookie(cookies)) return null;

    var email = cleanEmail(raw.email);
    var name = cleanName(raw.name);
    if (!name) name = email ? email.split("@")[0] : "Imported account";

    return {
      name: name,
      email: email,
      cookies: cookies,
      createdAt: timestampOr(raw.createdAt, timestamp),
      savedAt: timestampOr(raw.savedAt, timestamp),
      lastUsedAt: timestampOr(raw.lastUsedAt, null)
    };
  }

  // ─── Account manager ──────────────────────────────────────────────────────

  function emptyState() {
    return { accounts: {}, activeId: null };
  }

  function createManager(options) {
    var api = options.api;
    var storage = options.storage;
    var now = options.now || function () { return Date.now(); };
    var queue = Promise.resolve();

    function serialize(task) {
      var run = queue.then(task, task);
      queue = run.then(function () {}, function () {});
      return run;
    }

    async function load() {
      var stored = await storage.get("state");
      var state = stored && stored.state;
      if (!state || typeof state !== "object") return emptyState();
      return {
        accounts: state.accounts && typeof state.accounts === "object" ? state.accounts : {},
        activeId: typeof state.activeId === "string" ? state.activeId : null
      };
    }

    function save(state) {
      return storage.set({ state: state });
    }

    function summary(id, record) {
      return {
        id: id,
        name: record.name,
        email: record.email || null,
        cookieCount: (record.cookies || []).length,
        savedAt: record.savedAt || null,
        lastUsedAt: record.lastUsedAt || null
      };
    }

    async function list() {
      var state = await load();
      var accounts = Object.keys(state.accounts).map(function (id) {
        return summary(id, state.accounts[id]);
      });
      accounts.sort(function (a, b) {
        return (b.lastUsedAt || b.savedAt || 0) - (a.lastUsedAt || a.savedAt || 0);
      });
      return {
        accounts: accounts,
        activeId: state.activeId,
        activeName: state.activeId && state.accounts[state.activeId]
          ? state.accounts[state.activeId].name
          : null
      };
    }

    function saveCurrent(rawName, rawEmail) {
      return serialize(async function () {
        var name = cleanName(rawName);
        if (!name) throw new Error("A name is required");
        var cookies = await snapshot(api);
        if (!cookies.length) {
          throw new Error("No ChatGPT cookies found. Log in to chatgpt.com first.");
        }
        if (!hasSessionCookie(cookies)) {
          throw new Error("No ChatGPT login found. Log in to chatgpt.com first.");
        }
        var state = await load();
        var id = newId();
        var timestamp = now();
        state.accounts[id] = {
          name: name,
          email: cleanEmail(rawEmail),
          cookies: cookies,
          createdAt: timestamp,
          savedAt: timestamp,
          lastUsedAt: timestamp
        };
        // The browser is logged into this account right now, so it becomes active.
        state.activeId = id;
        await save(state);
        return summary(id, state.accounts[id]);
      });
    }

    function update(id, rawEmail) {
      return serialize(async function () {
        var state = await load();
        var record = state.accounts[id];
        if (!record) throw new Error("Account not found");
        var cookies = await snapshot(api);
        if (!cookies.length) {
          throw new Error("No ChatGPT cookies found. Log in to chatgpt.com first.");
        }
        if (!hasSessionCookie(cookies)) {
          throw new Error("No ChatGPT login found. Log in to chatgpt.com first.");
        }
        record.cookies = cookies;
        record.savedAt = now();
        if (cleanEmail(rawEmail)) record.email = cleanEmail(rawEmail);
        await save(state);
        return summary(id, record);
      });
    }

    function rename(id, rawName) {
      return serialize(async function () {
        var name = cleanName(rawName);
        if (!name) throw new Error("A name is required");
        var state = await load();
        var record = state.accounts[id];
        if (!record) throw new Error("Account not found");
        record.name = name;
        await save(state);
        return summary(id, record);
      });
    }

    function remove(id) {
      return serialize(async function () {
        var state = await load();
        if (!state.accounts[id]) throw new Error("Account not found");
        delete state.accounts[id];
        if (state.activeId === id) state.activeId = null;
        await save(state);
        return { removed: id };
      });
    }

    /**
     * Full backup of every saved snapshot, including cookies. The resulting
     * file is as sensitive as a logged-in browser profile, so the UI warns the
     * user to keep it private.
     */
    function exportAll() {
      return serialize(async function () {
        var state = await load();
        var accounts = Object.keys(state.accounts).map(function (id) {
          var record = state.accounts[id];
          return {
            id: id,
            name: record.name,
            email: record.email || null,
            createdAt: record.createdAt || null,
            savedAt: record.savedAt || null,
            lastUsedAt: record.lastUsedAt || null,
            cookies: JSON.parse(JSON.stringify(record.cookies || []))
          };
        });
        return {
          format: EXPORT_FORMAT,
          version: EXPORT_VERSION,
          exportedAt: now(),
          accounts: accounts
        };
      });
    }

    /**
     * Merge a backup into the current list. Accounts keep their exported id, so
     * importing the same file twice replaces instead of duplicating. Invalid
     * accounts are skipped rather than aborting the whole import.
     */
    function importAll(payload) {
      return serialize(async function () {
        if (!payload || typeof payload !== "object") {
          throw new Error("This is not a ChatGPT Accounts export file.");
        }
        if (payload.format !== EXPORT_FORMAT) {
          throw new Error("This is not a ChatGPT Accounts export file.");
        }
        if (payload.version !== EXPORT_VERSION) {
          throw new Error("Unsupported export version: " + payload.version);
        }
        if (!Array.isArray(payload.accounts)) {
          throw new Error("The export file has no accounts.");
        }
        if (!payload.accounts.length) {
          throw new Error("The export file has no accounts.");
        }
        if (payload.accounts.length > MAX_IMPORT_ACCOUNTS) {
          throw new Error("Too many accounts in this file (max " + MAX_IMPORT_ACCOUNTS + ").");
        }

        var state = await load();
        var timestamp = now();
        var added = 0;
        var replaced = 0;
        var skipped = 0;

        for (var i = 0; i < payload.accounts.length; i++) {
          var raw = payload.accounts[i];
          var record = sanitizeImportedAccount(raw, timestamp);
          if (!record) {
            skipped++;
            continue;
          }
          var id = raw && typeof raw.id === "string" && IMPORT_ID.test(raw.id) ? raw.id : newId();
          if (Object.prototype.hasOwnProperty.call(state.accounts, id)) replaced++;
          else added++;
          state.accounts[id] = record;
        }

        if (added + replaced) await save(state);
        return { added: added, replaced: replaced, skipped: skipped, imported: added + replaced };
      });
    }

    /**
     * Refresh the active account's saved snapshot from the live jar.
     * Returns { live, matched }. matched=false means the live session could
     * not be attributed to the active account (different email, or no active
     * account), so callers must not overwrite that account's slot.
     * An empty jar never erases a saved snapshot (the user may be logged out).
     */
    async function captureInto(state, email) {
      var live = await snapshot(api);
      var matched = false;
      if (hasSessionCookie(live) && state.activeId && state.accounts[state.activeId]) {
        var record = state.accounts[state.activeId];
        var known = cleanEmail(record.email);
        var current = cleanEmail(email);
        // With no known email on either side, assume the live jar is ours.
        if (!known || !current || known === current) {
          record.cookies = live;
          record.savedAt = now();
          if (current) record.email = current;
          matched = true;
        }
      }
      return { live: live, matched: matched };
    }

    function emailIsSaved(state, email) {
      var clean = cleanEmail(email);
      if (!clean) return false;
      return Object.keys(state.accounts).some(function (id) {
        return cleanEmail(state.accounts[id].email) === clean;
      });
    }

    function switchTo(id, rawEmail) {
      return serialize(async function () {
        var state = await load();
        var target = state.accounts[id];
        if (!target) throw new Error("Account not found");
        if (!target.cookies || !target.cookies.length) {
          throw new Error("This account has no saved cookies. Log in and press Update.");
        }

        var captured = await captureInto(state, rawEmail);
        var live = captured.live;

        // Never silently throw away a login that is not saved anywhere: the
        // user may have just signed in as another account manually. Anonymous
        // leftovers from a logged-out page are safe to clear.
        if (hasSessionCookie(live) && !captured.matched) {
          if (!emailIsSaved(state, rawEmail)) {
            throw new Error(
              "This live session is not saved yet. Save it as an account first, or press Log out."
            );
          }
        }

        await clearAll(api);
        var result = await restoreAll(api, target.cookies);

        if (result.ok === 0) {
          // Total failure: put the browser back where it was before we touched it.
          await clearAll(api);
          if (live.length) await restoreAll(api, live);
          throw new Error("Could not restore this account's cookies; rolled back");
        }

        state.activeId = id;
        target.lastUsedAt = now();
        await save(state);

        return {
          account: summary(id, target),
          restored: result.ok,
          failed: result.failed.length
        };
      });
    }

    /**
     * Log the browser out of ChatGPT while keeping all saved snapshots, so a
     * different account can be signed in and then saved. Refuses to discard a
     * live session that is not already saved under the active account.
     */
    function signOut(rawEmail) {
      return serialize(async function () {
        var state = await load();
        var record = state.activeId ? state.accounts[state.activeId] : null;
        var captured = await captureInto(state, rawEmail);
        var current = cleanEmail(rawEmail);
        var known = record ? cleanEmail(record.email) : null;

        if (hasSessionCookie(captured.live) && !captured.matched) {
          if (!emailIsSaved(state, rawEmail)) {
            if (record && known && current) {
              throw new Error(
                "The browser is signed in as " + current + ", but the active account is " +
                  record.name + ". Save this session as a new account first."
              );
            }
            throw new Error("Save the current session first so it is not lost.");
          }
        }

        await clearAll(api);
        state.activeId = null;
        await save(state);
        return {
          cleared: captured.live.length,
          savedName: record ? record.name : null
        };
      });
    }

    function debugState() {
      return load().then(function (state) { return { state: state }; });
    }

    return {
      list: list,
      saveCurrent: saveCurrent,
      update: update,
      rename: rename,
      remove: remove,
      switchTo: switchTo,
      signOut: signOut,
      exportAll: exportAll,
      importAll: importAll,
      debugState: debugState
    };
  }

  root.ChatGPTAccounts = {
    DOMAINS: DOMAINS,
    DEFAULT_STORE: DEFAULT_STORE,
    cookieKey: cookieKey,
    dedupe: dedupe,
    cookieUrl: cookieUrl,
    toSetDetails: toSetDetails,
    snapshot: snapshot,
    clearAll: clearAll,
    restoreAll: restoreAll,
    hasSessionCookie: hasSessionCookie,
    cleanName: cleanName,
    cleanEmail: cleanEmail,
    createManager: createManager
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
