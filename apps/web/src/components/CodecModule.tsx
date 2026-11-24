import { useId, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRightLeft,
  Binary,
  Check,
  ChevronDown,
  Code2,
  Copy,
  Cpu,
  Flame,
  Info,
  Layers,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Terminal,
  Zap,
} from 'lucide-react';
import type {
  CodecInput,
  CodecPresetId,
  GuardrailNote,
  NetworkConfig,
} from '../lib/types';
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

type CallDirection = CodecInput['callDirection'];
type SnippetTab = 'solidity' | 'octezJs' | 'smartpy' | 'cheatsheet';
type DecoderTab = 'micheline' | 'revert';

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

function GuardrailCard({ note }: { note: GuardrailNote }) {
  const isCritical = note.severity === 'critical';
  const isWarning = note.severity === 'warning';
  const severityClass = note.triggered
    ? isCritical
      ? 'guardrail-critical'
      : 'guardrail-warning'
    : 'guardrail-info';

  const Icon = note.triggered
    ? isCritical
      ? ShieldAlert
      : AlertTriangle
    : note.severity === 'info'
      ? Info
      : ShieldCheck;

  const iconClass = note.triggered
    ? isCritical
      ? 'text-danger'
      : 'text-warn'
    : isCritical
      ? 'text-danger'
      : isWarning
        ? 'text-evm'
        : 'text-michelson';

  return (
    <div className={`guardrail-item ${severityClass}`}>
      <div className="row-between" style={{ gap: '8px' }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            fontWeight: 600,
            fontSize: '12.5px',
            color: 'var(--text-strong)',
          }}
        >
          <Icon size={14} className={iconClass} aria-hidden="true" />
          {note.title}
        </span>
        <span
          className={`badge ${
            note.triggered
              ? isCritical
                ? 'badge-danger'
                : 'badge-warn'
              : 'badge-ok'
          }`}
        >
          {note.triggered ? (isCritical ? 'TRAP ACTIVE' : 'CHECK') : 'GUARDED'}
        </span>
      </div>
      <p style={{ margin: 0, fontSize: '12px', color: 'var(--muted)', lineHeight: 1.48 }}>
        {note.detail}
      </p>
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

  const [snippetTab, setSnippetTab] = useState<SnippetTab>('solidity');
  const [decoderTab, setDecoderTab] = useState<DecoderTab>('revert');
  const [rawMichelineInput, setRawMichelineInput] = useState<string>(
    '0x01000000136e616362656e63682d70696e672d76302e3131',
  );
  const [revertInput, setRevertInput] = useState<string>(REVERT_SAMPLES[0].payload);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const result = useMemo(() => encodeCodecInput(input), [input]);
  const snippets = useMemo(
    () => generateGuardrailedSnippets(input, result, network),
    [input, result, network],
  );

  const decodedRawMicheline = useMemo(
    () => decodeRawMichelineHex(rawMichelineInput),
    [rawMichelineInput],
  );
  const decodedRevert = useMemo(
    () => decodeRevertPayload(revertInput),
    [revertInput],
  );

  const weiMetrics = useMemo(() => formatMutezFromWei(input.valueWei), [input.valueWei]);
  const gasNum = useMemo(() => {
    const n = Number(input.evmGasCap);
    return Number.isFinite(n) ? n : 0;
  }, [input.evmGasCap]);

  const fieldVis = useMemo(() => getFieldVisibility(input.preset), [input.preset]);
  const isEvmOrigin =
    input.callDirection === 'evm_to_michelson' ||
    input.callDirection === 'evm_view_michelson';
  const isViewCall =
    input.callDirection === 'evm_view_michelson' ||
    input.callDirection === 'michelson_staticcall_evm';

  const kt1IsTz4 = isTz4Address(input.kt1Target.trim());
  const kt1Valid = isValidTezosXAddress(input.kt1Target.trim());
  const evmValid = isValidEvmAddress(input.evmTarget.trim());
  const addrFieldIsTz4 = fieldVis.showAddress && isTz4Address(input.addressVal.trim());
  const triggeredCount = result.guardrails.filter((g) => g.triggered).length;

  const handleCopy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1800);
  };

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

  return (
    <section aria-labelledby={`${uid}-heading`} className="stack">
      {/* Direction Switcher & Presets Panel */}
      <div className={`panel ${isEvmOrigin ? 'panel-evm' : 'panel-michelson'}`}>
        <div className="panel-header">
          <div>
            <h2 id={`${uid}-heading`} className="panel-title">
              <Binary size={16} className="text-michelson" aria-hidden="true" />
              Module 1 · Dual-Runtime Micheline Codec &amp; Guardrailed Snippet Workbench
            </h2>
            <p className="panel-subtitle">
              100% deterministic client-side binary Micheline encoder, Horus 8.0 / v0.11 gateway
              calldata builder, revert decoder, and trap-hardened code generator.
            </p>
          </div>
          <div className="row">
            <span className="badge badge-ok">ZERO-RPC · INSTANT</span>
            <span className={`badge ${isEvmOrigin ? 'badge-evm' : 'badge-michelson'}`}>
              {network.label} · {isViewCall ? 'VIEW' : 'ATOMIC WRITE'}
            </span>
          </div>
        </div>

        <div className="panel-body stack">
          {/* 4-Way Direction Switcher */}
          <div
            role="radiogroup"
            aria-label="Cross-runtime call direction"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(215px, 1fr))',
              gap: '10px',
            }}
          >
            {DIRECTION_OPTIONS.map((dir) => {
              const active = input.callDirection === dir.id;
              const isEvm = dir.fromRuntime === 'evm';
              return (
                <button
                  key={dir.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
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
                  style={{
                    textAlign: 'left',
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-md)',
                    cursor: 'pointer',
                    background: active
                      ? isEvm
                        ? 'var(--evm-soft)'
                        : 'var(--michelson-soft)'
                      : 'var(--bg-elevated)',
                    border: `1px solid ${
                      active
                        ? isEvm
                          ? 'var(--evm)'
                          : 'var(--michelson)'
                        : 'var(--border-strong)'
                    }`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '3px',
                    transition: 'border-color 140ms ease, background-color 140ms ease',
                  }}
                >
                  <div className="row-between" style={{ gap: '6px' }}>
                    <span style={{ fontWeight: 700, fontSize: '13px', color: 'var(--text-strong)' }}>
                      {dir.label}
                    </span>
                    <ArrowRightLeft
                      size={13}
                      className={active ? (isEvm ? 'text-evm' : 'text-michelson') : 'muted'}
                      aria-hidden="true"
                    />
                  </div>
                  <span
                    className={`mono ${active ? (isEvm ? 'text-evm' : 'text-michelson') : 'muted'}`}
                    style={{ fontSize: '11.5px' }}
                  >
                    {dir.sublabel}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Preset Chips */}
          <div className="stack-sm">
            <div className="row" style={{ gap: '6px' }}>
              <span
                className="mono text-evm"
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                  marginRight: '4px',
                }}
              >
                <Sparkles size={12} aria-hidden="true" />
                NACBench Canary
              </span>
              {canaryPresets.map((preset) => {
                const selected = input.preset === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPreset(preset)}
                    className={`btn btn-sm ${selected ? 'btn-evm' : ''}`}
                  >
                    <span className="mono">{preset.label}</span>
                    <span className="muted" style={{ fontSize: '10.5px', fontWeight: 500 }}>
                      {preset.tag}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="row" style={{ gap: '6px' }}>
              <span
                className="mono text-michelson"
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                  marginRight: '4px',
                }}
              >
                <Layers size={12} aria-hidden="true" />
                Primitives
              </span>
              {primitivePresets.map((preset) => {
                const selected = input.preset === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPreset(preset)}
                    className={`btn btn-sm ${selected ? 'btn-michelson' : ''}`}
                  >
                    <span className="mono">{preset.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Split Workbench: Structured Inputs ↔ Encoded Output & Decoders */}
      <div className="grid-2" style={{ alignItems: 'start' }}>
        {/* Left: Structured Call Specification */}
        <div className="panel">
          <div className="panel-header">
            <h3 className="panel-title">
              <Cpu size={15} className="text-evm" aria-hidden="true" />
              Structured Call Specification
            </h3>
            <span className="badge badge-muted">preset: {input.preset}</span>
          </div>

          <div className="panel-body stack">
            {/* Target & Entrypoint */}
            <fieldset
              style={{
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                padding: '12px',
                margin: 0,
                background: 'var(--bg-elevated)',
              }}
              className="stack-sm"
            >
              <legend
                className="mono muted"
                style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '0 6px' }}
              >
                Target &amp; Entrypoint Routing
              </legend>

              {isEvmOrigin ? (
                <div className="field">
                  <div className="field-label">
                    <label htmlFor={`${uid}-kt1`}>Michelson Destination (KT1 / tz1)</label>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        setInput((prev) => ({
                          ...prev,
                          kt1Target: network.michelson.evmGateway,
                        }))
                      }
                    >
                      Use Gateway KT1
                    </button>
                  </div>
                  <input
                    id={`${uid}-kt1`}
                    className="input mono"
                    value={input.kt1Target}
                    onChange={(e) => setInput((prev) => ({ ...prev, kt1Target: e.target.value }))}
                    placeholder="KT1..."
                    spellCheck={false}
                  />
                  {kt1IsTz4 && (
                    <div role="alert" className="alert alert-danger" style={{ padding: '7px 10px' }}>
                      <ShieldAlert size={14} aria-hidden="true" />
                      <span>
                        BLS <code className="mono">tz4</code> addresses are not supported on Tezos X
                        Michelson interface yet.
                      </span>
                    </div>
                  )}
                  {!kt1IsTz4 && input.kt1Target.trim() && !kt1Valid && (
                    <span className="field-hint text-warn">
                      Expected a 36-char Base58Check <code className="mono">KT1</code>/
                      <code className="mono">tz1</code>/<code className="mono">tz2</code>/
                      <code className="mono">tz3</code> address.
                    </span>
                  )}
                </div>
              ) : (
                <div className="field">
                  <div className="field-label">
                    <label htmlFor={`${uid}-evm`}>EVM Destination (0x…)</label>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        setInput((prev) => ({
                          ...prev,
                          evmTarget: DEFAULT_FIXTURES.freeRoutePoolEvm,
                        }))
                      }
                    >
                      Use Free-Route Pool
                    </button>
                  </div>
                  <input
                    id={`${uid}-evm`}
                    className="input mono"
                    value={input.evmTarget}
                    onChange={(e) => setInput((prev) => ({ ...prev, evmTarget: e.target.value }))}
                    placeholder="0x..."
                    spellCheck={false}
                  />
                  {input.evmTarget.trim() && !evmValid && (
                    <span className="field-hint text-danger">
                      Expected a 20-byte <code className="mono">0x</code>-prefixed EVM address.
                    </span>
                  )}
                </div>
              )}

              <div className="field">
                <label htmlFor={`${uid}-ep`} className="field-label">
                  {isEvmOrigin
                    ? isViewCall
                      ? 'Michelson On-Chain View Name'
                      : 'Michelson Entrypoint (without %)'
                    : input.callDirection === 'michelson_to_evm'
                      ? 'EVM Signature String (%call_evm 2nd field)'
                      : 'EVM View Signature (selector hashed for staticcall_evm)'}
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
                  <div className="row" style={{ gap: '5px', marginTop: '4px' }}>
                    <span className="mono muted" style={{ fontSize: '10.5px' }}>
                      ABI PRESETS:
                    </span>
                    {EVM_SIGNATURE_PRESETS.map((preset) => (
                      <button
                        key={preset.sig}
                        type="button"
                        className={`btn btn-sm ${
                          input.entrypoint.trim() === preset.sig ? 'btn-michelson' : ''
                        }`}
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
            </fieldset>

            {/* Typed Payload Fields */}
            <fieldset
              style={{
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                padding: '12px',
                margin: 0,
                background: 'var(--bg-elevated)',
              }}
              className="stack-sm"
            >
              <legend
                className="mono muted"
                style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '0 6px' }}
              >
                {isEvmOrigin ? 'Typed Micheline Parameter Payload' : 'Typed Solidity ABI Arguments'}
              </legend>

              {!isEvmOrigin && parsedEvmSig && !parsedEvmSig.ok && (
                <div role="alert" className="alert alert-danger" style={{ padding: '8px 10px' }}>
                  <ShieldAlert size={14} aria-hidden="true" />
                  <span>{parsedEvmSig.error}</span>
                </div>
              )}

              {!isEvmOrigin && parsedEvmSig && parsedEvmSig.ok && (
                <div className="stack-sm">
                  {parsedEvmSig.types.length === 0 ? (
                    <p className="mono muted" style={{ margin: 0, fontSize: '12px' }}>
                      <code className="mono">{parsedEvmSig.canonicalSig}</code> takes zero ABI
                      arguments.
                    </p>
                  ) : (
                    parsedEvmSig.types.map((paramType, idx) => {
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
                            Arg #{idx + 1} · <code className="mono text-evm">{paramType}</code>
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
                    })
                  )}
                </div>
              )}

              {isEvmOrigin && input.preset === 'unit' && (
                <p className="mono muted" style={{ margin: 0, fontSize: '12px' }}>
                  Unit primitive (<code className="mono">0x030b</code>) carries zero arguments.
                </p>
              )}

              {isEvmOrigin && fieldVis.showString && (
                <div className="field">
                  <label htmlFor={`${uid}-str`} className="field-label">
                    UTF-8 String Value
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
                    Unsigned Natural (nat ≥ 0)
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
                    Signed Integer (int, Zarith)
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
                    Raw Hex Bytes (0x…)
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
                    <label htmlFor={`${uid}-addr`}>Michelson Address (tz1/2/3 or KT1)</label>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        setInput((prev) => ({ ...prev, addressVal: DEFAULT_FIXTURES.aliceTz1 }))
                      }
                    >
                      Alice tz1
                    </button>
                  </div>
                  <input
                    id={`${uid}-addr`}
                    className="input mono"
                    value={input.addressVal}
                    onChange={(e) => setInput((prev) => ({ ...prev, addressVal: e.target.value }))}
                    placeholder="tz1..."
                    spellCheck={false}
                  />
                  {addrFieldIsTz4 && (
                    <span role="alert" className="field-hint text-danger">
                      BLS <code className="mono">tz4</code> is unsupported on Tezos X Michelson
                      interface — use <code className="mono">tz1</code>,{' '}
                      <code className="mono">tz2</code>, <code className="mono">tz3</code>, or{' '}
                      <code className="mono">KT1</code>.
                    </span>
                  )}
                </div>
              )}

              {isEvmOrigin && fieldVis.showMutez && (
                <div className="field">
                  <label htmlFor={`${uid}-mutez`} className="field-label">
                    Embedded Mutez (1 XTZ = 1,000,000 mutez)
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
            </fieldset>

            {/* Value 10^12 Dust & Gas Controls */}
            <fieldset
              style={{
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                padding: '12px',
                margin: 0,
                background: 'var(--bg-elevated)',
              }}
              className="stack-sm"
            >
              <legend
                className="mono muted"
                style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '0 6px' }}
              >
                Value Alignment (10¹² Wei ↔ Mutez) &amp; Gas Caps
              </legend>

              <div className="field">
                <div className="field-label">
                  <label htmlFor={`${uid}-wei`}>Attached EVM Value (wei)</label>
                  <div className="row" style={{ gap: '4px' }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setInput((prev) => ({ ...prev, valueWei: '0' }))}
                    >
                      0
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        setInput((prev) => ({ ...prev, valueWei: '1000000000000' }))
                      }
                    >
                      1 mutez (10¹²)
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        setInput((prev) => ({ ...prev, valueWei: '1000000000000000' }))
                      }
                    >
                      0.001 XTZ
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={injectOneWeiDust}
                    >
                      +1 wei dust
                    </button>
                  </div>
                </div>
                <input
                  id={`${uid}-wei`}
                  className="input mono"
                  inputMode="numeric"
                  value={input.valueWei}
                  onChange={(e) => setInput((prev) => ({ ...prev, valueWei: e.target.value }))}
                  style={{ borderColor: !result.mutezAligned ? 'var(--danger)' : undefined }}
                />

                <output
                  htmlFor={`${uid}-wei`}
                  aria-live="polite"
                  className={`alert ${result.mutezAligned ? 'alert-ok' : 'alert-danger'}`}
                  style={{ alignItems: 'center', justifyContent: 'space-between', padding: '8px 11px' }}
                >
                  {result.mutezAligned ? (
                    <span className="row" style={{ gap: '6px' }}>
                      <ShieldCheck size={14} aria-hidden="true" />
                      <span className="mono">
                        Aligned: {weiMetrics.mutez} mutez ({weiMetrics.xtz} XTZ) · dust = 0 wei
                      </span>
                    </span>
                  ) : (
                    <>
                      <span className="row" style={{ gap: '6px' }}>
                        <ShieldAlert size={14} aria-hidden="true" />
                        <span className="mono">
                          DUST REMAINDER: {result.dustRemainderWei} wei (not divisible by 10¹²)
                        </span>
                      </span>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={snapWeiToMutezGrid}
                      >
                        Snap to 10¹² grid
                      </button>
                    </>
                  )}
                </output>
              </div>

              <div className="field">
                <div className="field-label">
                  <label htmlFor={`${uid}-gas`}>EVM Gas Cap</label>
                  <div className="row" style={{ gap: '4px' }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setInput((prev) => ({ ...prev, evmGasCap: '3000000' }))}
                    >
                      3M Transfer
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setInput((prev) => ({ ...prev, evmGasCap: '5000000' }))}
                    >
                      5M NAC Call
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-evm"
                      onClick={() => setInput((prev) => ({ ...prev, evmGasCap: '1000000' }))}
                    >
                      1M OOG Probe
                    </button>
                  </div>
                </div>
                <input
                  id={`${uid}-gas`}
                  className="input mono"
                  inputMode="numeric"
                  value={input.evmGasCap}
                  onChange={(e) => setInput((prev) => ({ ...prev, evmGasCap: e.target.value }))}
                />
                {gasNum < 3_000_000 ? (
                  <span className="field-hint text-warn" style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                    <Flame size={13} aria-hidden="true" />
                    Below 3,000,000 EVM gas NAC floor — high risk of{' '}
                    <code className="mono">429 Too Many Requests: out of gas</code>.
                  </span>
                ) : (
                  <span className="field-hint text-ok" style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                    <Zap size={13} aria-hidden="true" />
                    Meets NAC v0.11 EVM gas floor ({gasNum.toLocaleString()} gas).
                  </span>
                )}
                <span className="field-hint">
                  Michelson hard op cap on {network.label}:{' '}
                  <strong className="mono text-michelson">
                    {network.michelson.hardGasLimitPerOperation.toLocaleString()}
                  </strong>{' '}
                  Michelson gas units (translated from EVM gas via kernel coefficient).
                </span>
              </div>
            </fieldset>
          </div>
        </div>

        {/* Right: Encoded Output & Collapsible Decoder */}
        <div className="stack">
          <div className="panel">
            <div className="panel-header">
              <h3 className="panel-title">
                <Terminal size={15} className="text-michelson" aria-hidden="true" />
                Live Encoded Telemetry
              </h3>
              <div className="row" style={{ gap: '6px' }}>
                <span className="badge badge-michelson">{result.michelineByteLength} bytes</span>
                <span className="badge badge-evm">selector: {result.abiSelector || 'N/A'}</span>
              </div>
            </div>

            <div className="panel-body stack">
              {!result.ok && result.error && (
                <div role="alert" className="alert alert-danger">
                  <ShieldAlert size={15} aria-hidden="true" />
                  <span>
                    <strong>Encoding Error:</strong> {result.error}
                  </span>
                </div>
              )}

              <div className="stack-sm">
                <div className="row-between">
                  <span className="field-label">Binary Micheline Hex (0x05-Stripped)</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => handleCopy('micheline', result.michelineHex)}
                    disabled={!result.michelineHex}
                  >
                    {copiedKey === 'micheline' ? <Check size={12} /> : <Copy size={12} />}
                    {copiedKey === 'micheline' ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre
                  className="code-block text-michelson"
                  style={{ maxHeight: '105px', overflowY: 'auto' }}
                >
                  {result.michelineHex || '—'}
                </pre>
              </div>

              <div className="stack-sm">
                <div className="row-between">
                  <span className="field-label">Round-Trip Decoded Micheline Expression</span>
                  <span className="badge badge-ok">encode → decode OK</span>
                </div>
                <pre
                  className="code-block pre"
                  style={{ maxHeight: '150px', overflowY: 'auto' }}
                >
                  {result.decodedExpression !== undefined
                    ? JSON.stringify(result.decodedExpression, null, 2)
                    : '—'}
                </pre>
              </div>

              <div className="stack-sm">
                <div className="row-between">
                  <span className="field-label">
                    Gateway Calldata ({isEvmOrigin ? network.evm.precompile : network.michelson.evmGateway})
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => handleCopy('calldata', result.gatewayCalldataHex)}
                    disabled={!result.gatewayCalldataHex}
                  >
                    {copiedKey === 'calldata' ? <Check size={12} /> : <Copy size={12} />}
                    {copiedKey === 'calldata' ? 'Copied' : 'Copy Calldata'}
                  </button>
                </div>
                <pre
                  className="code-block text-evm"
                  style={{ maxHeight: '130px', overflowY: 'auto' }}
                >
                  {result.gatewayCalldataHex || '—'}
                </pre>
              </div>
            </div>
          </div>

          {/* Collapsible Raw Hex & Revert Payload Decoder */}
          <details className="panel" open>
            <summary
              className="panel-header"
              style={{ cursor: 'pointer', listStyle: 'none' }}
            >
              <span className="panel-title">
                <ChevronDown size={15} className="muted" aria-hidden="true" />
                Raw Micheline Hex &amp; NAC Revert Payload Decoder
              </span>
              <span className="badge badge-muted">429 OOG · 404 · Error(string) · 0x05/Raw</span>
            </summary>

            <div className="panel-body stack-sm">
              <div className="subtabs" role="tablist" aria-label="Decoder mode">
                <button
                  type="button"
                  role="tab"
                  aria-selected={decoderTab === 'revert'}
                  aria-controls={`${uid}-dec-revert`}
                  id={`${uid}-tab-revert`}
                  className={`subtab ${decoderTab === 'revert' ? 'subtab-active' : ''}`}
                  onClick={() => setDecoderTab('revert')}
                >
                  Revert / 429 OOG Decoder
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={decoderTab === 'micheline'}
                  aria-controls={`${uid}-dec-mich`}
                  id={`${uid}-tab-mich`}
                  className={`subtab ${decoderTab === 'micheline' ? 'subtab-active' : ''}`}
                  onClick={() => setDecoderTab('micheline')}
                >
                  Raw Micheline Hex Decoder
                </button>
              </div>

              {decoderTab === 'revert' ? (
                <div
                  id={`${uid}-dec-revert`}
                  role="tabpanel"
                  aria-labelledby={`${uid}-tab-revert`}
                  className="stack-sm"
                >
                  <div className="row" style={{ gap: '5px' }}>
                    {REVERT_SAMPLES.map((sample) => (
                      <button
                        key={sample.label}
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setRevertInput(sample.payload)}
                      >
                        {sample.label}
                      </button>
                    ))}
                  </div>
                  <div className="field">
                    <label htmlFor={`${uid}-revert-in`} className="field-label">
                      Hex Revert Data (0x…) or Gateway UTF-8 Error
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
                    className={`alert ${decodedRevert.status === 429 ? 'alert-danger' : 'alert-info'}`}
                    style={{ flexDirection: 'column', gap: '6px' }}
                  >
                    <div className="row" style={{ gap: '6px' }}>
                      <span className={`badge ${decodedRevert.status === 429 ? 'badge-danger' : 'badge-evm'}`}>
                        kind: {decodedRevert.kind}
                      </span>
                      {decodedRevert.status !== undefined && (
                        <span className="badge badge-danger">HTTP / NAC {decodedRevert.status}</span>
                      )}
                    </div>
                    <strong style={{ color: 'var(--text-strong)', fontSize: '13px' }}>
                      {decodedRevert.summary}
                    </strong>
                    <code className="mono muted" style={{ fontSize: '11.5px', wordBreak: 'break-all' }}>
                      raw: {decodedRevert.raw}
                    </code>
                  </div>
                </div>
              ) : (
                <div
                  id={`${uid}-dec-mich`}
                  role="tabpanel"
                  aria-labelledby={`${uid}-tab-mich`}
                  className="stack-sm"
                >
                  <div className="row" style={{ gap: '5px' }}>
                    <button
                      type="button"
                      className="btn btn-sm btn-michelson"
                      onClick={() => {
                        if (result.michelineHex) setRawMichelineInput(result.michelineHex);
                      }}
                    >
                      Load Current Encoded Hex
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setRawMichelineInput('0x030b')}
                    >
                      Unit (0x030b)
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setRawMichelineInput('0x0707010000000470696e67002a')}
                    >
                      Pair(&quot;ping&quot;, 42)
                    </button>
                  </div>
                  <div className="field">
                    <label htmlFor={`${uid}-raw-hex`} className="field-label">
                      Raw Binary Micheline Hex (with or without 0x05 PACK prefix)
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
                      <span className="badge badge-ok" style={{ alignSelf: 'flex-start' }}>
                        Decoded ({decodedRawMicheline.bytesRead ?? 0} bytes consumed)
                      </span>
                      <pre
                        className="code-block pre"
                        style={{ maxHeight: '140px', overflowY: 'auto' }}
                      >
                        {JSON.stringify(decodedRawMicheline.expression, null, 2)}
                      </pre>
                    </div>
                  ) : (
                    <div role="alert" className="alert alert-danger">
                      {decodedRawMicheline.error || 'Invalid binary Micheline hex'}
                    </div>
                  )}
                </div>
              )}
            </div>
          </details>
        </div>
      </div>

      {/* 6 v0.11 / Horus 8.0 Guardrails Strip */}
      <div className="panel">
        <div className="panel-header">
          <h3 className="panel-title">
            <ShieldCheck size={16} className="text-ok" aria-hidden="true" />
            Tezos X v0.11 / Horus 8.0 Mandatory Guardrails ({result.guardrails.length})
          </h3>
          <div className="row">
            <span className="mono muted" style={{ fontSize: '11.5px' }}>
              Null cross-runtime SOURCE: {NULL_SOURCE_ADDRESS.slice(0, 12)}…
            </span>
            <span className={`badge ${triggeredCount > 0 ? 'badge-warn' : 'badge-ok'}`}>
              {triggeredCount > 0 ? `${triggeredCount} active alert(s)` : 'All guardrails green'}
            </span>
          </div>
        </div>
        <div className="panel-body">
          <div className="guardrail-list">
            {result.guardrails.map((note) => (
              <GuardrailCard key={note.id} note={note} />
            ))}
          </div>
        </div>
      </div>

      {/* Guardrail-Baked Copy-Paste Code Generator */}
      <div className="panel">
        <div className="panel-header">
          <h3 className="panel-title">
            <Code2 size={16} className="text-evm" aria-hidden="true" />
            Guardrail-Baked Copy-Paste Code Generator
          </h3>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => handleCopy(`snippet-${snippetTab}`, activeSnippetCode)}
          >
            {copiedKey === `snippet-${snippetTab}` ? <Check size={13} /> : <Copy size={13} />}
            {copiedKey === `snippet-${snippetTab}` ? 'Copied to Clipboard' : 'Copy Snippet'}
          </button>
        </div>

        <div className="panel-body stack-sm">
          <div className="subtabs" role="tablist" aria-label="Generated code language">
            {(
              [
                { id: 'solidity', label: 'Solidity 0.8.24' },
                { id: 'octezJs', label: '@tezos-x/octez.js v25.1' },
                { id: 'smartpy', label: 'SmartPy' },
                { id: 'cheatsheet', label: 'Selector Cheat-Sheet' },
              ] as { id: SnippetTab; label: string }[]
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`${uid}-snip-tab-${tab.id}`}
                aria-selected={snippetTab === tab.id}
                aria-controls={`${uid}-snip-panel`}
                className={`subtab ${snippetTab === tab.id ? 'subtab-active' : ''}`}
                onClick={() => setSnippetTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div
            id={`${uid}-snip-panel`}
            role="tabpanel"
            aria-labelledby={`${uid}-snip-tab-${snippetTab}`}
          >
            <pre
              className="code-block pre"
              style={{ maxHeight: '380px', overflowY: 'auto' }}
            >
              {activeSnippetCode}
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}
