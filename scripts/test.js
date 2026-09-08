// Runs the offline suites.
//
// Why this exists rather than `node --test dist/test/*.test.js` in the npm
// script: that glob is expanded by the shell, and npm runs scripts through
// cmd.exe on Windows, which doesn't expand it. Passing a directory instead
// isn't portable either — Node 21 treats the argument as a file path. So we
// list the files ourselves and hand them over explicitly.
//
// dist/canary is deliberately not included. It's the only test that touches
// the network, and it runs on a schedule in CI.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join("dist", "test");

let files;
try {
  files = readdirSync(dir)
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => join(dir, name));
} catch {
  console.error(`No compiled tests in ${dir}. Run \`npm run build\` first.`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`No *.test.js files in ${dir}.`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
