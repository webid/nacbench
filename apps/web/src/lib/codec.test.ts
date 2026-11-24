import { describe, expect, it } from 'vitest';
import {
  MAX_UINT256,
  computeBigMapKeyHash,
  decodeMicheline,
  decodeRawMichelineHex,
  decodeRevertPayload,
  encodeCodecInput,
  encodeMaterializeAliasCalldata,
  encodeUint256Checked,
  isTz4Address,
  isValidEvmAddress,
  isValidTezosXAddress,
  selectorOf,
} from './codec';
import { DEFAULT_FIXTURES, NETWORKS } from './networks';
import { buildOctezJsMaterializeSnippet, generateGuardrailedSnippets } from './snippets';
import type { CodecInput } from './types';

function makeBaseInput(overrides: Partial<CodecInput> = {}): CodecInput {
  return {
    preset: 'canary_record_ping',
    entrypoint: 'record_ping',
    kt1Target: DEFAULT_FIXTURES.evmGatewayKt1,
    evmTarget: DEFAULT_FIXTURES.freeRoutePoolEvm,
    stringVal: 'hello-nac',
    natVal: '42',
    intVal: '-128',
    bytesHex: '0xdeadbeef',
    addressVal: DEFAULT_FIXTURES.aliceTz1,
    mutezVal: '1000000',
    valueWei: '1000000000000',
    evmGasCap: '5000000',
    callDirection: 'evm_to_michelson',
    ...overrides,
  };
}

describe('codec — Micheline binary encoding & critic M1 polish decoding', () => {
  it('encodes Unit, String, Nat, negative Int, Bytes, Address, Pair, Option, Or', () => {
    const unitRes = encodeCodecInput(makeBaseInput({ preset: 'unit' }));
    expect(unitRes.ok).toBe(true);
    expect(unitRes.michelineHex).toBe('0x030b');
    expect(unitRes.decodedExpression).toEqual({ prim: 'Unit' });

    const strRes = encodeCodecInput(makeBaseInput({ preset: 'string', stringVal: 'TezosX' }));
    expect(strRes.ok).toBe(true);
    expect(strRes.michelineHex).toBe('0x010000000654657a6f7358');
    expect(strRes.decodedExpression).toEqual({ string: 'TezosX' });

    const negIntRes = encodeCodecInput(makeBaseInput({ preset: 'int', intVal: '-128' }));
    expect(negIntRes.ok).toBe(true);
    expect(negIntRes.decodedExpression).toEqual({ int: '-128' });

    const pairRes = encodeCodecInput(
      makeBaseInput({
        preset: 'pair_addr_mutez',
        addressVal: DEFAULT_FIXTURES.aliceTz1,
        mutezVal: '500000',
      }),
    );
    expect(pairRes.ok).toBe(true);
    expect(pairRes.decodedExpression).toMatchObject({
      prim: 'Pair',
      args: [
        { bytes: expect.stringMatching(/^0000[0-9a-f]{40}$/) },
        { int: '500000' },
      ],
    });
  });

  it('decodes annotated primitives (0x04, 0x06, 0x08) and generic Prim_N (0x09)', () => {
    // Prim_0 with annot (%unit_val): tag=0x04, op=0x0b (Unit), len=9, "%unit_val"
    const prim0Annot = '0x040b0000000925756e69745f76616c';
    expect(decodeMicheline(prim0Annot)).toEqual({
      prim: 'Unit',
      annots: ['%unit_val'],
    });

    // Prim_1 with annot: tag=0x06, op=0x09 (Some), arg=Unit(0x030b), annot="%opt"
    const prim1Annot = '0x0609030b00000004256f7074';
    expect(decodeMicheline(prim1Annot)).toEqual({
      prim: 'Some',
      args: [{ prim: 'Unit' }],
      annots: ['%opt'],
    });

    // Prim_2 with annot: tag=0x08, op=0x07 (Pair), arg1=int(1)=0x0001, arg2=int(2)=0x0002, annot="%p @v"
    const prim2Annot = '0x080700010002000000052570204076';
    expect(decodeMicheline(prim2Annot)).toEqual({
      prim: 'Pair',
      args: [{ int: '1' }, { int: '2' }],
      annots: ['%p', '@v'],
    });

    // Prim_N (0x09) 3-element comb Pair(1, 2, 3) with annot "%tri":
    // tag=0x09, op=0x07 (Pair), argsLen=6 (0001 0002 0003), annotLen=4 ("%tri")
    const primN = '0x0907000000060001000200030000000425747269';
    const res = decodeRawMichelineHex(primN);
    expect(res.ok).toBe(true);
    expect(res.expression).toEqual({
      prim: 'Pair',
      args: [{ int: '1' }, { int: '2' }, { int: '3' }],
      annots: ['%tri'],
    });
  });

  it('auto-handles 0x05 PACK prefix in decodeRawMichelineHex without breaking Prim_1 (0x05)', () => {
    // Prim_1 Some(Unit) starts with 0x05 too — must decode directly as Some(Unit)!
    const someUnit = decodeRawMichelineHex('0x0509030b');
    expect(someUnit.ok).toBe(true);
    expect(someUnit.expression).toEqual({ prim: 'Some', args: [{ prim: 'Unit' }] });

    // PACKed int 42: 0x05 (PACK) + 0x002a (int 42) — direct fails because 0x00 is not valid prim1 arg? Wait: 0x05 0x00 0x2a -> tag 0x2a invalid -> falls back to PACK!
    const packedInt = decodeRawMichelineHex('0x05002a');
    expect(packedInt.ok).toBe(true);
    expect(packedInt.expression).toEqual({ int: '42' });
  });
});

