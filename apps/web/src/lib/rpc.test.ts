import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParams, selectorOf } from './codec';
import { DEFAULT_FIXTURES, NETWORKS } from './networks';
import {
  captureBlockPinnedSnapshot,
  diffSnapshots,
  fetchGatewayHealth,
  inspectCrossRuntimeIdentity,
  runMichelsonScriptView,
} from './rpc';
import type { DualRuntimeSnapshot } from './types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('rpc — gateway health, identity inspection, and block-pinned state diffs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('aggregates dual-runtime health with 1:1 block sync and EXTCODESIZE==0 verification', async () => {
    const net = NETWORKS.previewnet;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === net.evm.rpcUrl) {
          const body = JSON.parse(String(init?.body)) as { id: number; method: string };
          if (body.method === 'eth_blockNumber') {
            return jsonResponse({ jsonrpc: '2.0', id: body.id, result: '0x2a' }); // 42
          }
          if (body.method === 'eth_getCode') {
            return jsonResponse({ jsonrpc: '2.0', id: body.id, result: '0x' });
          }
          if (body.method === 'tez_kernelVersion') {
            return jsonResponse({ jsonrpc: '2.0', id: body.id, result: 'horus-8.0-rc1' });
          }
        }
        if (url.endsWith('/header')) {
          return jsonResponse({ level: 42 });
        }
        if (url.endsWith('/constants')) {
          return jsonResponse({ hard_gas_limit_per_operation: '660000' });
        }
        if (url.endsWith('/entrypoints')) {
          return jsonResponse({ entrypoints: { call_evm: {}, materialize_alias: {} } });
        }
        if (url.endsWith('/script')) {
          return jsonResponse({
            code: [
              { prim: 'view', args: [{ string: 'staticcall_evm' }] },
              { prim: 'view', args: [{ string: 'originOf' }] },
            ],
          });
        }
        return jsonResponse({ error: 'not found' }, 404);
      }),
    );

    const health = await fetchGatewayHealth(net);
    expect(health.evmOk).toBe(true);
    expect(health.michelsonOk).toBe(true);
    expect(health.evmHead).toBe(42);
    expect(health.michelsonLevel).toBe(42);
    expect(health.synced).toBe(true);
    expect(health.precompileZeroCode).toBe(true);
    expect(health.gatewayEntrypoints).toEqual(['call_evm', 'materialize_alias']);
    expect(health.gatewayViews).toEqual(['staticcall_evm', 'originOf']);
    expect(health.hardGasLimit).toBe(660_000);
    expect(health.kernelVersion).toBe('horus-8.0-rc1');
  });

  it('inspects cross-runtime identity via originOf + resolveAddress + alias eth_getCode and rejects tz4', async () => {
    const net = NETWORKS.previewnet;
    await expect(
      inspectCrossRuntimeIdentity(net, DEFAULT_FIXTURES.sampleTz4Rejected),
    ).rejects.toThrow(/tz4/i);

    const translatedAlias = '0x1111111111111111111111111111111111111111';
    const originAbi = encodeAbiParams([
      { type: 'uint8', value: 1 }, // Native
      { type: 'uint8', value: 0 }, // Michelson
      { type: 'string', value: DEFAULT_FIXTURES.aliceTz1 },
    ]);
    const resolveAbi = encodeAbiParams([
      { type: 'bool', value: true },
      { type: 'uint8', value: 1 }, // Alias
      { type: 'string', value: translatedAlias },
    ]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          id: number;
          method: string;
          params: Array<{ data?: string } | string>;
        };
        if (body.method === 'eth_call') {
          const callObj = body.params[0] as { data: string };
          if (callObj.data.startsWith(selectorOf('originOf(string,uint8)'))) {
            return jsonResponse({ jsonrpc: '2.0', id: body.id, result: originAbi });
          }
          if (callObj.data.startsWith(selectorOf('resolveAddress(string,uint8,uint8)'))) {
            return jsonResponse({ jsonrpc: '2.0', id: body.id, result: resolveAbi });
          }
        }
        if (body.method === 'eth_getCode') {
          return jsonResponse({ jsonrpc: '2.0', id: body.id, result: '0x' });
        }
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: '0x' });
      }),
    );

    const report = await inspectCrossRuntimeIdentity(net, DEFAULT_FIXTURES.aliceTz1);
    expect(report.inferredRuntime).toBe(0);
    expect(report.kindLabel).toBe('Native');
    expect(report.homeRuntimeLabel).toBe('Michelson (0)');
    expect(report.translatedAddress).toBe(translatedAlias);
    expect(report.isMaterialized).toBe(false);
    expect(report.aliasTypeNote).toContain('Safe-CREATE2');
  });

  it('pins both EVM and Michelson snapshot queries to identical height N and computes structured diffs', async () => {
    const net = NETWORKS.previewnet;
    const requestedUrls: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url === net.evm.rpcUrl) {
          const body = JSON.parse(String(init?.body)) as {
            id: number;
            method: string;
            params: string[];
          };
          if (body.method === 'eth_getBalance') {
            expect(body.params[1]).toBe('0x64'); // block 100
            return jsonResponse({ jsonrpc: '2.0', id: body.id, result: '0xde0b6b3a7640000' }); // 1e18
          }
          if (body.method === 'eth_getCode') {
            expect(body.params[1]).toBe('0x64');
            return jsonResponse({ jsonrpc: '2.0', id: body.id, result: '0x60806040' });
          }
        }
        if (url.endsWith('/blocks/100/header')) return jsonResponse({ level: 100 });
        if (url.endsWith('/balance')) return jsonResponse('2500000');
        if (url.endsWith('/storage')) return jsonResponse({ int: '1' });
        if (url.includes('/big_maps/77/expru2dKqDfZG8hu4wNGkiyunvq2hdSKuVYtcKta7BWP6Q18oNxKjS')) {
          return jsonResponse({ string: 'ping-1' });
        }
        return jsonResponse({}, 404);
      }),
    );

    const snapA = await captureBlockPinnedSnapshot(net, {
      label: 'Before',
      pinnedBlock: 100,
      evmAddress: DEFAULT_FIXTURES.freeRoutePoolEvm,
      michelsonAddress: DEFAULT_FIXTURES.evmGatewayKt1,
      bigMapId: 77,
      bigMapKeyType: 'nat',
      bigMapKey: '1',
    });

    expect(snapA.blockNumber).toBe(100);
    expect(snapA.michelsonLevel).toBe(100);
    expect(snapA.blockSynced).toBe(true);
    expect(snapA.evmBalanceWei).toBe('1000000000000000000');
    expect(snapA.evmCodeBytes).toBe(4);
    expect(snapA.michelsonBalanceMutez).toBe('2500000');
    expect(snapA.bigMapValue).toEqual({ string: 'ping-1' });
    expect(requestedUrls.some((u) => u.includes('/blocks/100/context/big_maps/77/expr'))).toBe(true);

    const snapB: DualRuntimeSnapshot = {
      ...snapA,
      label: 'After',
      blockNumber: 101,
      michelsonLevel: 101,
      evmBalanceWei: '999000000000000000',
      michelsonBalanceMutez: '3500000',
      michelsonStorage: { int: '2' },
      bigMapValue: { string: 'ping-2' },
    };

    const diff = diffSnapshots(snapA, snapB);
    expect(diff.blockDelta).toBe(1);
    expect(diff.evmBalanceDeltaWei).toBe('-1000000000000000');
    expect(diff.michelsonBalanceDeltaMutez).toBe('1000000');
    expect(diff.michelsonStorageChanged).toBe(true);
    expect(diff.bigMapValueChanged).toBe(true);
  });

  it('calls run_script_view with Readable unparsing_mode and active chain_id', async () => {
    const net = NETWORKS.previewnet;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.unparsing_mode).toBe('Readable');
        expect(body.chain_id).toBe(net.michelson.chainId);
        return jsonResponse({ data: { prim: 'Pair', args: [{ int: '1' }, { int: '0' }] } });
      }),
    );

    const res = await runMichelsonScriptView(
      net,
      DEFAULT_FIXTURES.evmGatewayKt1,
      'originOf',
      { prim: 'Pair', args: [{ string: DEFAULT_FIXTURES.aliceTz1 }, { int: '0' }] },
    );
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ prim: 'Pair', args: [{ int: '1' }, { int: '0' }] });
  });
});
