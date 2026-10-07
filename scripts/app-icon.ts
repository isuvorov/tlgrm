// Regenerates the icons derived from docs/icon.png (the pixel circle without the wordmark):
// assets/tlgrm.icns — the icon of the daemon's .app bundle and its launcher (api/daemon.ts),
// assets/favicon.png — the tab icon of the web client (http.ts serves it at /favicon.ico).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const icon = join(root, "docs", "icon.png");
const assets = join(root, "assets");
const work = mkdtempSync(join(root, ".tmp-icon-"));

function run(cmd: string, args: string[]) {
  const result = spawnSync(cmd, args, { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${result.stderr}`);
}

const resize = (size: number, out: string) =>
  run("sips", ["-z", `${size}`, `${size}`, icon, "--out", out]);

try {
  mkdirSync(assets, { recursive: true });

  const iconset = join(work, "tlgrm.iconset");
  mkdirSync(iconset);
  // Up to 256@2x: Login Items and Finder lists never need more, and 1024px doubles the file.
  for (const size of [16, 32, 128, 256]) {
    resize(size, join(iconset, `icon_${size}x${size}.png`));
    resize(size * 2, join(iconset, `icon_${size}x${size}@2x.png`));
  }
  const icns = join(assets, "tlgrm.icns");
  run("iconutil", ["-c", "icns", iconset, "-o", icns]);
  console.log(`wrote ${icns}`);

  const favicon = join(assets, "favicon.png");
  resize(64, favicon);
  console.log(`wrote ${favicon}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
