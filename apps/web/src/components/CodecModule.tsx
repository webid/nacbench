import { useId, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, Check, Flame, Info, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { CodecInput, CodecPresetId, GuardrailNote, NetworkConfig } from '../lib/types';
import {
  decodeRawMichelineHex,
  decodeRevertPayload,
  encodeCodecInput,
  isTz4Address,
  isValidEvmAddress,
  isValidTezosXAddress,
  parseEvmSignature,
} from '../lib/codec';
import { generateGuardrailedSnippets } from '../lib/snippets';
import { DEFAULT_FIXTURES, NULL_SOURCE_ADDRESS } from '../lib/networks';
import { CopyButton, StepTitle, TabList, TabPanel, useCopy } from './ui';

type CallDirection = CodecInput['callDirection'];
type SnippetTab = 'solidity' | 'octezJs' | 'smartpy' | 'cheatsheet';
type DecoderTab = 'micheline' | 'revert';
type OutputTab = 'payload' | 'code' | 'guardrails' | 'decoder';

interface DirectionOption {
  id: CallDirection;
  label: string;
  sublabel: string;
  fromRuntime: 'evm' | 'michelson';
  isView: boolean;
}

const DIRECTION_OPTIONS: DirectionOption[] = [
  {
    id: 'evm_to_michelson',
    label: 'EVM → Michelson',
    sublabel: 'callMichelson (0xff00…0007)',
    fromRuntime: 'evm',
    isView: false,
  },
  {
    id: 'michelson_to_evm',
    label: 'Michelson → EVM',
    sublabel: '%call_evm (KT18oDJJKX…)',
    fromRuntime: 'michelson',
    isView: false,
  },
  {
    id: 'evm_view_michelson',
    label: 'EVM → Michelson View',
    sublabel: 'callMichelsonView 0x8326329c',
    fromRuntime: 'evm',
    isView: true,
  },
  {
    id: 'michelson_staticcall_evm',
    label: 'Michelson → EVM View',
    sublabel: 'staticcall_evm (snake_case)',
    fromRuntime: 'michelson',
    isView: true,
  },
];

interface PresetMeta {
  id: CodecPresetId;
  label: string;
  tag: string;
  group: 'canary' | 'primitive';
  patch: Partial<CodecInput>;
}

const WEI_PER_MUTEZ = 1_000_000_000_000n;

const PRESET_LIST: PresetMeta[] = [
  {
    id: 'canary_record_ping',
    label: '%record_ping',
    tag: 'Canary Write',
    group: 'canary',
    patch: {
      callDirection: 'evm_to_michelson',
      entrypoint: 'record_ping',
      stringVal: 'nacbench-ping-v0.11',
      valueWei: '1000000000000000',
      evmGasCap: '5000000',
    },
  },
  {
    id: 'canary_echo_callback',
    label: '%echo_callback',
    tag: 'Round-Trip',
    group: 'canary',
    patch: {
      callDirection: 'evm_to_michelson',
      entrypoint: 'echo_callback',
      natVal: '42',
      valueWei: '0',
      evmGasCap: '5000000',
    },
  },
  {
    id: 'canary_force_fail',
    label: '%force_fail',
    tag: 'Rollback',
    group: 'canary',
    patch: {
      callDirection: 'evm_to_michelson',
      entrypoint: 'force_fail',
      stringVal: 'CANARY_ROLLBACK_PROBE',
      valueWei: '0',
      evmGasCap: '5000000',
    },
  },
  {
    id: 'canary_burn_gas',
    label: '%burn_gas',
    tag: '429 OOG',
    group: 'canary',
    patch: {
      callDirection: 'evm_to_michelson',
      entrypoint: 'burn_gas',
      natVal: '2500',
      valueWei: '0',
      evmGasCap: '1000000',
    },
  },
  {
    id: 'canary_get_state_digest',
    label: 'get_state_digest',
    tag: 'View 0x8326329c',
    group: 'canary',
    patch: {
      callDirection: 'evm_view_michelson',
      entrypoint: 'get_state_digest',
      natVal: '0',
      valueWei: '0',
      evmGasCap: '5000000',
    },
  },
  {
    id: 'unit',
    label: 'unit',
    tag: '0x030b',
    group: 'primitive',
    patch: { entrypoint: 'default', valueWei: '0' },
  },
  {
    id: 'string',
    label: 'string',
    tag: '0x01',
    group: 'primitive',
    patch: { entrypoint: 'set_note', stringVal: 'hello-tezos-x' },
  },
  {
    id: 'nat',
    label: 'nat',
    tag: '0x00',
    group: 'primitive',
    patch: { entrypoint: 'set_nonce', natVal: '128064' },
  },
  {
    id: 'int',
    label: 'int',
    tag: '0x00±',
    group: 'primitive',
    patch: { entrypoint: 'adjust_delta', intVal: '-42' },
  },
  {
    id: 'bytes',
    label: 'bytes',
    tag: '0x0a',
    group: 'primitive',
    patch: { entrypoint: 'submit_blob', bytesHex: '0xdeadbeefcafe' },
  },
  {
    id: 'address',
    label: 'address',
    tag: 'tz1/KT1',
    group: 'primitive',
    patch: { entrypoint: 'set_owner', addressVal: DEFAULT_FIXTURES.aliceTz1 },
  },
  {
    id: 'pair_addr_mutez',
    label: 'Pair(address, mutez)',
    tag: '0x0707',
    group: 'primitive',
    patch: {
      entrypoint: 'payout',
      addressVal: DEFAULT_FIXTURES.aliceTz1,
      mutezVal: '1000000',
      valueWei: '1000000000000000000',
    },
  },
  {
    id: 'option_some',
    label: 'Option(Some)',
    tag: '0x0509',
    group: 'primitive',
    patch: { entrypoint: 'set_memo', stringVal: 'optional-payload' },
  },
  {
    id: 'or_left',
    label: 'Or(Left)',
    tag: '0x0505',
    group: 'primitive',
    patch: { entrypoint: 'dispatch', natVal: '7' },
  },
];

const REVERT_SAMPLES = [
  {
    label: '429 OOG (UTF-8)',
    payload:
      'Cross-runtime call failed with status 429 Too Many Requests: out of gas',
  },
  {
    label: '429 OOG (Hex)',
    payload:
      '0x43726f73732d72756e74696d652063616c6c206661696c65642077697468207374617475732034323920546f6f204d616e792052657175657374733a206f7574206f6620676173',
  },
  {
    label: '404 Missing View',
    payload:
      'Cross-runtime call failed with status 404 Not Found: view "staticcall_evm" not found on contract KT18oDJJKXMKhfE1bSuAPGp92pYcwVDiqsPw',
  },
  {
    label: 'materializeAlias Pubkey',
    payload:
      'materializeAlias: Native address verification error: Missing public key',
  },
  {
    label: 'Solidity Error(string)',
    payload:
      '0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000184d5554455a5f445553545f52454d41494e4445525f4552520000000000000000',
  },
];

function formatMutezFromWei(valueWei: string): {
  valid: boolean;
  mutez: string;
  xtz: string;
  dustWei: string;
} {
  const cleaned = valueWei.trim();
  if (!/^\d+$/.test(cleaned)) {
    return { valid: false, mutez: '0', xtz: '0', dustWei: '0' };
  }
  const wei = BigInt(cleaned);
  const mutez = wei / WEI_PER_MUTEZ;
  const dust = wei % WEI_PER_MUTEZ;
  const wholeXtz = mutez / 1_000_000n;
  const fracMutez = (mutez % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  const xtz = fracMutez ? `${wholeXtz.toString()}.${fracMutez}` : wholeXtz.toString();
  return {
    valid: true,
    mutez: mutez.toString(),
    xtz,
    dustWei: dust.toString(),
  };
}

function getFieldVisibility(preset: CodecPresetId) {
  return {
    showString:
      preset === 'string' ||
      preset === 'option_some' ||
      preset === 'canary_record_ping' ||
      preset === 'canary_force_fail',
    showNat:
      preset === 'nat' ||
      preset === 'or_left' ||
      preset === 'canary_echo_callback' ||
      preset === 'canary_burn_gas' ||
      preset === 'canary_get_state_digest',
    showInt: preset === 'int',
    showBytes: preset === 'bytes',
    showAddress: preset === 'address' || preset === 'pair_addr_mutez',
    showMutez: preset === 'pair_addr_mutez',
  };
}

function GuardrailRow({ note }: { note: GuardrailNote }) {
  const isCritical = note.severity === 'critical';
  const state = note.triggered ? (isCritical ? 'critical' : 'warning') : 'ok';

  const Icon = note.triggered
    ? isCritical
      ? ShieldAlert
      : AlertTriangle
    : note.severity === 'info'
      ? Info
      : ShieldCheck;

  const iconClass = note.triggered ? (isCritical ? 'text-danger' : 'text-warn') : 'muted';

  return (
    <div className="guard-row" data-state={state}>
      <Icon size={14} className={iconClass} aria-hidden="true" />
      <span className="guard-title">{note.title}</span>
      <span
        className={`pill pill-sm ${
          note.triggered ? (isCritical ? 'pill-danger' : 'pill-warn') : 'pill-muted'
        }`}
      >
        {note.triggered ? (isCritical ? 'Trap active' : 'Check') : 'Guarded'}
      </span>
      <p className="guard-detail">{note.detail}</p>
    </div>
  );
}

const EVM_SIGNATURE_PRESETS: Array<{
  sig: string;
  label: string;
  direction: 'michelson_to_evm' | 'michelson_staticcall_evm';
  defaultArgs: string[];
}> = [
  {
    sig: 'onMichelsonCallback(uint256,uint256)',
    label: 'onMichelsonCallback(uint256,uint256)',
    direction: 'michelson_to_evm',
    defaultArgs: ['42', '1'],
  },
  {
    sig: 'transfer(address,uint256)',
    label: 'transfer(address,uint256)',
    direction: 'michelson_to_evm',
    defaultArgs: [DEFAULT_FIXTURES.deadEvm, '1000000'],
  },
  {
    sig: 'setNote(string)',
    label: 'setNote(string)',
    direction: 'michelson_to_evm',
    defaultArgs: ['hello-from-michelson'],
  },
  {
    sig: 'echoView(uint256)',
    label: 'echoView(uint256)',
    direction: 'michelson_staticcall_evm',
    defaultArgs: ['42'],
  },
  {
    sig: 'balanceOf(address)',
    label: 'balanceOf(address)',
    direction: 'michelson_staticcall_evm',
    defaultArgs: [DEFAULT_FIXTURES.deadEvm],
  },
];

export function CodecModule({
  network,
  initialPreset,
  onPresetChange,
}: {
  network: NetworkConfig;
  initialPreset?: CodecPresetId;
  onPresetChange?: (preset: CodecPresetId) => void;
}) {
  const uid = useId();
  const [input, setInput] = useState<CodecInput>(() => {
    const base: CodecInput = {
      preset: 'canary_record_ping',
      entrypoint: 'record_ping',
      kt1Target: network.michelson.evmGateway,
      evmTarget: DEFAULT_FIXTURES.freeRoutePoolEvm,
      stringVal: 'nacbench-ping-v0.11',
      natVal: '42',
      intVal: '-42',
      bytesHex: '0xdeadbeef',
      addressVal: DEFAULT_FIXTURES.aliceTz1,
      mutezVal: '1000000',
      valueWei: '1000000000000000',
      evmGasCap: String(network.evm.nacRecommendedGas || 5_000_000),
      evmArgs: ['42', '1'],
      callDirection: 'evm_to_michelson',
    };
    if (initialPreset) {
      const matched = PRESET_LIST.find((p) => p.id === initialPreset);
      if (matched) {
        return { ...base, preset: matched.id, ...matched.patch };
      }
    }
    return base;
  });

  const [outputTab, setOutputTab] = useState<OutputTab>('payload');
  const [snippetTab, setSnippetTab] = useState<SnippetTab>('solidity');
  const [decoderTab, setDecoderTab] = useState<DecoderTab>('revert');
  const [rawMichelineInput, setRawMichelineInput] = useState<string>(
    '0x01000000136e616362656e63682d70696e672d76302e3131',
  );
  const [revertInput, setRevertInput] = useState<string>(REVERT_SAMPLES[0].payload);
  const { copiedKey, copy: handleCopy } = useCopy();

  const result = useMemo(() => encodeCodecInput(input), [input]);
  const snippets = useMemo(
    () => generateGuardrailedSnippets(input, result, network),
    [input, result, network],
  );

  const decodedRawMicheline = useMemo(
    () => decodeRawMichelineHex(rawMichelineInput),
    [rawMichelineInput],
  );
  const decodedRevert = useMemo(() => decodeRevertPayload(revertInput), [revertInput]);

  const weiMetrics = useMemo(() => formatMutezFromWei(input.valueWei), [input.valueWei]);
  const gasNum = useMemo(() => {
    const n = Number(input.evmGasCap);
    return Number.isFinite(n) ? n : 0;
  }, [input.evmGasCap]);

  const fieldVis = useMemo(() => getFieldVisibility(input.preset), [input.preset]);
  const isEvmOrigin =
    input.callDirection === 'evm_to_michelson' || input.callDirection === 'evm_view_michelson';

  const kt1IsTz4 = isTz4Address(input.kt1Target.trim());
  const kt1Valid = isValidTezosXAddress(input.kt1Target.trim());
  const evmValid = isValidEvmAddress(input.evmTarget.trim());
  const addrFieldIsTz4 = fieldVis.showAddress && isTz4Address(input.addressVal.trim());
  const triggeredCount = result.guardrails.filter((g) => g.triggered).length;
  const sortedGuardrails = useMemo(
    () =>
      [...result.guardrails].sort((a, b) => Number(b.triggered) - Number(a.triggered)),
    [result.guardrails],
  );

  const applyPreset = (preset: PresetMeta) => {
    setInput((prev) => ({
      ...prev,
      preset: preset.id,
      ...preset.patch,
    }));
    onPresetChange?.(preset.id);
  };

  const parsedEvmSig = useMemo(() => {
    if (isEvmOrigin) return null;
    const defaultSig =
      input.callDirection === 'michelson_to_evm'
        ? 'onMichelsonCallback(uint256,uint256)'
        : 'echoView(uint256)';
    const sigStr = input.entrypoint.includes('(') ? input.entrypoint : defaultSig;
    return parseEvmSignature(sigStr);
  }, [isEvmOrigin, input.callDirection, input.entrypoint]);

  const snapWeiToMutezGrid = () => {
    const cleaned = input.valueWei.trim();
    if (!/^\d+$/.test(cleaned)) return;
    const wei = BigInt(cleaned);
    const aligned = (wei / WEI_PER_MUTEZ) * WEI_PER_MUTEZ;
    setInput((prev) => ({ ...prev, valueWei: aligned.toString() }));
  };

  const injectOneWeiDust = () => {
    const cleaned = input.valueWei.trim();
    const base = /^\d+$/.test(cleaned) ? BigInt(cleaned) : 0n;
    const next = base % WEI_PER_MUTEZ === 0n ? base + 1n : base;
    setInput((prev) => ({ ...prev, valueWei: next.toString() }));
  };

  const activeSnippetCode = snippets[snippetTab];
  const canaryPresets = PRESET_LIST.filter((p) => p.group === 'canary');
  const primitivePresets = PRESET_LIST.filter((p) => p.group === 'primitive');
  const outPrefix = `${uid}-out`;
  const snipPrefix = `${uid}-snip`;
  const decPrefix = `${uid}-dec`;

  return (
    <section aria-labelledby={`${uid}-heading`}>
      <h2 id={`${uid}-heading`} className="sr-only">
        Module 1 · Encode &amp; Snippets
      </h2>

      <div className="workbench">
        {/* ============================ STEP 1 ============================ */}
        <div className="card">
          <div className="card-header">
            <StepTitle
              n={1}
              title="Direction & inputs"
              hint="Pick a call direction, start from a preset, then fine-tune values."
            />
            <span className="pill pill-muted">Runs locally · zero RPC</span>
          </div>

          <div className="card-body stack">
            {/* Direction */}
            <div className="form-section">
              <span className="section-label" id={`${uid}-dir-label`}>
                Call direction
              </span>
              <div
                role="radiogroup"
                aria-labelledby={`${uid}-dir-label`}
                className="direction-grid"
              >
                {DIRECTION_OPTIONS.map((dir) => {
                  const active = input.callDirection === dir.id;
                  return (
                    <button
                      key={dir.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className="direction-option"
                      onClick={() =>
                        setInput((prev) => ({
                          ...prev,
                          callDirection: dir.id,
                          ...(dir.id === 'evm_view_michelson' && prev.entrypoint === 'record_ping'
                            ? { entrypoint: 'get_state_digest' }
                            : {}),
                          ...(dir.id === 'michelson_to_evm' && prev.entrypoint === 'record_ping'
                            ? { entrypoint: 'onMichelsonCallback(uint256,uint256)' }
                            : {}),
                          ...(dir.id === 'michelson_staticcall_evm' &&
                          prev.entrypoint === 'record_ping'
                            ? { entrypoint: 'echoView(uint256)' }
                            : {}),
                        }))
                      }
                    >
                      <span className="direction-label">
                        {dir.label}
                        {dir.isView && <span className="pill pill-sm pill-muted">view</span>}
                      </span>
                      <span className="direction-sub">{dir.sublabel}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Presets */}
            <div className="form-section">
              <span className="section-label">Start from a preset</span>
              <div className="chip-row" role="group" aria-label="Canary presets">
                <span className="chip-row-label">Canary</span>
                {canaryPresets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="chip"
                    aria-pressed={input.preset === preset.id}
                    onClick={() => applyPreset(preset)}
                  >
                    <span className="mono">{preset.label}</span>
                    <span className="chip-meta">{preset.tag}</span>
                  </button>
                ))}
              </div>
              <div className="chip-row" role="group" aria-label="Primitive presets">
                <span className="chip-row-label">Primitives</span>
                {primitivePresets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="chip"
                    aria-pressed={input.preset === preset.id}
                    onClick={() => applyPreset(preset)}
                  >
                    <span className="mono">{preset.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Target & entrypoint */}
            <div className="form-section">
              <span className="section-label">Target &amp; entrypoint</span>

              {isEvmOrigin ? (
                <div className="field">
                  <div className="field-label">
                    <label htmlFor={`${uid}-kt1`}>
                      Michelson destination <span className="muted">(KT1 / tz1)</span>
                    </label>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        setInput((prev) => ({ ...prev, kt1Target: network.michelson.evmGateway }))
                      }
                    >
                      Use gateway KT1
                    </button>
                  </div>
                  <input
                    id={`${uid}-kt1`}
                    className="input mono"
                    value={input.kt1Target}
                    onChange={(e) => setInput((prev) => ({ ...prev, kt1Target: e.target.value }))}
                    placeholder="KT1..."
                    spellCheck={false}
                    aria-invalid={kt1IsTz4 || (!!input.kt1Target.trim() && !kt1Valid)}
                  />
                  {kt1IsTz4 && (
                    <div role="alert" className="alert alert-danger">
                      <ShieldAlert size={14} aria-hidden="true" />
                      <span>
                        BLS <code>tz4</code> addresses are not supported on the Tezos X Michelson
                        interface yet.
                      </span>
                    </div>
                  )}
                  {!kt1IsTz4 && input.kt1Target.trim() && !kt1Valid && (
                    <span className="field-hint text-warn">
                      Expected a 36-char Base58Check <code>KT1</code>/<code>tz1</code>/
                      <code>tz2</code>/<code>tz3</code> address.
                    </span>
                  )}
                </div>
              ) : (
                <div className="field">
                  <div className="field-label">
                    <label htmlFor={`${uid}-evm`}>
                      EVM destination <span className="muted">(0x…)</span>
                    </label>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        setInput((prev) => ({ ...prev, evmTarget: DEFAULT_FIXTURES.freeRoutePoolEvm }))
                      }
                    >
                      Use Free-Route pool
                    </button>
                  </div>
                  <input
                    id={`${uid}-evm`}
                    className="input mono"
                    value={input.evmTarget}
                    onChange={(e) => setInput((prev) => ({ ...prev, evmTarget: e.target.value }))}
                    placeholder="0x..."
                    spellCheck={false}
                    aria-invalid={!!input.evmTarget.trim() && !evmValid}
                  />
                  {input.evmTarget.trim() && !evmValid && (
                    <span className="field-hint text-danger">
                      Expected a 20-byte <code>0x</code>-prefixed EVM address.
                    </span>
                  )}
                </div>
              )}

              <div className="field">
                <label htmlFor={`${uid}-ep`} className="field-label">
                  {isEvmOrigin
                    ? input.callDirection === 'evm_view_michelson'
                      ? 'Michelson on-chain view name'
                      : 'Michelson entrypoint (without %)'
                    : input.callDirection === 'michelson_to_evm'
                      ? 'EVM signature (%call_evm 2nd field)'
                      : 'EVM view signature (selector hashed for staticcall_evm)'}
                </label>
                <input
                  id={`${uid}-ep`}
                  className="input mono"
                  value={input.entrypoint}
                  onChange={(e) => setInput((prev) => ({ ...prev, entrypoint: e.target.value }))}
                  placeholder={isEvmOrigin ? 'record_ping' : 'onMichelsonCallback(uint256,uint256)'}
                  spellCheck={false}
                />
                {!isEvmOrigin && (
                  <div className="chip-row" role="group" aria-label="ABI signature presets">
                    <span className="chip-row-label">ABI presets</span>
                    {EVM_SIGNATURE_PRESETS.map((preset) => (
                      <button
                        key={preset.sig}
                        type="button"
                        className="chip"
                        aria-pressed={input.entrypoint.trim() === preset.sig}
                        onClick={() =>
                          setInput((prev) => ({
                            ...prev,
                            entrypoint: preset.sig,
                            evmArgs: [...preset.defaultArgs],
                          }))
                        }
                      >
                        <span className="mono">{preset.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Typed payload */}
            <div className="form-section">
              <span className="section-label">
                {isEvmOrigin ? 'Micheline parameter' : 'Solidity ABI arguments'}
              </span>

              {!isEvmOrigin && parsedEvmSig && !parsedEvmSig.ok && (
                <div role="alert" className="alert alert-danger">
                  <ShieldAlert size={14} aria-hidden="true" />
                  <span>{parsedEvmSig.error}</span>
                </div>
              )}

              {!isEvmOrigin && parsedEvmSig && parsedEvmSig.ok && (
                <>
                  {parsedEvmSig.types.length === 0 ? (
                    <p className="field-hint" style={{ margin: 0 }}>
                      <code>{parsedEvmSig.canonicalSig}</code> takes zero ABI arguments.
                    </p>
                  ) : (
                    <div className="grid-2">
                      {parsedEvmSig.types.map((paramType, idx) => {
                        const currentVal = input.evmArgs?.[idx] ?? '';
                        const placeholder =
                          paramType === 'address'
                            ? DEFAULT_FIXTURES.deadEvm
                            : paramType === 'bool'
                              ? 'true'
                              : paramType === 'bytes32'
                                ? '0x0000…'
                                : paramType === 'bytes'
                                  ? '0xdeadbeef'
                                  : paramType === 'string'
                                    ? 'hello-nac'
                                    : paramType === 'int256'
                                      ? '-42'
                                      : idx === 0
                                        ? '42'
                                        : '1';
                        return (
                          <div key={`${parsedEvmSig.canonicalSig}-${idx}`} className="field">
                            <label htmlFor={`${uid}-evmarg-${idx}`} className="field-label">
                              <span>
                                Arg {idx + 1} <code className="muted">{paramType}</code>
                              </span>
                            </label>
                            <input
                              id={`${uid}-evmarg-${idx}`}
                              className="input mono"
                              value={currentVal}
                              onChange={(e) => {
                                const nextVal = e.target.value;
                                setInput((prev) => {
                                  const nextArgs = [...(prev.evmArgs ?? [])];
                                  nextArgs[idx] = nextVal;
                                  return { ...prev, evmArgs: nextArgs };
                                });
                              }}
                              placeholder={placeholder}
                              spellCheck={false}
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}

              {isEvmOrigin && input.preset === 'unit' && (
                <p className="field-hint" style={{ margin: 0 }}>
                  Unit primitive (<code>0x030b</code>) carries zero arguments.
                </p>
              )}

              {isEvmOrigin && fieldVis.showString && (
                <div className="field">
                  <label htmlFor={`${uid}-str`} className="field-label">
                    UTF-8 string
                  </label>
                  <input
                    id={`${uid}-str`}
                    className="input mono"
                    value={input.stringVal}
                    onChange={(e) => setInput((prev) => ({ ...prev, stringVal: e.target.value }))}
                    placeholder="Enter UTF-8 string..."
                  />
                </div>
              )}

              {isEvmOrigin && fieldVis.showNat && (
                <div className="field">
                  <label htmlFor={`${uid}-nat`} className="field-label">
                    <span>
                      Natural <span className="muted">(nat ≥ 0)</span>
                    </span>
                  </label>
                  <input
                    id={`${uid}-nat`}
                    className="input mono"
                    inputMode="numeric"
                    value={input.natVal}
                    onChange={(e) => setInput((prev) => ({ ...prev, natVal: e.target.value }))}
                    placeholder="42"
                  />
                </div>
              )}

              {isEvmOrigin && fieldVis.showInt && (
                <div className="field">
                  <label htmlFor={`${uid}-int`} className="field-label">
                    <span>
                      Signed integer <span className="muted">(int, Zarith)</span>
                    </span>
                  </label>
                  <input
                    id={`${uid}-int`}
                    className="input mono"
                    value={input.intVal}
                    onChange={(e) => setInput((prev) => ({ ...prev, intVal: e.target.value }))}
                    placeholder="-42"
                  />
                </div>
              )}

              {isEvmOrigin && fieldVis.showBytes && (
                <div className="field">
                  <label htmlFor={`${uid}-bytes`} className="field-label">
                    <span>
                      Raw bytes <span className="muted">(0x…)</span>
                    </span>
                  </label>
                  <input
                    id={`${uid}-bytes`}
                    className="input mono"
                    value={input.bytesHex}
                    onChange={(e) => setInput((prev) => ({ ...prev, bytesHex: e.target.value }))}
                    placeholder="0xdeadbeef"
                    spellCheck={false}
                  />
                </div>
              )}

              {isEvmOrigin && fieldVis.showAddress && (
                <div className="field">
                  <div className="field-label">
                    <label htmlFor={`${uid}-addr`}>
                      Michelson address <span className="muted">(tz1/2/3 or KT1)</span>
                    </label>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        setInput((prev) => ({ ...prev, addressVal: DEFAULT_FIXTURES.aliceTz1 }))
                      }
                    >
                      Use Alice tz1
                    </button>
                  </div>
                  <input
                    id={`${uid}-addr`}
                    className="input mono"
                    value={input.addressVal}
                    onChange={(e) => setInput((prev) => ({ ...prev, addressVal: e.target.value }))}
                    placeholder="tz1..."
                    spellCheck={false}
                    aria-invalid={addrFieldIsTz4}
                  />
                  {addrFieldIsTz4 && (
                    <span role="alert" className="field-hint text-danger">
                      BLS <code>tz4</code> is unsupported on the Tezos X Michelson interface — use{' '}
                      <code>tz1</code>, <code>tz2</code>, <code>tz3</code>, or <code>KT1</code>.
                    </span>
                  )}
                </div>
              )}

              {isEvmOrigin && fieldVis.showMutez && (
                <div className="field">
                  <label htmlFor={`${uid}-mutez`} className="field-label">
                    <span>
                      Embedded mutez <span className="muted">(1 XTZ = 1,000,000)</span>
                    </span>
                  </label>
                  <input
                    id={`${uid}-mutez`}
                    className="input mono"
                    inputMode="numeric"
                    value={input.mutezVal}
                    onChange={(e) => setInput((prev) => ({ ...prev, mutezVal: e.target.value }))}
                    placeholder="1000000"
                  />
                </div>
              )}
            </div>

            {/* Value & gas */}
            <div className="form-section">
              <span className="section-label">Value (10¹² wei ↔ mutez) &amp; gas</span>

              <div className="field">
                <label htmlFor={`${uid}-wei`} className="field-label">
                  <span>
                    Attached EVM value <span className="muted">(wei)</span>
                  </span>
                </label>
                <input
                  id={`${uid}-wei`}
                  className="input mono"
                  inputMode="numeric"
                  value={input.valueWei}
                  onChange={(e) => setInput((prev) => ({ ...prev, valueWei: e.target.value }))}
                  aria-invalid={!result.mutezAligned}
                  aria-describedby={`${uid}-wei-out`}
                />
                <div className="chip-row" role="group" aria-label="Value shortcuts">
                  <button
                    type="button"
                    className="chip"
                    onClick={() => setInput((prev) => ({ ...prev, valueWei: '0' }))}
                  >
                    0
                  </button>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => setInput((prev) => ({ ...prev, valueWei: '1000000000000' }))}
                  >
                    1 mutez (10¹²)
                  </button>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => setInput((prev) => ({ ...prev, valueWei: '1000000000000000' }))}
                  >
                    0.001 XTZ
                  </button>
                  <button
                    type="button"
                    className="chip"
                    onClick={injectOneWeiDust}
                    title="Test the 10¹² dust trap"
                  >
                    +1 wei dust (test trap)
                  </button>
                </div>

                <output id={`${uid}-wei-out`} htmlFor={`${uid}-wei`} aria-live="polite">
                  {result.mutezAligned ? (
                    <span className="output-line">
                      <ShieldCheck size={13} className="text-ok" aria-hidden="true" />
                      <span className="mono">
                        Aligned · {weiMetrics.mutez} mutez ({weiMetrics.xtz} XTZ) · 0 wei dust
                      </span>
                    </span>
                  ) : (
                    <span className="alert alert-danger" style={{ alignItems: 'center' }}>
                      <ShieldAlert size={14} aria-hidden="true" />
                      <span className="mono" style={{ flex: 1 }}>
                        Dust remainder: {result.dustRemainderWei} wei (not divisible by 10¹²)
                      </span>
                      <button type="button" className="btn btn-sm" onClick={snapWeiToMutezGrid}>
                        Snap to 10¹² grid
                      </button>
                    </span>
                  )}
                </output>
              </div>

              <div className="field">
                <label htmlFor={`${uid}-gas`} className="field-label">
                  EVM gas cap
                </label>
                <input
                  id={`${uid}-gas`}
                  className="input mono"
                  inputMode="numeric"
                  value={input.evmGasCap}
                  onChange={(e) => setInput((prev) => ({ ...prev, evmGasCap: e.target.value }))}
                />
                <div className="chip-row" role="group" aria-label="Gas cap shortcuts">
                  <button
                    type="button"
                    className="chip"
                    aria-pressed={input.evmGasCap === '3000000'}
                    onClick={() => setInput((prev) => ({ ...prev, evmGasCap: '3000000' }))}
                  >
                    3M transfer
                  </button>
                  <button
                    type="button"
                    className="chip"
                    aria-pressed={input.evmGasCap === '5000000'}
                    onClick={() => setInput((prev) => ({ ...prev, evmGasCap: '5000000' }))}
                  >
                    5M NAC call
                  </button>
                  <button
                    type="button"
                    className="chip"
                    aria-pressed={input.evmGasCap === '1000000'}
                    onClick={() => setInput((prev) => ({ ...prev, evmGasCap: '1000000' }))}
                  >
                    1M OOG probe
                  </button>
                </div>
                {gasNum < 3_000_000 ? (
                  <span className="output-line text-warn">
                    <Flame size={13} aria-hidden="true" />
                    Below the 3,000,000 EVM gas NAC floor — high risk of{' '}
                    <code>429 Too Many Requests: out of gas</code>.
                  </span>
                ) : (
                  <span className="output-line">
                    <Check size={13} aria-hidden="true" />
                    Meets the NAC v0.11 EVM gas floor ({gasNum.toLocaleString()} gas).
                  </span>
                )}
                <span className="field-hint">
                  Michelson hard op cap on {network.label}:{' '}
                  <strong className="mono strong">
                    {network.michelson.hardGasLimitPerOperation.toLocaleString()}
                  </strong>{' '}
                  gas units (translated from EVM gas via the kernel coefficient).
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* ============================ STEP 2 ============================ */}
        <div className="card workbench-sticky">
          <div className="card-header">
            <StepTitle n={2} title="Output & safe code" hint="Updates live as you edit step 1." />
            <div className="row" style={{ gap: 6 }}>
              <span className="pill mono">{result.michelineByteLength} B</span>
              <span className="pill mono">sel {result.abiSelector || 'N/A'}</span>
            </div>
          </div>

          <TabList<OutputTab>
            idPrefix={outPrefix}
            ariaLabel="Output views"
            className="tabbar"
            itemClassName="tabbar-item"
            value={outputTab}
            onChange={setOutputTab}
            items={[
              { id: 'payload', label: 'Encoded payload' },
              { id: 'code', label: 'Copy-paste code' },
              {
                id: 'guardrails',
                label: (
                  <>
                    Guardrails
                    <span className={`tab-count ${triggeredCount > 0 ? 'warn' : ''}`}>
                      {triggeredCount > 0
                        ? `${triggeredCount}/${result.guardrails.length}`
                        : result.guardrails.length}
                    </span>
                    {triggeredCount > 0 && (
                      <span className="sr-only">{triggeredCount} need attention</span>
                    )}
                  </>
                ),
              },
              { id: 'decoder', label: 'Hex & revert decoder' },
            ]}
          />

          <div className="card-body flush-top">
            {outputTab === 'payload' && (
              <TabPanel idPrefix={outPrefix} id="payload" className="stack">
                {!result.ok && result.error && (
                  <div role="alert" className="alert alert-danger">
                    <ShieldAlert size={14} aria-hidden="true" />
                    <span>
                      <strong>Encoding error:</strong> {result.error}
                    </span>
                  </div>
                )}

                <div className="stack-sm">
                  <div className="code-head">
                    <span className="code-label">
                      Gateway calldata
                      <span className="mono muted xsmall break-all">
                        → {isEvmOrigin ? network.evm.precompile : network.michelson.evmGateway}
                      </span>
                    </span>
                    <CopyButton
                      primary
                      label="Copy calldata"
                      copied={copiedKey === 'calldata'}
                      disabled={!result.gatewayCalldataHex}
                      onClick={() => void handleCopy('calldata', result.gatewayCalldataHex)}
                    />
                  </div>
                  <pre className="code-block" style={{ maxHeight: 150 }}>
                    {result.gatewayCalldataHex || '—'}
                  </pre>
                </div>

                <div className="stack-sm">
                  <div className="code-head">
                    <span className="code-label">
                      Binary Micheline hex <span className="muted xsmall">0x05-stripped</span>
                    </span>
                    <CopyButton
                      copied={copiedKey === 'micheline'}
                      disabled={!result.michelineHex}
                      onClick={() => void handleCopy('micheline', result.michelineHex)}
                    />
                  </div>
                  <pre className="code-block" style={{ maxHeight: 110 }}>
                    {result.michelineHex || '—'}
                  </pre>
                </div>

                <div className="stack-sm">
                  <div className="code-head">
                    <span className="code-label">Round-trip decoded expression</span>
                    {result.decodedExpression !== undefined && (
                      <span className="output-line">
                        <Check size={13} className="text-ok" aria-hidden="true" />
                        encode → decode OK
                      </span>
                    )}
                  </div>
                  <pre className="code-block pre" style={{ maxHeight: 170 }}>
                    {result.decodedExpression !== undefined
                      ? JSON.stringify(result.decodedExpression, null, 2)
                      : '—'}
                  </pre>
                </div>

                <div className="row-between" style={{ paddingTop: 4 }}>
                  <span className="field-hint">
                    Next: grab ready-to-paste Solidity / octez.js / SmartPy with guardrails baked in.
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setOutputTab('code')}
                  >
                    Copy-paste code
                    <ArrowRight size={13} aria-hidden="true" />
                  </button>
                </div>
              </TabPanel>
            )}

            {outputTab === 'code' && (
              <TabPanel idPrefix={outPrefix} id="code" className="stack-sm">
                <div className="row-between">
                  <TabList<SnippetTab>
                    idPrefix={snipPrefix}
                    ariaLabel="Generated code language"
                    value={snippetTab}
                    onChange={setSnippetTab}
                    items={[
                      { id: 'solidity', label: 'Solidity 0.8.24' },
                      { id: 'octezJs', label: 'octez.js v25.1' },
                      { id: 'smartpy', label: 'SmartPy' },
                      { id: 'cheatsheet', label: 'Selectors' },
                    ]}
                  />
                  <CopyButton
                    primary
                    label="Copy snippet"
                    copied={copiedKey === `snippet-${snippetTab}`}
                    onClick={() => void handleCopy(`snippet-${snippetTab}`, activeSnippetCode)}
                  />
                </div>
                <TabPanel idPrefix={snipPrefix} id={snippetTab}>
                  <pre className="code-block pre" style={{ maxHeight: 520 }}>
                    {activeSnippetCode}
                  </pre>
                </TabPanel>
                <span className="field-hint">
                  {snippetTab === 'octezJs' ? '@tezos-x/octez.js v25.1 · ' : ''}
                  Generated from the current inputs with the v0.11 guardrails from the{' '}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ height: 'auto', padding: '0 2px', verticalAlign: 'baseline' }}
                    onClick={() => setOutputTab('guardrails')}
                  >
                    Guardrails tab
                  </button>{' '}
                  baked in.
                </span>
              </TabPanel>
            )}

            {outputTab === 'guardrails' && (
              <TabPanel idPrefix={outPrefix} id="guardrails" className="stack-sm">
                <div className="row-between">
                  <span className="output-line" aria-live="polite">
                    {triggeredCount > 0 ? (
                      <>
                        <AlertTriangle size={13} className="text-warn" aria-hidden="true" />
                        <span>
                          <strong className="strong">
                            {triggeredCount} of {result.guardrails.length}
                          </strong>{' '}
                          need attention for this input
                        </span>
                      </>
                    ) : (
                      <>
                        <ShieldCheck size={13} className="text-ok" aria-hidden="true" />
                        <span>
                          All {result.guardrails.length} Tezos X v0.11 / Horus 8.0 guardrails pass
                        </span>
                      </>
                    )}
                  </span>
                  <span className="mono muted xsmall" title={NULL_SOURCE_ADDRESS}>
                    Null cross-runtime SOURCE: {NULL_SOURCE_ADDRESS.slice(0, 12)}…
                  </span>
                </div>
                <div className="guard-list">
                  {sortedGuardrails.map((note) => (
                    <GuardrailRow key={note.id} note={note} />
                  ))}
                </div>
              </TabPanel>
            )}

            {outputTab === 'decoder' && (
              <TabPanel idPrefix={outPrefix} id="decoder" className="stack-sm">
                <TabList<DecoderTab>
                  idPrefix={decPrefix}
                  ariaLabel="Decoder mode"
                  value={decoderTab}
                  onChange={setDecoderTab}
                  items={[
                    { id: 'revert', label: 'Revert / 429 OOG' },
                    { id: 'micheline', label: 'Raw Micheline hex' },
                  ]}
                />

                {decoderTab === 'revert' ? (
                  <TabPanel idPrefix={decPrefix} id="revert" className="stack-sm">
                    <div className="chip-row" role="group" aria-label="Sample revert payloads">
                      <span className="chip-row-label">Samples</span>
                      {REVERT_SAMPLES.map((sample) => (
                        <button
                          key={sample.label}
                          type="button"
                          className="chip"
                          aria-pressed={revertInput === sample.payload}
                          onClick={() => setRevertInput(sample.payload)}
                        >
                          {sample.label}
                        </button>
                      ))}
                    </div>
                    <div className="field">
                      <label htmlFor={`${uid}-revert-in`} className="field-label">
                        Hex revert data (0x…) or gateway UTF-8 error
                      </label>
                      <textarea
                        id={`${uid}-revert-in`}
                        className="textarea mono"
                        rows={3}
                        value={revertInput}
                        onChange={(e) => setRevertInput(e.target.value)}
                        spellCheck={false}
                      />
                    </div>
                    <div
                      aria-live="polite"
                      className={`alert ${decodedRevert.status === 429 ? 'alert-danger' : 'alert-info'}`}
                      style={{ flexDirection: 'column', gap: 6 }}
                    >
                      <div className="row" style={{ gap: 6 }}>
                        <span
                          className={`pill pill-sm ${decodedRevert.status === 429 ? 'pill-danger' : ''}`}
                        >
                          kind: {decodedRevert.kind}
                        </span>
                        {decodedRevert.status !== undefined && (
                          <span className="pill pill-sm pill-danger">
                            HTTP / NAC {decodedRevert.status}
                          </span>
                        )}
                      </div>
                      <strong className="strong" style={{ fontSize: 13 }}>
                        {decodedRevert.summary}
                      </strong>
                      <code className="muted xsmall break-all">raw: {decodedRevert.raw}</code>
                    </div>
                  </TabPanel>
                ) : (
                  <TabPanel idPrefix={decPrefix} id="micheline" className="stack-sm">
                    <div className="chip-row" role="group" aria-label="Sample Micheline hex">
                      <span className="chip-row-label">Load</span>
                      <button
                        type="button"
                        className="chip"
                        onClick={() => {
                          if (result.michelineHex) setRawMichelineInput(result.michelineHex);
                        }}
                      >
                        Current encoded hex
                      </button>
                      <button
                        type="button"
                        className="chip"
                        onClick={() => setRawMichelineInput('0x030b')}
                      >
                        Unit (0x030b)
                      </button>
                      <button
                        type="button"
                        className="chip"
                        onClick={() => setRawMichelineInput('0x0707010000000470696e67002a')}
                      >
                        Pair(&quot;ping&quot;, 42)
                      </button>
                    </div>
                    <div className="field">
                      <label htmlFor={`${uid}-raw-hex`} className="field-label">
                        Raw binary Micheline hex (with or without 0x05 PACK prefix)
                      </label>
                      <textarea
                        id={`${uid}-raw-hex`}
                        className="textarea mono"
                        rows={2}
                        value={rawMichelineInput}
                        onChange={(e) => setRawMichelineInput(e.target.value)}
                        spellCheck={false}
                      />
                    </div>
                    {decodedRawMicheline.ok ? (
                      <div className="stack-sm">
                        <span className="output-line">
                          <Check size={13} className="text-ok" aria-hidden="true" />
                          Decoded ({decodedRawMicheline.bytesRead ?? 0} bytes consumed)
                        </span>
                        <pre className="code-block pre" style={{ maxHeight: 200 }}>
                          {JSON.stringify(decodedRawMicheline.expression, null, 2)}
                        </pre>
                      </div>
                    ) : (
                      <div role="alert" className="alert alert-danger">
                        <ShieldAlert size={14} aria-hidden="true" />
                        <span>{decodedRawMicheline.error || 'Invalid binary Micheline hex'}</span>
                      </div>
                    )}
                  </TabPanel>
                )}
              </TabPanel>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
