/**
 * Pure-JS Keccak-256, Solidity ABI codec, NAC precompile codecs, and 429 OOG / revert decoder.
 * MIT License, zero dependencies.
 */

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
const MASK64 = 0xffffffffffffffffn;

function rotl64(x, n) {
  const s = BigInt(n);
  return ((x << s) | (x >> (64n - s))) & MASK64;
}

function keccakF1600(st) {
  for (let round = 0; round < 24; round++) {
    const bc = new Array(5);
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

export function keccak256Hex(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const rate = 136;
  const st = new Array(25).fill(0n);
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
  let out = "";
  for (let i = 0; i < 4; i++) {
    let lane = st[i];
    for (let b = 0; b < 8; b++) {
      out += Number((lane >> BigInt(8 * b)) & 0xffn)
        .toString(16)
        .padStart(2, "0");
    }
  }
  return out;
}

export function selectorOf(signature) {
  return "0x" + keccak256Hex(signature).slice(0, 8);
}

function pad32(hexNoPrefix) {
  return hexNoPrefix.padStart(64, "0");
}

export function encodeUint256(val) {
  const v = BigInt(val);
  if (v < 0n) throw new RangeError(`uint256 cannot be negative: ${v}`);
  return pad32(v.toString(16));
}

export function encodeBoolWord(val) {
  return encodeUint256(val ? 1n : 0n);
}

export function encodeAddressWord(addr) {
  const clean = addr.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new Error(`Invalid EVM address: ${addr}`);
  }
  return pad32(clean);
}

function encodeDynamicBytes(bytes) {
  const lenHex = encodeUint256(bytes.length);
  const dataHex = Buffer.from(bytes).toString("hex");
  const rem = dataHex.length % 64;
  const padded = rem === 0 ? dataHex : dataHex + "0".repeat(64 - rem);
  return lenHex + padded;
}

/**
 * Encode ABI arguments without 4-byte selector (ideal for Michelson `%call_evm` `data` field).
 * @param {Array<{type: 'uint8'|'uint256'|'bool'|'address'|'string'|'bytes', value: any}>} params
 */
export function encodeAbiParams(params) {
  const head = [];
  const tail = [];
  let dynOffset = params.length * 32;
  for (const p of params) {
    if (p.type === "uint8" || p.type === "uint256") {
      head.push(encodeUint256(p.value));
    } else if (p.type === "bool") {
      head.push(encodeBoolWord(p.value));
    } else if (p.type === "address") {
      head.push(encodeAddressWord(p.value));
    } else if (p.type === "string") {
      head.push(encodeUint256(dynOffset));
      const enc = encodeDynamicBytes(new TextEncoder().encode(p.value));
      tail.push(enc);
      dynOffset += enc.length / 2;
    } else if (p.type === "bytes") {
      head.push(encodeUint256(dynOffset));
      const raw = typeof p.value === "string"
        ? Buffer.from(p.value.replace(/^0x/, ""), "hex")
        : Buffer.from(p.value);
      const enc = encodeDynamicBytes(raw);
      tail.push(enc);
      dynOffset += enc.length / 2;
    } else {
      throw new Error(`Unsupported ABI type: ${p.type}`);
    }
  }
  return "0x" + head.join("") + tail.join("");
}

/** Encode full EVM calldata WITH 4-byte selector (for EVM calls & Michelson `staticcall_evm`). */
export function encodeFunctionCall(signature, params = []) {
  const sel = selectorOf(signature);
  const body = encodeAbiParams(params).slice(2);
  return sel + body;
}

export function decodeWordBigInt(hexNoPrefix, wordIndex) {
  const slice = hexNoPrefix.slice(wordIndex * 64, (wordIndex + 1) * 64);
  if (slice.length < 64) return null;
  return BigInt("0x" + slice);
}

export function decodeDynamicBytes(hexNoPrefix, offsetBytes) {
  const start = Number(offsetBytes) * 2;
  const lenHex = hexNoPrefix.slice(start, start + 64);
  if (lenHex.length < 64) return null;
  const len = Number(BigInt("0x" + lenHex));
  return "0x" + hexNoPrefix.slice(start + 64, start + 64 + len * 2);
}

export function decodeDynamicString(hexNoPrefix, offsetBytes) {
  const bytesHex = decodeDynamicBytes(hexNoPrefix, offsetBytes);
  if (!bytesHex) return null;
  return Buffer.from(bytesHex.slice(2), "hex").toString("utf8");
}

// ---------------------------------------------------------------------------
// NAC Precompile & Canary Wire Encoders / Decoders
// ---------------------------------------------------------------------------
export function encodeCallMichelson(destinationKt1, entrypoint, michelineHex) {
  return encodeFunctionCall("callMichelson(string,string,bytes)", [
    { type: "string", value: destinationKt1 },
    { type: "string", value: entrypoint },
    { type: "bytes", value: michelineHex },
  ]);
}

export function encodeCallMichelsonView(destinationKt1, viewName, michelineHex) {
  return encodeFunctionCall("callMichelsonView(string,string,bytes)", [
    { type: "string", value: destinationKt1 },
    { type: "string", value: viewName },
    { type: "bytes", value: michelineHex },
  ]);
}

export function encodeOriginOf(addr, sourceRuntime) {
  return encodeFunctionCall("originOf(string,uint8)", [
    { type: "string", value: addr },
    { type: "uint8", value: sourceRuntime },
  ]);
}

export function decodeOriginOf(rawHex) {
  const h = (rawHex || "").replace(/^0x/, "");
  if (h.length < 192) return { ok: false, raw: rawHex };
  const kind = Number(decodeWordBigInt(h, 0));
  const homeRuntime = Number(decodeWordBigInt(h, 1));
  const offset = decodeWordBigInt(h, 2);
  const nativeAddress = decodeDynamicString(h, offset);
  return {
    ok: true,
    kind,
    kindLabel: kind === 1 ? "Native" : kind === 2 ? "Alias" : "Unknown",
    homeRuntime,
    homeRuntimeLabel: homeRuntime === 0 ? "Michelson" : homeRuntime === 1 ? "EVM" : `Runtime(${homeRuntime})`,
    nativeAddress,
  };
}

export function encodeResolveAddress(addr, sourceRuntime, targetRuntime) {
  return encodeFunctionCall("resolveAddress(string,uint8,uint8)", [
    { type: "string", value: addr },
    { type: "uint8", value: sourceRuntime },
    { type: "uint8", value: targetRuntime },
  ]);
}

/**
 * Live-verified Previewnet v0.11 / Horus 8.0 EVM alias materialization precompile call (0xbfe88b4b).
 * Note: For `tz1/tz2/tz3` accounts, `publicKey` (e.g., `edpk...`) is required by the kernel.
 */
export function encodeMaterializeAliasEvm(nativeRuntime, nativeAddress, publicKey = "") {
  return encodeFunctionCall("materializeAlias(string,string,string)", [
    { type: "string", value: nativeRuntime },
    { type: "string", value: nativeAddress },
    { type: "string", value: publicKey },
  ]);
}

export function decodeResolveAddress(rawHex) {
  const h = (rawHex || "").replace(/^0x/, "");
  if (h.length < 192) return { ok: false, raw: rawHex };
  const classified = decodeWordBigInt(h, 0) !== 0n;
  const resolution = Number(decodeWordBigInt(h, 1));
  const offset = decodeWordBigInt(h, 2);
  const translated = decodeDynamicString(h, offset);
  return {
    ok: true,
    classified,
    resolution,
    translated,
  };
}

/** Exact 64-byte ABI tail matching NacCanary `echo_callback` -> `onMichelsonCallback(uint256,uint256)` */
export function encodeEchoCallbackArgs(nonce, michelsonCallbackCount) {
  return encodeAbiParams([
    { type: "uint256", value: nonce },
    { type: "uint256", value: michelsonCallbackCount },
  ]);
}

/** Full calldata WITH 4-byte selector for `NacCanaryEvm.echoView(uint256)` (for `staticcall_evm`). */
export function encodeEchoViewCalldata(x) {
  return encodeFunctionCall("echoView(uint256)", [{ type: "uint256", value: x }]);
}

/**
 * Decode cross-runtime revert data from Previewnet v0.11 / Horus 8.0:
 * - Standard Solidity Error(string) (0x08c379a0)
 * - Solidity Panic(uint256) (0x4e487b71)
 * - Tezos X v0.9+ Cross-Runtime 429 OOG
 * - Plain UTF-8 gateway error strings (e.g., "Cross-runtime call failed with status 404...")
 */
export function decodeCrossRuntimeRevert(rawHex) {
  if (!rawHex || rawHex === "0x") {
    return { category: "EMPTY", message: "Empty revert data", is429Oog: false, raw: rawHex || "0x" };
  }
  const h = rawHex.toLowerCase().replace(/^0x/, "");

  // Solidity Error(string)
  if (h.startsWith("08c379a0") && h.length >= 136) {
    const body = h.slice(8);
    const offset = decodeWordBigInt(body, 0);
    const msg = decodeDynamicString(body, offset) || "";
    const is429Oog = /\b429\b/.test(msg) && /\bOOG\b/i.test(msg);
    return {
      category: is429Oog ? "CROSS_RUNTIME_429_OOG" : "SOLIDITY_ERROR",
      message: msg,
      is429Oog,
      raw: rawHex,
    };
  }

  // Solidity Panic(uint256)
  if (h.startsWith("4e487b71") && h.length >= 72) {
    const code = decodeWordBigInt(h.slice(8), 0);
    return {
      category: "SOLIDITY_PANIC",
      panicCode: "0x" + code.toString(16),
      message: `Panic(0x${code.toString(16)})`,
      is429Oog: false,
      raw: rawHex,
    };
  }

  // Try raw UTF-8 (Previewnet 0xff...0007 precompile returns raw UTF-8 strings)
  const text = Buffer.from(h, "hex").toString("utf8");
  const printable = /^[\x20-\x7e\r\n\t]+$/.test(text);
  if (printable) {
    const is429Oog = /\b429\b/.test(text) && /\bOOG\b/i.test(text);
    const l1ErrorMatch = text.match(/\b([a-z0-9_]+\.[a-z0-9_.-]+)\b/i);
    return {
      category: is429Oog ? "CROSS_RUNTIME_429_OOG" : "GATEWAY_UTF8_REVERT",
      message: text,
      is429Oog,
      l1ErrorId: l1ErrorMatch ? l1ErrorMatch[1] : null,
      raw: rawHex,
    };
  }

  return { category: "RAW_BYTES", message: rawHex, is429Oog: false, raw: rawHex };
}
