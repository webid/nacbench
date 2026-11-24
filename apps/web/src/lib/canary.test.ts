import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CANARY_SELECTORS,
  PREVIEWNET_SAMPLE_TX_HASH,
  buildNactraceUrl,
  computeMirroredMichelsonOpHash,
  decodeMichelsonAddressBytes,
  encodeProbeOogCalldata,
  encodeProbeRollbackCalldata,
  encodeProbeRoundTripCalldata,
  encodeProbeViewCalldata,
  encodeProbeWriteCalldata,
  executeReadOnlyProbeView,
  flattenCallTracerFrames,
  inspectTransactionHash,
  loadDefaultCanaryAddresses,
  parseNacCanaryMichelsonStorage,
  readCanaryLiveState,
  resolveKnownSelectorName,
  sendCanaryProbeTx,
  unwrapProbeViewMichelineBytes,
} from './canary';
import {
  bytesToHex,
  encodeAbiParams,
  encodeNat,
  encodePair,
  selectorOf,
} from './codec';
import { DEFAULT_FIXTURES, NETWORKS, NULL_SOURCE_ADDRESS } from './networks';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('canary — ABI selectors, encoders, and nactrace deep-link builder', () => {
  it('matches all 8 verified M1 NacCanaryEvm.sol function selectors', () => {
    expect(selectorOf('probeWrite(string,string,uint256)')).toBe(CANARY_SELECTORS.probeWrite);
    expect(selectorOf('probeRoundTrip(string,uint256,uint256)')).toBe(
      CANARY_SELECTORS.probeRoundTrip,
    );
    expect(selectorOf('onMichelsonCallback(uint256,uint256)')).toBe(
      CANARY_SELECTORS.onMichelsonCallback,
    );
    expect(selectorOf('probeView(string,uint256)')).toBe(CANARY_SELECTORS.probeView);
    expect(selectorOf('probeRollback(string,string,uint256)')).toBe(
      CANARY_SELECTORS.probeRollback,
    );
    expect(selectorOf('probeOog(string,uint256,uint256,bool)')).toBe(CANARY_SELECTORS.probeOog);
    expect(selectorOf('echoView(uint256)')).toBe(CANARY_SELECTORS.echoView);
    expect(selectorOf('setAuthorizedKt1Alias(address)')).toBe(
      CANARY_SELECTORS.setAuthorizedKt1Alias,
    );
  });

  it('encodes all 5 probe calldatas with exact selectors', () => {
    const kt1 = DEFAULT_FIXTURES.evmGatewayKt1;
    expect(encodeProbeWriteCalldata(kt1, 'ping-1', 5_000_000n).startsWith('0xa2b9cf04')).toBe(
      true,
    );
    expect(encodeProbeRoundTripCalldata(kt1, 42n, 5_000_000n).startsWith('0x3afa6469')).toBe(true);
    expect(encodeProbeViewCalldata(kt1, 7n).startsWith('0x00aa2ecb')).toBe(true);
    expect(
      encodeProbeRollbackCalldata(kt1, 'FORCE_ROLLBACK', 5_000_000n).startsWith('0x6bab2b6f'),
    ).toBe(true);
    expect(encodeProbeOogCalldata(kt1, 1000n, 400_000n, true).startsWith('0xccc96ba6')).toBe(true);
  });

  it('builds complementary nactrace deep-link URLs cleanly', () => {
    expect(buildNactraceUrl('previewnet', PREVIEWNET_SAMPLE_TX_HASH)).toBe(
      `https://migl992.github.io/nactrace/?hash=${PREVIEWNET_SAMPLE_TX_HASH}&network=previewnet`,
    );
    expect(buildNactraceUrl('mainnet', '0xabc')).toBe(
      'https://migl992.github.io/nactrace/?hash=0xabc&network=mainnet',
    );
  });

  it('returns unconfigured safely when no deployment manifest or custom storage exists', () => {
    const addrs = loadDefaultCanaryAddresses('shadownet');
    expect(addrs.source).toBe('unconfigured');
    expect(addrs.evmCanary).toBe('');
    expect(addrs.michelsonCanary).toBe('');
  });
});

