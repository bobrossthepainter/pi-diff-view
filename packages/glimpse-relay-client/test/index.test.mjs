import assert from "node:assert/strict";
import test from "node:test";
import {
  getRelayClientAllowedHosts,
  openRelayedUrl,
} from "../dist/index.js";

const ENV_NAME = "GLIMPSE_RELAY_CLIENT_ALLOWED_HOSTS";

function withAllowedHosts(value, run) {
  const previous = process.env[ENV_NAME];
  if (value == null) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = value;
  try {
    return run();
  } finally {
    if (previous == null) delete process.env[ENV_NAME];
    else process.env[ENV_NAME] = previous;
  }
}

test("allowed target hosts include loopback defaults", () => {
  withAllowedHosts(undefined, () => {
    assert.deepEqual(getRelayClientAllowedHosts(), ["localhost", "127.0.0.1"]);
  });
});

test("allowed target hosts add normalized exact environment entries", () => {
  withAllowedHosts(" Google.COM, bing.com,localhost, ", () => {
    assert.deepEqual(getRelayClientAllowedHosts(), ["localhost", "127.0.0.1", "google.com", "bing.com"]);
  });
});

test("openRelayedUrl rejects disallowed hosts before connecting", async () => {
  await withAllowedHosts(undefined, async () => {
    await assert.rejects(
      openRelayedUrl("http://example.com:9000/welcome"),
      /Refusing to relay disallowed host 'example\.com'/,
    );
  });
});

test("openRelayedUrl only accepts HTTP and HTTPS", async () => {
  await assert.rejects(openRelayedUrl("file:///tmp/index.html"), /Only http: and https: are supported/);
});
