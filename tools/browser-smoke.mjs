import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A library smoke harness is needed here to load an actual extension in a
// disposable persistent Chromium context, rather than inject its JS manually.
if (process.argv.length !== 2) throw new Error("This offline smoke check accepts no arguments.");
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = path.join(root, "dist", "x-inline-followers-1.0.0");
const fixture = readFileSync(path.join(root, "fixtures/x-page.html"), "utf8");
const output = path.join(root, "output");
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(path.join(os.tmpdir(), "x-followers-qa-"));
const checks = [];
const apiRequests = [];
const unexpectedRequests = [];
const errors = [];
const gql = (operation) => `/i/api/graphql/synthetic/${operation}`;
const user = (handle, count) => ({ __typename: "User", core: { screen_name: handle }, relationship_counts: { followers: count } });
const initial = { data: { timeline: { instructions: [{ entries: [user("demo_174k",174000),user("demo_11k",11000),user("demo_1574",1574),user("demo_423",423),user("demo_zero",0),user("quote_demo",93),{ core:{ screen_name:"no_number" }, quoted: user("quote_demo",93) }] }] } } };
const responses = new Map([[gql("HomeTimeline"), initial]]);
let context;
let page;

async function check(name, action) {
  await action();
  checks.push(name);
  console.log(`PASS ${name}`);
}

const waitForText = async (selector, text) => page.waitForFunction(({selector,text}) => document.querySelector(selector)?.textContent === text, {selector,text}, {timeout:7000});
const badge = (id) => `#${id} [data-xfc-badge]`;
const badgeCount = () => page.locator("[data-xfc-badge]").count();

