/* Canonical pure helpers; bundled separately into each execution world. */
(() => {
  "use strict";
  if (globalThis.XFollowersCore) return;

  const CHANNEL = "x-inline-followers/v1";
  const MAX_PROFILES = 5000;
  const HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "api.x.com", "api.twitter.com"]);
  const RESERVED = new Set(["home", "explore", "notifications", "messages", "i", "settings", "search", "compose", "login", "logout", "signup", "tos", "privacy", "jobs", "download", "account", "communities", "intent", "hashtag"]);

  function normalizeHandle(value) {
    return typeof value === "string" && /^[A-Za-z0-9_]{1,15}$/.test(value) ? value.toLowerCase() : null;
  }

  function validCount(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function extractProfiles(payload) {
    const found = new Map();
    const seen = new WeakSet();
    const pending = [{ value: payload, depth: 0 }];
    let visited = 0;
    while (pending.length && visited < 60000 && found.size < MAX_PROFILES) {
      const { value, depth } = pending.pop();
      if (!value || typeof value !== "object" || seen.has(value) || depth > 45) continue;
      seen.add(value);
      visited += 1;

      // Bind the name and count on the SAME user object, never a recursive
      // count search that could accidentally borrow a quoted author's count.
      const handle = normalizeHandle(value.core?.screen_name ?? value.legacy?.screen_name ?? value.screen_name ?? value.username);
      const count = value.relationship_counts?.followers ?? value.legacy?.followers_count ?? value.public_metrics?.followers_count ?? value.followers_count;
      if (handle && validCount(count) && !found.has(handle)) found.set(handle, { handle, count });

      for (const [key, child] of Object.entries(value)) {
        if (/^(?:dm|direct_messages|messages|inbox|conversation|chat|grok)/i.test(key)) continue;
        if (child && typeof child === "object") pending.push({ value: child, depth: depth + 1 });
      }
    }
    return Array.from(found.values());
  }

  function isProfileResponseUrl(input, base = "https://x.com") {
    try {
      const url = new URL(input, base);
      if (url.protocol !== "https:" || !HOSTS.has(url.hostname)) return false;
      const pathname = decodeURIComponent(url.pathname);
      if (/dm|direct.?message|inbox|conversation|chat|grok/i.test(pathname)) return false;
      const graphql = pathname.match(/^\/(?:i\/api\/)?graphql\/[^/]+\/([^/]+)$/);
      if (graphql) return /user|tweet|follow|timeline|search|notif|connect|favorit|retweet|people|list/i.test(graphql[1]);
      return /^\/(?:i\/api\/)?(?:1\.1|2)\/(?:users|friends|followers|statuses|notifications|search|timeline)\//.test(pathname);
    } catch {
      return false;
    }
  }

  function handleFromHref(href, base = "https://x.com") {
    try {
      const url = new URL(href, base);
      if (!HOSTS.has(url.hostname) || url.protocol !== "https:") return null;
      const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
      const handle = match && normalizeHandle(match[1]);
      return handle && !RESERVED.has(handle) ? handle : null;
    } catch {
      return null;
    }
  }

  function formatCount(count, format = "compact") {
    if (!validCount(count)) return "";
    if (format === "exact" || count < 10000) return count.toLocaleString("en-US");
    const unit = count >= 100000000 ? 100000000 : 10000;
    return `${Number((count / unit).toFixed(1))}${unit === 10000 ? "万" : "亿"}`;
  }

  function remember(cache, profile) {
    cache.delete(profile.handle);
    cache.set(profile.handle, profile.count);
    while (cache.size > MAX_PROFILES) cache.delete(cache.keys().next().value);
  }

  globalThis.XFollowersCore = Object.freeze({ CHANNEL, MAX_PROFILES, normalizeHandle, validCount, extractProfiles, isProfileResponseUrl, handleFromHref, formatCount, remember });
})();

/* Observe the page's own fetch/XHR. Never initiates an API request. */
(() => {
  "use strict";
  if (globalThis.__xFollowersObserver) return;
  globalThis.__xFollowersObserver = true;
  const { CHANNEL, extractProfiles, isProfileResponseUrl, remember } = globalThis.XFollowersCore;
  const MAX_BYTES = 4 * 1024 * 1024;
  const cache = new Map();
  const pending = new Map();
  let timer;
  let enabled = true;

  function flush() {
    timer = undefined;
    if (!enabled) return pending.clear();
    const profiles = Array.from(pending.values());
    pending.clear();
    for (let i = 0; i < profiles.length; i += 300) {
      // No raw responses, headers, post text or credentials cross this bridge.
      window.postMessage({ channel: CHANNEL, type: "profiles", profiles: profiles.slice(i, i + 300) }, location.origin);
    }
  }

  function collect(payload) {
    if (!enabled) return;
    for (const profile of extractProfiles(payload)) {
      const changed = cache.get(profile.handle) !== profile.count;
      remember(cache, profile);
      if (changed) pending.set(profile.handle, profile);
    }
    if (pending.size && timer === undefined) timer = setTimeout(flush, 60);
  }

  async function readResponse(response) {
    if (!enabled || !response.ok || !isProfileResponseUrl(response.url, location.href)) return;
    const type = response.headers.get("content-type") || "";
    if (!/json/i.test(type) || Number(response.headers.get("content-length")) > MAX_BYTES) return;
    let reader;
    try {
      const copy = response.clone();
      reader = copy.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let size = 0;
      let body = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (!enabled || size > MAX_BYTES) {
          void reader.cancel().catch(() => {});
          return;
        }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
      if (enabled) collect(JSON.parse(body));
    } catch {
      // Non-JSON, unavailable or aborted responses must not affect X.
    } finally {
      reader?.releaseLock();
    }
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const result = Reflect.apply(originalFetch, this, args);
    try {
      const input = args[0];
      const url = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
      if (enabled && url && isProfileResponseUrl(url, location.href)) {
        // Preserve the original Promise and Response for the page.
        void result.then(readResponse).catch(() => {});
      }
    } catch {
      // Observing is optional; the original fetch result always wins.
    }
    return result;
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrUrls = new WeakMap();
  XMLHttpRequest.prototype.open = function (...args) {
    const result = Reflect.apply(xhrOpen, this, args);
    xhrUrls.set(this, String(args[1]));
    return result;
  };
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    const onLoad = () => {
      if (!enabled || this.status < 200 || this.status >= 300) return;
      if (!isProfileResponseUrl(this.responseURL || xhrUrls.get(this), location.href)) return;
      try {
        if (this.responseType === "json") {
          if (Number(this.getResponseHeader("content-length")) <= MAX_BYTES) collect(this.response);
        } else if (this.responseType === "" || this.responseType === "text") {
          const text = this.responseText;
          if (text.length <= MAX_BYTES) collect(JSON.parse(text));
        }
      } catch {
        // Includes binary response types and malformed JSON.
      }
    };
    const cleanup = () => {
      this.removeEventListener("load", onLoad);
      this.removeEventListener("loadend", cleanup);
    };
    this.addEventListener("load", onLoad, { once: true });
    this.addEventListener("loadend", cleanup, { once: true });
    try {
      return Reflect.apply(xhrSend, this, args);
    } catch (error) {
      cleanup();
      throw error;
    }
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.channel !== CHANNEL || message.type !== "control" || typeof message.enabled !== "boolean") return;
    enabled = message.enabled;
    if (!enabled) pending.clear();
    if (enabled && message.replay === true) {
      for (const [handle, count] of cache) pending.set(handle, { handle, count });
      if (timer === undefined) timer = setTimeout(flush, 0);
    }
  });
})();
