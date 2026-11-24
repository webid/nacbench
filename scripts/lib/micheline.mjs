/**
 * Binary Micheline encoder & decoder (MIT License, zero dependencies).
 * Byte-for-byte compatible with Tezos Michelson PACK/wire format and Micheline.sol.
 */

export const WEI_PER_MUTEZ = 1_000_000_000_000n;

// Micheline binary tags
const TAG_INT = 0x00;
const TAG_STRING = 0x01;
const TAG_SEQ = 0x02;
const TAG_PRIM_0 = 0x03;
const TAG_PRIM_1 = 0x05;
const TAG_PRIM_2 = 0x07;
const TAG_BYTES = 0x0a;

// Common Michelson primitive opcodes
export const PRIM = {
  False: 0x03,
  Left: 0x05,
  None: 0x06,
  Pair: 0x07,
  Right: 0x08,
  Some: 0x09,
  True: 0x0a,
  Unit: 0x0b,
};

const PRIM_NAME_BY_CODE = Object.fromEntries(
  Object.entries(PRIM).map(([k, v]) => [v, k]),
);

export function hexToBytes(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`Invalid hex string length: ${clean.length}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes, withPrefix = true) {
  let out = withPrefix ? "0x" : "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

export function concatBytes(...arrays) {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function uint32BE(n) {
  if (n < 0 || n > 0xffffffff) {
    throw new RangeError(`uint32 out of range: ${n}`);
  }
  return new Uint8Array([
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ]);
}

function readUint32BE(bytes, offset) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

/**
 * Guardrail for EVM -> Michelson native XTZ transfers:
 * Sub-mutez wei (non-multiples of 10^12) are silently truncated by the gateway.
 */
export function assertMutezAligned(weiValue) {
  const v = BigInt(weiValue);
  if (v < 0n) throw new RangeError("Negative wei value");
  if (v % WEI_PER_MUTEZ !== 0n) {
    throw new RangeError(
      `Sub-mutez precision loss: ${v} wei is not a multiple of 10^12 (remainder ${v % WEI_PER_MUTEZ} wei would be truncated)`,
    );
  }
  return v;
}

export function weiToMutez(weiValue) {
  return assertMutezAligned(weiValue) / WEI_PER_MUTEZ;
}

export function mutezToWei(mutezValue) {
  const m = BigInt(mutezValue);
  if (m < 0n) throw new RangeError("Negative mutez value");
  return m * WEI_PER_MUTEZ;
}

/** Unit -> 0x030b */
export function encodeUnit() {
  return new Uint8Array([TAG_PRIM_0, PRIM.Unit]);
}

/** Bool -> 0x030a (True) | 0x0303 (False) */
export function encodeBool(value) {
  return new Uint8Array([TAG_PRIM_0, value ? PRIM.True : PRIM.False]);
}

/** Tezos signed Zarith integer (tag 0x00). First byte: bit7=more, bit6=sign, bits0..5=mag. */
export function encodeInt(value) {
  const v = BigInt(value);
  const negative = v < 0n;
  let mag = negative ? -v : v;

  const out = [TAG_INT];
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

export function encodeNat(value) {
  const v = BigInt(value);
  if (v < 0n) throw new RangeError(`nat must be non-negative, got ${v}`);
  return encodeInt(v);
}

export function encodeString(str) {
  const utf8 = new TextEncoder().encode(str);
  return concatBytes(new Uint8Array([TAG_STRING]), uint32BE(utf8.length), utf8);
}

export function encodeBytes(input) {
  const raw = typeof input === "string" ? hexToBytes(input) : input;
  return concatBytes(new Uint8Array([TAG_BYTES]), uint32BE(raw.length), raw);
}

export function encodeNone() {
  return new Uint8Array([TAG_PRIM_0, PRIM.None]);
}

export function encodeSome(encodedInner) {
  return concatBytes(new Uint8Array([TAG_PRIM_1, PRIM.Some]), encodedInner);
}

export function encodeLeft(encodedInner) {
  return concatBytes(new Uint8Array([TAG_PRIM_1, PRIM.Left]), encodedInner);
}

export function encodeRight(encodedInner) {
  return concatBytes(new Uint8Array([TAG_PRIM_1, PRIM.Right]), encodedInner);
}

export function encodePair(encodedLeft, encodedRight) {
  return concatBytes(new Uint8Array([TAG_PRIM_2, PRIM.Pair]), encodedLeft, encodedRight);
}

/** Right-combed Michelson pair for >= 2 already-encoded elements. */
export function encodeRightComb(encodedItems) {
  if (!Array.isArray(encodedItems) || encodedItems.length < 2) {
    throw new Error("encodeRightComb requires at least 2 items");
  }
  let acc = encodedItems[encodedItems.length - 1];
  for (let i = encodedItems.length - 2; i >= 0; i--) {
    acc = encodePair(encodedItems[i], acc);
  }
  return acc;
}

export function encodeSequence(encodedItems) {
  const body = concatBytes(...encodedItems);
  return concatBytes(new Uint8Array([TAG_SEQ]), uint32BE(body.length), body);
}

/** Prepend Tezos 0x05 PACK watermark (required for BLAKE2b big_map script_expr hashing). */
export function packData(encodedMicheline) {
  const raw = typeof encodedMicheline === "string" ? hexToBytes(encodedMicheline) : encodedMicheline;
  return concatBytes(new Uint8Array([0x05]), raw);
}

/**
 * Decode a binary Micheline payload (with or without leading 0x05 PACK watermark).
 */
export function decodeMicheline(input, { expectPackPrefix = false } = {}) {
  const bytes = typeof input === "string" ? hexToBytes(input) : input;
  let offset = 0;
  if (expectPackPrefix) {
    if (bytes[0] !== 0x05) {
      throw new Error(`Expected 0x05 PACK prefix, got 0x${bytes[0]?.toString(16)}`);
    }
    offset = 1;
  }

  function parseNode() {
    if (offset >= bytes.length) throw new Error("Unexpected end of Micheline bytes");
    const tag = bytes[offset++];
    if (tag === TAG_INT) {
      const first = bytes[offset++];
      const negative = (first & 0x40) !== 0;
      let mag = BigInt(first & 0x3f);
      let shift = 6n;
      let more = (first & 0x80) !== 0;
      while (more) {
        if (offset >= bytes.length) throw new Error("Truncated Zarith int");
        const b = bytes[offset++];
        mag |= BigInt(b & 0x7f) << shift;
        shift += 7n;
        more = (b & 0x80) !== 0;
      }
      return { int: (negative ? -mag : mag).toString() };
    }
    if (tag === TAG_STRING) {
      const len = readUint32BE(bytes, offset);
      offset += 4;
      const str = new TextDecoder().decode(bytes.slice(offset, offset + len));
      offset += len;
      return { string: str };
    }
    if (tag === TAG_BYTES) {
      const len = readUint32BE(bytes, offset);
      offset += 4;
      const hex = bytesToHex(bytes.slice(offset, offset + len), false);
      offset += len;
      return { bytes: hex };
    }
    if (tag === TAG_SEQ) {
      const byteLen = readUint32BE(bytes, offset);
      offset += 4;
      const end = offset + byteLen;
      const items = [];
      while (offset < end) items.push(parseNode());
      return items;
    }
    if (tag === TAG_PRIM_0) {
      const opcode = bytes[offset++];
      return { prim: PRIM_NAME_BY_CODE[opcode] || `0x${opcode.toString(16)}` };
    }
    if (tag === TAG_PRIM_1) {
      const opcode = bytes[offset++];
      const arg = parseNode();
      return { prim: PRIM_NAME_BY_CODE[opcode] || `0x${opcode.toString(16)}`, args: [arg] };
    }
    if (tag === TAG_PRIM_2) {
      const opcode = bytes[offset++];
      const a = parseNode();
      const b = parseNode();
      return { prim: PRIM_NAME_BY_CODE[opcode] || `0x${opcode.toString(16)}`, args: [a, b] };
    }
    throw new Error(`Unsupported Micheline tag: 0x${tag.toString(16)} at offset ${offset - 1}`);
  }

  const value = parseNode();
  if (offset !== bytes.length) {
    throw new Error(`Trailing bytes in Micheline payload: consumed ${offset} of ${bytes.length}`);
  }
  return value;
}
