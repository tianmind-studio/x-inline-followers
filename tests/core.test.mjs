import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const extension = new URL("../src/", import.meta.url);
const source = (name) => readFileSync(new URL(name, extension), "utf8");
const pure = vm.createContext({ URL });
vm.runInContext(source("core.js"), pure);
const core = pure.XFollowersCore;
const plain = (value) => JSON.parse(JSON.stringify(value));

test("extracts old/new GraphQL, REST and v2 user shapes, including zero", () => {
  const profiles = core.extractProfiles({ data: [
    { __typename: "User", core: { screen_name: "Modern" }, legacy: { followers_count: 174000 } },
    { legacy: { screen_name: "Legacy", followers_count: 423 } },
    { screen_name: "Rest", followers_count: 0 },
    { username: "V2", public_metrics: { followers_count: 7806 } }
  ] });
  assert.deepEqual(plain(profiles).sort((a, b) => a.handle.localeCompare(b.handle)), [
    { handle: "legacy", count: 423 }, { handle: "modern", count: 174000 }, { handle: "rest", count: 0 }, { handle: "v2", count: 7806 }
  ]);
});

test("never borrows a nested/quoted user's count for a missing author", () => {
  const data = { core: { screen_name: "Missing" }, quoted_status: { core: { screen_name: "Quoted" }, legacy: { followers_count: 93 } } };
  assert.deepEqual(plain(core.extractProfiles(data)), [{ handle: "quoted", count: 93 }]);
});

test("extracts the current split GraphQL counts on the same user, including zero", () => {
  const data = [
    { __typename: "User", core: { screen_name: "Current" }, relationship_counts: { followers: 35123, following: 10 } },
    { core: { screen_name: "Zero" }, relationship_counts: { followers: 0 }, legacy: { followers_count: 8 } },
    { core: { screen_name: "Missing" }, quoted: { core: { screen_name: "Quoted" }, relationship_counts: { followers: 93 } } },
    { core: { screen_name: "Invalid" }, relationship_counts: { followers: "7" } }
  ];
  assert.deepEqual(plain(core.extractProfiles(data)).sort((a, b) => a.handle.localeCompare(b.handle)), [
    { handle: "current", count: 35123 }, { handle: "quoted", count: 93 }, { handle: "zero", count: 0 }
  ]);
});

test("rejects invalid names, non-numeric counts and private message branches", () => {
  assert.deepEqual(plain(core.extractProfiles([
    { screen_name: "bad/name", followers_count: 8 },
    { screen_name: "String", followers_count: "8" },
    { screen_name: "Negative", followers_count: -1 },
    { screen_name: "Fraction", followers_count: 1.5 },
    { screen_name: "Unsafe", followers_count: Number.MAX_SAFE_INTEGER + 1 },
    { messages: { screen_name: "Private", followers_count: 3 } }
  ])), []);
});

test("handles duplicate users, circular values and bounded caches", () => {
  const user = { legacy: { screen_name: "Same", followers_count: 8 } };
  user.loop = user;
  assert.deepEqual(plain(core.extractProfiles([user, user])), [{ handle: "same", count: 8 }]);
  const cache = new Map();
  for (let i = 0; i <= core.MAX_PROFILES; i++) core.remember(cache, { handle: `u${i}`, count: i });
  assert.equal(cache.size, core.MAX_PROFILES);
  assert.equal(cache.has("u0"), false);
  core.remember(cache, { handle: "u1", count: 0 });
  assert.equal(cache.get("u1"), 0);
});

test("formats screenshot-style Chinese units, exact values and true zero", () => {
  for (const [count, expected] of [[0, "0"], [423, "423"], [1574, "1,574"], [7806, "7,806"], [11000, "1.1万"], [164000, "16.4万"], [174000, "17.4万"], [125000000, "1.3亿"]]) {
    assert.equal(core.formatCount(count), expected);
  }
  assert.equal(core.formatCount(174000, "exact"), "174,000");
  assert.equal(core.formatCount(null), "");
});

test("only recognizes X profile links, excluding status/permalink/builtin routes", () => {
  assert.equal(core.handleFromHref("/Example_1"), "example_1");
  assert.equal(core.handleFromHref("https://twitter.com/Example_1/?s=20"), "example_1");
  for (const href of ["/home", "/i", "/messages", "/user/status/123", "/user/photo", "https://evil.example/user", "javascript:alert(1)", "https://x.com.evil.example/user"]) assert.equal(core.handleFromHref(href), null, href);
});

