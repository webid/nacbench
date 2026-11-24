/**
 * Pure-JS RFC 7693 BLAKE2b implementation (MIT License, zero dependencies).
 * Used for Tezos big_map script_expr key hashing (blake2b-256) and key hashes (blake2b-160).
 */

const MASK64 = 0xffffffffffffffffn;

const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];

const SIGMA = [
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

function rotr64(x, n) {
  const s = BigInt(n);
  return ((x >> s) | (x << (64n - s))) & MASK64;
}

function readU64LE(buf, offset) {
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    v |= BigInt(buf[offset + i]) << BigInt(8 * i);
  }
  return v;
}

function mixG(v, a, b, c, d, x, y) {
  v[a] = (v[a] + v[b] + x) & MASK64;
  v[d] = rotr64(v[d] ^ v[a], 32);
  v[c] = (v[c] + v[d]) & MASK64;
  v[b] = rotr64(v[b] ^ v[c], 24);
  v[a] = (v[a] + v[b] + y) & MASK64;
  v[d] = rotr64(v[d] ^ v[a], 16);
  v[c] = (v[c] + v[d]) & MASK64;
  v[b] = rotr64(v[b] ^ v[c], 63);
}

function compress(h, block, tLow, tHigh, isLast) {
  const m = new Array(16);
  for (let i = 0; i < 16; i++) {
    m[i] = readU64LE(block, i * 8);
  }
  const v = new Array(16);
  for (let i = 0; i < 8; i++) {
    v[i] = h[i];
    v[i + 8] = IV[i];
  }
  v[12] ^= tLow & MASK64;
  v[13] ^= tHigh & MASK64;
  if (isLast) v[14] ^= MASK64;

  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r];
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

/**
 * Compute unkeyed BLAKE2b digest of `input` (Uint8Array or string) with output length `outlen` (1..64 bytes).
 */
export function blake2b(input, outlen = 32) {
  if (outlen < 1 || outlen > 64) {
    throw new RangeError(`BLAKE2b outlen must be 1..64, got ${outlen}`);
  }
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;

  const h = IV.slice();
  // Parameter block: fanout=1, depth=1, digest length=outlen
  h[0] ^= 0x01010000n ^ BigInt(outlen);

  let offset = 0;
  let tLow = 0n;
  let tHigh = 0n;

  while (data.length - offset > 128) {
    tLow = (tLow + 128n) & MASK64;
    if (tLow < 128n) tHigh = (tHigh + 1n) & MASK64;
    compress(h, data.subarray(offset, offset + 128), tLow, tHigh, false);
    offset += 128;
  }

  const lastBlock = new Uint8Array(128);
  const remaining = data.length - offset;
  if (remaining > 0) {
    lastBlock.set(data.subarray(offset));
  }
  const remBig = BigInt(remaining);
  tLow = (tLow + remBig) & MASK64;
  if (tLow < remBig) tHigh = (tHigh + 1n) & MASK64;
  compress(h, lastBlock, tLow, tHigh, true);

  const out = new Uint8Array(outlen);
  for (let i = 0; i < outlen; i++) {
    out[i] = Number((h[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn);
  }
  return out;
}

export function blake2b256(input) {
  return blake2b(input, 32);
}

export function blake2b160(input) {
  return blake2b(input, 20);
}
