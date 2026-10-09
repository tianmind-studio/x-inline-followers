# X 粉丝数 · Inline Followers

在 X 信息流、回复和用户列表的名字旁显示粉丝数。Chrome Manifest V3 扩展，只使用页面已经收到的数据。

Show follower counts beside names on X. Uses the page's existing responses, with no extra API requests or data uploads.

## 下载与安装

1. [下载 v1.0.0 安装包](https://github.com/tianmind-studio/x-inline-followers/raw/refs/heads/main/downloads/x-inline-followers-1.0.0.zip)，解压到一个长期保留的文件夹。
2. 在 Chrome 打开 `chrome://extensions`，开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择解压后含 `manifest.json` 的文件夹。
4. 刷新 X 页面，正常浏览即可。

也可下载整个仓库，直接加载 [extension/](extension/) 目录。不要直接加载 `src/`：发布脚本会把共享逻辑分别打包进两个执行环境。

## 功能

- 在信息流、回复、搜索结果、粉丝和关注列表中显示蓝色粉丝数标签。
- 弹窗支持开关，以及简洁数字（17.4万）和完整数字（174,000）切换；悬停显示完整数量。
- 支持深色主题、滚动加载、页面内导航和列表节点复用；保留账号主页链接。
- 没有可靠数字时留空，不把缺失值当作 0，也不借用引用作者的粉丝数。

## 数据与权限

扩展在页面加载时观察已有 fetch / XMLHttpRequest JSON 响应，不发起额外 API 请求，不需要 API Key。仅匹配 X/Twitter 桌面网站，持久化权限只有 `storage`。

只在当前标签页内存中保存最多 5,000 个账号名与粉丝数，刷新或关闭后清空。持久化数据只有开关与数字格式。跳过私信、聊天和 Grok 响应；跨脚本只传递账号名与粉丝数，没有服务端、分析追踪或上传。

数字是页面最近收到的快照。X 的响应字段或页面结构改变后可能需要更新；手机 App 不适用。

## 开发与验证

使用 Node.js 20+。单元测试无需安装 npm 依赖：

```sh
npm test
npm run package
```

打包还需系统提供 `/usr/bin/zip` 和 `/usr/bin/unzip`，输出位于 `dist/`。`src/` 保留可编辑源码，`extension/` 是本版本的可直接加载副本。

可选的 `node tools/browser-smoke.mjs` 需要本地 Playwright 和 Chromium。它在临时浏览器配置中加载实际扩展，使用合成账号与模拟响应，拦截所有外部网络请求，截图及摘要写入 `output/`。

v1.0.0 已完成 12 项独立单元检查、22 项隔离浏览器检查，并于 2026-10-09 在真实 X 公开页面验证新版 `relationship_counts.followers` 字段与姓名行布局。

安装包 SHA-256：`e8632ec0fdde0177d4152f259d2418932869521704aea352cb01a35de6a2c27f`

## 灵感来源

受到 [@yiren_ai 的分享](https://x.com/yiren_ai/status/2108490929787322455)启发，独立实现。