test("observes only profile/timeline API responses; excludes DMs and external hosts", () => {
  for (const url of ["/i/api/graphql/abc/HomeTimeline", "/i/api/graphql/abc/BlueVerifiedFollowers", "/i/api/graphql/abc/UserByScreenName", "https://api.twitter.com/1.1/users/lookup.json"]) assert.equal(core.isProfileResponseUrl(url), true, url);
  for (const url of ["/i/api/1.1/dm/inbox_initial_state.json", "/i/api/graphql/abc/DmAllSearchSlice", "/i/api/graphql/abc/DirectMessages", "/i/api/graphql/abc/GrokConversation", "/i/api/graphql/abc/%44mUsers", "/analytics", "https://evil.example/i/api/graphql/abc/HomeTimeline", "https://x.com.evil.example/i/api/graphql/abc/HomeTimeline"]) assert.equal(core.isProfileResponseUrl(url), false, url);
});

function observerHarness() {
  const posted = [];
  const listeners = [];
  const timers = [];
  let calls = 0;
  const url = "https://x.com/i/api/graphql/abc/HomeTimeline";
  let response;
  let promise;
  class FakeXHR extends EventTarget {
    open(method, requestUrl) { this.method = method; this.responseURL = requestUrl; }
    send() { this.dispatchEvent(new Event("load")); this.dispatchEvent(new Event("loadend")); }
    getResponseHeader() { return null; }
  }
  const sandbox = { URL, Response, TextDecoder, XMLHttpRequest: FakeXHR, location: { href: "https://x.com/home", origin: "https://x.com" }, setTimeout: (fn) => { timers.push(fn); return timers.length; } };
  sandbox.window = sandbox;
  sandbox.postMessage = (message) => posted.push(message);
  sandbox.addEventListener = (kind, listener) => { if (kind === "message") listeners.push(listener); };
  sandbox.fetch = () => { calls++; return promise; };
  vm.createContext(sandbox);
  vm.runInContext(source("core.js"), sandbox);
  vm.runInContext(source("observer.js"), sandbox);
  function setResponse(body, responseUrl = url, type = "application/json") {
    response = new Response(body, { headers: { "content-type": type } });
    Object.defineProperty(response, "url", { value: responseUrl });
    promise = Promise.resolve(response);
  }
  setResponse(JSON.stringify({ legacy: { screen_name: "Example", followers_count: 174000 }, text: "synthetic post text" }));
  return { sandbox, posted, timers, listeners, setResponse, url, get response() { return response; }, get promise() { return promise; }, get calls() { return calls; } };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

test("fetch hook preserves original Promise/Response/body and bridges only count pairs", async () => {
  const h = observerHarness();
  const promise = h.sandbox.fetch(h.url);
  assert.equal(promise, h.promise);
  const response = await promise;
  assert.equal(response, h.response);
  assert.equal((await response.json()).legacy.followers_count, 174000);
  await settle();
  h.timers.splice(0).forEach((fn) => fn());
  assert.equal(h.calls, 1);
  assert.deepEqual(plain(h.posted), [{ channel: core.CHANNEL, type: "profiles", profiles: [{ handle: "example", count: 174000 }] }]);
});

test("fetch hook safely ignores malformed/oversized/private responses", async () => {
  for (const [body, url] of [["not json", "https://x.com/i/api/graphql/abc/HomeTimeline"], [" ".repeat(4 * 1024 * 1024 + 1), "https://x.com/i/api/graphql/abc/HomeTimeline"], ['{"screen_name":"Private","followers_count":9}', "https://x.com/i/api/1.1/dm/inbox.json"]]) {
    const h = observerHarness();
    h.setResponse(body, url);
    await h.sandbox.fetch(url);
    await settle();
    h.timers.splice(0).forEach((fn) => fn());
    assert.equal(h.posted.length, 0);
  }
});

test("XHR hook preserves page data and handles reused XHR instances", () => {
  const h = observerHarness();
  const xhr = new h.sandbox.XMLHttpRequest();
  xhr.status = 200;
  xhr.responseType = "json";
  xhr.response = { core: { screen_name: "Example" }, legacy: { followers_count: 7 } };
  xhr.open("GET", h.url);
  xhr.send();
  h.timers.splice(0).forEach((fn) => fn());
  assert.equal(xhr.response.legacy.followers_count, 7);
  assert.equal(h.posted[0].profiles[0].count, 7);
  xhr.response = { screen_name: "Example", followers_count: 0 };
  xhr.open("GET", h.url);
  xhr.send();
  h.timers.splice(0).forEach((fn) => fn());
  assert.equal(h.posted[1].profiles[0].count, 0);
});

test("manifest has no remote code, broad host, credential or history permissions", () => {
  const manifest = JSON.parse(source("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.equal(manifest.background, undefined);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.content_scripts.map((s) => s.world), ["MAIN", "ISOLATED"]);
  // Chromium can deduplicate the same file declared in both worlds. Each
  // world therefore gets a distinct script with its own bundled core.
  assert.equal(new Set(manifest.content_scripts.flatMap(s=>s.js)).size,2);
  for (const script of manifest.content_scripts) {
    assert.equal(script.run_at, "document_start");
    assert.equal(script.matches.includes("<all_urls>"), false);
    for (const name of script.js) assert.ok(readFileSync(new URL(name, extension)).length > 0);
  }
});

