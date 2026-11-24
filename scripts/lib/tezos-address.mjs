/**
 * Tezos Base58Check, address validation, and big_map script_expr key hashing (MIT License, zero dependencies).
 */

import { createHash } from "node:crypto";
import { blake2b256 } from "./blake2b.mjs";
import { concatBytes, encodeNat, packData } from "./micheline.mjs";

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = new Map([...B58_ALPHABET].map((ch, idx) => [ch, BigInt(idx)]));

export const TEZOS_PREFIX = {
  tz1: new Uint8Array([6, 161, 159]),
  tz2: new Uint8Array([6, 161, 161]),
  tz3: new Uint8Array([6, 161, 164]),
  KT1: new Uint8Array([2, 90, 121]),
  expr: new Uint8Array([13, 44, 64, 27]),
};

function doubleSha256(bytes) {
  const first = createHash("sha256").update(bytes).digest();
  return new Uint8Array(createHash("sha256").update(first).digest());
}

export function base58Encode(bytes) {
  let num = 0n;
  for (const b of bytes) num = (num << 8n) | BigInt(b);
  let out = "";
  while (num > 0n) {
    const rem = Number(num % 58n);
    num /= 58n;
    out = B58_ALPHABET[rem] + out;
  }
  for (const b of bytes) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out || "1";
}

export function base58Decode(str) {
  let num = 0n;
  for (const ch of str) {
    const val = B58_MAP.get(ch);
    if (val === undefined) throw new Error(`Invalid Base58 character: '${ch}'`);
    num = num * 58n + val;
  }
  const bytes = [];
  while (num > 0n) {
    bytes.push(Number(num & 0xffn));
    num >>= 8n;
  }
  bytes.reverse();
  let leadingZeros = 0;
  for (const ch of str) {
    if (ch === "1") leadingZeros++;
    else break;
  }
  return concatBytes(new Uint8Array(leadingZeros), new Uint8Array(bytes));
}

export function base58CheckEncode(payload) {
  const checksum = doubleSha256(payload).subarray(0, 4);
  return base58Encode(concatBytes(payload, checksum));
}

export function base58CheckDecode(str) {
  const raw = base58Decode(str);
  if (raw.length < 5) throw new Error(`Base58Check payload too short: ${str}`);
  const payload = raw.subarray(0, raw.length - 4);
  const checksum = raw.subarray(raw.length - 4);
  const expected = doubleSha256(payload).subarray(0, 4);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expected[i]) {
      throw new Error(`Invalid Base58Check checksum for '${str}'`);
    }
  }
  return payload;
}

/**
 * Validate Tezos addresses supported on Tezos X / Etherlink Michelson interface.
 * Explicitly rejects tz4 (BLS addresses are NOT supported on Etherlink Michelson).
 */
export function isValidTezosXAddress(addr) {
  if (typeof addr !== "string") return false;
  if (!/^(tz[123]|KT1)[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr)) return false;
  try {
    const payload = base58CheckDecode(addr);
    return payload.length === 23;
  } catch {
    return false;
  }
}

export function isValidEvmAddress(addr) {
  return typeof addr === "string" && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

/**
 * Encode tz1/tz2/tz3/KT1 into canonical 22-byte Michelson PACK address bytes.
 * Implicit: 0x00 || (0x00=tz1 | 0x01=tz2 | 0x02=tz3) || 20-byte pkh
 * Originated: 0x01 || 20-byte hash || 0x00
 */
export function encodeTezosAddressBytes(addr) {
  if (!isValidTezosXAddress(addr)) {
    throw new Error(`Unsupported or invalid Tezos X address: ${addr}`);
  }
  const payload = base58CheckDecode(addr);
  const hash20 = payload.subarray(3);
  if (addr.startsWith("tz1")) return concatBytes(new Uint8Array([0x00, 0x00]), hash20);
  if (addr.startsWith("tz2")) return concatBytes(new Uint8Array([0x00, 0x01]), hash20);
  if (addr.startsWith("tz3")) return concatBytes(new Uint8Array([0x00, 0x02]), hash20);
  if (addr.startsWith("KT1")) return concatBytes(new Uint8Array([0x01]), hash20, new Uint8Array([0x00]));
  throw new Error(`Unsupported address prefix: ${addr}`);
}

/**
 * Compute Tezos big_map key expression hash (`expr...`) from an already-encoded Micheline key
 * (without leading 0x05 watermark; `packData` prepends 0x05).
 */
export function bigMapKeyExpr(encodedMichelineKey) {
  const packed = packData(encodedMichelineKey);
  const hash = blake2b256(packed);
  return base58CheckEncode(concatBytes(TEZOS_PREFIX.expr, hash));
}

/** Convenience helper for nat-keyed big_maps (e.g., NacCanary `pings[ping_count]`). */
export function natBigMapKeyExpr(natValue) {
  return bigMapKeyExpr(encodeNat(natValue));
}

/**
 * Construct the exact 9-field right-comb Michelson initial storage for `NacCanary`
 * (`contracts/michelson/artifacts/nac_canary/step_001_cont_0_contract.tz`)
 * using the live deployer's tz1/tz2/tz3 address so `%set_paired_evm` passes `NOT_ADMIN`.
 */
export function buildNacCanaryInitialStorage(adminAddress, gatewayAddress) {
  if (!isValidTezosXAddress(adminAddress) || !adminAddress.startsWith("tz")) {
    throw new Error(`Invalid NacCanary admin address (expected tz1/tz2/tz3): ${adminAddress}`);
  }
  if (!isValidTezosXAddress(gatewayAddress) || !gatewayAddress.startsWith("KT1")) {
    throw new Error(`Invalid Michelson EVM gateway address (expected KT1): ${gatewayAddress}`);
  }
  return `(Pair "${adminAddress}" (Pair "${gatewayAddress}" (Pair 0 (Pair "" (Pair "${adminAddress}" (Pair "${adminAddress}" (Pair "" (Pair 0 {}))))))))`;
}
