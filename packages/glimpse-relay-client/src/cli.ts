#!/usr/bin/env node
import { openRelayedUrl, type GlimpseRelayedUrl } from "./index.js";

function printHelp(): void {
  console.log(`glimpse-relay-open

Open a client-reachable HTTP(S) URL in Glimpse on the relay host.

Usage:
  glimpse-relay-open <url>

Example:
  glimpse-relay-open http://localhost:9000/welcome

Allowed targets default to localhost and 127.0.0.1. Add exact hostnames with:
  GLIMPSE_RELAY_CLIENT_ALLOWED_HOSTS=google.com,bing.com
`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}
if (args.length !== 1) {
  printHelp();
  process.exitCode = 2;
} else {
  let session: GlimpseRelayedUrl | undefined;
  let stopping = false;

  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    session?.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    session = await openRelayedUrl(args[0]!);
    await new Promise<void>((resolve, reject) => {
      session!.once("closed", resolve);
      session!.once("error", reject);
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    session?.close();
  }
}
