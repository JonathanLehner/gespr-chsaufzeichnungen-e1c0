/**
 * Wiedergabe-Tokens: nur mit AUTH_SECRET signiert, kein eingebauter Ersatzwert.
 *
 * Aufruf: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { signPlaybackToken, verifyPlaybackToken } from "../src/lib/audio";

const RECORDING_ID = "aufnahme-1";
const EMAIL = "samir.weber@immotrustag.ch";

function withSecret(value: string | undefined, run: () => void) {
  const previous = process.env.AUTH_SECRET;
  if (value === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previous;
  }
}

function forge(secret: string): string {
  const expires = Date.now() + 60_000;
  const signature = createHmac("sha256", secret)
    .update(`${RECORDING_ID}.${EMAIL}.${expires}`)
    .digest("base64url");
  return `${expires}.${signature}`;
}

test("mit AUTH_SECRET signierte Tokens werden angenommen", () => {
  withSecret("test-geheimnis-1234567890", () => {
    const token = signPlaybackToken(RECORDING_ID, EMAIL);
    assert.equal(verifyPlaybackToken(token, RECORDING_ID, EMAIL), true);
    assert.equal(verifyPlaybackToken(token, "andere-aufnahme", EMAIL), false);
  });
});

test("mit dem früheren Standardwert gefälschte Tokens werden abgelehnt", () => {
  withSecret("test-geheimnis-1234567890", () => {
    assert.equal(verifyPlaybackToken(forge("entwicklungs-geheimnis"), RECORDING_ID, EMAIL), false);
  });
});

test("ohne AUTH_SECRET wird weder signiert noch geprüft", () => {
  for (const value of [undefined, "", "   "]) {
    withSecret(value, () => {
      assert.throws(() => signPlaybackToken(RECORDING_ID, EMAIL), /AUTH_SECRET ist nicht gesetzt/);
      assert.throws(
        () => verifyPlaybackToken(forge("entwicklungs-geheimnis"), RECORDING_ID, EMAIL),
        /AUTH_SECRET ist nicht gesetzt/,
      );
    });
  }
});