describe('codec — strict uint256 bounds, addresses, big_map key hashing, and selectors', () => {
  it('enforces [0, 2^256 - 1] bounds on encodeUint256Checked', () => {
    expect(encodeUint256Checked(0n)).toBe('0'.repeat(64));
    expect(encodeUint256Checked(MAX_UINT256)).toBe('f'.repeat(64));
    expect(encodeUint256Checked('255')).toBe('0'.repeat(62) + 'ff');

    expect(() => encodeUint256Checked(-1n)).toThrow(RangeError);
    expect(() => encodeUint256Checked('-1')).toThrow(RangeError);
    expect(() => encodeUint256Checked(MAX_UINT256 + 1n)).toThrow(RangeError);
    expect(() => encodeUint256Checked('')).toThrow(RangeError);
  });

  it('validates tz1/KT1 Base58Check addresses and explicitly rejects tz4 BLS addresses', () => {
    expect(isValidTezosXAddress(DEFAULT_FIXTURES.aliceTz1)).toBe(true);
    expect(isValidTezosXAddress(DEFAULT_FIXTURES.evmGatewayKt1)).toBe(true);
    expect(isValidTezosXAddress('tz1VSUr8wwNhLAzempoch5d6hLRiTh8CjcjX')).toBe(false); // bad checksum
    expect(isTz4Address(DEFAULT_FIXTURES.sampleTz4Rejected)).toBe(true);
    expect(isValidTezosXAddress(DEFAULT_FIXTURES.sampleTz4Rejected)).toBe(false);

    expect(isValidEvmAddress(DEFAULT_FIXTURES.freeRoutePoolEvm)).toBe(true);
    expect(isValidEvmAddress('0x1234')).toBe(false);
  });

  it('computes deterministic Tezos big_map expr... hashes matching BLAKE2b-256 + Base58Check', () => {
    const natZero = computeBigMapKeyHash('nat', '0');
    expect(natZero.packedHex).toBe('0x050000');
    expect(natZero.exprHash).toBe('exprtZBwZUeYYYfUs9B9Rg2ywHezVHnCCnmF9WsDQVrs582dSK63dC');

    const natKey = computeBigMapKeyHash('nat', '1');
    expect(natKey.packedHex).toBe('0x050001');
    expect(natKey.exprHash).toMatch(/^expr[1-9A-HJ-NP-Za-km-z]{50}$/);

    // Canonical Tezos script_expr hash for nat 1 (0x050001):
    expect(natKey.exprHash).toBe('expru2dKqDfZG8hu4wNGkiyunvq2hdSKuVYtcKta7BWP6Q18oNxKjS');

    const addrKey = computeBigMapKeyHash('address', DEFAULT_FIXTURES.aliceTz1);
    expect(addrKey.packedHex.startsWith('0x050a000000160000')).toBe(true);
    expect(addrKey.exprHash.startsWith('expr')).toBe(true);
  });

  it('produces live-verified Previewnet v0.11 / Horus 8.0 precompile selectors', () => {
    expect(selectorOf('callMichelsonView(string,string,bytes)')).toBe('0x8326329c');
    expect(selectorOf('materializeAlias(string,string,string)')).toBe('0xbfe88b4b');

    const matCalldata = encodeMaterializeAliasCalldata(
      'tezos',
      DEFAULT_FIXTURES.aliceTz1,
      DEFAULT_FIXTURES.alicePubKey,
    );
    expect(matCalldata.startsWith('0xbfe88b4b')).toBe(true);
  });
});

