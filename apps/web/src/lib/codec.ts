import { NULL_SOURCE_ADDRESS } from './networks';
import type { CodecInput, CodecResult, GuardrailNote } from './types';

export const WEI_PER_MUTEZ = 1_000_000_000_000n;
export const MAX_UINT256 = (1n << 256n) - 1n;

// ---------------------------------------------------------------------------
// Byte & Hex Utilities (100% browser-safe, zero Buffer / node:* imports)
// ---------------------------------------------------------------------------
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, '');
  if (clean.length === 0) return new Uint8Array(0);
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`Invalid hex string: '${hex}'`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array, withPrefix = true): string {
  let out = withPrefix ? '0x' : '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function uint32BE(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new RangeError(`uint32 out of range: ${n}`);
  }
  return new Uint8Array([
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ]);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) {
    throw new Error(`Unexpected EOF reading uint32 at offset ${offset}`);
  }
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

// ---------------------------------------------------------------------------
// Pure-TS Synchronous SHA-256 (FIPS 180-4) for Base58Check
// ---------------------------------------------------------------------------
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256(data: Uint8Array): Uint8Array {
  const bitLen = BigInt(data.length) * 8n;
  const rem = (data.length + 9) % 64;
  const padLen = rem === 0 ? 0 : 64 - rem;
  const buf = new Uint8Array(data.length + 9 + padLen);
  buf.set(data, 0);
  buf[data.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(buf.length - 8, Number((bitLen >> 32n) & 0xffffffffn), false);
  view.setUint32(buf.length - 4, Number(bitLen & 0xffffffffn), false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < buf.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
}

function doubleSha256(bytes: Uint8Array): Uint8Array {
  return sha256(sha256(bytes));
}

// ---------------------------------------------------------------------------
// Pure-TS RFC 7693 BLAKE2b (for Tezos big_map script_expr key hashing)
// ---------------------------------------------------------------------------
const MASK64 = 0xffffffffffffffffn;

const BLAKE2B_IV = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
];

const BLAKE2B_SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

function rotr64(x: bigint, n: number): bigint {
  const s = BigInt(n);
  return ((x >> s) | (x << (64n - s))) & MASK64;
}

function readU64LE(buf: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    v |= BigInt(buf[offset + i]) << BigInt(8 * i);
  }
  return v;
}

function mixG(v: bigint[], a: number, b: number, c: number, d: number, x: bigint, y: bigint): void {
  v[a] = (v[a] + v[b] + x) & MASK64;
  v[d] = rotr64(v[d] ^ v[a], 32);
  v[c] = (v[c] + v[d]) & MASK64;
  v[b] = rotr64(v[b] ^ v[c], 24);
  v[a] = (v[a] + v[b] + y) & MASK64;
  v[d] = rotr64(v[d] ^ v[a], 16);
  v[c] = (v[c] + v[d]) & MASK64;
  v[b] = rotr64(v[b] ^ v[c], 63);
}

