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
