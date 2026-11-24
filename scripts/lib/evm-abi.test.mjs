import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeCrossRuntimeRevert,
  decodeOriginOf,
  decodeResolveAddress,
  encodeAbiParams,
  encodeCallMichelson,
  encodeCallMichelsonView,
  encodeEchoCallbackArgs,
  encodeEchoViewCalldata,
  encodeFunctionCall,
  encodeMaterializeAliasEvm,
  encodeOriginOf,
  encodeResolveAddress,
  keccak256Hex,
  selectorOf,
} from "./evm-abi.mjs";

test("Keccak-256 and Solidity function selectors match standard & M0-verified values", () => {
  assert.equal(
    keccak256Hex(""),
    "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  );
  assert.equal(selectorOf("transfer(address,uint256)"), "0xa9059cbb");
  // Live M0-verified selectors on Previewnet v0.11 precompile 0xff...0007
  assert.equal(selectorOf("callMichelsonView(string,string,bytes)"), "0x8326329c");
  assert.equal(selectorOf("materializeAlias(string,string,string)"), "0xbfe88b4b");
  assert.equal(
    encodeMaterializeAliasEvm("tezos", "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb", "edpk...").slice(0, 10),
    "0xbfe88b4b",
  );
  assert.equal(encodeCallMichelsonView("KT18oDJJKXMKhfE1bSuAPGp92pYcwVDiqsPw", "get_state_digest", "0x0001").slice(0, 10), "0x8326329c");
  assert.ok(encodeCallMichelson("KT18oDJJKXMKhfE1bSuAPGp92pYcwVDiqsPw", "record_ping", "0x030b").startsWith(selectorOf("callMichelson(string,string,bytes)")));
});

test("decodeOriginOf and decodeResolveAddress decode live M0 Previewnet v0.11 responses", () => {
  // Exact raw response from scripts/m0-results.json for tz1VSUr... (runtime 0 = Michelson)
  const rawOrigin =
    "0x0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000060" +
    "0000000000000000000000000000000000000000000000000000000000000024" +
    "747a31565355723877774e684c417a656d706f6368356436684c5269546838436a636a6200000000000000000000000000000000000000000000000000000000";

  const origin = decodeOriginOf(rawOrigin);
  assert.equal(origin.ok, true);
  assert.equal(origin.kind, 1);
  assert.equal(origin.kindLabel, "Native");
  assert.equal(origin.homeRuntime, 0);
  assert.equal(origin.homeRuntimeLabel, "Michelson");
  assert.equal(origin.nativeAddress, "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb");

  // Exact raw response from scripts/m0-results.json for resolveAddress(tz1VSUr..., 0, 1)
  const rawResolve =
    "0x0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000060" +
    "000000000000000000000000000000000000000000000000000000000000002a" +
    "30783363304545323144413039336230414134346335393042413042423138383365663830383031333700000000000000000000000000000000000000000000";

  const resolved = decodeResolveAddress(rawResolve);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.classified, true);
  assert.equal(resolved.resolution, 1);
  assert.equal(resolved.translated, "0x3c0EE21DA093b0AA44c590BA0BB1883ef8080137");

  assert.ok(encodeOriginOf("tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb", 0).startsWith("0x"));
  assert.ok(encodeResolveAddress("tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb", 0, 1).startsWith("0x"));
});

test("Canary callback & staticcall_evm encoders match exact wire layout", () => {
  // 64-byte ABI tail (no selector) for %call_evm -> onMichelsonCallback(uint256,uint256)
  const tail = encodeEchoCallbackArgs(7n, 3n);
  assert.equal(tail.length, 2 + 128); // 64 bytes
  assert.equal(
    tail,
    "0x0000000000000000000000000000000000000000000000000000000000000007" +
      "0000000000000000000000000000000000000000000000000000000000000003",
  );

  // Full calldata (4-byte selector + 32-byte word) for staticcall_evm -> echoView(uint256)
  const echoCd = encodeEchoViewCalldata(99n);
  assert.equal(echoCd.length, 2 + 8 + 64);
  assert.equal(echoCd.slice(0, 10), selectorOf("echoView(uint256)"));
});

test("decodeCrossRuntimeRevert classifies 429 OOG, UTF-8 gateway errors, and Solidity Error(string)", () => {
  // 429 OOG raw UTF-8 revert
  const oogHex = "0x" + Buffer.from("Cross-runtime call failed with status 429: OOG", "utf8").toString("hex");
  const oog = decodeCrossRuntimeRevert(oogHex);
  assert.equal(oog.category, "CROSS_RUNTIME_429_OOG");
  assert.equal(oog.is429Oog, true);

  // Live M0 404 UTF-8 revert from 0xff...0007
  const live404 =
    "0x43726f73732d72756e74696d652063616c6c206661696c656420776974682073746174757320343034";
  const r404 = decodeCrossRuntimeRevert(live404);
  assert.equal(r404.category, "GATEWAY_UTF8_REVERT");
  assert.equal(r404.is429Oog, false);
  assert.match(r404.message, /status 404/);

  // Solidity Error(string)
  const solErr = encodeFunctionCall("Error(string)", [{ type: "string", value: "Sub-mutez dust" }]);
  const decodedErr = decodeCrossRuntimeRevert(solErr);
  assert.equal(decodedErr.category, "SOLIDITY_ERROR");
  assert.equal(decodedErr.message, "Sub-mutez dust");

  // Solidity Error(string) wrapping 429 OOG
  const solOog = encodeFunctionCall("Error(string)", [{ type: "string", value: "429 OOG" }]);
  assert.equal(decodeCrossRuntimeRevert(solOog).category, "CROSS_RUNTIME_429_OOG");

  // ABI params encoding check
  const p = encodeAbiParams([{ type: "bool", value: true }, { type: "address", value: "0xff00000000000000000000000000000000000007" }]);
  assert.equal(p.length, 2 + 128);
});
