"use strict";
const toggle = document.getElementById("enabled");
const formatSelect = document.getElementById("format");
const status = document.getElementById("status");
const hint = document.getElementById("hint");

async function refreshStatus() {
  if (!toggle.checked) {
    status.textContent = "粉丝徽标已关闭";
    hint.textContent = "开启后继续浏览，页面有数据时会自动显示。";
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No tab");
    const result = await chrome.tabs.sendMessage(tab.id, { type: "x-followers:status" });
    status.textContent = result.badges ? `当前页已显示 ${result.badges} 个粉丝徽标` : "等待页面中的粉丝数数据";
    hint.textContent = "新安装请刷新 X。缺少数字时不会猜测，悬停徽标可看完整数量。";
  } catch {
    status.textContent = "请在 X 页面使用";
    hint.textContent = "打开 x.com 并刷新页面后，正常浏览即可。";
  }
}

async function save() {
  try {
    await chrome.storage.local.set({ enabled: toggle.checked, format: formatSelect.value });
    await refreshStatus();
  } catch {
    status.textContent = "设置未保存，请重新打开扩展";
  }
}

chrome.storage.local.get(["enabled", "format"]).then((values) => {
  toggle.checked = values.enabled !== false;
  formatSelect.value = values.format === "exact" ? "exact" : "compact";
  return refreshStatus();
}).catch(() => { status.textContent = "扩展暂不可用，请重新打开"; });
toggle.addEventListener("change", save);
formatSelect.addEventListener("change", save);
