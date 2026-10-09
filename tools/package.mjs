import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.length !== 2) throw new Error("This packager accepts no arguments.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src");
const version = JSON.parse(readFileSync(path.join(source, "manifest.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Unexpected release version.");
const dist = path.join(root, "dist");
const output = path.join(dist, `x-inline-followers-${version}`);
const archive = `${output}.zip`;
const files = ["manifest.json", "observer.js", "content.js", "badges.css", "popup.html", "popup.css", "popup.js"];
for (const file of [source, dist, output, archive, path.join(source,"core.js"), ...files.map((name) => path.join(source, name)), ...files.map((name) => path.join(output, name))]) {
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error("Refusing symbolic link in release paths.");
}
mkdirSync(output, { recursive: true });
const core = readFileSync(path.join(source,"core.js"),"utf8");
for (const file of files) {
  if(file === "observer.js" || file === "content.js") {
    writeFileSync(path.join(output,file),core+"\n"+readFileSync(path.join(source,file),"utf8"));
  } else {
    copyFileSync(path.join(source, file), path.join(output, file));
  }
}
execFileSync("/usr/bin/zip", ["-q", "-X", archive, ...files], { cwd: output });
const entries = execFileSync("/usr/bin/unzip", ["-Z1", archive], { encoding: "utf8" }).trim().split("\n").sort();
if (JSON.stringify(entries) !== JSON.stringify([...files].sort())) throw new Error("Unexpected archive contents; review before delivery.");
console.log(JSON.stringify({ unpacked: output, zip: archive, files: entries.length }, null, 2));
