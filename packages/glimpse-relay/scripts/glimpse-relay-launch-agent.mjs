#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "dev.glimpse-relay";
const DEFAULT_PORT = 7777;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = os.homedir();
const launchAgentsDir = join(home, "Library", "LaunchAgents");
const logsDir = join(home, "Library", "Logs");
const plistPath = join(launchAgentsDir, `${LABEL}.plist`);
const defaultTokenPath = join(home, ".glimpse-relay-token");
const tokenPath = process.env.GLIMPSE_RELAY_TOKEN_FILE || defaultTokenPath;

function usage() {
  console.log(`glimpse-relay launch agent

Usage:
  glimpse-relay install [--port 7777]
  glimpse-relay uninstall
  glimpse-relay status
  glimpse-relay env

Package scripts:
  npm run relay:install [-- --port 7777]
  npm run relay:uninstall
  npm run relay:status
  npm run relay:env
`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: options.stdio ?? "inherit",
    encoding: "utf8",
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.status ?? "unknown"}`);
  }
  return result;
}

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value != null && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  let port = parsePort(envValue("GLIMPSE_RELAY_PORT") || String(DEFAULT_PORT));

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--port" || arg === "-p") {
      const value = rest[i + 1];
      if (value == null || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      port = parsePort(value);
      i += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      port = parsePort(arg.slice("--port=".length));
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { command: "help", port };
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { command, port };
}

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function uid() {
  return String(process.getuid?.() ?? run("id", ["-u"], { stdio: "pipe" }).stdout.trim());
}

function serviceName() {
  return `gui/${uid()}/${LABEL}`;
}

function ensureMacOS() {
  if (process.platform !== "darwin") {
    throw new Error("LaunchAgent auto-start is only available on macOS. Run this on the Mac host, not in the container.");
  }
}

function ensureTokenFile() {
  if (!existsSync(tokenPath)) {
    writeFileSync(tokenPath, `${randomBytes(16).toString("hex")}\n`, { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    return;
  }

  const token = readFileSync(tokenPath, "utf8").trim();
  if (token.length === 0) {
    writeFileSync(tokenPath, `${randomBytes(16).toString("hex")}\n`, { mode: 0o600 });
  }
  chmodSync(tokenPath, 0o600);
}

function ensureGlimpseBuild() {
  const glimpseDir = join(root, "node_modules", "glimpseui");
  if (!existsSync(glimpseDir)) {
    console.log("Installing host dependencies...");
    run("npm", ["install"]);
  }

  const macHost = join(glimpseDir, "src", "glimpse");
  if (!existsSync(macHost)) {
    console.log("Building Glimpse macOS host binary...");
    run("npm", ["--prefix", glimpseDir, "run", "build:macos"]);
  }
}

function plistXml(port) {
  const nodePath = process.execPath;
  const relayPath = join(root, "bin", "glimpse-relay.mjs");
  const stdoutPath = join(logsDir, "glimpse-relay.log");
  const stderrPath = join(logsDir, "glimpse-relay.err.log");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(relayPath)}</string>
    <string>--docker</string>
    <string>--port</string>
    <string>${port}</string>
    <string>--token-file</string>
    <string>${escapeXml(tokenPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(root)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`;
}

function install(port) {
  ensureMacOS();
  ensureTokenFile();
  ensureGlimpseBuild();
  mkdirSync(launchAgentsDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(plistPath, plistXml(port), "utf8");

  run("launchctl", ["bootout", `gui/${uid()}`, plistPath], { allowFailure: true });
  run("launchctl", ["bootstrap", `gui/${uid()}`, plistPath]);
  run("launchctl", ["enable", serviceName()], { allowFailure: true });
  run("launchctl", ["kickstart", "-k", serviceName()], { allowFailure: true });

  console.log(`\nInstalled and started ${LABEL}`);
  printEnv(port);
}

function uninstall() {
  ensureMacOS();
  run("launchctl", ["bootout", `gui/${uid()}`, plistPath], { allowFailure: true });
  run("launchctl", ["disable", serviceName()], { allowFailure: true });
  rmSync(plistPath, { force: true });
  console.log(`Uninstalled ${LABEL}`);
  console.log(`Token file left in place: ${tokenPath}`);
}

function status() {
  ensureMacOS();
  run("launchctl", ["print", serviceName()], { allowFailure: true });
  console.log(`\nplist: ${plistPath}`);
  console.log(`logs: ${join(logsDir, "glimpse-relay.log")}`);
  console.log(`errors: ${join(logsDir, "glimpse-relay.err.log")}`);
}

function printEnv(port) {
  console.log(`\nContainer env:`);
  console.log(`export GLIMPSE_RELAY=host.docker.internal:${port}`);
  console.log(`export GLIMPSE_RELAY_TOKEN_FILE=${tokenPath}`);
  console.log(`\nIf that token file is not mounted in the container, use:`);
  console.log(`export GLIMPSE_RELAY_TOKEN="$(cat ${tokenPath})"`);
  console.log(`\nLogs:`);
  console.log(`tail -f ${join(logsDir, "glimpse-relay.log")}`);
}

try {
  const { command, port } = parseArgs(process.argv.slice(2));

  if (command === "install") install(port);
  else if (command === "uninstall") uninstall();
  else if (command === "status") status();
  else if (command === "env") printEnv(port);
  else {
    usage();
    process.exit(command === "help" ? 0 : 1);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