describe('codec — guardrails & revert decoder', () => {
  it('flags sub-mutez wei dust (< 10^12) and low EVM gas caps', () => {
    const dusty = encodeCodecInput(
      makeBaseInput({ valueWei: '1000000000001', evmGasCap: '1500000' }),
    );
    expect(dusty.ok).toBe(true);
    expect(dusty.mutezAligned).toBe(false);
    expect(dusty.dustRemainderWei).toBe('1');

    const dustGuard = dusty.guardrails.find((g) => g.id === 'mutez-dust');
    expect(dustGuard?.triggered).toBe(true);
    expect(dustGuard?.severity).toBe('critical');

    const gasGuard = dusty.guardrails.find((g) => g.id === 'gas-cap-asymmetry');
    expect(gasGuard?.triggered).toBe(true);
  });

  it('enforces %call_evm (no selector) vs staticcall_evm (with 4-byte selector) asymmetry', () => {
    const callEvm = encodeCodecInput(
      makeBaseInput({
        callDirection: 'michelson_to_evm',
        entrypoint: 'onMichelsonCallback(uint256,uint256)',
        natVal: '99',
      }),
    );
    expect(callEvm.ok).toBe(true);
    // 2 uint256 words = 64 bytes = 128 hex chars + '0x' = 130 chars (NO 4-byte selector!)
    expect(callEvm.gatewayCalldataHex.length).toBe(130);

    const staticEvm = encodeCodecInput(
      makeBaseInput({
        callDirection: 'michelson_staticcall_evm',
        entrypoint: 'echoView(uint256)',
        natVal: '99',
      }),
    );
    expect(staticEvm.ok).toBe(true);
    expect(staticEvm.gatewayCalldataHex.startsWith(selectorOf('echoView(uint256)'))).toBe(true);
    // 4-byte selector + 32-byte uint256 = 36 bytes = 72 hex chars + '0x' = 74 chars
    expect(staticEvm.gatewayCalldataHex.length).toBe(74);
  });

  it('encodes multi-signature EVM ABI args (transfer, balanceOf, setNote) accurately and rejects unsupported tuples', () => {
    const recipient = '0x000000000000000000000000000000000000dEaD';

    // %call_evm: transfer(address,uint256) -> 64 bytes args-only (NO 4-byte selector!)
    const transferCallEvm = encodeCodecInput(
      makeBaseInput({
        callDirection: 'michelson_to_evm',
        entrypoint: 'transfer(address,uint256)',
        evmArgs: [recipient, '1000000'],
      }),
    );
    expect(transferCallEvm.ok).toBe(true);
    expect(transferCallEvm.abiSelector).toBe('0xa9059cbb');
    expect(transferCallEvm.gatewayCalldataHex).toBe(
      '0x' +
        '0'.repeat(24) +
        '000000000000000000000000000000000000dead' +
        '0'.repeat(58) +
        '0f4240',
    );

    // staticcall_evm: balanceOf(address) -> 4-byte selector 0x70a08231 + 32-byte address word
    const balanceOfStatic = encodeCodecInput(
      makeBaseInput({
        callDirection: 'michelson_staticcall_evm',
        entrypoint: 'balanceOf(address)',
        evmArgs: [recipient],
      }),
    );
    expect(balanceOfStatic.ok).toBe(true);
    expect(balanceOfStatic.abiSelector).toBe('0x70a08231');
    expect(balanceOfStatic.gatewayCalldataHex).toBe(
      '0x70a08231' + '0'.repeat(24) + '000000000000000000000000000000000000dead',
    );

    // Unsupported nested tuple must fail cleanly instead of silently encoding wrong bytes
    const badTuple = encodeCodecInput(
      makeBaseInput({
        callDirection: 'michelson_to_evm',
        entrypoint: 'submit((address,uint256))',
      }),
    );
    expect(badTuple.ok).toBe(false);
    expect(badTuple.error).toMatch(/Unsupported nested tuple/i);
  });

  it('decodes raw UTF-8 Previewnet 429 OOG reverts, Solidity Error(string), and Panic(uint256)', () => {
    const utf8OogHex =
      '0x' +
      Array.from(new TextEncoder().encode('Cross-runtime call failed with status 429: OOG'))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    const decodedOog = decodeRevertPayload(utf8OogHex);
    expect(decodedOog.kind).toBe('CROSS_RUNTIME_429_OOG');
    expect(decodedOog.status).toBe(429);

    const panicDiv0 = decodeRevertPayload(
      '0x4e487b71' + '0'.repeat(62) + '12',
    );
    expect(panicDiv0.kind).toBe('SOLIDITY_PANIC');
    expect(panicDiv0.summary).toContain('Division or modulo by zero');

    const empty = decodeRevertPayload('0x');
    expect(empty.kind).toBe('EMPTY');
  });
});

