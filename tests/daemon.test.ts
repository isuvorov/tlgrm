import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DAEMON_LABEL,
  daemonBundlePath,
  daemonPlistPath,
  renderBundleInfoPlist,
  renderBundleLauncher,
  renderDaemonPlist,
} from "../src/api/daemon.ts";

describe("daemon plist", () => {
  const plist = renderDaemonPlist({
    program: ["/opt/homebrew/bin/node", "/repo/lib/cli.js", "server"],
    workingDirectory: "/repo",
    logPath: "/logs/daemon.log",
    env: { PATH: "/usr/bin:/bin", HOME: "/Users/me" },
  });

  test("runs `server` under the tlgrm label, at load and kept alive", () => {
    assert.ok(plist.includes(`<string>${DAEMON_LABEL}</string>`));
    assert.ok(
      plist.includes("<string>/repo/lib/cli.js</string>\n    <string>server</string>"),
    );
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  });

  test("stdout and stderr both go to the daemon log", () => {
    assert.match(
      plist,
      /<key>StandardOutPath<\/key>\s*<string>\/logs\/daemon.log<\/string>/,
    );
    assert.match(
      plist,
      /<key>StandardErrorPath<\/key>\s*<string>\/logs\/daemon.log<\/string>/,
    );
  });

  test("escapes XML in paths", () => {
    const odd = renderDaemonPlist({
      program: ["/a&b/<node>"],
      workingDirectory: "/",
      logPath: "/l",
      env: {},
    });
    assert.ok(odd.includes("<string>/a&amp;b/&lt;node&gt;</string>"));
  });

  test("lives in ~/Library/LaunchAgents", () => {
    assert.equal(
      daemonPlistPath("/Users/me"),
      `/Users/me/Library/LaunchAgents/${DAEMON_LABEL}.plist`,
    );
  });
});

describe("daemon app bundle", () => {
  test("the plist ties the job to the bundle, so macOS shows tlgrm instead of node", () => {
    const plist = renderDaemonPlist({
      program: ["/x"],
      workingDirectory: "/",
      logPath: "/l",
      env: {},
    });
    assert.match(
      plist,
      new RegExp(
        `<key>AssociatedBundleIdentifiers</key>\\s*<array>\\s*<string>${DAEMON_LABEL}</string>`,
      ),
    );
  });

  test("Info.plist names the bundle and its icon, background-only", () => {
    const info = renderBundleInfoPlist();
    assert.match(
      info,
      new RegExp(`<key>CFBundleIdentifier</key>\\s*<string>${DAEMON_LABEL}</string>`),
    );
    assert.match(info, /<key>CFBundleName<\/key>\s*<string>tlgrm<\/string>/);
    assert.match(info, /<key>CFBundleIconFile<\/key>\s*<string>tlgrm<\/string>/);
    assert.match(info, /<key>LSBackgroundOnly<\/key>\s*<true\/>/);
  });

  test("the launcher execs node on `server`, quoting paths", () => {
    assert.equal(
      renderBundleLauncher("/opt/node", "/my dir/it's/cli.js"),
      "#!/bin/sh\nexec '/opt/node' '/my dir/it'\\''s/cli.js' server\n",
    );
  });

  test("lives in Application Support", () => {
    assert.equal(
      daemonBundlePath("/Users/me"),
      "/Users/me/Library/Application Support/tlgrm/tlgrm.app",
    );
  });
});
