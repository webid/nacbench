import test from "node:test";
import assert from "node:assert/strict";
import { diffSnapshots, loadNetworkConfig } from "./pinning.mjs";

test("loadNetworkConfig loads M0-verified previewnet, shadownet, and mainnet profiles", async () => {
  const prev = await loadNetworkConfig("previewnet");
  assert.equal(prev.evm.chainId, 128064);
  assert.equal(prev.michelson.chainId, "NetXY2oPPzkxUW1");
  assert.equal(prev.michelson.hardGasLimitPerOperation, 660000);
  assert.equal(prev.evm.nacPrecompile, "0xff00000000000000000000000000000000000007");
  assert.equal(prev.michelson.evmGateway, "KT18oDJJKXMKhfE1bSuAPGp92pYcwVDiqsPw");

  const shadow = await loadNetworkConfig("shadownet");
  assert.equal(shadow.evm.chainId, 127823);
  assert.equal(shadow.michelson.chainId, "NetXtLrzvQDobza");

  const main = await loadNetworkConfig("mainnet");
  assert.equal(main.evm.chainId, 42793);
  assert.equal(main.michelson.chainId, "NetXohUVN5QWR4f");

  await assert.rejects(() => loadNetworkConfig("nonexistent"), /Unknown network/);
});

test("diffSnapshots computes exact EVM wei & Michelson mutez deltas and storage mutation flag", () => {
  const before = {
    pinnedHeight: 1902551,
    evm: { address: "0x1111111111111111111111111111111111111111", balanceWei: "1000000000000000000" },
    michelson: { address: "KT1abc", balanceMutez: "500000", storage: { int: "1" } },
  };
  const after = {
    pinnedHeight: 1902552,
    evm: { address: "0x1111111111111111111111111111111111111111", balanceWei: "999000000000000000" },
    michelson: { address: "KT1abc", balanceMutez: "501000", storage: { int: "2" } },
  };
  const diff = diffSnapshots(before, after);
  assert.equal(diff.beforeHeight, 1902551);
  assert.equal(diff.afterHeight, 1902552);
  assert.equal(diff.evmDeltaWei, "-1000000000000000");
  assert.equal(diff.michelsonDeltaMutez, "1000");
  assert.equal(diff.michelsonStorageChanged, true);

  // Identical rollback snapshot shows zero net diff
  const rollbackDiff = diffSnapshots(before, { ...before, pinnedHeight: 1902552 });
  assert.equal(rollbackDiff.evmDeltaWei, "0");
  assert.equal(rollbackDiff.michelsonDeltaMutez, "0");
  assert.equal(rollbackDiff.michelsonStorageChanged, false);
});
