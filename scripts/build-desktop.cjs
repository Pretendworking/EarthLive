// Build a versioned desktop folder. Pass an output directory as the first argument.
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const version = require("../package.json").version;
const output = path.resolve(process.argv[2] || path.join(root, "release", `EarthLive-${version}`));
const cli = require.resolve("electron-builder/cli.js");
const electronDist = path.join(path.dirname(require.resolve("electron/package.json")), "dist");
const result = spawnSync(process.execPath, [cli, "--win", "--dir", "--publish", "never", `--config.directories.output=${output}`, `--config.electronDist=${electronDist}`], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
const executable = path.join(output, "win-unpacked", `EarthLive-${version}.exe`);
fs.copyFileSync(path.join(output, "win-unpacked", "EarthLive.exe"), executable);
fs.writeFileSync(path.join(output, "build-info.json"), JSON.stringify({ version, builtAt: new Date().toISOString(), executable }, null, 2));
console.log(`Ready: ${executable}`);
console.log("Point the EarthLive desktop shortcut at this executable; keep the whole win-unpacked folder together.");
