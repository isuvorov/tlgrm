// Copies the version from package.json into src/constants.ts.
//
// VERSION is a literal there rather than a JSON import: constants.ts is loaded
// by every entry point, and reading package.json at import time would tie the
// CLI to a file layout that `files` does not guarantee. The cost is that the two
// can drift — so semantic-release runs this in its prepare step, and `npm run
// version:sync` does the same by hand.
//
// Exits non-zero when nothing was replaced: a silent no-op here would ship a
// release whose `--version` lies.
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf-8")) as {
  version: string;
};

const target = new URL("src/constants.ts", root);
const source = readFileSync(target, "utf-8");
const line = /^export const VERSION = ".*";$/m;

if (!line.test(source)) {
  console.error(`no VERSION declaration found in ${target.pathname}`);
  process.exit(1);
}

const updated = source.replace(line, `export const VERSION = "${pkg.version}";`);
if (updated !== source) writeFileSync(target, updated);
console.log(`VERSION = ${pkg.version}`);