function blake2bCompress(
  h: bigint[],
  block: Uint8Array,
  tLow: bigint,
  tHigh: bigint,
  isLast: boolean,
): void {
  const m = new Array<bigint>(16);
  for (let i = 0; i < 16; i++) m[i] = readU64LE(block, i * 8);

  const v = new Array<bigint>(16);
  for (let i = 0; i < 8; i++) {
    v[i] = h[i];
    v[i + 8] = BLAKE2B_IV[i];
  }
  v[12] ^= tLow & MASK64;
  v[13] ^= tHigh & MASK64;
  if (isLast) v[14] ^= MASK64;

  for (let r = 0; r < 12; r++) {
    const s = BLAKE2B_SIGMA[r];
    mixG(v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
    mixG(v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
    mixG(v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
    mixG(v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
    mixG(v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
    mixG(v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
    mixG(v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
    mixG(v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
  }

  for (let i = 0; i < 8; i++) {
    h[i] ^= v[i] ^ v[i + 8];
  }
}

export function blake2b(input: Uint8Array | string, outlen = 32): Uint8Array {
  if (outlen < 1 || outlen > 64) {
    throw new RangeError(`BLAKE2b outlen must be 1..64, got ${outlen}`);
  }
  const data = typeof input === 'string' ? textEncoder.encode(input) : input;
  const h = BLAKE2B_IV.slice();
  h[0] ^= 0x01010000n ^ BigInt(outlen);

  let offset = 0;
  let tLow = 0n;
  let tHigh = 0n;

  while (data.length - offset > 128) {
    tLow = (tLow + 128n) & MASK64;
    if (tLow < 128n) tHigh = (tHigh + 1n) & MASK64;
    blake2bCompress(h, data.subarray(offset, offset + 128), tLow, tHigh, false);
    offset += 128;
  }

  const lastBlock = new Uint8Array(128);
  const remaining = data.length - offset;
  if (remaining > 0) lastBlock.set(data.subarray(offset));
  const remBig = BigInt(remaining);
  tLow = (tLow + remBig) & MASK64;
  if (tLow < remBig) tHigh = (tHigh + 1n) & MASK64;
  blake2bCompress(h, lastBlock, tLow, tHigh, true);

  const out = new Uint8Array(outlen);
  for (let i = 0; i < outlen; i++) {
    out[i] = Number((h[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn);
  }
  return out;
}

export function blake2b256(input: Uint8Array | string): Uint8Array {
  return blake2b(input, 32);
}

// ---------------------------------------------------------------------------
// Pure-TS Keccak-256 (Ethereum / Solidity ABI selectors)
// ---------------------------------------------------------------------------
const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const KECCAK_ROTC = [
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14,
  27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
];
const KECCAK_PILN = [
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4,
  15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
];

function rotl64(x: bigint, n: number): bigint {
  const s = BigInt(n);
  return ((x << s) | (x >> (64n - s))) & MASK64;
}

function keccakF1600(st: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    const bc = new Array<bigint>(5);
    for (let i = 0; i < 5; i++) {
      bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
    }
    for (let i = 0; i < 5; i++) {
      const t = bc[(i + 4) % 5] ^ rotl64(bc[(i + 1) % 5], 1);
      for (let j = 0; j < 25; j += 5) st[j + i] ^= t;
    }
    let t = st[1];
    for (let i = 0; i < 24; i++) {
      const j = KECCAK_PILN[i];
      bc[0] = st[j];
      st[j] = rotl64(t, KECCAK_ROTC[i]);
      t = bc[0];
    }
    for (let j = 0; j < 25; j += 5) {
      for (let i = 0; i < 5; i++) bc[i] = st[j + i];
      for (let i = 0; i < 5; i++) {
        st[j + i] ^= (~bc[(i + 1) % 5] & MASK64) & bc[(i + 2) % 5];
      }
    }
    st[0] ^= KECCAK_RC[round];
  }
}

export function keccak256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? textEncoder.encode(input) : input;
  const rate = 136;
  const st = new Array<bigint>(25).fill(0n);
  const paddedLen = Math.ceil((bytes.length + 1) / rate) * rate;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[bytes.length] = 0x01;
  buf[paddedLen - 1] |= 0x80;

  for (let offset = 0; offset < buf.length; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 0; b < 8; b++) {
        lane |= BigInt(buf[offset + i * 8 + b]) << BigInt(8 * b);
      }
      st[i] ^= lane;
    }
    keccakF1600(st);
  }
  let out = '';
  for (let i = 0; i < 4; i++) {
    const lane = st[i];
    for (let b = 0; b < 8; b++) {
      out += Number((lane >> BigInt(8 * b)) & 0xffn)
        .toString(16)
        .padStart(2, '0');
    }
  }
  return out;
}

export function selectorOf(signature: string): string {
  return '0x' + keccak256Hex(signature).slice(0, 8);
}

// ---------------------------------------------------------------------------
// Base58Check & Tezos X Address Validation / Canonical Encoding
// ---------------------------------------------------------------------------
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Map<string, bigint>(
  [...B58_ALPHABET].map((ch, idx) => [ch, BigInt(idx)]),
);

const TEZOS_PREFIX = {
  expr: new Uint8Array([13, 44, 64, 27]),
};

export function base58Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (const b of bytes) num = (num << 8n) | BigInt(b);
  let out = '';
  while (num > 0n) {
    const rem = Number(num % 58n);
    num /= 58n;
    out = B58_ALPHABET[rem] + out;
  }
  for (const b of bytes) {
    if (b === 0) out = '1' + out;
    else break;
  }
  return out || '1';
}

export function base58Decode(str: string): Uint8Array {
  let num = 0n;
  for (const ch of str) {
    const val = B58_MAP.get(ch);
    if (val === undefined) throw new Error(`Invalid Base58 character: '${ch}'`);
    num = num * 58n + val;
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.push(Number(num & 0xffn));
    num >>= 8n;
  }
  bytes.reverse();
  let leadingZeros = 0;
  for (const ch of str) {
    if (ch === '1') leadingZeros++;
    else break;
  }
  return concatBytes(new Uint8Array(leadingZeros), new Uint8Array(bytes));
}

export function base58CheckEncode(payload: Uint8Array): string {
  const checksum = doubleSha256(payload).subarray(0, 4);
  return base58Encode(concatBytes(payload, checksum));
}

export function base58CheckDecode(str: string): Uint8Array {
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

/** Explicit detector for tz4 (BLS12-381) addresses — unsupported on Tezos X Michelson runtime. */
export function isTz4Address(addr: string): boolean {
  return typeof addr === 'string' && /^tz4[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr.trim());
}

/** Validate Tezos X supported addresses (tz1, tz2, tz3, KT1) with Base58Check verification. Rejects tz4. */
export function isValidTezosXAddress(addr: string): boolean {
  if (typeof addr !== 'string') return false;
  const trimmed = addr.trim();
  if (!/^(tz[123]|KT1)[1-9A-HJ-NP-Za-km-z]{33}$/.test(trimmed)) return false;
  try {
    const payload = base58CheckDecode(trimmed);
    return payload.length === 23;
  } catch {
    return false;
  }
}

export function isValidEvmAddress(addr: string): boolean {
  return typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr.trim());
}

/**
 * Canonical 22-byte Michelson PACK address bytes:
 * - Implicit: 0x00 || (0x00=tz1 | 0x01=tz2 | 0x02=tz3) || 20-byte pkh
 * - Originated: 0x01 || 20-byte hash || 0x00
 */
export function encodeTezosAddressBytes(addr: string): Uint8Array {
  const trimmed = addr.trim();
  if (isTz4Address(trimmed)) {
    throw new Error(
      `BLS tz4 address '${trimmed}' is not supported on Tezos X / Etherlink Michelson runtime`,
    );
  }
  if (!isValidTezosXAddress(trimmed)) {
    throw new Error(`Invalid Tezos X address: '${addr}'`);
  }
  const payload = base58CheckDecode(trimmed);
  const hash20 = payload.subarray(3);
  if (trimmed.startsWith('tz1')) return concatBytes(new Uint8Array([0x00, 0x00]), hash20);
  if (trimmed.startsWith('tz2')) return concatBytes(new Uint8Array([0x00, 0x01]), hash20);
  if (trimmed.startsWith('tz3')) return concatBytes(new Uint8Array([0x00, 0x02]), hash20);
  if (trimmed.startsWith('KT1')) {
    return concatBytes(new Uint8Array([0x01]), hash20, new Uint8Array([0x00]));
  }
  throw new Error(`Unsupported Tezos address prefix: '${trimmed}'`);
}

// ---------------------------------------------------------------------------
// Binary Micheline Codec (with Prim_N 0x09 & Annotated Prim Decoding)
// ---------------------------------------------------------------------------
const TAG_INT = 0x00;
const TAG_STRING = 0x01;
const TAG_SEQ = 0x02;
const TAG_PRIM_0 = 0x03;
const TAG_PRIM_0_ANNOT = 0x04;
const TAG_PRIM_1 = 0x05;
const TAG_PRIM_1_ANNOT = 0x06;
const TAG_PRIM_2 = 0x07;
const TAG_PRIM_2_ANNOT = 0x08;
const TAG_PRIM_N = 0x09;
const TAG_BYTES = 0x0a;

export const PRIM = {
  False: 0x03,
  Elt: 0x04,
  Left: 0x05,
  None: 0x06,
  Pair: 0x07,
  Right: 0x08,
  Some: 0x09,
  True: 0x0a,
  Unit: 0x0b,
} as const;

const PRIM_NAME_BY_CODE: Record<number, string> = {
  0x00: 'parameter',
  0x01: 'storage',
  0x02: 'code',
  0x03: 'False',
  0x04: 'Elt',
  0x05: 'Left',
  0x06: 'None',
  0x07: 'Pair',
  0x08: 'Right',
  0x09: 'Some',
  0x0a: 'True',
  0x0b: 'Unit',
  0x59: 'bool',
  0x5a: 'contract',
  0x5b: 'int',
  0x5f: 'list',
  0x60: 'map',
  0x61: 'big_map',
  0x62: 'nat',
  0x63: 'option',
  0x64: 'or',
  0x65: 'pair',
  0x66: 'set',
  0x68: 'string',
  0x69: 'bytes',
  0x6a: 'mutez',
  0x6b: 'timestamp',
  0x6c: 'unit',
  0x6e: 'address',
};

export function encodeUnit(): Uint8Array {
  return new Uint8Array([TAG_PRIM_0, PRIM.Unit]);
}

export function encodeBool(value: boolean): Uint8Array {
  return new Uint8Array([TAG_PRIM_0, value ? PRIM.True : PRIM.False]);
}

export function encodeInt(value: string | number | bigint): Uint8Array {
  const v = BigInt(value);
  const negative = v < 0n;
  let mag = negative ? -v : v;

  const out: number[] = [TAG_INT];
  let first = Number(mag & 0x3fn);
  if (negative) first |= 0x40;
  mag >>= 6n;
  if (mag > 0n) first |= 0x80;
  out.push(first);

  while (mag > 0n) {
    let byte = Number(mag & 0x7fn);
    mag >>= 7n;
    if (mag > 0n) byte |= 0x80;
    out.push(byte);
  }
  return new Uint8Array(out);
}

export function encodeNat(value: string | number | bigint): Uint8Array {
  const v = BigInt(value);
  if (v < 0n) throw new RangeError(`nat must be non-negative, got ${v}`);
  return encodeInt(v);
}

export function encodeString(str: string): Uint8Array {
  const utf8 = textEncoder.encode(str);
  return concatBytes(new Uint8Array([TAG_STRING]), uint32BE(utf8.length), utf8);
}

export function encodeBytes(input: string | Uint8Array): Uint8Array {
  const raw = typeof input === 'string' ? hexToBytes(input) : input;
  return concatBytes(new Uint8Array([TAG_BYTES]), uint32BE(raw.length), raw);
}

export function encodeNone(): Uint8Array {
  return new Uint8Array([TAG_PRIM_0, PRIM.None]);
}

export function encodeSome(encodedInner: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([TAG_PRIM_1, PRIM.Some]), encodedInner);
}

export function encodeLeft(encodedInner: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([TAG_PRIM_1, PRIM.Left]), encodedInner);
}

export function encodeRight(encodedInner: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([TAG_PRIM_1, PRIM.Right]), encodedInner);
}

export function encodePair(encodedLeft: Uint8Array, encodedRight: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([TAG_PRIM_2, PRIM.Pair]), encodedLeft, encodedRight);
}

export function encodeSequence(encodedItems: Uint8Array[]): Uint8Array {
  const body = concatBytes(...encodedItems);
  return concatBytes(new Uint8Array([TAG_SEQ]), uint32BE(body.length), body);
}

export function packData(encodedMicheline: Uint8Array | string): Uint8Array {
  const raw = typeof encodedMicheline === 'string' ? hexToBytes(encodedMicheline) : encodedMicheline;
  return concatBytes(new Uint8Array([0x05]), raw);
}

/**
 * Decode binary Micheline (supports Int, String, Bytes, Seq, Prim 0/1/2 with/without annots,
 * and Prim_N 0x09 generic N-arg annotated primitives).
 */
export function decodeMicheline(
  input: string | Uint8Array,
  { expectPackPrefix = false }: { expectPackPrefix?: boolean } = {},
): unknown {
  const bytes = typeof input === 'string' ? hexToBytes(input) : input;
  if (bytes.length === 0) throw new Error('Empty Micheline byte payload');

  let offset = 0;
  if (expectPackPrefix) {
    if (bytes[0] !== 0x05) {
      throw new Error(`Expected 0x05 PACK prefix, got 0x${bytes[0].toString(16)}`);
    }
    offset = 1;
  }

  function readAnnots(): string[] | undefined {
    const len = readUint32BE(bytes, offset);
    offset += 4;
    if (offset + len > bytes.length) {
      throw new Error(`Truncated Micheline annotations (need ${len} bytes at offset ${offset})`);
    }
    const raw = textDecoder.decode(bytes.subarray(offset, offset + len)).trim();
    offset += len;
    if (!raw) return undefined;
    return raw.split(/\s+/);
  }

  function primName(opcode: number): string {
    return PRIM_NAME_BY_CODE[opcode] ?? `0x${opcode.toString(16).padStart(2, '0')}`;
  }

  function readByte(ctx: string): number {
    if (offset >= bytes.length) {
      throw new Error(`Unexpected end of Micheline bytes while reading ${ctx}`);
    }
    return bytes[offset++];
  }

  function parseNode(): unknown {
    const tag = readByte('node tag');

    if (tag === TAG_INT) {
      const first = readByte('Zarith first byte');
      const negative = (first & 0x40) !== 0;
      let mag = BigInt(first & 0x3f);
      let shift = 6n;
      let more = (first & 0x80) !== 0;
      while (more) {
        const b = readByte('Zarith continuation byte');
        mag |= BigInt(b & 0x7f) << shift;
        shift += 7n;
        more = (b & 0x80) !== 0;
      }
      return { int: (negative ? -mag : mag).toString() };
    }

    if (tag === TAG_STRING) {
      const len = readUint32BE(bytes, offset);
      offset += 4;
      if (offset + len > bytes.length) {
        throw new Error(`Truncated string payload (expected ${len} bytes)`);
      }
      const str = textDecoder.decode(bytes.subarray(offset, offset + len));
      offset += len;
      return { string: str };
    }

    if (tag === TAG_BYTES) {
      const len = readUint32BE(bytes, offset);
      offset += 4;
      if (offset + len > bytes.length) {
        throw new Error(`Truncated bytes payload (expected ${len} bytes)`);
      }
      const hex = bytesToHex(bytes.subarray(offset, offset + len), false);
      offset += len;
      return { bytes: hex };
    }

    if (tag === TAG_SEQ) {
      const byteLen = readUint32BE(bytes, offset);
      offset += 4;
      const end = offset + byteLen;
      if (end > bytes.length) {
        throw new Error(`Truncated sequence payload (expected ${byteLen} bytes)`);
      }
      const items: unknown[] = [];
      while (offset < end) items.push(parseNode());
      if (offset !== end) {
        throw new Error(`Sequence element overran declared length (${offset} > ${end})`);
      }
      return items;
    }

    if (tag === TAG_PRIM_0) {
      const opcode = readByte('prim0 opcode');
      return { prim: primName(opcode) };
    }

    if (tag === TAG_PRIM_0_ANNOT) {
      const opcode = readByte('prim0+annot opcode');
      const annots = readAnnots();
      return annots ? { prim: primName(opcode), annots } : { prim: primName(opcode) };
    }

    if (tag === TAG_PRIM_1) {
      const opcode = readByte('prim1 opcode');
      const arg = parseNode();
      return { prim: primName(opcode), args: [arg] };
    }

    if (tag === TAG_PRIM_1_ANNOT) {
      const opcode = readByte('prim1+annot opcode');
      const arg = parseNode();
      const annots = readAnnots();
      return annots
        ? { prim: primName(opcode), args: [arg], annots }
        : { prim: primName(opcode), args: [arg] };
    }

    if (tag === TAG_PRIM_2) {
      const opcode = readByte('prim2 opcode');
      const a = parseNode();
      const b = parseNode();
      return { prim: primName(opcode), args: [a, b] };
    }

    if (tag === TAG_PRIM_2_ANNOT) {
      const opcode = readByte('prim2+annot opcode');
      const a = parseNode();
      const b = parseNode();
      const annots = readAnnots();
      return annots
        ? { prim: primName(opcode), args: [a, b], annots }
        : { prim: primName(opcode), args: [a, b] };
    }

    if (tag === TAG_PRIM_N) {
      const opcode = readByte('primN opcode');
      const argsByteLen = readUint32BE(bytes, offset);
      offset += 4;
      const argsEnd = offset + argsByteLen;
      if (argsEnd > bytes.length) {
        throw new Error(`Truncated Prim_N args (expected ${argsByteLen} bytes)`);
      }
      const args: unknown[] = [];
      while (offset < argsEnd) args.push(parseNode());
      if (offset !== argsEnd) {
        throw new Error(`Prim_N args overran declared length (${offset} > ${argsEnd})`);
      }
      const annots = readAnnots();
      const node: Record<string, unknown> = { prim: primName(opcode), args };
      if (annots) node.annots = annots;
      return node;
    }

    throw new Error(`Unsupported Micheline tag: 0x${tag.toString(16).padStart(2, '0')} at offset ${offset - 1}`);
  }

  const value = parseNode();
  if (offset !== bytes.length) {
    throw new Error(`Trailing bytes in Micheline payload: consumed ${offset} of ${bytes.length}`);
  }
  return value;
}

export function decodeRawMichelineHex(hex: string): {
  ok: boolean;
  expression?: unknown;
  bytesRead?: number;
  error?: string;
} {
  try {
    const bytes = hexToBytes(hex);
    if (bytes.length === 0) {
      return { ok: false, error: 'Provide a non-empty hex Micheline payload (e.g. 0x030b).' };
    }
    try {
      const expression = decodeMicheline(bytes, { expectPackPrefix: false });
      return { ok: true, expression, bytesRead: bytes.length };
    } catch (directErr) {
      if (bytes[0] === 0x05 && bytes.length > 1) {
        const expression = decodeMicheline(bytes, { expectPackPrefix: true });
        return { ok: true, expression, bytesRead: bytes.length };
      }
      throw directErr;
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function computeBigMapKeyHash(
  keyType: 'nat' | 'string' | 'address',
  value: string,
): { packedHex: string; exprHash: string } {
  let encoded: Uint8Array;
  if (keyType === 'nat') {
    encoded = encodeNat(value.trim());
  } else if (keyType === 'string') {
    encoded = encodeString(value);
  } else if (keyType === 'address') {
    encoded = encodeBytes(encodeTezosAddressBytes(value));
  } else {
    throw new Error(`Unsupported big_map keyType: ${String(keyType)}`);
  }
  const packed = packData(encoded);
  const hash = blake2b256(packed);
  const exprHash = base58CheckEncode(concatBytes(TEZOS_PREFIX.expr, hash));
  return {
    packedHex: bytesToHex(packed, true),
    exprHash,
  };
}

// ---------------------------------------------------------------------------
// Solidity ABI Codec with Strict [0, 2^256 - 1] Bounds
// ---------------------------------------------------------------------------
function pad32(hexNoPrefix: string): string {
  return hexNoPrefix.padStart(64, '0');
}

/**
 * Encode uint256 word (64 lowercase hex chars, no 0x prefix) with strict [0, 2^256 - 1] check.
 */
export function encodeUint256Checked(v: string | bigint): string {
  let big: bigint;
  if (typeof v === 'bigint') {
    big = v;
  } else {
    const trimmed = v.trim();
    if (!trimmed) throw new RangeError('uint256 value cannot be empty');
    try {
      big = BigInt(trimmed);
    } catch {
      throw new RangeError(`Invalid uint256 value: '${v}'`);
    }
  }
  if (big < 0n) {
    throw new RangeError(`uint256 underflow: value must be >= 0, got ${big}`);
  }
  if (big > MAX_UINT256) {
    throw new RangeError(`uint256 overflow: value exceeds 2^256 - 1`);
  }
  return pad32(big.toString(16));
}

function encodeAddressWord(addr: string): string {
  const clean = addr.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new Error(`Invalid EVM address: '${addr}'`);
  }
  return pad32(clean);
}

const MIN_INT256 = -(1n << 255n);
const MAX_INT256 = (1n << 255n) - 1n;

export function encodeInt256Checked(v: string | bigint): string {
  let big: bigint;
  if (typeof v === 'bigint') {
    big = v;
  } else {
    const trimmed = v.trim();
    if (!trimmed) throw new RangeError('int256 value cannot be empty');
    try {
      big = BigInt(trimmed);
    } catch {
      throw new RangeError(`Invalid int256 value: '${v}'`);
    }
  }
  if (big < MIN_INT256 || big > MAX_INT256) {
    throw new RangeError(`int256 out of range [-2^255, 2^255 - 1]`);
  }
  const twos = big < 0n ? (1n << 256n) + big : big;
  return pad32(twos.toString(16));
}

function encodeBytes32Word(hex: string): string {
  const clean = hex.trim().toLowerCase().replace(/^0x/, '');
  if (clean.length > 64 || (clean.length > 0 && !/^[0-9a-f]+$/.test(clean))) {
    throw new Error(`Invalid bytes32 hex value: '${hex}' (expected <= 32 bytes hex)`);
  }
  return clean.padEnd(64, '0');
}

export type SupportedEvmAbiType =
  | 'uint8'
  | 'uint256'
  | 'int256'
  | 'bool'
  | 'address'
  | 'bytes32'
  | 'string'
  | 'bytes';

const SUPPORTED_EVM_ABI_TYPES = new Set<string>([
  'uint8',
  'uint256',
  'int256',
  'bool',
  'address',
  'bytes32',
  'string',
  'bytes',
]);

/**
 * Parse a Solidity function signature like `transfer(address,uint256)` into canonical form and
 * typed parameter list. Rejects nested tuples or unsupported types cleanly instead of guessing.
 */
export function parseEvmSignature(sig: string):
  | { ok: true; canonicalSig: string; name: string; types: SupportedEvmAbiType[] }
  | { ok: false; error: string } {
  const trimmed = sig.trim();
  const openIdx = trimmed.indexOf('(');
  const closeIdx = trimmed.lastIndexOf(')');
  if (openIdx <= 0 || closeIdx !== trimmed.length - 1) {
    return {
      ok: false,
      error: `Invalid Solidity signature '${sig}'. Expected format like transfer(address,uint256).`,
    };
  }
  const name = trimmed.slice(0, openIdx).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return { ok: false, error: `Invalid Solidity function name '${name}'.` };
  }
  const inner = trimmed.slice(openIdx + 1, closeIdx).trim();
  if (!inner) {
    return { ok: true, canonicalSig: `${name}()`, name, types: [] };
  }
  if (inner.includes('(') || inner.includes(')')) {
    return {
      ok: false,
      error: `Unsupported nested tuple parameter in '${sig}'. Supported ABI types: uint256, uint8, int256, address, bool, bytes32, string, bytes.`,
    };
  }

  const rawParts = inner.split(',').map((p) => p.trim());
  const types: SupportedEvmAbiType[] = [];
  for (const part of rawParts) {
    // Allow optional param names like "address to" by taking the first token, and normalize uint/int aliases
    const baseToken = part.split(/\s+/)[0] ?? '';
    const normalized =
      baseToken === 'uint' ? 'uint256' : baseToken === 'int' ? 'int256' : baseToken;
    if (!SUPPORTED_EVM_ABI_TYPES.has(normalized)) {
      return {
        ok: false,
        error: `Unsupported Solidity ABI type '${baseToken || part}' in '${sig}'. Supported types: uint256, uint8, int256, address, bool, bytes32, string, bytes.`,
      };
    }
    types.push(normalized as SupportedEvmAbiType);
  }
  return {
    ok: true,
    canonicalSig: `${name}(${types.join(',')})`,
    name,
    types,
  };
}

function encodeDynamicBytesWord(bytes: Uint8Array): string {
  const lenHex = encodeUint256Checked(BigInt(bytes.length));
  const dataHex = bytesToHex(bytes, false);
  const rem = dataHex.length % 64;
  const padded = rem === 0 ? dataHex : dataHex + '0'.repeat(64 - rem);
  return lenHex + padded;
}

type AbiParam =
  | { type: 'uint8'; value: number | bigint | string }
  | { type: 'uint256'; value: bigint | string }
  | { type: 'int256'; value: bigint | string }
  | { type: 'bool'; value: boolean }
  | { type: 'address'; value: string }
  | { type: 'bytes32'; value: string }
  | { type: 'string'; value: string }
  | { type: 'bytes'; value: string | Uint8Array };

export function encodeAbiParams(params: AbiParam[]): string {
  const head: string[] = [];
  const tail: string[] = [];
  let dynOffset = params.length * 32;

  for (const p of params) {
    if (p.type === 'uint8') {
      const val = typeof p.value === 'number' ? BigInt(p.value) : BigInt(p.value);
      if (val < 0n || val > 255n) throw new RangeError(`uint8 out of range: ${val}`);
      head.push(encodeUint256Checked(val));
    } else if (p.type === 'uint256') {
      head.push(encodeUint256Checked(p.value));
    } else if (p.type === 'int256') {
      head.push(encodeInt256Checked(p.value));
    } else if (p.type === 'bool') {
      head.push(encodeUint256Checked(p.value ? 1n : 0n));
    } else if (p.type === 'address') {
      head.push(encodeAddressWord(p.value));
    } else if (p.type === 'bytes32') {
      head.push(encodeBytes32Word(p.value));
    } else if (p.type === 'string') {
      head.push(encodeUint256Checked(BigInt(dynOffset)));
      const enc = encodeDynamicBytesWord(textEncoder.encode(p.value));
      tail.push(enc);
      dynOffset += enc.length / 2;
    } else if (p.type === 'bytes') {
      head.push(encodeUint256Checked(BigInt(dynOffset)));
      const raw = typeof p.value === 'string' ? hexToBytes(p.value) : p.value;
      const enc = encodeDynamicBytesWord(raw);
      tail.push(enc);
      dynOffset += enc.length / 2;
    }
  }
  return '0x' + head.join('') + tail.join('');
}

export function encodeFunctionCall(signature: string, params: AbiParam[] = []): string {
  const sel = selectorOf(signature);
  const body = encodeAbiParams(params).slice(2);
  return sel + body;
}

export function decodeWordBigInt(hexNoPrefix: string, wordIndex: number): bigint | null {
  const slice = hexNoPrefix.slice(wordIndex * 64, (wordIndex + 1) * 64);
  if (slice.length < 64) return null;
  return BigInt('0x' + slice);
}

export function decodeDynamicBytesHex(hexNoPrefix: string, offsetBytes: bigint): string | null {
  const start = Number(offsetBytes) * 2;
  const lenHex = hexNoPrefix.slice(start, start + 64);
  if (lenHex.length < 64) return null;
  const len = Number(BigInt('0x' + lenHex));
  if (start + 64 + len * 2 > hexNoPrefix.length) return null;
  return '0x' + hexNoPrefix.slice(start + 64, start + 64 + len * 2);
}

export function decodeDynamicString(hexNoPrefix: string, offsetBytes: bigint): string | null {
  const bytesHex = decodeDynamicBytesHex(hexNoPrefix, offsetBytes);
  if (!bytesHex) return null;
  return textDecoder.decode(hexToBytes(bytesHex));
}

// ---------------------------------------------------------------------------
// Tezos X Gateway Precompile Calldata Encoders / Decoders
// ---------------------------------------------------------------------------
export function encodeCallMichelson(
  destinationKt1: string,
  entrypoint: string,
  michelineHex: string,
): string {
  return encodeFunctionCall('callMichelson(string,string,bytes)', [
    { type: 'string', value: destinationKt1 },
    { type: 'string', value: entrypoint },
    { type: 'bytes', value: michelineHex },
  ]);
}

export function encodeCallMichelsonView(
  destinationKt1: string,
  viewName: string,
  michelineHex: string,
): string {
  return encodeFunctionCall('callMichelsonView(string,string,bytes)', [
    { type: 'string', value: destinationKt1 },
    { type: 'string', value: viewName },
    { type: 'bytes', value: michelineHex },
  ]);
}

export function encodeOriginOfCalldata(addr: string, sourceRuntime: 0 | 1): string {
  return encodeFunctionCall('originOf(string,uint8)', [
    { type: 'string', value: addr },
    { type: 'uint8', value: sourceRuntime },
  ]);
}

export function decodeOriginOfHex(rawHex: string): {
  ok: boolean;
  kind: number;
  kindLabel: string;
  homeRuntime: number | null;
  homeRuntimeLabel: string;
  nativeAddress: string | null;
} {
  const h = (rawHex || '').replace(/^0x/i, '');
  if (h.length < 192) {
    return {
      ok: false,
      kind: 0,
      kindLabel: 'Unknown',
      homeRuntime: null,
      homeRuntimeLabel: 'Unknown',
      nativeAddress: null,
    };
  }
  const kind = Number(decodeWordBigInt(h, 0) ?? 0n);
  const homeRuntime = Number(decodeWordBigInt(h, 1) ?? 0n);
  const offset = decodeWordBigInt(h, 2) ?? 0n;
  const nativeAddress = decodeDynamicString(h, offset);

  const kindLabel = kind === 1 ? 'Native' : kind === 2 ? 'Alias' : 'Unknown';
  const homeRuntimeLabel =
    homeRuntime === 0 ? 'Michelson (0)' : homeRuntime === 1 ? 'EVM (1)' : `Runtime (${homeRuntime})`;

  return {
    ok: true,
    kind,
    kindLabel,
    homeRuntime,
    homeRuntimeLabel,
    nativeAddress: nativeAddress && nativeAddress.length > 0 ? nativeAddress : null,
  };
}

export function encodeResolveAddressCalldata(
  addr: string,
  sourceRuntime: 0 | 1,
  targetRuntime: 0 | 1,
): string {
  return encodeFunctionCall('resolveAddress(string,uint8,uint8)', [
    { type: 'string', value: addr },
    { type: 'uint8', value: sourceRuntime },
    { type: 'uint8', value: targetRuntime },
  ]);
}

export function decodeResolveAddressHex(rawHex: string): {
  ok: boolean;
  classified: boolean;
  resolution: number;
  resolutionLabel: string;
  translatedAddress: string | null;
} {
  const h = (rawHex || '').replace(/^0x/i, '');
  if (h.length < 192) {
    return {
      ok: false,
      classified: false,
      resolution: 0,
      resolutionLabel: 'Unresolved',
      translatedAddress: null,
    };
  }
  const classified = (decodeWordBigInt(h, 0) ?? 0n) !== 0n;
  const resolution = Number(decodeWordBigInt(h, 1) ?? 0n);
  const offset = decodeWordBigInt(h, 2) ?? 0n;
  const translated = decodeDynamicString(h, offset);
  const resolutionLabel =
    resolution === 1 ? 'Alias' : resolution === 2 ? 'Native' : 'Unresolved';

  return {
    ok: true,
    classified,
    resolution,
    resolutionLabel,
    translatedAddress: translated && translated.length > 0 ? translated : null,
  };
}

/**
 * Live-verified Previewnet v0.11 / Horus 8.0 EVM alias materialization precompile call (0xbfe88b4b).
 */
export function encodeMaterializeAliasCalldata(
  nativeRuntime: string,
  nativeAddress: string,
  publicKey: string,
): string {
  return encodeFunctionCall('materializeAlias(string,string,string)', [
    { type: 'string', value: nativeRuntime },
    { type: 'string', value: nativeAddress },
    { type: 'string', value: publicKey },
  ]);
}

// ---------------------------------------------------------------------------
// Cross-Runtime Revert & 429 OOG Payload Decoder
// ---------------------------------------------------------------------------
const PANIC_REASONS: Record<number, string> = {
  0x00: 'Generic compiler panic',
  0x01: 'Assertion failed (assert)',
  0x11: 'Arithmetic underflow or overflow',
  0x12: 'Division or modulo by zero',
  0x21: 'Invalid enum value',
  0x32: 'Array index out of bounds',
  0x41: 'Out of memory allocation',
  0x51: 'Zero-initialized function pointer call',
};

function extractStatusCode(text: string): number | undefined {
  const explicit = text.match(/status\s+(\d{3})/i);
  if (explicit) return Number(explicit[1]);
  const oog429 = text.match(/\b(429)\b/);
  if (oog429) return 429;
  return undefined;
}

export function decodeRevertPayload(hexOrText: string): {
  kind: string;
  status?: number;
  summary: string;
  raw: string;
} {
  const trimmed = (hexOrText || '').trim();
  if (!trimmed || trimmed === '0x') {
    return {
      kind: 'EMPTY',
      summary: 'Empty revert data (0x). Check EXTCODESIZE==0 or silent out-of-gas.',
      raw: trimmed || '0x',
    };
  }

  const isHexLike = /^0x[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0;
  if (isHexLike) {
    const h = trimmed.slice(2).toLowerCase();

    // Standard Solidity Error(string) — 0x08c379a0
    if (h.startsWith('08c379a0') && h.length >= 136) {
      const body = h.slice(8);
      const offset = decodeWordBigInt(body, 0);
      const msg = offset !== null ? decodeDynamicString(body, offset) : null;
      if (msg !== null) {
        const status = extractStatusCode(msg);
        const is429Oog = status === 429 || (/\b429\b/.test(msg) && /\bOOG\b/i.test(msg));
        return {
          kind: is429Oog ? 'CROSS_RUNTIME_429_OOG' : 'SOLIDITY_ERROR',
          status: is429Oog ? 429 : status,
          summary: is429Oog
            ? `Cross-Runtime 429 OOG: ${msg} — increase EVM gas cap (recommend >= 5,000,000) or stay under Michelson 660k op limit.`
            : `Error("${msg}")`,
          raw: trimmed,
        };
      }
    }

    // Standard Solidity Panic(uint256) — 0x4e487b71
    if (h.startsWith('4e487b71') && h.length >= 72) {
      const code = Number(decodeWordBigInt(h.slice(8), 0) ?? 0n);
      const reason = PANIC_REASONS[code] ?? 'Unknown Solidity panic code';
      return {
        kind: 'SOLIDITY_PANIC',
        summary: `Panic(0x${code.toString(16)}): ${reason}`,
        raw: trimmed,
      };
    }

    // Tezos X Gateway raw UTF-8 revert strings (0xff00...0007 returns unframed UTF-8)
    const decodedText = textDecoder.decode(hexToBytes(trimmed));
    if (/^[\x20-\x7e\r\n\t]+$/.test(decodedText)) {
      const status = extractStatusCode(decodedText);
      const is429Oog = status === 429 || (/\b429\b/.test(decodedText) && /\bOOG\b/i.test(decodedText));
      return {
        kind: is429Oog ? 'CROSS_RUNTIME_429_OOG' : 'GATEWAY_UTF8_REVERT',
        status: is429Oog ? 429 : status,
        summary: is429Oog
          ? `Tezos X Gateway 429 OOG: ${decodedText}`
          : `Gateway UTF-8 Revert${status ? ` (HTTP ${status})` : ''}: ${decodedText}`,
        raw: trimmed,
      };
    }

    return {
      kind: 'RAW_HEX_REVERT',
      summary: `Unrecognized custom error or raw revert bytes (selector 0x${h.slice(0, 8)}, ${h.length / 2} bytes).`,
      raw: trimmed,
    };
  }

  // Plain-text RPC error or revert trace string
  const status = extractStatusCode(trimmed);
  const is429Oog = status === 429 || (/\b429\b/.test(trimmed) && /\bOOG\b/i.test(trimmed));
  return {
    kind: is429Oog ? 'CROSS_RUNTIME_429_OOG' : 'TEXT_REVERT',
    status: is429Oog ? 429 : status,
    summary: is429Oog
      ? `Cross-Runtime 429 OOG detected: ${trimmed}`
      : trimmed,
    raw: trimmed,
  };
}

// ---------------------------------------------------------------------------
// High-Level NACBench Codec Pipeline (`encodeCodecInput`)
// ---------------------------------------------------------------------------
function buildGuardrails(
  input: CodecInput,
  mutezAligned: boolean,
  dustRemainderWei: string,
): GuardrailNote[] {
  const gasCapNum = Number(input.evmGasCap || '0');
  const lowGas = Number.isFinite(gasCapNum) && gasCapNum > 0 && gasCapNum < 3_000_000;
  const isEvmToMich =
    input.callDirection === 'evm_to_michelson' || input.callDirection === 'evm_view_michelson';
  const isMichToEvm =
    input.callDirection === 'michelson_to_evm' ||
    input.callDirection === 'michelson_staticcall_evm';

  return [
    {
      id: 'extcodesize-zero',
      severity: isEvmToMich ? 'warning' : 'info',
      title: 'EXTCODESIZE == 0 Precompile Trap',
      detail:
        '0xff00…0007 returns 0x bytecode. High-level Solidity interfaces revert automatically — always use low-level .call / .staticcall.',
      triggered: isEvmToMich,
    },
    {
      id: 'mutez-dust',
      severity: mutezAligned ? 'info' : 'critical',
      title: '10^12 Wei ↔ Mutez Alignment',
      detail: mutezAligned
        ? 'Value is cleanly aligned to 10^12 wei (0 sub-mutez dust truncation).'
        : `Unaligned value! Remainder ${dustRemainderWei} wei (< 1 mutez) would be truncated by the gateway — assert value % 1e12 == 0.`,
      triggered: !mutezAligned,
    },
    {
      id: 'selector-asymmetry',
      severity: isMichToEvm ? 'warning' : 'info',
      title: '%call_evm vs staticcall_evm Selector Asymmetry',
      detail:
        '%call_evm passes the signature string separately and expects ABI args-only data (NO 4-byte selector); staticcall_evm requires full calldata WITH 4-byte selector.',
      triggered: isMichToEvm,
    },
    {
      id: 'gas-cap-asymmetry',
      severity: lowGas ? 'warning' : 'info',
      title: 'EVM 5M vs Michelson 660k Gas Asymmetry',
      detail: lowGas
        ? `Configured EVM gas cap (${input.evmGasCap}) is below 3,000,000 and risks a v0.11 HTTP-429 OOG revert. Recommend 5,000,000 EVM gas; Michelson ops cap at 660,000.`
        : 'Recommended EVM cross-runtime gas is 5,000,000 (3M min for transfers). Michelson hard_gas_limit_per_operation is 660,000.',
      triggered: lowGas,
    },
    {
      id: 'caller-equals-self',
      severity: input.preset === 'canary_echo_callback' || isMichToEvm ? 'warning' : 'info',
      title: 'Caller Alias & Callback Auth Guard',
      detail:
        'Cross-runtime callbacks arrive from the resolved KT1/EVM alias (NOT the gateway address). Guard reentrancy and pin authorizedKt1Alias.',
      triggered: input.preset === 'canary_echo_callback' || isMichToEvm,
    },
    {
      id: 'null-source',
      severity: isEvmToMich ? 'warning' : 'info',
      title: `Null SOURCE (${NULL_SOURCE_ADDRESS.slice(0, 12)}…)`,
      detail: `EVM-originated calls enter Michelson with SOURCE == ${NULL_SOURCE_ADDRESS}. Authenticate on sp.sender (the resolved alias), never sp.source.`,
      triggered: isEvmToMich,
    },
  ];
}

export function encodeCodecInput(input: CodecInput): CodecResult {
  let valueWeiBig = 0n;
  try {
    valueWeiBig = BigInt((input.valueWei || '0').trim() || '0');
    if (valueWeiBig < 0n) throw new RangeError('Value in wei cannot be negative');
  } catch (err) {
    const guardrails = buildGuardrails(input, false, 'invalid');
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Invalid wei value',
      michelineHex: '0x',
      michelineByteLength: 0,
      decodedExpression: null,
      gatewayCalldataHex: '0x',
      abiSelector: '0x00000000',
      mutezAligned: false,
      dustRemainderWei: 'invalid',
      guardrails,
    };
  }

  const dustBig = valueWeiBig % WEI_PER_MUTEZ;
  const mutezAligned = dustBig === 0n;
  const dustRemainderWei = dustBig.toString();
  const guardrails = buildGuardrails(input, mutezAligned, dustRemainderWei);

  try {
    let encoded: Uint8Array;
    let effectiveEntrypoint = input.entrypoint.trim();

    switch (input.preset) {
      case 'unit':
        encoded = encodeUnit();
        break;
      case 'string':
        encoded = encodeString(input.stringVal);
        break;
      case 'nat':
        encoded = encodeNat(input.natVal.trim() || '0');
        break;
      case 'int':
        encoded = encodeInt(input.intVal.trim() || '0');
        break;
      case 'bytes':
        encoded = encodeBytes(input.bytesHex.trim() || '0x');
        break;
      case 'address':
        encoded = encodeBytes(encodeTezosAddressBytes(input.addressVal));
        break;
      case 'pair_addr_mutez':
        encoded = encodePair(
          encodeBytes(encodeTezosAddressBytes(input.addressVal)),
          encodeNat(input.mutezVal.trim() || '0'),
        );
        break;
      case 'option_some':
        encoded = encodeSome(encodeString(input.stringVal));
        break;
      case 'or_left':
        encoded = encodeLeft(encodeNat(input.natVal.trim() || '0'));
        break;
      case 'canary_record_ping':
        effectiveEntrypoint = effectiveEntrypoint || 'record_ping';
        encoded = encodeString(input.stringVal || 'nacbench-ping');
        break;
      case 'canary_echo_callback':
        effectiveEntrypoint = effectiveEntrypoint || 'echo_callback';
        encoded = encodeNat(input.natVal.trim() || '42');
        break;
      case 'canary_force_fail':
        effectiveEntrypoint = effectiveEntrypoint || 'force_fail';
        encoded = encodeString(input.stringVal || 'ROLLBACK_SENTINEL');
        break;
      case 'canary_burn_gas':
        effectiveEntrypoint = effectiveEntrypoint || 'burn_gas';
        encoded = encodeNat(input.natVal.trim() || '200');
        break;
      case 'canary_get_state_digest':
        effectiveEntrypoint = effectiveEntrypoint || 'get_state_digest';
        encoded = encodeNat(input.natVal.trim() || '7');
        break;
      default:
        throw new Error(`Unsupported preset: ${String(input.preset)}`);
    }

    const michelineHex = bytesToHex(encoded, true);
    const decodedExpression = decodeMicheline(encoded);

    const kt1 = input.kt1Target.trim();
    if (isTz4Address(kt1)) {
      throw new Error(`Target '${kt1}' is a tz4 BLS address (unsupported on Tezos X Michelson)`);
    }

    let gatewayCalldataHex: string;
    let abiSelector: string;

    if (input.callDirection === 'evm_to_michelson') {
      const ep = effectiveEntrypoint || 'default';
      abiSelector = selectorOf('callMichelson(string,string,bytes)');
      gatewayCalldataHex = encodeCallMichelson(kt1, ep, michelineHex);
    } else if (input.callDirection === 'evm_view_michelson') {
      const viewName = effectiveEntrypoint || 'get_state_digest';
      abiSelector = selectorOf('callMichelsonView(string,string,bytes)');
      gatewayCalldataHex = encodeCallMichelsonView(kt1, viewName, michelineHex);
    } else if (input.callDirection === 'michelson_to_evm' || input.callDirection === 'michelson_staticcall_evm') {
      const defaultSig =
        input.callDirection === 'michelson_to_evm'
          ? 'onMichelsonCallback(uint256,uint256)'
          : 'echoView(uint256)';
      const rawSig = effectiveEntrypoint.includes('(') ? effectiveEntrypoint : defaultSig;
      const parsedSig = parseEvmSignature(rawSig);
      if (!parsedSig.ok) {
        throw new Error(parsedSig.error);
      }

      abiSelector = selectorOf(parsedSig.canonicalSig);
      let uintSeen = 0;
      const abiParams: AbiParam[] = parsedSig.types.map((t, idx) => {
        const explicit = input.evmArgs?.[idx];
        if (t === 'uint256' || t === 'uint8') {
          const fallback = uintSeen === 0 ? input.natVal.trim() || '42' : '1';
          uintSeen++;
          return { type: t, value: explicit !== undefined && explicit !== '' ? explicit.trim() : fallback };
        }
        if (t === 'int256') {
          return {
            type: 'int256',
            value: explicit !== undefined && explicit !== '' ? explicit.trim() : input.intVal.trim() || '0',
          };
        }
        if (t === 'address') {
          const fallbackAddr = isValidEvmAddress(input.addressVal)
            ? input.addressVal.trim()
            : input.evmTarget.trim();
          return {
            type: 'address',
            value: explicit !== undefined && explicit !== '' ? explicit.trim() : fallbackAddr,
          };
        }
        if (t === 'bool') {
          const val = (explicit ?? 'true').trim().toLowerCase();
          if (val !== 'true' && val !== 'false' && val !== '1' && val !== '0') {
            throw new Error(`Invalid bool argument #${idx + 1}: '${explicit}' (expected true/false)`);
          }
          return { type: 'bool', value: val === 'true' || val === '1' };
        }
        if (t === 'bytes32') {
          return {
            type: 'bytes32',
            value: explicit !== undefined && explicit !== '' ? explicit.trim() : input.bytesHex.trim() || '0x',
          };
        }
        if (t === 'string') {
          return {
            type: 'string',
            value: explicit !== undefined ? explicit : input.stringVal,
          };
        }
        return {
          type: 'bytes',
          value: explicit !== undefined && explicit !== '' ? explicit.trim() : input.bytesHex.trim() || '0x',
        };
      });

      // %call_evm takes selector string separately and expects ABI args WITHOUT 4-byte selector;
      // staticcall_evm expects full EVM calldata WITH 4-byte selector!
      gatewayCalldataHex =
        input.callDirection === 'michelson_to_evm'
          ? encodeAbiParams(abiParams)
          : encodeFunctionCall(parsedSig.canonicalSig, abiParams);
    } else {
      throw new Error(`Unsupported callDirection: ${String(input.callDirection)}`);
    }

    return {
      ok: true,
      michelineHex,
      michelineByteLength: encoded.length,
      decodedExpression,
      gatewayCalldataHex,
      abiSelector,
      mutezAligned,
      dustRemainderWei,
      guardrails,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      michelineHex: '0x',
      michelineByteLength: 0,
      decodedExpression: null,
      gatewayCalldataHex: '0x',
      abiSelector: '0x00000000',
      mutezAligned,
      dustRemainderWei,
      guardrails,
    };
  }
}
