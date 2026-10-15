/**
 * Prüft die Signatur der Wiedergabe-Links (`src/lib/audio.ts`): Ein mit dem
 * früheren festen Entwicklungsschlüssel signiertes Token wird abgelehnt, und
 * ohne AUTH_SECRET verweigert die Signatur den Dienst.
 *
 * Aufruf: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { signPlaybackToken, verifyPlaybackToken } from "../src/lib/audio";

const RECORDING = "aufnahme-1";
const EMAIL = "samir.weber@immotrustag.ch";

function withSecret<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.AUTH_SECRET;
  if (value === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previous;
  }
}

test("Token mit dem alten Entwicklungsschlüssel wird abgelehnt", () => {
  const expires = Date.now() + 60_000;
  const forged = createHmac("sha256", "entwicklungs-geheimnis")
    .update(`${RECORDING}.${EMAIL}.${expires}`)
    .digest("base64url");
  withSecret("test-geheimnis-" + Math.random(), () => {
    assert.equal(verifyPlaybackToken(`${expires}.${forged}`, RECORDING, EMAIL), false);
  });
});

test("Gültiges Token wird angenommen", () => {
  withSecret("test-geheimnis", () => {
    const token = signPlaybackToken(RECORDING, EMAIL);
    assert.equal(verifyPlaybackToken(token, RECORDING, EMAIL), true);
    assert.equal(verifyPlaybackToken(token, "andere-aufnahme", EMAIL), false);
  });
});

test("Ohne AUTH_SECRET wird nicht signiert", () => {
  withSecret(undefined, () => {
    assert.throws(() => signPlaybackToken(RECORDING, EMAIL), /AUTH_SECRET ist nicht gesetzt/);
    assert.throws(() => verifyPlaybackToken(`${Date.now() + 60_000}.x`, RECORDING, EMAIL), /AUTH_SECRET/);
  });
  withSecret("", () => {
    assert.throws(() => signPlaybackToken(RECORDING, EMAIL), /AUTH_SECRET ist nicht gesetzt/);
  });
});
