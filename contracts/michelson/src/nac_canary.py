import smartpy as sp


@sp.module
def main():
    # Live Previewnet v0.11 enshrined Michelson gateway:
    # KT18oDJJKXMKhfE1bSuAPGp92pYcwVDiqsPw
    # Entrypoint %call_evm: pair string string bytes (option (contract bytes))
    # View staticcall_evm: pair string bytes -> bytes
    call_evm_type: type = sp.record(
        destination=sp.string,
        selector=sp.string,
        data=sp.bytes,
        callback=sp.option[sp.contract[sp.bytes]],
    ).layout(("destination", ("selector", ("data", "callback"))))

    ping_record_type: type = sp.record(
        note=sp.string,
        sender=sp.address,
        source=sp.address,
        amount=sp.mutez,
    ).layout(("note", ("sender", ("source", "amount"))))

    state_digest_type: type = sp.record(
        ping_count=sp.nat,
        callback_count=sp.nat,
        echo=sp.nat,
    ).layout(("ping_count", ("callback_count", "echo")))

    staticcall_params_type: type = sp.record(
        target=sp.string,
        calldata=sp.bytes,
    ).layout(("target", "calldata"))

    class NacCanary(sp.Contract):
        """NACBench Milestone 1 Michelson Canary for Tezos X Previewnet v0.11.

        Paired byte-for-byte with NacCanaryEvm.sol to exercise:
        - EVM -> Michelson writes (%record_ping) with mutez + sender/source capture
        - EVM -> Michelson -> EVM atomic round-trip callbacks (%echo_callback -> %call_evm)
        - Atomic cross-runtime rollback (%force_fail)
        - Deterministic gas burn for 429 OOG probing (%burn_gas)
        - On-chain views (get_state_digest, probe_evm_staticcall -> staticcall_evm)
        """

        def __init__(self, admin, paired_evm_canary, authorized_evm_gateway):
            self.data.admin = sp.cast(admin, sp.address)
            self.data.paired_evm_canary = sp.cast(paired_evm_canary, sp.string)
            self.data.authorized_evm_gateway = sp.cast(
                authorized_evm_gateway, sp.address
            )
            self.data.ping_count = sp.nat(0)
            self.data.callback_count = sp.nat(0)
            self.data.last_note = ""
            self.data.last_sender = admin
            self.data.last_source = admin
            self.data.pings = sp.cast(
                sp.big_map(),
                sp.big_map[sp.nat, ping_record_type],
            )

        @sp.private()
        def encode_u256(self, value):
            """Encode a nat as a 32-byte big-endian Solidity uint256 word."""
            sp.cast(value, sp.nat)
            zero = sp.bytes(
                "0x0000000000000000000000000000000000000000000000000000000000000000"
            )
            raw = sp.to_bytes(value)
            assert sp.len(raw) <= 32, "UINT256_OVERFLOW"
            padding = sp.slice(0, sp.as_nat(32 - sp.len(raw)), zero).unwrap_some(
                error="PAD_FAILED"
            )
            return padding + raw

        @sp.entrypoint
        def record_ping(self, note):
            """Record a cross-runtime or native ping, capturing sender, source, and mutez."""
            sp.cast(note, sp.string)
            self.data.ping_count += 1
            self.data.pings[self.data.ping_count] = sp.record(
                note=note,
                sender=sp.sender,
                source=sp.source,
                amount=sp.amount,
            )
            self.data.last_note = note
            self.data.last_sender = sp.sender
            self.data.last_source = sp.source

        @sp.entrypoint
        def echo_callback(self, nonce):
            """Emit an atomic %call_evm callback to NacCanaryEvm.onMichelsonCallback(uint256,uint256)."""
            sp.cast(nonce, sp.nat)
            assert self.data.paired_evm_canary != "", "PAIRED_EVM_NOT_SET"
            self.data.callback_count += 1

            abi_bytes = self.encode_u256(nonce) + self.encode_u256(
                self.data.callback_count
            )
            gateway = sp.contract(
                call_evm_type,
                self.data.authorized_evm_gateway,
                entrypoint="call_evm",
            ).unwrap_some(error="GATEWAY_ENTRYPOINT_MISSING")
            sp.transfer(
                sp.record(
                    destination=self.data.paired_evm_canary,
                    selector="onMichelsonCallback(uint256,uint256)",
                    data=abi_bytes,
                    callback=sp.cast(None, sp.option[sp.contract[sp.bytes]]),
                ),
                sp.mutez(0),
                gateway,
            )

        @sp.entrypoint
        def force_fail(self, reason):
            """Unconditionally fail with reason to prove atomic cross-runtime rollback."""
            sp.cast(reason, sp.string)
            raise reason

        @sp.entrypoint
        def burn_gas(self, iterations):
            """Deterministic BLAKE2b loop for tuning EVM gas caps and 429 OOG probes."""
            sp.cast(iterations, sp.nat)
            acc = sp.bytes("0x00")
            i = sp.nat(0)
            while i < iterations:
                acc = sp.blake2b(acc)
                i += 1
            # Keep acc live after the loop so the optimizer cannot elide the hashes.
            assert sp.len(acc) > 0, "UNREACHABLE"
            self.data.ping_count += 1

        @sp.entrypoint
        def set_paired_evm(self, evm_addr):
            """Admin-only setter for the paired lowercase 0x... NacCanaryEvm address."""
            sp.cast(evm_addr, sp.string)
            assert sp.sender == self.data.admin, "NOT_ADMIN"
            self.data.paired_evm_canary = evm_addr

        @sp.onchain_view()
        def get_state_digest(self, x):
            """Return counters plus echoed input for EVM callMichelsonView probes."""
            sp.cast(x, sp.nat)
            return sp.cast(
                sp.record(
                    ping_count=self.data.ping_count,
                    callback_count=self.data.callback_count,
                    echo=x,
                ),
                state_digest_type,
            )

        @sp.onchain_view()
        def probe_evm_staticcall(self, params):
            """Forward a read-only staticcall_evm query through the enshrined gateway."""
            sp.cast(params, staticcall_params_type)
            return sp.view(
                "staticcall_evm",
                self.data.authorized_evm_gateway,
                (params.target, params.calldata),
                sp.bytes,
            ).unwrap_some(error="STATICCALL_EVM_VIEW_FAILED")