describe('canary — probeView Micheline decoding, Michelson storage parsing, and live state reads', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses 9-field right-comb NacCanary Michelson storage (nested and comb)', () => {
    const nested = {
      prim: 'Pair',
      args: [
        { string: DEFAULT_FIXTURES.aliceTz1 },
        {
          prim: 'Pair',
          args: [
            { string: DEFAULT_FIXTURES.evmGatewayKt1 },
            {
              prim: 'Pair',
              args: [
                { int: '3' },
                {
                  prim: 'Pair',
                  args: [
                    { string: 'hello-m3' },
                    {
                      prim: 'Pair',
                      args: [
                        { string: 'KT1Alias1111111111111111111111111111' },
                        {
                          prim: 'Pair',
                          args: [
                            { string: NULL_SOURCE_ADDRESS },
                            {
                              prim: 'Pair',
                              args: [
                                { string: DEFAULT_FIXTURES.freeRoutePoolEvm },
                                {
                                  prim: 'Pair',
                                  args: [{ int: '5' }, { int: '99' }],
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const parsed = parseNacCanaryMichelsonStorage(nested);
    expect(parsed).toEqual({
      admin: DEFAULT_FIXTURES.aliceTz1,
      callbackCount: '3',
      lastNote: 'hello-m3',
      lastSender: 'KT1Alias1111111111111111111111111111',
      lastSource: NULL_SOURCE_ADDRESS,
      pairedEvmCanary: DEFAULT_FIXTURES.freeRoutePoolEvm,
      pingCount: '5',
    });

    // Optimized 22-byte {"bytes": "..."} address fields returned by live Previewnet RPC /storage
    expect(
      decodeMichelsonAddressBytes('00000000000000000000000000000000000000000000'),
    ).toBe(NULL_SOURCE_ADDRESS);

    // 22-byte optimized KT18oDJJKXMKhfE1bSuAPGp92pYcwVDiqsPw + null source + Alice tz1
    const optimizedStorage = {
      prim: 'Pair',
      args: [
        { bytes: '00006b82198cb179e8306c1bedd08f12dc863f328886' }, // Alice tz1VSUr...
        { bytes: '01000000000000000000000000000000000000000100' }, // gateway
        { int: '1' },
        { string: 'nacbench-m1-ping' },
        { bytes: '01000000000000000000000000000000000000000100' }, // KT1 sender
        { bytes: '00000000000000000000000000000000000000000000' }, // null tz1Ke2h7...
        { string: DEFAULT_FIXTURES.freeRoutePoolEvm },
        { int: '1' },
        { int: '42' },
      ],
    };
    const parsedOpt = parseNacCanaryMichelsonStorage(optimizedStorage);
    expect(parsedOpt?.admin).toBe(DEFAULT_FIXTURES.aliceTz1);
    expect(parsedOpt?.lastSource).toBe(NULL_SOURCE_ADDRESS);
    expect(parsedOpt?.lastSender).toMatch(/^KT1[1-9A-HJ-NP-Za-km-z]{33}$/);
  });

  it('executes read-only probeView + echoView + run_script_view and decodes Micheline state digest', async () => {
    const net = NETWORKS.previewnet;
    const evmCanary = '0x2222222222222222222222222222222222222222';
    const kt1Canary = DEFAULT_FIXTURES.evmGatewayKt1;

    // Encode Michelson Pair(ping_count=5, Pair(callback_count=2, echo=7))
    const rawMicheline = encodePair(encodeNat(5), encodePair(encodeNat(2), encodeNat(7)));
    const probeViewAbiReturn = encodeAbiParams([
      { type: 'bytes', value: bytesToHex(rawMicheline, true) },
    ]);
    const echoViewAbiReturn = encodeAbiParams([
      { type: 'uint256', value: 7n },
      { type: 'uint256', value: 5n },
    ]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === net.evm.rpcUrl) {
          const body = JSON.parse(String(init?.body)) as {
            id: number;
            params: Array<{ data?: string }>;
          };
          const callData = body.params[0]?.data ?? '';
          if (callData.startsWith(CANARY_SELECTORS.probeView)) {
            return jsonResponse({ jsonrpc: '2.0', id: body.id, result: probeViewAbiReturn });
          }
          if (callData.startsWith(CANARY_SELECTORS.echoView)) {
            return jsonResponse({ jsonrpc: '2.0', id: body.id, result: echoViewAbiReturn });
          }
        }
        if (url.includes('/run_script_view')) {
          return jsonResponse({
            data: { prim: 'Pair', args: [{ int: '5' }, { prim: 'Pair', args: [{ int: '2' }, { int: '7' }] }] },
          });
        }
        return jsonResponse({}, 404);
      }),
    );

    const res = await executeReadOnlyProbeView(
      net,
      { evmCanary, michelsonCanary: kt1Canary, source: 'custom' },
      7n,
    );
    expect(res.ok).toBe(true);
    expect(res.rawMichelineHex).toBe(bytesToHex(rawMicheline, true));
    expect(res.decodedDigest).toEqual({
      prim: 'Pair',
      args: [{ int: '5' }, { prim: 'Pair', args: [{ int: '2' }, { int: '7' }] }],
    });
    expect(res.echoViewResult).toEqual({ echoed: '7', writes: '5' });
    expect(res.runScriptViewResult).toBeDefined();
  });

  it('reads pinned dual-runtime CanaryLiveState using a single JSON-RPC batch POST and retries on 503', async () => {
    const net = NETWORKS.previewnet;
    const evmCanary = '0x3333333333333333333333333333333333333333';
    const kt1Canary = DEFAULT_FIXTURES.evmGatewayKt1;
    let batchPosts = 0;
    let first503Triggered = false;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === net.evm.rpcUrl) {
          const parsed = JSON.parse(String(init?.body)) as
            | { id: number; method: string; params: Array<{ data?: string } | string> }
            | Array<{ id: number; method: string; params: Array<{ data?: string } | string> }>;

          if (Array.isArray(parsed)) {
            batchPosts++;
            expect(parsed).toHaveLength(11);
            return jsonResponse(
              parsed.map((req) => {
                expect(req.method).toBe('eth_call');
                expect(req.params[1]).toBe('0xc8');
                const sel = (req.params[0] as { data: string }).data;
                if (sel === selectorOf('lastOogReturnData()')) {
                  return {
                    jsonrpc: '2.0',
                    id: req.id,
                    result: encodeAbiParams([{ type: 'bytes', value: '0xdeadbeef' }]),
                  };
                }
                return {
                  jsonrpc: '2.0',
                  id: req.id,
                  result: encodeAbiParams([{ type: 'uint256', value: 1n }]),
                };
              }),
            );
          }

          if (parsed.method === 'eth_blockNumber') {
            if (!first503Triggered) {
              first503Triggered = true;
              return new Response('<html>503 Service Temporarily Unavailable</html>', {
                status: 503,
              });
            }
            return jsonResponse({ jsonrpc: '2.0', id: parsed.id, result: '0xc8' }); // 200
          }
        }
        if (url.endsWith('/blocks/200/header')) return jsonResponse({ level: 200 });
        if (url.endsWith('/storage')) {
          return jsonResponse({
            prim: 'Pair',
            args: [
              { string: DEFAULT_FIXTURES.aliceTz1 },
              { string: DEFAULT_FIXTURES.evmGatewayKt1 },
              { int: '2' },
              { string: 'live-note' },
              { string: DEFAULT_FIXTURES.aliceTz1 },
              { string: NULL_SOURCE_ADDRESS },
              { string: evmCanary },
              { int: '4' },
              { int: '12' },
            ],
          });
        }
        return jsonResponse({}, 404);
      }),
    );

    const state = await readCanaryLiveState(net, {
      evmCanary,
      michelsonCanary: kt1Canary,
      source: 'custom',
    });
    expect(first503Triggered).toBe(true);
    expect(batchPosts).toBe(1);
    expect(state.blockNumber).toBe(200);
    expect(state.michelsonLevel).toBe(200);
    expect(state.blockSynced).toBe(true);
    expect(state.evm?.writeCount).toBe('1');
    expect(state.evm?.lastOogOk).toBe(true);
    expect(state.evm?.lastOogReturnData).toBe('0xdeadbeef');
    expect(state.michelson?.pingCount).toBe('4');
    expect(state.michelson?.lastSource).toBe(NULL_SOURCE_ADDRESS);
  });
});

describe('canary — callTracer flattening, 429 OOG detection, Blockscout fallback, and tx sender', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('flattens nested callTracer frames, tags 0xff...0007 gateway hops, and decodes 429 OOG', () => {
    const net = NETWORKS.previewnet;
    const oogUtf8Hex =
      '0x' +
      Array.from(new TextEncoder().encode('Cross-runtime call failed with status 429: OOG'))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

    const frames = flattenCallTracerFrames(
      {
        type: 'CALL',
        from: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        gas: '0x5b8d80',
        gasUsed: '0x186a0',
        input: CANARY_SELECTORS.probeOog + '00'.repeat(128),
        error: 'execution reverted',
        calls: [
          {
            type: 'CALL',
            from: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            to: net.evm.precompile,
            gas: '0x61a80',
            gasUsed: '0x61a80',
            input: '0xa1544fc3' + '00'.repeat(64),
            error: 'execution reverted',
            output: oogUtf8Hex,
          },
        ],
      },
      net.evm.precompile,
    );

    expect(frames).toHaveLength(2);
    expect(frames[0].depth).toBe(0);
    expect(frames[0].isGatewayPrecompile).toBe(false);
    expect(frames[1].depth).toBe(1);
    expect(frames[1].isGatewayPrecompile).toBe(true);
    expect(frames[1].decodedRevert?.kind).toBe('CROSS_RUNTIME_429_OOG');
    expect(frames[1].decodedRevert?.status).toBe(429);
  });

  it('inspectTransactionHash falls back cleanly to Blockscout v2 when debug_traceTransaction fails', async () => {
    const net = NETWORKS.previewnet;
    const txHash = PREVIEWNET_SAMPLE_TX_HASH;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === net.evm.rpcUrl) {
          const body = JSON.parse(String(init?.body)) as { id: number; method: string };
          if (body.method === 'eth_getTransactionReceipt') {
            return jsonResponse({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                status: '0x0',
                blockNumber: '0x1e240',
                from: '0x1111111111111111111111111111111111111111',
                to: '0x2222222222222222222222222222222222222222',
                gasUsed: '0x3d090',
              },
            });
          }
          if (body.method === 'debug_traceTransaction') {
            return jsonResponse({
              jsonrpc: '2.0',
              id: body.id,
              error: { code: -32601, message: 'Method not found' },
            });
          }
        }
        if (url.endsWith(`/transactions/${txHash}`)) {
          return jsonResponse({
            from: { hash: '0x1111111111111111111111111111111111111111' },
            to: { hash: '0x2222222222222222222222222222222222222222' },
            value: '0',
            gas_limit: '5000000',
            gas_used: '250000',
            raw_input: CANARY_SELECTORS.probeOog + '00',
            revert_reason: 'Cross-runtime call failed with status 429: OOG',
            result: 'reverted',
          });
        }
        if (url.endsWith(`/transactions/${txHash}/internal-transactions`)) {
          return jsonResponse({
            items: [
              {
                call_type: 'call',
                from: { hash: '0x2222222222222222222222222222222222222222' },
                to: { hash: net.evm.precompile },
                value: '0',
                gas_limit: '400000',
                gas_used: '400000',
                error: 'Cross-runtime call failed with status 429: OOG',
              },
            ],
          });
        }
        return jsonResponse({}, 404);
      }),
    );

    const report = await inspectTransactionHash(net, txHash);
    expect(report.receiptFound).toBe(true);
    expect(report.status).toBe('reverted');
    expect(report.blockNumber).toBe(123456);
    expect(report.traceSource).toBe('blockscout_fallback');
    expect(report.gatewayHops).toBe(1);
    expect(report.decodedTopRevert?.kind).toBe('CROSS_RUNTIME_429_OOG');
    expect(report.nactraceUrl).toContain('migl992.github.io/nactrace');
    expect(report.rawTraceError).toContain('Method not found');
  });

  it('enforces 10^12 wei alignment and explicit gasLimit in sendCanaryProbeTx', async () => {
    const net = NETWORKS.previewnet;
    const evmCanary = '0x2222222222222222222222222222222222222222';
    const sentParams: unknown[] = [];

    const mockProvider = {
      request: vi.fn(
        async ({
          method,
          params,
        }: {
          method: string;
          params?: unknown[] | Record<string, unknown>;
        }) => {
          if (method === 'eth_chainId') return '0x' + net.evm.chainId.toString(16);
          if (method === 'eth_accounts') return ['0x9999999999999999999999999999999999999999'];
          if (method === 'eth_sendTransaction') {
            sentParams.push(Array.isArray(params) ? params[0] : params);
            return PREVIEWNET_SAMPLE_TX_HASH;
          }
          return null;
        },
      ),
    };

    // Unaligned dust wei must reject before wallet prompt!
    await expect(
      sendCanaryProbeTx(mockProvider, net, evmCanary, '0x6bab2b6f', { valueWei: 1n }),
    ).rejects.toThrow(/Sub-mutez/i);

    const txHash = await sendCanaryProbeTx(mockProvider, net, evmCanary, '0x6bab2b6f', {
      valueWei: 1_000_000_000_000n,
      gasLimit: 6_000_000n,
    });
    expect(txHash).toBe(PREVIEWNET_SAMPLE_TX_HASH);
    expect(sentParams[0]).toMatchObject({
      to: evmCanary,
      gas: '0x' + (6_000_000).toString(16),
      value: '0x' + (1_000_000_000_000).toString(16),
    });
  });

  it('unwraps double ABI-encoded callMichelsonView bytes and detects caught 429 OOG on status 0x1 receipts', async () => {
    const net = NETWORKS.previewnet;

    // 1. Double ABI-encoded bytes: abi.encode(abi.encode(rawMicheline))
    const rawMicheline = encodePair(encodeNat(5), encodePair(encodeNat(2), encodeNat(7)));
    const innerAbi = encodeAbiParams([{ type: 'bytes', value: bytesToHex(rawMicheline, true) }]);
    const doubleAbi = encodeAbiParams([{ type: 'bytes', value: innerAbi }]);
    expect(unwrapProbeViewMichelineBytes(doubleAbi)).toBe(bytesToHex(rawMicheline, true));

    // 2. Mirrored Michelson op hash (51-char o... Base58Check)
    const mirroredOp = computeMirroredMichelsonOpHash(PREVIEWNET_SAMPLE_TX_HASH);
    expect(mirroredOp).toMatch(/^o[1-9A-HJ-NP-Za-km-z]{50}$/);

    // 3. Caught 429 OOG on a status=0x1 (success) receipt populates decodedTopRevert & mirrored tzktUrl
    const oogErrAbi =
      '0x08c379a0' +
      encodeAbiParams([
        {
          type: 'string',
          value: 'Cross-runtime call failed with status 429 Too Many Requests: OOG',
        },
      ]).slice(2);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { id: number; method: string };
        if (body.method === 'eth_getTransactionReceipt') {
          return jsonResponse({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              status: '0x1', // caught in EVM!
              blockNumber: '0x10',
              from: '0x1111111111111111111111111111111111111111',
              to: '0x2222222222222222222222222222222222222222',
              gasUsed: '0x7a120',
            },
          });
        }
        if (body.method === 'debug_traceTransaction') {
          return jsonResponse({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              type: 'CALL',
              from: '0x1111111111111111111111111111111111111111',
              to: '0x2222222222222222222222222222222222222222',
              gas: '0x16e360',
              gasUsed: '0x7a120',
              input: CANARY_SELECTORS.probeOog + '00'.repeat(64),
              calls: [
                {
                  type: 'CALL',
                  from: '0x2222222222222222222222222222222222222222',
                  to: net.evm.precompile,
                  gas: '0x61a80',
                  gasUsed: '0x61a80',
                  input: '0xa1544fc3' + '00'.repeat(64),
                  error: 'execution reverted',
                  output: oogErrAbi,
                },
              ],
            },
          });
        }
        return jsonResponse({}, 404);
      }),
    );

    const report = await inspectTransactionHash(net, PREVIEWNET_SAMPLE_TX_HASH);
    expect(report.status).toBe('success');
    expect(report.traceSource).toBe('callTracer');
    expect(report.gatewayHops).toBe(1);
    expect(report.decodedTopRevert?.kind).toBe('CROSS_RUNTIME_429_OOG');
    expect(report.decodedTopRevert?.status).toBe(429);
    expect(report.tzktUrl).toBe(`${net.michelson.explorerUrl}/${mirroredOp}`);
  });

  it('maps known Canary and NAC Gateway 4-byte selectors to readable method names', () => {
    expect(resolveKnownSelectorName('0xa2b9cf04')).toBe('probeWrite');
    expect(resolveKnownSelectorName('0x3afa6469')).toBe('probeRoundTrip');
    expect(resolveKnownSelectorName('0x0464372c')).toBe('onMichelsonCallback');
    expect(resolveKnownSelectorName('0x00aa2ecb')).toBe('probeView');
    expect(resolveKnownSelectorName('0x6bab2b6f')).toBe('probeRollback');
    expect(resolveKnownSelectorName('0x6BAB2B6F')).toBe('probeRollback');
    expect(resolveKnownSelectorName('0xccc96ba6')).toBe('probeOog');
    expect(resolveKnownSelectorName('0xa1544fc3')).toBe('callMichelson');
    expect(resolveKnownSelectorName('0x8326329c')).toBe('callMichelsonView');
    expect(resolveKnownSelectorName('0xbfe88b4b')).toBe('materializeAlias');
    expect(resolveKnownSelectorName('0xdeadbeef')).toBeNull();
    expect(resolveKnownSelectorName(undefined)).toBeNull();
  });
});
