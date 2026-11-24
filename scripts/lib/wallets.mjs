/**
 * Zero-dependency Previewnet wallet generator (Ed25519 Tezos + secp256k1 EVM) and .env loader.
 * Pure Node.js >= 20 (`node:crypto`) + local `blake2b.mjs`, `tezos-address.mjs`, `evm-abi.mjs`.
 * MIT License.
 */

import {
  createECDH,
  createPrivateKey,
  createPublicKey,
  randomBytes,
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { blake2b160 } from "./blake2b.mjs";
import { keccak256Hex } from "./evm-abi.mjs";
import { concatBytes } from "./micheline.mjs";
import { base58CheckEncode, TEZOS_PREFIX } from "./tezos-address.mjs";

// Tezos Base58Check prefixes for Ed25519 32-byte seed (54-char edsk...) and 32-byte pubkey (edpk...)
const EDSK_SEED_PREFIX = new Uint8Array([13, 15, 58, 7]);
const EDPK_PREFIX = new Uint8Array([13, 15, 37, 217]);

// RFC 8410 ASN.1 DER PKCS#8 header for a 32-byte Ed25519 private key seed
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

/**
 * Derive Tezos `edsk` (32-byte seed), `edpk`, and `tz1` address from a 32-byte Ed25519 seed.
 */
export function deriveTezosEd25519FromSeed(seedInput) {
  const seed =
    typeof seedInput === "string"
      ? Buffer.from(seedInput.replace(/^0x/i, ""), "hex")
      : Buffer.from(seedInput);

  if (seed.length !== 32) {
    throw new RangeError(`Ed25519 seed must be exactly 32 bytes, got ${seed.length}`);
  }

  const pkcs8Der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  const privKeyObj = createPrivateKey({
    key: pkcs8Der,
    format: "der",
    type: "pkcs8",
  });
  const spkiDer = createPublicKey(privKeyObj).export({
    format: "der",
    type: "spki",
  });

  // Ed25519 SPKI DER is 12-byte ASN.1 header + 32-byte raw public key
  const rawPubKey = new Uint8Array(spkiDer.subarray(spkiDer.length - 32));
  if (rawPubKey.length !== 32) {
    throw new Error(`Unexpected Ed25519 SPKI public key length: ${rawPubKey.length}`);
  }

  const secretKey = base58CheckEncode(
    concatBytes(EDSK_SEED_PREFIX, new Uint8Array(seed)),
  );
  const publicKey = base58CheckEncode(concatBytes(EDPK_PREFIX, rawPubKey));
  const pkh = blake2b160(rawPubKey);
  const address = base58CheckEncode(concatBytes(TEZOS_PREFIX.tz1, pkh));

  return {
    address,
    publicKey,
    secretKey,
  };
}

/** Generate a fresh disposable Tezos Ed25519 wallet (`tz1`, `edpk`, 54-char `edsk` seed). */
export function generateTezosEd25519Wallet() {
  return deriveTezosEd25519FromSeed(randomBytes(32));
}

/** Convert a 20-byte hex EVM address to EIP-55 mixed-case checksum format. */
export function toEip55ChecksumAddress(addr) {
  const lower = addr.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(lower)) {
    throw new Error(`Invalid 20-byte EVM address: '${addr}'`);
  }
  const hash = keccak256Hex(lower);
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const ch = lower[i];
    if (ch >= "a" && ch <= "f" && parseInt(hash[i], 16) >= 8) {
      out += ch.toUpperCase();
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Derive EIP-55 EVM address and uncompressed secp256k1 public key (`0x04...`) from a 32-byte private key.
 */
export function deriveEvmWalletFromPrivateKey(privateKeyInput) {
  const privBuf =
    typeof privateKeyInput === "string"
      ? Buffer.from(privateKeyInput.replace(/^0x/i, ""), "hex")
      : Buffer.from(privateKeyInput);

  if (privBuf.length !== 32) {
    throw new RangeError(
      `secp256k1 private key must be exactly 32 bytes, got ${privBuf.length}`,
    );
  }

  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(privBuf);
  const uncompressedPub = ecdh.getPublicKey(null, "uncompressed");
  if (uncompressedPub.length !== 65 || uncompressedPub[0] !== 0x04) {
    throw new Error("Unexpected uncompressed secp256k1 public key format");
  }

  const pubXY = new Uint8Array(uncompressedPub.subarray(1));
  const hashHex = keccak256Hex(pubXY);
  const address = toEip55ChecksumAddress(hashHex.slice(24));

  return {
    address,
    publicKey: "0x" + uncompressedPub.toString("hex"),
    privateKey: "0x" + privBuf.toString("hex"),
  };
}

/** Generate a fresh disposable secp256k1 EVM wallet (`0x` EIP-55 address, uncompressed pubkey, private key). */
export function generateEvmSecp256k1Wallet() {
  const ecdh = createECDH("secp256k1");
  ecdh.generateKeys();
  return deriveEvmWalletFromPrivateKey(ecdh.getPrivateKey());
}

/**
 * Zero-dependency `.env` file parser/loader.
 * Never overrides keys already present in `targetEnv` (defaults to `process.env`).
 */
export function loadDotEnvFile(filePath, targetEnv = process.env) {
  if (!existsSync(filePath)) {
    return { loaded: false, path: filePath, keys: [] };
  }
  const raw = readFileSync(filePath, "utf8");
  const loadedKeys = [];

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const stripped = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eqIdx = stripped.indexOf("=");
    if (eqIdx <= 0) continue;

    const key = stripped.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = stripped.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      }
    } else {
      // Strip inline comment preceded by whitespace in unquoted values
      const commentMatch = value.match(/\s+#.*$/);
      if (commentMatch) {
        value = value.slice(0, commentMatch.index).trim();
      }
    }

    if (targetEnv[key] === undefined) {
      targetEnv[key] = value;
      loadedKeys.push(key);
    }
  }

  return { loaded: true, path: filePath, keys: loadedKeys };
}

/**
 * Load `.env.previewnet` then `.env` from `rootDir` without overriding explicit shell env vars.
 */
export function loadProjectDotEnvs(rootDir, targetEnv = process.env) {
  const previewnet = loadDotEnvFile(resolve(rootDir, ".env.previewnet"), targetEnv);
  const base = loadDotEnvFile(resolve(rootDir, ".env"), targetEnv);
  return { previewnet, base };
}