describe('snippets — direction-accurate octez.js / EVM snippets & v25 methodsObject', () => {
  it('branches octezJs cleanly across all 4 NAC call directions without mixing callMichelson into %call_evm', () => {
    const net = NETWORKS.previewnet;

    // 1. evm_to_michelson -> eth_sendTransaction to 0xff00...0007 (never call_evm)
    const evmToMichInput = makeBaseInput({ callDirection: 'evm_to_michelson' });
    const evmToMichRes = encodeCodecInput(evmToMichInput);
    const evmToMichSnip = generateGuardrailedSnippets(evmToMichInput, evmToMichRes, net);
    expect(evmToMichSnip.octezJs).toContain('eth_sendTransaction');
    expect(evmToMichSnip.octezJs).toContain(evmToMichRes.gatewayCalldataHex);
    expect(evmToMichSnip.octezJs).not.toContain('methodsObject.call_evm');

    // 2. evm_view_michelson -> eth_call to 0xff00...0007 with 0x8326329c
    const evmViewInput = makeBaseInput({
      callDirection: 'evm_view_michelson',
      preset: 'canary_get_state_digest',
      entrypoint: 'get_state_digest',
    });
    const evmViewRes = encodeCodecInput(evmViewInput);
    const evmViewSnip = generateGuardrailedSnippets(evmViewInput, evmViewRes, net);
    expect(evmViewSnip.octezJs).toContain("method: 'eth_call'");
    expect(evmViewSnip.octezJs).toContain('0x8326329c');
    expect(evmViewSnip.octezJs).not.toContain('methodsObject.call_evm');

    // 3. michelson_to_evm -> methodsObject.call_evm with args-only data (no 4-byte selector)
    const michToEvmInput = makeBaseInput({
      callDirection: 'michelson_to_evm',
      entrypoint: 'onMichelsonCallback(uint256,uint256)',
      natVal: '99',
    });
    const michToEvmRes = encodeCodecInput(michToEvmInput);
    const michToEvmSnip = generateGuardrailedSnippets(michToEvmInput, michToEvmRes, net);
    expect(michToEvmSnip.octezJs).toContain('methodsObject.call_evm');
    expect(michToEvmSnip.octezJs).toContain(michToEvmRes.gatewayCalldataHex.slice(2));

    // 4. michelson_staticcall_evm -> contractViews.staticcall_evm with full 4-byte selector calldata
    const staticInput = makeBaseInput({
      callDirection: 'michelson_staticcall_evm',
      entrypoint: 'echoView(uint256)',
      natVal: '99',
    });
    const staticRes = encodeCodecInput(staticInput);
    const staticSnip = generateGuardrailedSnippets(staticInput, staticRes, net);
    expect(staticSnip.octezJs).toContain('staticcall_evm');
    expect(staticSnip.octezJs).toContain(staticRes.gatewayCalldataHex.slice(2));
  });

  it('uses modern methodsObject.materialize_alias with numeric positional fields in octez.js v25', () => {
    const snippet = buildOctezJsMaterializeSnippet(
      NETWORKS.previewnet,
      DEFAULT_FIXTURES.aliceTz1,
      DEFAULT_FIXTURES.alicePubKey,
    );
    expect(snippet).toContain('gateway.methodsObject');
    expect(snippet).toContain(".materialize_alias({\n    0: 'tezos',");
    expect(snippet).toContain(`1: '${DEFAULT_FIXTURES.aliceTz1}'`);
    expect(snippet).toContain(`2: '${DEFAULT_FIXTURES.alicePubKey}'`);
    expect(snippet).not.toContain('gateway.methods.');
  });
});
