import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pi = process.platform === "win32" ? "pi.cmd" : "pi";

console.log(`Building ${root} ...`);
execFileSync(npm, ["run", "build"], { cwd: root, stdio: "inherit" });

console.log("Installing the built package into pi ...");
execFileSync(pi, ["install", root], { stdio: "inherit" });

console.log("Done. Restart pi or run /reload.");
