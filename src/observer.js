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
