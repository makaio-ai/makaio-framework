"""Behavioral conformance test runner for makaio-bus-protocol cases.json.

Each test function exercises one conformance case end-to-end using a real
``BusClient`` wired to a ``FakeWebSocket``.  The suite covers both:

- **Wire-only cases** (existing): server→client frames are pushed into the fake
  socket, client→server frames are verified in ``FakeWebSocket.sent``.
- **Local dispatch cases** (new): local handlers are registered, events or
  requests are dispatched in-process, and outcomes are checked directly.
- **Auth cases**: the HMAC challenge-response handshake wire sequence is
  simulated and the client's response is verified against the expected
  signature.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from _fakes import FakeWebSocket
from makaio import BusClient, EventContext, RequestContext
from makaio._auth import hmac_sign

CONFORMANCE_DIR = Path(__file__).resolve().parents[2] / "conformance"
CASES_FILE = CONFORMANCE_DIR / "cases.json"
FIXTURES_FILE = CONFORMANCE_DIR / "fixtures" / "messages.json"

# ---------------------------------------------------------------------------
# Auth secret used by the auth-challenge-response conformance fixture.
# Must match the secret used to pre-compute the fixture's "auth-response"
# signature in fixtures/messages.json.
# ---------------------------------------------------------------------------
_AUTH_CONFORMANCE_SECRET = "conformance-secret"


# ---------------------------------------------------------------------------
# Helpers: load conformance data
# ---------------------------------------------------------------------------


def _load_cases() -> list[dict]:
    """Load and return the list of conformance cases.

    @returns: Parsed list of case dicts from ``cases.json``.
    """
    return json.loads(CASES_FILE.read_text())["cases"]


def _load_messages() -> dict[str, dict]:
    """Load and return the fixture message map.

    @returns: Parsed dict of named message fixtures from ``fixtures/messages.json``.
    """
    return json.loads(FIXTURES_FILE.read_text())["messages"]


def _case(case_id: str) -> dict:
    """Look up one conformance case by id.

    @param case_id: The ``id`` field of the desired case.
    @returns: The matching case dict.
    @raises KeyError: If no case with that id is found.
    """
    for c in _load_cases():
        if c["id"] == case_id:
            return c
    raise KeyError(f"Conformance case not found: {case_id!r}")


def _msg(message_ref: str) -> dict:
    """Look up one fixture message by ref.

    @param message_ref: Key in the ``messages`` dict of ``messages.json``.
    @returns: The matching message fixture dict (a copy).
    """
    return dict(_load_messages()[message_ref])


def _ready_ws() -> FakeWebSocket:
    """Create a fake socket with the SDK readiness frame already queued."""
    ws = FakeWebSocket()
    ws.push(_msg("subscribe-sync-complete"))
    return ws


# ---------------------------------------------------------------------------
# Wire-only conformance cases
# ---------------------------------------------------------------------------


async def test_event_delivery_agent_complete() -> None:
    """Conformance: event-delivery-agent-complete.

    A concrete subscription receives an event on the same subject.
    """
    ws = _ready_ws()
    client = BusClient("ws://test", websocket_factory=lambda url: ws)
    received: list[EventContext] = []

    async def handler(ctx: EventContext) -> None:
        received.append(ctx)

    await client.connect()
    await client.subscribe("agent.complete", handler)
    await ws.wait_sent(1)

    ws.push(_msg("event.agent.complete"))

    deadline = asyncio.get_running_loop().time() + 2.0
    while not received and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.01)

    assert received, "handler was never called"
    ctx = received[0]
    assert ctx.subject == "agent.complete", f"unexpected subject: {ctx.subject!r}"
    assert ctx.payload == _msg("event.agent.complete")["payload"]

    await client.close()


async def test_request_response_correlation_approval_request() -> None:
    """Conformance: request-response-correlation-approval-request.

    A request and its response are bound by the same correlationId.
    """
    ws = _ready_ws()
    client = BusClient("ws://test", websocket_factory=lambda url: ws)
    await client.connect()

    request_fixture = _msg("request.approval.request")
    response_fixture = _msg("response.approval.request")
    expected_correlation_id = request_fixture["correlationId"]

    request_task = asyncio.create_task(
        client.request(
            "approval.request",
            request_fixture["payload"],
            timeout=request_fixture["timeout"],
            priority=request_fixture["priority"],
        )
    )

    sent_frame = await ws.wait_sent(1)
    assert sent_frame["type"] == "request"
    assert sent_frame["correlationId"] != expected_correlation_id, (
        "client should generate its own correlationId, not copy the fixture's"
    )

    ws.push({**response_fixture, "correlationId": sent_frame["correlationId"]})

    result = await asyncio.wait_for(request_task, timeout=2.0)
    assert result == response_fixture["result"]

    await client.close()


async def test_no_handler_response_tool_execute() -> None:
    """Conformance: no-handler-response-tool-execute.

    A request with no available handler returns a NO_HANDLER error.
    """
    ws = _ready_ws()
    client = BusClient("ws://test", websocket_factory=lambda url: ws)
    await client.connect()

    ws.push(_msg("request.tool.execute.no-handler"))

    response_frame = await ws.wait_sent(1)
    assert response_frame["type"] == "response"
    assert response_frame["error"]["code"] == "NO_HANDLER"
    assert response_frame["error"]["subject"] == "tool.execute"

    await client.close()


async def test_subscribe_replace_and_unsubscribe_approval_request() -> None:
    """Conformance: subscribe-replace-and-unsubscribe-approval-request.

    A second subscribe call replaces the current priority snapshot; closing
    one registration republishes remaining priorities; the final unsubscribe
    removes the subject.
    """
    ws = _ready_ws()
    client = BusClient("ws://test", websocket_factory=lambda url: ws)
    await client.connect()

    async def first_handler(ctx: RequestContext) -> None:
        ctx.set_result({"by": "first"})

    async def second_handler(ctx: RequestContext) -> None:
        ctx.set_result({"by": "second"})

    first = await client.on_request("approval.request", first_handler, priority=100)
    initial_frame = await ws.wait_sent(1)
    assert initial_frame == _msg("subscribe.approval.request.initial")

    second = await client.on_request("approval.request", second_handler, priority=250)
    updated_frame = await ws.wait_sent(2)
    assert updated_frame == _msg("subscribe.approval.request.updated")

    await first.close()
    remaining_frame = await ws.wait_sent(3)
    assert remaining_frame == _msg("subscribe.approval.request.remaining")

    await second.close()
    unsubscribe_frame = await ws.wait_sent(4)
    assert unsubscribe_frame == _msg("unsubscribe.approval.request")

    await client.close()


async def test_wildcard_subscriptions_agent_wildcard() -> None:
    """Conformance: wildcard-subscriptions-agent-wildcard.

    A wildcard subject pattern receives matching concrete subjects in the same
    namespace.
    """
    ws = _ready_ws()
    client = BusClient("ws://test", websocket_factory=lambda url: ws)
    received: list[EventContext] = []

    async def handler(ctx: EventContext) -> None:
        received.append(ctx)

    await client.connect()
    await client.subscribe("agent.*", handler)
    subscribe_frame = await ws.wait_sent(1)
    assert subscribe_frame == _msg("subscribe.agent.wildcard")

    ws.push(_msg("event.agent.complete"))

    deadline = asyncio.get_running_loop().time() + 2.0
    while not received and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.01)

    assert received, "wildcard handler was never called"
    ctx = received[0]
    assert ctx.subject == "agent.complete"
    assert ctx.payload == _msg("event.agent.complete")["payload"]

    await client.close()


async def test_reconnect_subscription_replay() -> None:
    """Conformance: reconnect-subscription-replay.

    Local subscriptions are replayed after reconnect; the transport-level sync
    handshake completes.
    """
    initial_ws = _ready_ws()
    reconnect_ws = _ready_ws()
    sockets = iter([initial_ws, reconnect_ws])
    client = BusClient("ws://test", websocket_factory=lambda url: next(sockets))
    await client.connect()

    async def event_handler(ctx: EventContext) -> None:
        pass

    async def request_handler(ctx: RequestContext) -> None:
        ctx.set_result({"ok": True})

    await client.subscribe("agent.*", event_handler)
    await client.on_request("approval.request", request_handler, priority=250)
    await initial_ws.wait_sent(2)

    await client.reconnect()

    replay_frame = await reconnect_ws.wait_sent(1)
    assert replay_frame["type"] == "subscribe"
    assert "agent.*" in replay_frame["subjects"]
    assert "approval.request" in replay_frame["subjects"]
    assert replay_frame["subjects"]["approval.request"] == [250]

    reconnect_ws.push(_msg("subscribe-sync-complete"))
    await asyncio.sleep(0.05)

    await client.close()


async def test_heartbeat_handling() -> None:
    """Conformance: heartbeat-handling.

    Heartbeat frames are transport-level keep-alives and are ignored by
    application dispatch.
    """
    ws = _ready_ws()
    client = BusClient("ws://test", websocket_factory=lambda url: ws)
    received: list[EventContext] = []

    async def handler(ctx: EventContext) -> None:
        received.append(ctx)

    await client.connect()
    await client.subscribe("agent.complete", handler)
    await ws.wait_sent(1)

    ws.push(_msg("heartbeat"))
    await asyncio.sleep(0.05)

    assert not received, "heartbeat must not be delivered to application handlers"

    await client.close()


async def test_broadcast_response_tool_execute() -> None:
    """Conformance: broadcast-response-tool-execute.

    Broadcast and broadcast-response frames are ignored by application dispatch.
    """
    ws = _ready_ws()
    client = BusClient("ws://test", websocket_factory=lambda url: ws)
    received: list[EventContext] = []

    async def handler(ctx: EventContext) -> None:
        received.append(ctx)

    await client.connect()
    await client.subscribe("tool.execute", handler)
    await ws.wait_sent(1)

    ws.push(_msg("broadcast.tool.execute"))
    ws.push(_msg("broadcast-response.tool.execute"))
    await asyncio.sleep(0.05)

    assert not received, "broadcast frames must not be delivered to application handlers"

    await client.close()


# ---------------------------------------------------------------------------
# New local dispatch conformance cases
# ---------------------------------------------------------------------------


async def test_local_request_dispatch() -> None:
    """Conformance: local-request-dispatch.

    A request is handled by a locally registered handler without any wire
    roundtrip.  The response comes from the local handler, not the server.
    """
    ws = _ready_ws()
    client = BusClient("ws://test", dispatch="local-first", websocket_factory=lambda url: ws)
    await client.connect()

    async def handler(ctx: RequestContext) -> None:
        ctx.set_result({"handled": True})

    await client.on_request("test.local", handler, priority=100)
    await ws.wait_sent(1)

    result = await client.request("test.local", {"query": "test"})

    assert result == {"handled": True}, f"unexpected result: {result!r}"

    request_frames = [f for f in ws.sent if f.get("type") == "request"]
    assert len(request_frames) == 0, (
        f"local dispatch must not send a wire request frame; sent: {ws.sent!r}"
    )

    await client.close()


async def test_local_request_priority_chain() -> None:
    """Conformance: local-request-priority-chain.

    Two local request handlers at different priorities.  Higher-priority
    handler calls next(); lower-priority handler sets the result.  The final
    result matches what the lower-priority handler set.
    """
    ws = _ready_ws()
    client = BusClient("ws://test", dispatch="local-first", websocket_factory=lambda url: ws)
    await client.connect()

    async def high_priority_handler(ctx: RequestContext) -> None:
        await ctx.next()

    async def low_priority_handler(ctx: RequestContext) -> None:
        ctx.set_result({"from": "low"})

    await client.on_request("test.chain", high_priority_handler, priority=100)
    await client.on_request("test.chain", low_priority_handler, priority=50)
    await ws.wait_sent(2)

    result = await client.request("test.chain", {})

    assert result == {"from": "low"}, f"unexpected result: {result!r}"

    await client.close()


async def test_local_event_parallel_dispatch() -> None:
    """Conformance: local-event-parallel-dispatch.

    An event delivered to multiple matching local handlers.  All handlers
    receive the event.
    """
    ws = _ready_ws()
    client = BusClient("ws://test", dispatch="local-first", websocket_factory=lambda url: ws)
    received: list[str] = []
    all_done = asyncio.Event()

    async def handler_a(ctx: EventContext) -> None:
        received.append("a")
        if len(received) == 2:
            all_done.set()

    async def handler_b(ctx: EventContext) -> None:
        received.append("b")
        if len(received) == 2:
            all_done.set()

    await client.connect()
    await client.subscribe("test.event.parallel", handler_a)
    await client.subscribe("test.event.parallel", handler_b)
    await ws.wait_sent(2)

    ws.push(
        {
            "type": "event",
            "namespace": "test",
            "subject": "event.parallel",
            "payload": {"seq": 1},
            "messageId": "evt-parallel-001",
        }
    )

    await asyncio.wait_for(all_done.wait(), timeout=2.0)
    assert sorted(received) == ["a", "b"], (
        f"expected both handlers to run, got: {received!r}"
    )

    await client.close()


async def test_local_wildcard_event_matching() -> None:
    """Conformance: local-wildcard-event-matching.

    A wildcard subscription (agent.*) receives an event on agent.complete,
    exercising the local wildcard matching path directly (no wire subscribe
    needed for the local match assertion).
    """
    ws = _ready_ws()
    client = BusClient("ws://test", dispatch="local-first", websocket_factory=lambda url: ws)
    received: list[EventContext] = []

    async def wildcard_handler(ctx: EventContext) -> None:
        received.append(ctx)

    await client.connect()
    await client.subscribe("agent.*", wildcard_handler)
    await ws.wait_sent(1)

    subscribe_frame = ws.sent[0]
    assert subscribe_frame == _msg("subscribe.agent.wildcard"), (
        f"unexpected subscribe frame: {subscribe_frame!r}"
    )

    ws.push(_msg("event.agent.complete"))

    deadline = asyncio.get_running_loop().time() + 2.0
    while not received and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.01)

    assert received, "wildcard handler was not called"
    ctx = received[0]
    assert ctx.subject == "agent.complete", f"unexpected subject: {ctx.subject!r}"

    await client.close()


async def test_auth_challenge_response() -> None:
    """Conformance: auth-challenge-response.

    HMAC auth handshake: server sends challenge, client responds with the
    HMAC-SHA256 signature of the nonce, server confirms with success=true.

    This test drives ``run_auth_handshake`` directly (the same path ``BusClient``
    uses internally) to verify the wire sequence matches the conformance fixture.
    """
    from makaio._auth import run_auth_handshake

    challenge_fixture = _msg("auth-challenge")
    response_fixture = _msg("auth-response")
    result_fixture = _msg("auth-result")

    sent: list[dict] = []
    recv_queue: asyncio.Queue[dict] = asyncio.Queue()

    async def _send(message: dict) -> None:
        sent.append(message)

    async def _recv() -> dict:
        return await recv_queue.get()

    recv_queue.put_nowait(challenge_fixture)
    recv_queue.put_nowait(result_fixture)

    await run_auth_handshake(_send, _recv, _AUTH_CONFORMANCE_SECRET)

    assert len(sent) == 1, f"expected exactly one auth-response frame, got {len(sent)}"
    assert sent[0]["type"] == "auth-response"

    expected_signature = hmac_sign(_AUTH_CONFORMANCE_SECRET, challenge_fixture["nonce"])
    assert sent[0]["signature"] == expected_signature, (
        f"signature mismatch: {sent[0]['signature']!r} != {expected_signature!r}"
    )
    assert sent[0]["signature"] == response_fixture["signature"], (
        "client signature must match the fixture's pre-computed signature"
    )

    assert result_fixture["success"] is True
