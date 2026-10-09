(() => {
  "use strict";
  if (globalThis.__xFollowersContent) return;
  globalThis.__xFollowersContent = true;
  const { CHANNEL, normalizeHandle, validCount, handleFromHref, formatCount, remember } = globalThis.XFollowersCore;
  const ROOTS = '[data-testid="User-Name"], [data-testid="UserName"], [data-testid="UserCell"]';
  const BADGE = "[data-xfc-badge]";
  const cache = new Map();
  let enabled = true;
  let format = "compact";
  let timer;

  function control(replay = false) {
    window.postMessage({ channel: CHANNEL, type: "control", enabled, replay }, location.origin);
  }

  function renderRoot(root) {
    // A list cell may contain its own named header; process the header once.
    if (root.matches('[data-testid="UserCell"]') && root.querySelector('[data-testid="User-Name"], [data-testid="UserName"]')) return;
    const ownBadges = Array.from(root.querySelectorAll(BADGE)).filter((el) => el.closest(ROOTS) === root);
    const links = Array.from(root.querySelectorAll("a[href]"))
      .filter((link) => link.closest(ROOTS) === root)
      .map((link) => ({ link, handle: handleFromHref(link.getAttribute("href"), location.href) }))
      // Avatar-only links have no text. A real name link can also contain an
      // affiliated-account logo, so an image must not disqualify its name.
      .filter(({ link, handle }) => handle && link.textContent.trim());
    const selected = links.find(({ link }) => !link.textContent.trim().startsWith("@")) || links[0];
    const count = selected && cache.get(selected.handle);
    if (!selected || count === undefined || !enabled) {
      ownBadges.forEach((el) => el.remove());
      return;
    }

    const { link, handle } = selected;
    let slot = link.parentElement;
    // Keep the badge on the name line if a user cell stacks name and handle.
    if (!slot || slot === root || getComputedStyle(slot).flexDirection === "column" || slot.querySelector("time")) slot = link;
    // Current X list names use a column link around a horizontal name row.
    if (slot === link && getComputedStyle(link).flexDirection === "column") {
      const nameRow = Array.from(link.children).find((el) => el.textContent.trim() && /^(?:inline-)?flex$/.test(getComputedStyle(el).display) && getComputedStyle(el).flexDirection === "row");
      if (nameRow) slot = nameRow;
    }
    let badge = ownBadges.shift();
    ownBadges.forEach((el) => el.remove());
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "xfc-badge";
      badge.setAttribute("data-xfc-badge", "");
    }
    const label = `粉丝 ${formatCount(count, format)}`;
    const exact = count.toLocaleString("en-US");
    const title = `@${handle} · ${exact} 位粉丝（本页最近收到的数据）`;
    if (badge.textContent !== label) badge.textContent = label;
    if (badge.title !== title) badge.title = title;
    badge.setAttribute("aria-label", `${exact} 位粉丝`);
    badge.dataset.xfcHandle = handle;
    if (badge.parentElement !== slot) slot.appendChild(badge);
  }

  function render() {
    timer = undefined;
    for (const root of document.querySelectorAll(ROOTS)) renderRoot(root);
  }

  function schedule() {
    if (timer === undefined) timer = setTimeout(render, 90);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.channel !== CHANNEL || message.type !== "profiles" || !Array.isArray(message.profiles) || message.profiles.length > 300) return;
    for (const profile of message.profiles) {
      if (!profile || typeof profile !== "object") continue;
      const handle = normalizeHandle(profile.handle);
      if (handle && validCount(profile.count)) remember(cache, { handle, count: profile.count });
    }
    schedule();
  });

  function start() {
    const mutations = new MutationObserver((records) => {
      if (!enabled) return;
      const relevant = records.some((record) => {
        if (record.target.parentElement?.closest(BADGE) || record.target.closest?.(BADGE)) return false;
        if (record.type === "childList" && record.addedNodes.length && !record.removedNodes.length && Array.from(record.addedNodes).every((node) => node.nodeType === 1 && node.matches(BADGE))) return false;
        return true;
      });
      if (relevant) schedule();
    });
    mutations.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["href", "data-testid"] });
    schedule();
  }

  function settings(values) {
    enabled = values.enabled !== false;
    format = values.format === "exact" ? "exact" : "compact";
    control(enabled);
    schedule();
  }

  if (globalThis.chrome?.storage?.local) {
    chrome.storage.local.get(["enabled", "format"]).then(settings).catch(() => control(true));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || (!changes.enabled && !changes.format)) return;
      settings({ enabled: changes.enabled ? changes.enabled.newValue : enabled, format: changes.format ? changes.format.newValue : format });
    });
    chrome.runtime.onMessage.addListener((message, _sender, respond) => {
      if (message?.type === "x-followers:status") respond({ enabled, format, profiles: cache.size, badges: document.querySelectorAll(BADGE).length });
    });
  } else {
    // Allows the synthetic local preview to exercise the same DOM renderer.
    control(true);
  }
  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
