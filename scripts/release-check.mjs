import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function run(command, args) {
  console.log(`> ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit" });
}

function runNpm(args) {
  if (process.platform === "win32") {
    console.log(`> npm.cmd ${args.join(" ")}`);
    execFileSync("cmd.exe", ["/d", "/s", "/c", "npm.cmd", ...args], { stdio: "inherit" });
    return;
  }

  run("npm", args);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));

if (pkg.version !== manifest.version) {
  throw new Error(`package.json version ${pkg.version} does not match manifest.json version ${manifest.version}`);
}
if (!(pkg.version in versions)) {
  throw new Error(`versions.json is missing ${pkg.version}`);
}

runNpm(["test"]);
runNpm(["run", "build"]);

console.log(`Release check passed for ${pkg.version}.`);