@sp.module
def mocks():
    mock_call_evm_type: type = sp.record(
        destination=sp.string,
        selector=sp.string,
        data=sp.bytes,
        callback=sp.option[sp.contract[sp.bytes]],
    ).layout(("destination", ("selector", ("data", "callback"))))

    class MockGateway(sp.Contract):
        """Local mock of KT18oDJJKXMKhfE1bSuAPGp92pYcwVDiqsPw for SmartPy tests."""

        def __init__(self, staticcall_response):
            self.data.call_count = sp.nat(0)
            self.data.last_destination = ""
            self.data.last_selector = ""
            self.data.last_data = sp.bytes("0x")
            self.data.has_callback = False
            self.data.last_sender = sp.address("tz1Ke2h7sDdakHJQh8WX4Z372du1KChsksyU")
            self.data.staticcall_response = sp.cast(staticcall_response, sp.bytes)

        @sp.entrypoint
        def call_evm(self, params):
            sp.cast(params, mock_call_evm_type)
            self.data.call_count += 1
            self.data.last_destination = params.destination
            self.data.last_selector = params.selector
            self.data.last_data = params.data
            self.data.has_callback = params.callback.is_some()
            self.data.last_sender = sp.sender

        @sp.onchain_view()
        def staticcall_evm(self, params):
            sp.cast(params, sp.pair[sp.string, sp.bytes])
            (target, calldata) = params
            assert target != "", "EMPTY_TARGET"
            assert sp.len(calldata) >= 4, "SHORT_CALLDATA"
            return self.data.staticcall_response + calldata


