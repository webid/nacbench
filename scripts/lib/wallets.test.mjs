import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "./micheline.mjs";
import { base58CheckDecode, isValidEvmAddress, isValidTezosXAddress } from "./tezos-address.mjs";
import {
  deriveEvmWalletFromPrivateKey,
  deriveTezosEd25519FromSeed,
  generateEvmSecp256k1Wallet,
  generateTezosEd25519Wallet,
  loadDotEnvFile,
  toEip55ChecksumAddress,
} from "./wallets.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GEN_SCRIPT = resolve(__dirname, "../generate-previewnet-wallets.mjs");

test("deriveTezosEd25519FromSeed matches RFC 8032 Vector 1 and Tezos Alice sandbox vector", () => {
  // 1. RFC 8032 Test Vector 1
  const rfcSeed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
  const rfcExpectedPubHex = "0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
  const rfcWallet = deriveTezosEd25519FromSeed(rfcSeed);
  const decodedPub = base58CheckDecode(rfcWallet.publicKey);
  assert.equal(bytesToHex(decodedPub.subarray(4)), rfcExpectedPubHex);
  assert.equal(rfcWallet.secretKey.length, 54);
  assert.ok(rfcWallet.secretKey.startsWith("edsk"));
  assert.equal(isValidTezosXAddress(rfcWallet.address), true);

  // 2. Canonical Tezos sandbox Alice vector
  const aliceEdsk = "edsk3QoqBuvdamxouPhin7swCvkQNgq4jP5KZPbwWNnwdZpSpJiEbq";
  const aliceSeed = base58CheckDecode(aliceEdsk).subarray(4);
  const alice = deriveTezosEd25519FromSeed(aliceSeed);
  assert.equal(alice.secretKey, aliceEdsk);
  assert.equal(alice.publicKey, "edpkvGfYw3LyB1UcCahKQk4rF2tvbMUk8GFiTuMjL75uGXrpvKXhjn");
  assert.equal(alice.address, "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb");
});

test("generateTezosEd25519Wallet cross-verifies live against octez-client", (t) => {
  const wallet = generateTezosEd25519Wallet();
  assert.equal(isValidTezosXAddress(wallet.address), true);
  assert.equal(wallet.secretKey.length, 54);
  assert.ok(wallet.publicKey.startsWith("edpk"));

  const octezBin = process.env.OCTEZ_CLIENT_BIN || "octez-client";
  try {
    execFileSync(octezBin, ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("octez-client binary not installed in environment");
    return;
  }

  const baseDir = mkdtempSync(join(tmpdir(), "nacbench-octez-verify-"));
  try {
    const env = { ...process.env, TEZOS_CLIENT_UNSAFE_DISABLE_DISCLAIMER: "Y" };
    execFileSync(
      octezBin,
      ["--base-dir", baseDir, "import", "secret", "key", "test", `unencrypted:${wallet.secretKey}`, "--force"],
      { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const out = execFileSync(
      octezBin,
      ["--base-dir", baseDir, "show", "address", "test", "--show-secret"],
      { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.match(out, new RegExp(`Hash:\\s*${wallet.address}`));
    assert.match(out, new RegExp(`Public Key:\\s*${wallet.publicKey}`));
    assert.match(out, new RegExp(`Secret Key:\\s*unencrypted:${wallet.secretKey}`));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("deriveEvmWalletFromPrivateKey matches secp256k1 & Foundry/Anvil EIP-55 vectors", () => {
  const one = deriveEvmWalletFromPrivateKey(
    "0x0000000000000000000000000000000000000000000000000000000000000001",
  );
  assert.equal(one.address, "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
  assert.ok(one.publicKey.startsWith("0x04"));
  assert.equal(one.publicKey.length, 132);

  // Foundry / Anvil Account #0
  const anvil0 = deriveEvmWalletFromPrivateKey(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  assert.equal(anvil0.address, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");

  // Random fresh wallet
  const fresh = generateEvmSecp256k1Wallet();
  assert.equal(isValidEvmAddress(fresh.address), true);
  assert.equal(fresh.address, toEip55ChecksumAddress(fresh.address.toLowerCase()));
  assert.match(fresh.privateKey, /^0x[0-9a-f]{64}$/);
});

test("loadDotEnvFile parses comments/quotes and never overrides existing env keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "nacbench-dotenv-"));
  try {
    const p = join(dir, ".env.test");
    writeFileSync(
      p,
      [
        "# leading comment",
        "",
        "NETWORK=previewnet # inline comment",
        'QUOTED_VAL="hello\\nworld"',
        "SINGLE_VAL='raw#not-a-comment'",
        "export EXPORTED_KEY=abc123",
        "EXISTING=from-file",
      ].join("\n"),
      "utf8",
    );

    const targetEnv = { EXISTING: "from-shell" };
    const res = loadDotEnvFile(p, targetEnv);
    assert.equal(res.loaded, true);
    assert.equal(targetEnv.NETWORK, "previewnet");
    assert.equal(targetEnv.QUOTED_VAL, "hello\nworld");
    assert.equal(targetEnv.SINGLE_VAL, "raw#not-a-comment");
    assert.equal(targetEnv.EXPORTED_KEY, "abc123");
    assert.equal(targetEnv.EXISTING, "from-shell");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate-previewnet-wallets.mjs enforces 0o600, flag wx no-overwrite, and never prints secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "nacbench-gen-wallets-"));
  try {
    const outPath = join(dir, ".env.previewnet");
    const stdout = execFileSync(process.execPath, [GEN_SCRIPT, "--out", outPath], {
      encoding: "utf8",
    });

    // Verify file mode is strictly 0o600
    const mode = statSync(outPath).mode & 0o777;
    assert.equal(mode, 0o600);

    // Load generated env file and inspect keys
    const envObj = {};
    loadDotEnvFile(outPath, envObj);
    assert.equal(envObj.NETWORK, "previewnet");
    assert.equal(isValidTezosXAddress(envObj.TEZOS_ADDRESS), true);
    assert.equal(envObj.TEZOS_SECRET_KEY, envObj.TEZOS_PRIVATE_KEY);
    assert.equal(isValidEvmAddress(envObj.EVM_ADDRESS), true);
    assert.equal(envObj.TEZOS_CHAIN_ID, "NetXY2oPPzkxUW1");
    assert.equal(envObj.EVM_CHAIN_ID, "128064");

    // Verify stdout prints ONLY public info and NEVER secrets
    assert.ok(stdout.includes(envObj.TEZOS_ADDRESS));
    assert.ok(stdout.includes(envObj.TEZOS_PUBLIC_KEY));
    assert.ok(stdout.includes(envObj.EVM_ADDRESS));
    assert.ok(stdout.includes("https://faucet.previewnet.tezosx.nomadic-labs.com"));
    assert.equal(stdout.includes(envObj.TEZOS_SECRET_KEY), false);
    assert.equal(stdout.includes(envObj.EVM_PRIVATE_KEY), false);
    assert.equal(stdout.includes("edsk"), false);

    // Second run MUST refuse to overwrite existing file (flag: 'wx')
    const originalContent = readFileSync(outPath, "utf8");
    assert.throws(
      () =>
        execFileSync(process.execPath, [GEN_SCRIPT, "--out", outPath], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      (err) => {
        assert.equal(err.status, 1);
        assert.match(String(err.stderr), /Refusing to overwrite/i);
        return true;
      },
    );
    assert.equal(readFileSync(outPath, "utf8"), originalContent);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
