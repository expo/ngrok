#!/usr/bin/env node

let path = require("path");
let fs = require("fs");
let { execFileSync } = require("child_process");

let ngrokBin = path.join(
  __dirname,
  `../packages/ngrok-bin-${process.platform}-${process.arch}/ngrok`,
);
let ngrokVersion =
  execFileSync(ngrokBin, ["--version"])
    .toString()
    .trim()
    .replace(/^ngrok version /, "");
let platforms = fs
  .readFileSync("./scripts/platforms.txt", "utf8")
  .trim()
  .split("\n");

let mainPkg = require("../packages/ngrok-bin/package.json");
mainPkg.version = ngrokVersion;

for (let platform of platforms) {
  let name = `@expo/ngrok-bin-${platform}`;
  let [os, arch] = platform.split('-');
  let pkg;
  try {
    pkg = require(`../packages/ngrok-bin-${platform}/package.json`);
  } catch (e) {
    pkg = {
      name,
      description: `ngrok binary for ${platform}`,
      repository: {
        type: "git",
        url: "https://github.com/expo/ngrok.git",
        directory: `packages/${name}`,
      },
      os: [os],
      cpu: [arch],
    };
  }
  pkg.name = pkg.name || name;
  pkg.version = ngrokVersion;
  mainPkg.optionalDependencies[name] = ngrokVersion;
  fs.writeFileSync(
    `./packages/ngrok-bin-${platform}/package.json`,
    JSON.stringify(pkg, null, 2) + "\n",
  );
}
fs.writeFileSync(
  `./packages/ngrok-bin/package.json`,
  JSON.stringify(mainPkg, null, 2) + "\n",
);