PREVIEWNET_GATEWAY = "KT18oDJJKXMKhfE1bSuAPGp92pYcwVDiqsPw"
NULL_SOURCE = "tz1Ke2h7sDdakHJQh8WX4Z372du1KChsksyU"
DEFAULT_ADMIN = "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb"
PAIRED_EVM_ADDR = "0x1111111111111111111111111111111111111111"


@sp.add_test()
def nac_canary():
    """Canonical compilation + core behavior tests targeting Previewnet gateway."""
    scenario = sp.test_scenario("nac_canary", main)
    admin = sp.address(DEFAULT_ADMIN)
    caller = sp.test_account("caller")
    evm_alias = sp.test_account("evm_alias")
    attacker = sp.test_account("attacker")

    canary = main.NacCanary(
        admin,
        "",
        sp.address(PREVIEWNET_GATEWAY),
    )
    scenario += canary

    # Initial storage checks
    scenario.verify(canary.data.admin == admin)
    scenario.verify(canary.data.paired_evm_canary == "")
    scenario.verify(canary.data.authorized_evm_gateway == sp.address(PREVIEWNET_GATEWAY))
    scenario.verify(canary.data.ping_count == 0)
    scenario.verify(canary.data.callback_count == 0)

    # %record_ping with native caller and non-zero mutez
    canary.record_ping(
        "hello-previewnet",
        _sender=caller.address,
        _source=caller.address,
        _amount=sp.mutez(1234),
    )
    scenario.verify(canary.data.ping_count == 1)
    scenario.verify(canary.data.last_note == "hello-previewnet")
    scenario.verify(canary.data.last_sender == caller.address)
    scenario.verify(canary.data.last_source == caller.address)
    scenario.verify(
        canary.data.pings[1]
        == sp.record(
            note="hello-previewnet",
            sender=caller.address,
            source=caller.address,
            amount=sp.mutez(1234),
        )
    )

    # %record_ping simulating EVM NAC caller where SOURCE is null tz1Ke2h...
    canary.record_ping(
        "from-evm-alias",
        _sender=evm_alias.address,
        _source=sp.address(NULL_SOURCE),
        _amount=sp.mutez(500000),
    )
    scenario.verify(canary.data.ping_count == 2)
    scenario.verify(canary.data.last_note == "from-evm-alias")
    scenario.verify(canary.data.last_sender == evm_alias.address)
    scenario.verify(canary.data.last_source == sp.address(NULL_SOURCE))
    scenario.verify(canary.data.pings[2].sender == evm_alias.address)
    scenario.verify(canary.data.pings[2].source == sp.address(NULL_SOURCE))
    scenario.verify(canary.data.pings[2].amount == sp.mutez(500000))

    # %force_fail unconditionally fails with exact reason string
    canary.force_fail(
        "ATOMIC_ROLLBACK_PROBE",
        _sender=caller.address,
        _valid=False,
        _exception="ATOMIC_ROLLBACK_PROBE",
    )

    # %burn_gas succeeds for 0 and small iteration counts, incrementing ping_count
    canary.burn_gas(0, _sender=caller.address)
    scenario.verify(canary.data.ping_count == 3)
    canary.burn_gas(8, _sender=caller.address)
    scenario.verify(canary.data.ping_count == 4)

    # %echo_callback rejects when paired_evm_canary is empty
    canary.echo_callback(
        1,
        _sender=caller.address,
        _valid=False,
        _exception="PAIRED_EVM_NOT_SET",
    )

    # %set_paired_evm enforces admin authorization
    canary.set_paired_evm(
        PAIRED_EVM_ADDR,
        _sender=attacker.address,
        _valid=False,
        _exception="NOT_ADMIN",
    )
    canary.set_paired_evm(PAIRED_EVM_ADDR, _sender=admin)
    scenario.verify(canary.data.paired_evm_canary == PAIRED_EVM_ADDR)

    # get_state_digest view returns exact counters + echoed x
    digest = canary.get_state_digest(999)
    scenario.verify(digest.ping_count == 4)
    scenario.verify(digest.callback_count == 0)
    scenario.verify(digest.echo == 999)


