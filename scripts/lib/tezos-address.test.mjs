import test from "node:test";
import assert from "node:assert/strict";
import {
  base58CheckDecode,
  base58CheckEncode,
  bigMapKeyExpr,
  buildNacCanaryInitialStorage,
  encodeTezosAddressBytes,
  isValidEvmAddress,
  isValidTezosXAddress,
  natBigMapKeyExpr,
} from "./tezos-address.mjs";
import { bytesToHex, encodeNat, encodeString } from "./micheline.mjs";

test("Tezos X address validation accepts tz1/tz2/tz3/KT1 and rejects tz4 & bad checksums", () => {
  assert.equal(isValidTezosXAddress("tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb"), true);
  assert.equal(isValidTezosXAddress("KT18oDJJKXMKhfE1bSuAPGp92pYcwVDiqsPw"), true);
  assert.equal(isValidTezosXAddress("tz1Ke2h7sDdakHJQh8WX4Z372du1KChsksyU"), true);
  // Corrupted checksum
  assert.equal(isValidTezosXAddress("tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcja"), false);
  // tz4 (BLS) explicitly rejected for Tezos X / Etherlink Michelson interface
  assert.equal(isValidTezosXAddress("tz4F2fxv7s644v2W8sA4yH7q2J1c9s5K3m8P9x"), false);
  // EVM address validation
  assert.equal(isValidEvmAddress("0xff00000000000000000000000000000000000007"), true);
  assert.equal(isValidEvmAddress("0x1234"), false);
});

test("encodeTezosAddressBytes produces canonical 22-byte Michelson address encoding", () => {
  const tz1Bytes = encodeTezosAddressBytes("tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb");
  assert.equal(tz1Bytes.length, 22);
  assert.equal(tz1Bytes[0], 0x00);
  assert.equal(tz1Bytes[1], 0x00);

  const kt1Bytes = encodeTezosAddressBytes("KT18oDJJKXMKhfE1bSuAPGp92pYcwVDiqsPw");
  assert.equal(kt1Bytes.length, 22);
  assert.equal(kt1Bytes[0], 0x01);
  assert.equal(kt1Bytes[21], 0x00);
});

test("natBigMapKeyExpr matches canonical Tezos script_expr hash vectors", () => {
  // Canonical Tezos vector: PACK(0: nat) = 0x050000 -> exprtZBwZUeYYYfUs9B9Rg2ywHezVHnCCnmF9WsDQVrs582dSK63dC
  assert.equal(natBigMapKeyExpr(0), "exprtZBwZUeYYYfUs9B9Rg2ywHezVHnCCnmF9WsDQVrs582dSK63dC");
  // PACK(1: nat) = 0x050001 -> expru2dKqDfZG8hu4wNGkiyunvq2hdSKuVYtcKta7BWP6Q18oNxKjS
  assert.equal(natBigMapKeyExpr(1), "expru2dKqDfZG8hu4wNGkiyunvq2hdSKuVYtcKta7BWP6Q18oNxKjS");
  assert.equal(bigMapKeyExpr(encodeNat(1)), natBigMapKeyExpr(1));

  // Verify Base58Check round-trip on string key expr
  const strExpr = bigMapKeyExpr(encodeString("ping"));
  assert.ok(strExpr.startsWith("expr"));
  const decoded = base58CheckDecode(strExpr);
  assert.equal(decoded.length, 36); // 4-byte prefix + 32-byte blake2b256
  assert.equal(base58CheckEncode(decoded), strExpr);
  assert.equal(bytesToHex(decoded.subarray(0, 4)), "0x0d2c401b");
});

test("buildNacCanaryInitialStorage matches 9-field right-comb storage and rejects invalid addresses", () => {
  const admin = "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb";
  const gw = "KT18oDJJKXMKhfE1bSuAPGp92pYcwVDiqsPw";
  const init = buildNacCanaryInitialStorage(admin, gw);
  assert.equal(
    init,
    `(Pair "${admin}" (Pair "${gw}" (Pair 0 (Pair "" (Pair "${admin}" (Pair "${admin}" (Pair "" (Pair 0 {}))))))))`,
  );
  // Rejects KT1 as admin, tz4 as admin, or tz1 as gateway
  assert.throws(() => buildNacCanaryInitialStorage(gw, gw), /Invalid NacCanary admin/);
  assert.throws(() => buildNacCanaryInitialStorage("tz4F2fxv7s644v2W8sA4yH7q2J1c9s5K3m8P9x", gw), /Invalid NacCanary admin/);
  assert.throws(() => buildNacCanaryInitialStorage(admin, admin), /Invalid Michelson EVM gateway/);
});
