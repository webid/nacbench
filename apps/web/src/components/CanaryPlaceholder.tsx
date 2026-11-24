import { ArrowRight, CheckCircle2, Flame, RotateCcw, Terminal, Zap } from 'lucide-react';
import type { GatewayHealth, NetworkConfig } from '../lib/types';

interface CanaryPlaceholderProps {
  network: NetworkConfig;
  health: GatewayHealth | null;
  onJumpToCodec: () => void;
  onJumpToAlias: () => void;
}

const CANARY_PROBES = [
  {
    id: 'probeWrite',
    evmFn: 'probeWrite(kt1, note, gasCap)',
    michelsonEp: '%record_ping(string)',
    summary:
      'EVM → Michelson atomic write enforcing value % 1e12 == 0, recording sp.sender (EVM alias), sp.source (tz1Ke2h7…), and mutez in pings big_map.',
    badge: 'EVM → MICHELSON',
    badgeClass: 'badge-evm',
  },
  {
    id: 'probeRoundTrip',
    evmFn: 'probeRoundTrip(kt1, nonce, gasCap)',
    michelsonEp: '%echo_callback(nat) → onMichelsonCallback(uint256,uint256)',
    summary:
      'Atomic 3-hop EVM → Michelson → EVM round-trip in a single block with reentrancy & authorizedKt1Alias callback guards.',
    badge: 'ROUND-TRIP',
    badgeClass: 'badge-ok',
  },
  {
    id: 'probeView',
    evmFn: 'probeView(kt1, x)',
    michelsonEp: 'get_state_digest(nat) via 0x8326329c',
    summary:
      'Read-only EVM → Michelson on-chain view using low-level .staticcall against callMichelsonView(string,string,bytes).',
    badge: 'VIEW · STATICCALL',
    badgeClass: 'badge-michelson',
  },
  {
    id: 'probeRollback',
    evmFn: 'probeRollback(kt1, reason, gasCap)',
    michelsonEp: '%force_fail(string)',
    summary:
      'Increments EVM rollbackSentinel before invoking Michelson %force_fail, proving atomic cross-runtime state reversion.',
    badge: 'ATOMIC ROLLBACK',
    badgeClass: 'badge-danger',
  },
  {
    id: 'probeOog',
    evmFn: 'probeOog(kt1, iterations, gasCap, catchRevert)',
    michelsonEp: '%burn_gas(nat)',
    summary:
      'Deterministic BLAKE2b gas burn loop to trigger, catch, and decode Tezos X v0.11 HTTP-429 OOG cross-runtime reverts.',
    badge: '429 OOG PROBE',
    badgeClass: 'badge-warn',
  },
];

export function CanaryPlaceholder({
  network,
  health,
  onJumpToCodec,
  onJumpToAlias,
}: CanaryPlaceholderProps) {
  return (
    <div className="stack">
      <section className="panel panel-evm">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">
              <Flame size={16} className="text-evm" />
              Live Paired Canary Lab
              <span className="badge badge-warn">Milestone 3</span>
            </h2>
            <p className="panel-subtitle">
              Interactive 1-click executor for the M1-verified{' '}
              <span className="mono">NacCanaryEvm.sol</span> ↔{' '}
              <span className="mono">nac_canary.py</span> paired contracts on {network.label}.
            </p>
          </div>
          <div className="row">
            <button type="button" className="btn btn-primary btn-sm" onClick={onJumpToCodec}>
              Open Codec Presets <ArrowRight size={13} />
            </button>
            <button type="button" className="btn btn-michelson btn-sm" onClick={onJumpToAlias}>
              Inspect State Diff <ArrowRight size={13} />
            </button>
          </div>
        </div>

        <div className="panel-body stack">
          <div className="alert alert-info">
            <CheckCircle2 size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <div>
              <strong>Milestone 1 contracts & deployment scripts are already verified locally.</strong>{' '}
              Milestone 3 wires live deployed Previewnet addresses, 1-click EVM/Michelson probe
              execution, real-time <span className="mono">debug_traceTransaction(callTracer)</span>{' '}
              call trees, and automatic block-pinned before/after diffs into this tab.
            </div>
          </div>

          <div className="kv-grid">
            <div className="kv-item">
              <span className="kv-label">Active Target Network</span>
              <span className="kv-value">{network.label}</span>
            </div>
            <div className="kv-item">
              <span className="kv-label">EVM Precompile (EXTCODESIZE=0)</span>
              <span className="kv-value text-evm">{network.evm.precompile}</span>
            </div>
            <div className="kv-item">
              <span className="kv-label">Michelson Enshrined Gateway</span>
              <span className="kv-value text-michelson">{network.michelson.evmGateway}</span>
            </div>
            <div className="kv-item">
              <span className="kv-label">Live Block Sync</span>
              <span className="kv-value">
                {health?.synced
                  ? `Synced at #${health.evmHead}`
                  : health
                    ? `EVM #${health.evmHead ?? '—'} / Mich #${health.michelsonLevel ?? '—'}`
                    : 'Probing…'}
              </span>
            </div>
          </div>

          <div className="grid-2">
            {CANARY_PROBES.map((probe) => (
              <div key={probe.id} className="guardrail-item" style={{ gap: 8 }}>
                <div className="row-between">
                  <strong className="mono" style={{ fontSize: 12.5 }}>
                    {probe.evmFn}
                  </strong>
                  <span className={`badge ${probe.badgeClass}`}>{probe.badge}</span>
                </div>
                <div className="mono text-michelson" style={{ fontSize: 11.5 }}>
                  <Zap size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                  {probe.michelsonEp}
                </div>
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  {probe.summary}
                </p>
              </div>
            ))}
          </div>

          <div className="panel" style={{ background: 'var(--bg-elevated)' }}>
            <div className="panel-header">
              <span className="panel-title" style={{ fontSize: 13 }}>
                <Terminal size={14} className="text-ok" />
                M1 CLI Canary Deploy & Read-Only Verification Commands
              </span>
              <span className="badge badge-muted">Zero-TVL · Previewnet</span>
            </div>
            <div className="panel-body">
              <pre className="code-block pre">{`# 1. Dry-run paired NacCanaryEvm + nac_canary deployment (offline-safe)
node scripts/deploy-previewnet.mjs --dry-run --offline

# 2. Deploy live canary pair to Previewnet (requires funded EVM + Tezos keys in .env)
npm run deploy:previewnet -- --live

# 3. Run read-only dual-runtime state verification against deployed addresses
npm run verify:canary`}</pre>
            </div>
          </div>

          <div className="row muted" style={{ fontSize: 12 }}>
            <RotateCcw size={13} />
            <span>
              Tip: All 5 canary payloads (<span className="mono">record_ping</span>,{' '}
              <span className="mono">echo_callback</span>, <span className="mono">force_fail</span>,{' '}
              <span className="mono">burn_gas</span>, <span className="mono">get_state_digest</span>)
              are already available as live presets in the <strong>Codec & Snippets</strong> tab.
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