@sp.add_test()
def nac_canary_gateway_integration():
    """Full mock-gateway integration tests for %echo_callback ABI & probe_evm_staticcall."""
    scenario = sp.test_scenario("nac_canary_gateway_integration", [main, mocks])
    admin = sp.test_account("admin")
    caller = sp.test_account("caller")

    staticcall_prefix = sp.bytes("0xdeadbeef")
    gateway = mocks.MockGateway(staticcall_prefix)
    scenario += gateway

    canary = main.NacCanary(
        admin.address,
        PAIRED_EVM_ADDR,
        gateway.address,
    )
    scenario += canary

    # 1. %echo_callback with nonce = 0 (critical edge case: sp.to_bytes(0) == 0x)
    canary.echo_callback(0, _sender=caller.address)
    scenario.verify(canary.data.callback_count == 1)
    scenario.verify(gateway.data.call_count == 1)
    scenario.verify(gateway.data.last_destination == PAIRED_EVM_ADDR)
    scenario.verify(
        gateway.data.last_selector == "onMichelsonCallback(uint256,uint256)"
    )
    scenario.verify(gateway.data.has_callback == False)
    scenario.verify(gateway.data.last_sender == canary.address)
    scenario.verify(
        gateway.data.last_data
        == sp.bytes(
            "0x0000000000000000000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000001"
        )
    )

    # 2. %echo_callback with nonce = 42 (0x2a), callback_count becomes 2
    canary.echo_callback(42, _sender=caller.address)
    scenario.verify(canary.data.callback_count == 2)
    scenario.verify(gateway.data.call_count == 2)
    scenario.verify(
        gateway.data.last_data
        == sp.bytes(
            "0x000000000000000000000000000000000000000000000000000000000000002a"
            "0000000000000000000000000000000000000000000000000000000000000002"
        )
    )

    # 3. %echo_callback with max uint256 (2**256 - 1), callback_count becomes 3
    max_u256 = (1 << 256) - 1
    canary.echo_callback(max_u256, _sender=caller.address)
    scenario.verify(canary.data.callback_count == 3)
    scenario.verify(
        gateway.data.last_data
        == sp.bytes(
            "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
            "0000000000000000000000000000000000000000000000000000000000000003"
        )
    )

    # 4. %echo_callback with 2**256 overflows uint256 cleanly
    canary.echo_callback(
        1 << 256,
        _sender=caller.address,
        _valid=False,
        _exception="UINT256_OVERFLOW",
    )
    scenario.verify(canary.data.callback_count == 3)

    # 5. get_state_digest reflects updated callback_count
    digest = canary.get_state_digest(77)
    scenario.verify(digest.ping_count == 0)
    scenario.verify(digest.callback_count == 3)
    scenario.verify(digest.echo == 77)

    # 6. probe_evm_staticcall invokes gateway's staticcall_evm view with (target, calldata)
    # Example calldata: selector for echoView(uint256) + uint256(7)
    sample_calldata = sp.bytes(
        "0x123456780000000000000000000000000000000000000000000000000000000000000007"
    )
    view_res = canary.probe_evm_staticcall(
        sp.record(target=PAIRED_EVM_ADDR, calldata=sample_calldata)
    )
    scenario.verify(view_res == staticcall_prefix + sample_calldata)

    # 7. probe_evm_staticcall fails cleanly when gateway view fails/returns None
    scenario.verify(
        sp.is_failing(
            canary.probe_evm_staticcall(
                sp.record(target="", calldata=sample_calldata)
            )
        )
    )
