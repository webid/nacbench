import smartpy as sp

tstorage = sp.record(call_count = sp.nat, has_callback = sp.bool, last_data = sp.bytes, last_destination = sp.string, last_selector = sp.string, last_sender = sp.address, staticcall_response = sp.bytes).layout(("call_count", ("has_callback", ("last_data", ("last_destination", ("last_selector", ("last_sender", "staticcall_response")))))))
tparameter = sp.variant(call_evm = sp.record(callback = sp.option(sp.contract(sp.bytes)), data = sp.bytes, destination = sp.string, selector = sp.string).layout(("destination", ("selector", ("data", "callback"))))).layout("call_evm")
tprivates = { }
tviews = { "staticcall_evm": (sp.pair(sp.string, sp.bytes), sp.bytes) }
