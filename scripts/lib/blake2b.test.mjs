import test from "node:test";
import assert from "node:assert/strict";
import { blake2b, blake2b160, blake2b256 } from "./blake2b.mjs";
import { bytesToHex } from "./micheline.mjs";

test("RFC 7693 official BLAKE2b-512 test vectors", () => {
  // Empty string
  assert.equal(
    bytesToHex(blake2b("", 64), false),
    "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce",
  );
  // "abc" (RFC 7693 Appendix A)
  assert.equal(
    bytesToHex(blake2b("abc", 64), false),
    "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
  );
});

test("BLAKE2b-256 and BLAKE2b-160 standard test vectors", () => {
  assert.equal(
    bytesToHex(blake2b256(""), false),
    "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8",
  );
  assert.equal(
    bytesToHex(blake2b256("abc"), false),
    "bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319",
  );
  assert.equal(blake2b160("abc").length, 20);
  // Multi-block (>128 bytes) test
  const longMsg = new Uint8Array(300).fill(0x41);
  const digest = blake2b256(longMsg);
  assert.equal(digest.length, 32);
});
