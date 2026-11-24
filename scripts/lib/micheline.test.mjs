import test from "node:test";
import assert from "node:assert/strict";
import {
  WEI_PER_MUTEZ,
  assertMutezAligned,
  bytesToHex,
  decodeMicheline,
  encodeBool,
  encodeBytes,
  encodeInt,
  encodeLeft,
  encodeNat,
  encodeNone,
  encodePair,
  encodeRight,
  encodeRightComb,
  encodeSequence,
  encodeSome,
  encodeString,
  encodeUnit,
  mutezToWei,
  packData,
  weiToMutez,
} from "./micheline.mjs";

test("encodeUnit matches Tezos X docs constant 0x030b", () => {
  assert.equal(bytesToHex(encodeUnit()), "0x030b");
  assert.deepEqual(decodeMicheline("0x030b"), { prim: "Unit" });
});

test("encodeBool matches True=0x030a and False=0x0303", () => {
  assert.equal(bytesToHex(encodeBool(true)), "0x030a");
  assert.equal(bytesToHex(encodeBool(false)), "0x0303");
  assert.deepEqual(decodeMicheline("0x030a"), { prim: "True" });
  assert.deepEqual(decodeMicheline("0x0303"), { prim: "False" });
});

test("encodeInt / encodeNat Zarith encoding & round-trip", () => {
  assert.equal(bytesToHex(encodeNat(0)), "0x0000");
  assert.equal(bytesToHex(encodeNat(1)), "0x0001");
  assert.equal(bytesToHex(encodeNat(63)), "0x003f");
  // 64 = 0b1_000000 -> first byte 0x80 (more=1, sign=0, lo6=0), second byte 0x01
  assert.equal(bytesToHex(encodeNat(64)), "0x008001");
  // -1 -> first byte 0x41 (sign=1, mag=1)
  assert.equal(bytesToHex(encodeInt(-1)), "0x0041");
  // 1_000_000 (1 XTZ in mutez)
  const oneTez = encodeNat(1_000_000);
  assert.deepEqual(decodeMicheline(oneTez), { int: "1000000" });

  // Large 256-bit value round-trip
  const big = (1n << 128n) + 123456789n;
  assert.deepEqual(decodeMicheline(encodeNat(big)), { int: big.toString() });
  assert.deepEqual(decodeMicheline(encodeInt(-big)), { int: (-big).toString() });

  assert.throws(() => encodeNat(-1), /non-negative/);
});

test("encodeString and encodeBytes round-trip", () => {
  const s = encodeString("hello-nac");
  assert.equal(bytesToHex(s), "0x010000000968656c6c6f2d6e6163");
  assert.deepEqual(decodeMicheline(s), { string: "hello-nac" });

  const b = encodeBytes("0xdeadbeef");
  assert.equal(bytesToHex(b), "0x0a00000004deadbeef");
  assert.deepEqual(decodeMicheline(b), { bytes: "deadbeef" });
});

test("encodePair, encodeRightComb, option, either, sequence, and packData", () => {
  const comb = encodeRightComb([
    encodeBytes("0x1122"),
    encodeBool(true),
    encodeNat(42),
  ]);
  assert.equal(bytesToHex(comb), "0x07070a0000000211220707030a002a");
  assert.deepEqual(decodeMicheline(comb), {
    prim: "Pair",
    args: [
      { bytes: "1122" },
      { prim: "Pair", args: [{ prim: "True" }, { int: "42" }] },
    ],
  });

  assert.deepEqual(decodeMicheline(encodeNone()), { prim: "None" });
  assert.deepEqual(decodeMicheline(encodeSome(encodeNat(7))), {
    prim: "Some",
    args: [{ int: "7" }],
  });
  assert.deepEqual(decodeMicheline(encodeLeft(encodeString("a"))), {
    prim: "Left",
    args: [{ string: "a" }],
  });
  assert.deepEqual(decodeMicheline(encodeRight(encodeUnit())), {
    prim: "Right",
    args: [{ prim: "Unit" }],
  });
  assert.deepEqual(decodeMicheline(encodeSequence([encodeNat(1), encodeNat(2)])), [
    { int: "1" },
    { int: "2" },
  ]);

  const packed = packData(encodeUnit());
  assert.equal(bytesToHex(packed), "0x05030b");
  assert.deepEqual(decodeMicheline(packed, { expectPackPrefix: true }), { prim: "Unit" });
});

test("assertMutezAligned & wei/mutez conversions prevent 10^12 truncation", () => {
  assert.equal(WEI_PER_MUTEZ, 1_000_000_000_000n);
  assert.equal(weiToMutez(0n), 0n);
  assert.equal(weiToMutez(10n ** 18n), 1_000_000n);
  assert.equal(mutezToWei(1_000_000n), 10n ** 18n);
  assert.equal(assertMutezAligned(5_000_000_000_000n), 5_000_000_000_000n);
  assert.throws(() => assertMutezAligned(10n ** 18n + 1n), /Sub-mutez precision loss/);
  assert.throws(() => weiToMutez(999_999_999_999n), /Sub-mutez precision loss/);
});