try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true, viewport: { width: 810, height: 1130 }, deviceScaleFactor: 1,
    serviceWorkers: "block",
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  context.on("page", (p) => p.on("pageerror", (error) => errors.push(error.message)));
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.protocol === "chrome-extension:") return route.continue();
    if (["x.com","twitter.com"].includes(url.hostname)) {
      if (request.resourceType() === "document") return route.fulfill({ contentType: "text/html", body: fixture });
      if (responses.has(url.pathname)) {
        apiRequests.push(url.pathname);
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(responses.get(url.pathname)) });
      }
      if (url.pathname === "/favicon.ico") return route.fulfill({ status:204, body:"" });
    }
    unexpectedRequests.push(`${url.protocol}//${url.hostname}${url.pathname}`);
    await route.abort();
  });
  await context.addInitScript(() => {
    window.qaMessages = [];
    window.addEventListener("message", event => {
      if(event.data?.channel === "x-inline-followers/v1") window.qaMessages.push({type:event.data.type,profiles:event.data.profiles?.length,enabled:event.data.enabled,origin:event.origin,self:event.source===window});
    });
  });
  page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const worlds = new Map();
  cdp.on("Runtime.executionContextCreated", ({context:world}) => worlds.set(world.id,world));
  cdp.on("Runtime.executionContextDestroyed", ({executionContextId}) => worlds.delete(executionContextId));
  cdp.on("Runtime.executionContextsCleared", () => worlds.clear());
  await cdp.send("Runtime.enable");
  await page.goto("https://x.com/home");
  let extensionId;
  for (const world of worlds.values()) {
    const result = await cdp.send("Runtime.evaluate", { expression: "globalThis.chrome?.runtime?.id", contextId:world.id, returnByValue:true });
    if (result.result.value) extensionId=result.result.value;
  }
  try {
    await page.waitForFunction(() => document.querySelectorAll("[data-xfc-badge]").length === 6, null, {timeout:5000});
  } catch(error) {
    console.log(JSON.stringify({messages:await page.evaluate(()=>window.qaMessages),errors}));
    throw error;
  }

  await check("actual MV3 extension loaded in both page and isolated worlds", async () => {
    assert.match(extensionId, /^[a-p]{32}$/);
    assert.equal(await page.evaluate(() => globalThis.__xFollowersObserver), true);
    assert.equal(await page.evaluate(() => globalThis.__xFollowersContent), undefined);
  });
  await check("initial fetch: timeline, list, quote and zero render correctly", async () => {
    await waitForText(badge("tweet-main"), "粉丝 17.4万");
    await waitForText(badge("tweet-second"), "粉丝 1.1万");
    await waitForText(badge("cell-small"), "粉丝 423");
    await waitForText(badge("cell-zero"), "粉丝 0");
    await waitForText(badge("quote-name"), "粉丝 93");
  });
  await check("missing values stay blank; quoted counts do not leak to author", async () => {
    assert.equal(await page.locator(badge("tweet-missing")).count(),0);
    assert.equal(await page.locator(badge("cell-waiting")).count(),0);
  });
  await check("original response body is still available to X", async () => {
    assert.equal(await page.evaluate(() => window.originalPayload.data.timeline.instructions[0].entries[0].relationship_counts.followers),174000);
  });
  await check("hover exposes exact number and keeps profile links", async () => {
    assert.match(await page.locator(badge("tweet-main")).getAttribute("title"),/174,000/);
    assert.equal(await page.locator("#tweet-main a.name-link").getAttribute("href"),"/demo_174k");
    await page.locator(badge("tweet-main")).hover();
  });
  await check("affiliated-account logos keep badges beside the display name", async () => {
    await page.evaluate(() => {
      const image=document.createElement("img");
      image.alt="Affiliated account";image.width=12;image.height=12;
      image.src='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="%231d9bf0"/></svg>';
      document.querySelector("#cell-small .name-link").appendChild(image);
    });
    await page.waitForFunction(() => {
      const row=document.getElementById("cell-small");
      return row.querySelector("[data-xfc-badge]")?.parentElement === row.querySelector(".name-link").parentElement;
    });
  });
  await check("column profile links use the inner horizontal name row", async () => {
    await page.evaluate(() => {
      const link=document.querySelector("#cell-small .name-link");
      const line=document.createElement("div");line.dataset.qaNameLine="";line.style.display="flex";line.style.flexDirection="row";
      line.append(...link.childNodes);link.appendChild(line);
      link.style.flexDirection="column";link.parentElement.style.flexDirection="column";
    });
    await page.waitForFunction(() => document.querySelector("#cell-small [data-xfc-badge]")?.parentElement?.hasAttribute("data-qa-name-line"));
    await page.evaluate(() => {
      const link=document.querySelector("#cell-small .name-link"),line=link.querySelector("[data-qa-name-line]");
      link.style.flexDirection="";link.parentElement.style.flexDirection="";line.replaceWith(...line.childNodes);
    });
    await page.waitForFunction(() => document.querySelector("#cell-small [data-xfc-badge]")?.parentElement === document.querySelector("#cell-small .name-row"));
  });
  await check("no duplicate badges after repeated DOM mutations", async () => {
    await page.evaluate(() => { for(let i=0;i<15;i++){const span=document.createElement("span");document.body.appendChild(span);span.remove();} });
    await page.waitForTimeout(250);
    assert.equal(await badgeCount(),6);
  });

  await page.screenshot({ path:path.join(output,"preview-light.png"), fullPage:true });
  await check("dark X theme and narrow viewport retain readable badges", async () => {
    await page.evaluate(() => document.body.classList.add("dark"));
    await page.screenshot({ path:path.join(output,"preview-dark.png"),fullPage:true });
    await page.setViewportSize({width:390,height:1000});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    assert.equal(await badgeCount(),6);
    await page.screenshot({path:path.join(output,"preview-mobile.png"),fullPage:true});
    await page.setViewportSize({width:810,height:1130});
    await page.evaluate(() => document.body.classList.remove("dark"));
  });
  await check("newly mounted/scroll-loaded rows receive cached counts", async () => {
    await page.evaluate(() => window.demo.cell("demo_174k","Mia 的列表条目","滚动加载的合成条目","scroll-row"));
    await waitForText(badge("scroll-row"),"粉丝 17.4万");
    assert.equal(await badgeCount(),7);
  });
  await check("late data from XHR fills an existing row; XHR data intact", async () => {
    responses.set(gql("Followers"),{data:[user("waiting_demo",3868)]});
    const count=await page.evaluate(async (url) => new Promise((resolve,reject) => {
      const xhr=new XMLHttpRequest();xhr.open("GET",url);xhr.responseType="json";
      xhr.onload=()=>resolve(xhr.response.data[0].relationship_counts.followers);xhr.onerror=reject;xhr.send();
    }),gql("Followers"));
    assert.equal(count,3868);
    await waitForText(badge("cell-waiting"),"粉丝 3,868");
  });
  await check("later responses update already displayed counts", async () => {
    responses.set(gql("UserByScreenName"),{data:{user:{result:user("demo_174k",180000)}}});
    await page.evaluate((url)=>fetch(url).then(r=>r.json()),gql("UserByScreenName"));
    await waitForText(badge("tweet-main"),"粉丝 18万");
    await waitForText(badge("scroll-row"),"粉丝 18万");
  });
  await check("recycled DOM updates account identity and removes a stale badge", async () => {
    await page.evaluate(() => {
      const root=document.getElementById("tweet-main");
      root.querySelectorAll("a").forEach(a=>a.href="/demo_zero");
      root.querySelector(".name").textContent="复用后的零粉丝账号";
    });
    await waitForText(badge("tweet-main"),"粉丝 0");
    await page.evaluate(() => document.querySelectorAll("#tweet-main a").forEach(a=>a.href="/unknown_demo"));
    await page.waitForFunction(()=>!document.querySelector("#tweet-main [data-xfc-badge]"));
  });
  await check("non-user/private response does not add a badge", async () => {
    const privateUrl="/i/api/1.1/dm/inbox_initial_state.json";
    responses.set(privateUrl,{screen_name:"unknown_demo",followers_count:99999});
    await page.evaluate(url=>fetch(url).then(r=>r.json()),privateUrl);
    await page.waitForTimeout(200);
    assert.equal(await page.locator(badge("tweet-main")).count(),0);
  });

  const popup=await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();
  await check("popup reads active X tab status without tabs permission", async () => {
    await popup.evaluate(()=>refreshStatus());
    assert.match(await popup.locator("#status").textContent(),/已显示 \d+ 个粉丝徽标/);
  });
  await popup.screenshot({path:path.join(output,"popup.png"),clip:{x:0,y:0,width:310,height:370}});
  await check("popup changes number format in the current page", async () => {
    await popup.locator("#format").selectOption("exact");
    await waitForText(badge("tweet-second"),"粉丝 11,000");
  });
  await check("off hides badges; settings store only preferences", async () => {
    await popup.locator("#enabled").uncheck();
    await page.waitForFunction(()=>document.querySelectorAll("[data-xfc-badge]").length===0);
    const stored=await popup.evaluate(()=>chrome.storage.local.get(null));
    assert.deepEqual(stored,{enabled:false,format:"exact"});
  });
  await check("disabled setting persists across page refresh", async () => {
    await page.reload();
    await page.evaluate(()=>window.initialRequest);
    await page.waitForTimeout(300);
    assert.equal(await badgeCount(),0);
  });
  await check("enable resumes passive observation and restores compact display", async () => {
    await popup.locator("#format").selectOption("compact");
    await popup.locator("#enabled").check();
    await page.evaluate(url=>fetch(url).then(r=>r.json()),gql("HomeTimeline"));
    await waitForText(badge("tweet-main"),"粉丝 17.4万");
  });
  await check("SPA navigation keeps badges without a reload", async () => {
    await page.evaluate(()=>history.pushState({},"","/demo_174k/followers"));
    await page.evaluate(()=>window.demo.cell("demo_11k","新路由的条目","SPA 中的用户列表","spa-row"));
    await waitForText(badge("spa-row"),"粉丝 1.1万");
  });
  await check("twitter.com match loads the extension too", async () => {
    await page.goto("https://twitter.com/home");
    await waitForText(badge("tweet-main"),"粉丝 17.4万");
  });
  await check("extension creates no extra API/network requests or page errors", async () => {
    // 3 fixture page loads and 4 explicitly invoked synthetic requests.
    assert.equal(apiRequests.length,7,JSON.stringify(apiRequests));
    assert.deepEqual(unexpectedRequests,[]);
    assert.deepEqual(errors,[]);
  });
  const report={passed:true,scope:"Actual unpacked MV3 extension; synthetic X pages/responses only; no live account verification",checks,apiRequests:apiRequests.length,unexpectedRequests:unexpectedRequests.length,errors};
  writeFileSync(path.join(output,"qa-report.json"),JSON.stringify(report,null,2)+"\n");
  rmSync(path.join(output,"failure.png"),{force:true});
  console.log(JSON.stringify({passed:true,checks:checks.length,artifacts:output}));
} catch(error) {
  writeFileSync(path.join(output,"qa-report.json"),JSON.stringify({passed:false,checks,error:error.message},null,2)+"\n");
  if(page) await page.screenshot({path:path.join(output,"failure.png"),fullPage:true}).catch(()=>{});
  throw error;
} finally {
  await context?.close();
  rmSync(profile,{recursive:true,force:true});
}
