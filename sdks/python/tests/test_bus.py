import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from makaio import BusClient, BusError, RequestTimeoutError
from makaio._dispatch import _subject_matches_pattern
from makaio.generated import agent, subjects
from makaio.generated.payloads.agent import (
    AgentSendMessageRequest,
    AgentSendMessageRequestSessionContext,
    AgentSendMessageResponse,
    AgentStartedPayload,
)
from makaio.types import EventContext, RequestContext

CONFORMANCE_DIR = Path(__file__).resolve().parents[2] / "conformance"


def conformance_cases():
    return json.loads((CONFORMANCE_DIR / "cases.json").read_text())["cases"]


def conformance_messages():
    return json.loads((CONFORMANCE_DIR / "fixtures" / "messages.json").read_text())["messages"]


def conformance_message(message_ref):
    return conformance_messages()[message_ref]


def assert_conformance_assertion_shape(case_id, assertion):
    kind = assertion.get("kind")
    if kind == "delivers":
        if not (isinstance(assertion.get("targets"), list) and assertion["targets"]):
            raise AssertionError(f"{case_id} delivers assertions must declare one or more targets")
        return
    if kind == "matches":
        if not isinstance(assertion.get("subject"), str):
            raise AssertionError(f"{case_id} matches assertions must declare a subject")
        pattern = assertion.get("pattern")
        if pattern is not None and not isinstance(pattern, str):
            raise AssertionError(f"{case_id} matches assertions must declare a string pattern")
        return
    if kind == "correlates":
        if not isinstance(assertion.get("correlationId"), str):
            raise AssertionError(f"{case_id} correlates assertions must declare a correlationId")
        return
    if kind == "error":
        if not isinstance(assertion.get("code"), str):
            raise AssertionError(f"{case_id} error assertions must declare a code")
        if not isinstance(assertion.get("subject"), str):
            raise AssertionError(f"{case_id} error assertions must declare a subject")
        return
    if kind == "replaces":
        if not isinstance(assertion.get("subject"), str):
            raise AssertionError(f"{case_id} replaces assertions must declare a subject")
        if not isinstance(assertion.get("priorities"), list):
            raise AssertionError(f"{case_id} replaces assertions must declare a priorities list")
        return
    if kind == "unsubscribes-when-empty":
        if not isinstance(assertion.get("subject"), str):
            raise AssertionError(f"{case_id} unsubscribes-when-empty assertions must declare a subject")
        return
    if kind == "replays":
        if not (isinstance(assertion.get("messages"), list) and assertion["messages"]):
            raise AssertionError(f"{case_id} replays assertions must declare replay message refs")
        return
    if kind == "handshake" or kind == "ignored":
        if not isinstance(assertion.get("messageRef"), str):
            raise AssertionError(f"{case_id} {kind} assertions must declare a messageRef")
        return
    if kind == "local-handled":
        if not isinstance(assertion.get("subject"), str):
            raise AssertionError(f"{case_id} local-handled assertions must declare a subject")
        return
    if kind == "result-matches":
        if not isinstance(assertion.get("subject"), str):
            raise AssertionError(f"{case_id} result-matches assertions must declare a subject")
        if "expected" not in assertion:
            raise AssertionError(f"{case_id} result-matches assertions must declare an expected value")
        return
    if kind == "all-received":
        if not isinstance(assertion.get("subject"), str):
            raise AssertionError(f"{case_id} all-received assertions must declare a subject")
        if not isinstance(assertion.get("handlerCount"), int):
            raise AssertionError(f"{case_id} all-received assertions must declare handlerCount")
        return
    if kind == "auth-handshake":
        if not isinstance(assertion.get("challengeRef"), str):
            raise AssertionError(f"{case_id} auth-handshake assertions must declare a challengeRef")
        if not isinstance(assertion.get("responseRef"), str):
            raise AssertionError(f"{case_id} auth-handshake assertions must declare a responseRef")
        if not isinstance(assertion.get("resultRef"), str):
            raise AssertionError(f"{case_id} auth-handshake assertions must declare a resultRef")
        return
    raise AssertionError(f"{case_id} declares unsupported assertion kind {kind!r}")


class FakeWebSocket:
    def __init__(self, *, auto_sync_complete=True):
        self.sent = []
        self.incoming = asyncio.Queue()
        self.closed = False
        if auto_sync_complete:
            self.push({"type": "subscribe-sync-complete"})

    async def send(self, message):
        self.sent.append(json.loads(message))

    async def recv(self):
        message = await self.incoming.get()
        if isinstance(message, Exception):
            raise message
        return message

    async def close(self):
        self.closed = True

    async def receive(self, message):
        await self.incoming.put(json.dumps(message))

    def push(self, message):
        self.incoming.put_nowait(json.dumps(message))

    async def receive_raw(self, message):
        """Queue a raw inbound frame without JSON serialization."""

        await self.incoming.put(message)

    async def wait_sent(self, count, *, timeout=2.0, interval=0.01):
        """Wait for a specific number of outbound frames and return the last one."""

        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            if len(self.sent) >= count:
                return self.sent[count - 1]
            await asyncio.sleep(interval)
        if len(self.sent) >= count:
            return self.sent[count - 1]
        raise AssertionError(f"expected {count} sent messages, got {len(self.sent)}")


class FailingSendWebSocket(FakeWebSocket):
    async def send(self, message):
        self.sent.append(json.loads(message))
        raise RuntimeError("send failed")


class FailingCloseWebSocket(FakeWebSocket):
    async def close(self):
        self.closed = True
        raise RuntimeError("close failed")


class MemoryLineReader:
    def __init__(self):
        self.lines = asyncio.Queue()

    async def readline(self):
        return await self.lines.get()

    def push(self, message):
        self.lines.put_nowait(json.dumps(message).encode("utf-8") + b"\n")


class MemoryLineWriter:
    def __init__(self):
        self.frames = []
        self.closed = False

    def write(self, data):
        self.frames.append(data)

    async def drain(self):
        pass

    def close(self):
        self.closed = True


class RequestGateBusClient(BusClient):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.request_send_started = asyncio.Event()
        self.release_request_send = asyncio.Event()

    async def _send(self, message):
        if message.get("type") == "request":
            self.request_send_started.set()
            await self.release_request_send.wait()
        await super()._send(message)


class ConformanceFixtureTest(unittest.TestCase):
    def test_all_conformance_message_refs_resolve(self):
        messages = conformance_messages()

        for case in conformance_cases():
            for wire_entry in case["wire"]:
                with self.subTest(case=case["id"], message_ref=wire_entry["messageRef"]):
                    self.assertIn(wire_entry["messageRef"], messages)

    def test_all_conformance_assertions_are_supported(self):
        messages = conformance_messages()

        for case in conformance_cases():
            for assertion in case["assertions"]:
                with self.subTest(case=case["id"], kind=assertion["kind"]):
                    assert_conformance_assertion_shape(case["id"], assertion)
                    message_ref = assertion.get("messageRef")
                    if isinstance(message_ref, str):
                        self.assertIn(message_ref, messages)
                    for replay_ref in assertion.get("messages", []):
                        self.assertIn(replay_ref, messages)
                    for ref_key in ("challengeRef", "responseRef", "resultRef"):
                        auth_ref = assertion.get(ref_key)
                        if isinstance(auth_ref, str):
                            self.assertIn(auth_ref, messages)


class SubjectPatternTest(unittest.TestCase):
    # Note: _subject_matches_pattern from _dispatch uses (subject, pattern) order.
    def test_dot_wildcard_matches_subject_prefixes(self):
        self.assertTrue(_subject_matches_pattern("agent.started", "agent.*"))
        self.assertTrue(_subject_matches_pattern("agent.contextWindow.updated", "agent.*"))
        self.assertFalse(_subject_matches_pattern("agent:worker.started", "agent.*"))

    def test_colon_wildcard_matches_child_namespace_prefixes(self):
        self.assertTrue(_subject_matches_pattern("tool.execute:remote", "tool.execute:*"))
        self.assertTrue(_subject_matches_pattern("adapter:claudeCode:sdk.thinking", "adapter:*"))
        self.assertFalse(_subject_matches_pattern("adapter.initialized", "adapter:*"))


class BusClientTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.websocket = FakeWebSocket()
        self.client = BusClient("ws://test", websocket_factory=lambda url: self.websocket)
        await self.client.connect()

    async def asyncTearDown(self):
        await self.client.close()

    async def test_event_subscribe_and_emit_framing(self):
        received = asyncio.Future()

        async def handler(ctx: EventContext):
            received.set_result((ctx.payload, ctx.message))

        await self.client.subscribe(subjects.AGENT_STARTED, handler)

        subscribe_frame = await self.websocket.wait_sent(1)
        self.assertEqual(subscribe_frame, {"type": "subscribe", "subjects": {subjects.AGENT_STARTED: []}})

        await self.client.emit(subjects.AGENT_STARTED, {"agentId": "agent-1"})
        payload, message = await asyncio.wait_for(received, timeout=1)
        self.assertEqual(payload, {"agentId": "agent-1"})
        self.assertEqual(message["type"], "event")

        received = asyncio.Future()
        event_frame = await self.websocket.wait_sent(2)
        self.assertEqual(event_frame["type"], "event")
        self.assertEqual(event_frame["namespace"], "agent")
        self.assertEqual(event_frame["subject"], "started")
        self.assertEqual(event_frame["payload"], {"agentId": "agent-1"})
        self.assertIsInstance(event_frame["messageId"], str)

        await self.websocket.receive(
            {
                "type": "event",
                "namespace": "agent",
                "subject": "started",
                "payload": {"agentId": "agent-2"},
                "messageId": "message-1",
            },
        )

        payload, message = await asyncio.wait_for(received, timeout=1)
        self.assertEqual(payload, {"agentId": "agent-2"})
        self.assertEqual(message["messageId"], "message-1")

    async def test_typed_event_subject_serializes_and_deserializes_payload(self):
        received = asyncio.Future()

        async def handler(ctx: EventContext):
            received.set_result(ctx.payload)

        await self.client.subscribe(agent.started, handler)
        await self.websocket.wait_sent(1)

        payload = AgentStartedPayload(
            adapter_id="adapter-1",
            adapter_name="test",
            adapter_session_id="adapter-session-1",
            agent_id="agent-1",
            cwd=None,
            model=None,
        )
        await self.client.emit(agent.started, payload)

        local_payload = await asyncio.wait_for(received, timeout=1)
        self.assertEqual(local_payload, payload)

        event_frame = await self.websocket.wait_sent(2)
        self.assertEqual(
            event_frame["payload"],
            {
                "adapterId": "adapter-1",
                "adapterName": "test",
                "adapterSessionId": "adapter-session-1",
                "agentId": "agent-1",
            },
        )

        received = asyncio.Future()
        await self.websocket.receive(
            {
                "type": "event",
                "namespace": "agent",
                "subject": "started",
                "payload": {
                    "adapterId": "adapter-2",
                    "adapterName": "test",
                    "adapterSessionId": "adapter-session-2",
                    "agentId": "agent-2",
                    "cwd": "/tmp/project",
                    "model": "test-model",
                },
                "messageId": "message-typed",
            },
        )

        inbound_payload = await asyncio.wait_for(received, timeout=1)
        self.assertEqual(
            inbound_payload,
            AgentStartedPayload(
                adapter_id="adapter-2",
                adapter_name="test",
                adapter_session_id="adapter-session-2",
                agent_id="agent-2",
                cwd="/tmp/project",
                model="test-model",
            ),
        )

    async def test_request_response_correlation(self):
        request_task = asyncio.create_task(self.client.request(subjects.TOOL_LIST, {"scope": "workspace"}))

        request_frame = await self.websocket.wait_sent(1)
        self.assertEqual(request_frame["type"], "request")
        self.assertEqual(request_frame["namespace"], "tool")
        self.assertEqual(request_frame["subject"], "list")
        self.assertEqual(request_frame["payload"], {"scope": "workspace"})
        self.assertIsInstance(request_frame["correlationId"], str)

        await self.websocket.receive(
            {
                "type": "response",
                "correlationId": request_frame["correlationId"],
                "result": {"tools": []},
            },
        )

        self.assertEqual(await asyncio.wait_for(request_task, timeout=1), {"tools": []})

    async def test_typed_request_subject_serializes_payload_and_deserializes_response(self):
        payload = AgentSendMessageRequest(
            adapter_id="adapter-1",
            agent_id="agent-1",
            message={"role": "user", "content": "hello"},
            session_context=AgentSendMessageRequestSessionContext(is_first_turn=True),
        )
        request_task = asyncio.create_task(self.client.request(agent.send_message, payload))

        request_frame = await self.websocket.wait_sent(1)
        self.assertEqual(request_frame["type"], "request")
        self.assertEqual(request_frame["namespace"], "agent")
        self.assertEqual(request_frame["subject"], "sendMessage")
        self.assertEqual(
            request_frame["payload"],
            {
                "adapterId": "adapter-1",
                "agentId": "agent-1",
                "message": {"role": "user", "content": "hello"},
                "sessionContext": {"isFirstTurn": True},
            },
        )

        await self.websocket.receive(
            {
                "type": "response",
                "correlationId": request_frame["correlationId"],
                "result": {"messageId": "message-1"},
            },
        )

        self.assertEqual(
            await asyncio.wait_for(request_task, timeout=1),
            AgentSendMessageResponse(message_id="message-1"),
        )

    async def test_local_first_typed_request_deserializes_local_dict_response(self):
        async def handler(ctx: RequestContext):
            ctx.set_result({"messageId": "message-local"})

        await self.client.on_request(agent.send_message, handler)
        await self.websocket.wait_sent(1)

        payload = AgentSendMessageRequest(
            adapter_id="adapter-1",
            agent_id="agent-1",
            message={"role": "user", "content": "hello"},
        )

        result = await self.client.request(agent.send_message, payload)

        self.assertEqual(result, AgentSendMessageResponse(message_id="message-local"))

    async def test_request_wire_propagates_timeout_priority_and_deadline(self):
        request_task = asyncio.create_task(
            self.client.request(
                subjects.TOOL_LIST,
                {"scope": "workspace"},
                timeout=15,
                priority=250,
                deadline=1234567890,
                timeout_ms=1000,
            ),
        )

        request_frame = await self.websocket.wait_sent(1)
        self.assertEqual(request_frame["type"], "request")
        self.assertEqual(request_frame["namespace"], "tool")
        self.assertEqual(request_frame["subject"], "list")
        self.assertEqual(request_frame["payload"], {"scope": "workspace"})
        self.assertEqual(request_frame["timeout"], 15)
        self.assertEqual(request_frame["priority"], 250)
        self.assertEqual(request_frame["deadline"], 1234567890)
        self.assertIsInstance(request_frame["correlationId"], str)
        self.assertIsInstance(request_frame["messageId"], str)
        self.assertNotIn("timeout_ms", request_frame)

        await self.websocket.receive(
            {
                "type": "response",
                "correlationId": request_frame["correlationId"],
                "result": {"tools": []},
            },
        )

        self.assertEqual(await asyncio.wait_for(request_task, timeout=1), {"tools": []})

    async def test_request_timeout_raises_sdk_timeout_error(self):
        request_task = asyncio.create_task(
            self.client.request(subjects.TOOL_LIST, {"scope": "workspace"}, timeout_ms=10),
        )

        request_frame = await self.websocket.wait_sent(1)
        self.assertEqual(request_frame["type"], "request")

        with self.assertRaises(RequestTimeoutError) as raised:
            await asyncio.wait_for(request_task, timeout=1)

        self.assertEqual(raised.exception.subject, subjects.TOOL_LIST)
        self.assertEqual(raised.exception.timeout_ms, 10)

    async def test_local_first_request_timeout_covers_local_handler(self):
        started = asyncio.Event()

        async def blocking_handler(ctx: RequestContext):
            started.set()
            await asyncio.Future()

        await self.client.on_request(subjects.TOOL_EXECUTE, blocking_handler, priority=100)
        await self.websocket.wait_sent(1)

        with self.assertRaises(RequestTimeoutError) as raised:
            await self.client.request(subjects.TOOL_EXECUTE, {"toolId": "local"}, timeout_ms=10)

        await asyncio.wait_for(started.wait(), timeout=1)
        self.assertEqual(raised.exception.subject, subjects.TOOL_EXECUTE)
        self.assertEqual(len(self.websocket.sent), 1)

    async def test_transport_drop_resets_connection_and_fails_pending_request(self):
        request_task = asyncio.create_task(self.client.request(subjects.TOOL_LIST, {"scope": "workspace"}))
        await self.websocket.wait_sent(1)

        await self.websocket.incoming.put(RuntimeError("connection dropped"))

        with self.assertRaises(BusError) as raised:
            await asyncio.wait_for(request_task, timeout=1)

        self.assertEqual(raised.exception.code, "CONNECTION_CLOSED")
        self.assertTrue(self.websocket.closed)
        with self.assertRaisesRegex(RuntimeError, "not connected"):
            await self.client.emit(subjects.AGENT_STARTED, {"agentId": "agent-1"})

    async def test_request_error_raises_bus_error(self):
        request_task = asyncio.create_task(self.client.request(subjects.TOOL_EXECUTE, {"toolId": "missing"}))
        request_frame = await self.websocket.wait_sent(1)

        await self.websocket.receive(
            {
                "type": "response",
                "correlationId": request_frame["correlationId"],
                "error": {
                    "message": "No handler",
                    "code": "NO_HANDLER",
                    "subject": subjects.TOOL_EXECUTE,
                },
            },
        )

        with self.assertRaises(BusError) as raised:
            await asyncio.wait_for(request_task, timeout=1)

        self.assertEqual(raised.exception.code, "NO_HANDLER")
        self.assertEqual(raised.exception.subject, subjects.TOOL_EXECUTE)

    async def test_malformed_inbound_frame_closes_connection_and_fails_pending_request(self):
        request_task = asyncio.create_task(self.client.request(subjects.TOOL_LIST, {"scope": "workspace"}))
        await self.websocket.wait_sent(1)

        with self.assertLogs("makaio.bus", level="ERROR") as logs:
            await self.websocket.receive_raw("{")

            with self.assertRaises(BusError) as raised:
                await asyncio.wait_for(request_task, timeout=1)

        self.assertEqual(raised.exception.code, "CONNECTION_CLOSED")
        self.assertTrue(self.websocket.closed)
        self.assertIn("Makaio bus connection received an invalid frame", logs.output[0])

    async def test_close_failure_still_fails_pending_request(self):
        failing_websocket = FailingCloseWebSocket()
        client = BusClient("ws://test", websocket_factory=lambda url: failing_websocket)
        await client.connect()

        request_task = asyncio.create_task(client.request(subjects.TOOL_LIST, {"scope": "workspace"}))
        await failing_websocket.wait_sent(1)

        with self.assertRaisesRegex(RuntimeError, "close failed"):
            await client.close()

        with self.assertRaises(BusError) as raised:
            await asyncio.wait_for(request_task, timeout=1)

        self.assertEqual(raised.exception.code, "CONNECTION_CLOSED")
        self.assertTrue(failing_websocket.closed)

    async def test_reconnect_replays_local_subscriptions_and_fails_pending_request(self):
        initial_websocket = FakeWebSocket()
        reconnect_websocket = FakeWebSocket()
        websockets = iter((initial_websocket, reconnect_websocket))
        client = BusClient("ws://test", websocket_factory=lambda url: next(websockets))
        await client.connect()

        received = asyncio.Future()

        async def event_handler(ctx: EventContext):
            received.set_result(ctx.payload)

        async def request_handler(ctx: RequestContext):
            ctx.set_result({"approved": True, "toolName": ctx.payload.get("toolName")})

        await client.subscribe(subjects.AGENT_STARTED, event_handler)
        await client.on_request(subjects.APPROVAL_REQUEST, request_handler, priority=100)

        pending_request = asyncio.create_task(client.request(subjects.TOOL_LIST, {"scope": "workspace"}))
        await initial_websocket.wait_sent(3)

        await client.reconnect()

        with self.assertRaises(BusError) as raised:
            await asyncio.wait_for(pending_request, timeout=1)

        self.assertEqual(raised.exception.code, "CONNECTION_CLOSED")
        self.assertTrue(initial_websocket.closed)
        self.assertEqual(
            reconnect_websocket.sent,
            [
                {
                    "type": "subscribe",
                    "subjects": {
                        subjects.AGENT_STARTED: [],
                        subjects.APPROVAL_REQUEST: [100],
                    },
                }
            ],
        )

        await reconnect_websocket.receive(
            {
                "type": "event",
                "namespace": "agent",
                "subject": "started",
                "payload": {"agentId": "agent-2"},
                "messageId": "message-reconnected-event",
            },
        )
        self.assertEqual(await asyncio.wait_for(received, timeout=1), {"agentId": "agent-2"})

        await reconnect_websocket.receive(
            {
                "type": "request",
                "namespace": "approval",
                "subject": "request",
                "payload": {"toolName": "example.echo"},
                "correlationId": "incoming-reconnect",
                "messageId": "message-reconnected-request",
                "priority": 250,
            },
        )
        response_frame = await reconnect_websocket.wait_sent(2)
        self.assertEqual(
            response_frame,
            {
                "type": "response",
                "correlationId": "incoming-reconnect",
                "result": {"approved": True, "toolName": "example.echo"},
            },
        )

        await client.close()

    async def test_transport_drop_leaves_client_reconnectable(self):
        initial_websocket = FakeWebSocket()
        reconnect_websocket = FakeWebSocket()
        websockets = iter((initial_websocket, reconnect_websocket))
        client = BusClient("ws://test", websocket_factory=lambda url: next(websockets))
        await client.connect()
        await client.subscribe(subjects.AGENT_STARTED, lambda ctx: None)
        await initial_websocket.wait_sent(1)

        initial_websocket.incoming.put_nowait(RuntimeError("socket dropped"))
        await asyncio.sleep(0.05)

        await client.reconnect()

        self.assertEqual(
            reconnect_websocket.sent,
            [{"type": "subscribe", "subjects": {subjects.AGENT_STARTED: []}}],
        )
        await client.close()

    async def test_auto_reconnect_replays_local_subscriptions_after_transport_drop(self):
        initial_websocket = FakeWebSocket()
        reconnect_websocket = FakeWebSocket()
        websockets = iter((initial_websocket, reconnect_websocket))
        client = BusClient(
            "ws://test",
            auto_reconnect=True,
            websocket_factory=lambda url: next(websockets),
        )
        await client.connect()
        await client.subscribe(subjects.AGENT_STARTED, lambda ctx: None)
        await initial_websocket.wait_sent(1)

        initial_websocket.incoming.put_nowait(RuntimeError("socket dropped"))
        await reconnect_websocket.wait_sent(1)

        self.assertEqual(
            reconnect_websocket.sent,
            [{"type": "subscribe", "subjects": {subjects.AGENT_STARTED: []}}],
        )
        await client.close()

    async def test_local_first_fallthrough_sends_next_priority_cursor(self):
        async def high_handler(ctx: RequestContext):
            await ctx.next()

        async def low_handler(ctx: RequestContext):
            pass

        await self.client.on_request(subjects.TOOL_EXECUTE, high_handler, priority=100)
        await self.client.on_request(subjects.TOOL_EXECUTE, low_handler, priority=50)
        await self.websocket.wait_sent(2)

        request_task = asyncio.create_task(self.client.request(subjects.TOOL_EXECUTE, {"toolId": "remote"}))
        request_frame = await self.websocket.wait_sent(3)

        self.assertEqual(request_frame["type"], "request")
        self.assertEqual(request_frame["priority"], 50)

        await self.websocket.receive(
            {
                "type": "response",
                "correlationId": request_frame["correlationId"],
                "result": {"handledBy": "remote"},
            },
        )
        self.assertEqual(await asyncio.wait_for(request_task, timeout=1), {"handledBy": "remote"})

    async def test_remote_dispatch_sends_wire_request_when_local_handler_exists(self):
        websocket = FakeWebSocket()
        client = BusClient("ws://test", dispatch="remote", websocket_factory=lambda url: websocket)
        await client.connect()

        async def handler(ctx: RequestContext):
            ctx.set_result({"handledBy": "local"})

        await client.on_request(subjects.TOOL_EXECUTE, handler, priority=100)
        await websocket.wait_sent(1)

        request_task = asyncio.create_task(client.request(subjects.TOOL_EXECUTE, {"toolId": "remote"}))
        request_frame = await websocket.wait_sent(2)
        self.assertEqual(request_frame["type"], "request")
        self.assertNotIn("priority", request_frame)

        await websocket.receive(
            {
                "type": "response",
                "correlationId": request_frame["correlationId"],
                "result": {"handledBy": "remote"},
            },
        )

        self.assertEqual(await asyncio.wait_for(request_task, timeout=1), {"handledBy": "remote"})
        await client.close()

    async def test_remote_dispatch_emit_skips_local_event_handlers(self):
        websocket = FakeWebSocket()
        client = BusClient("ws://test", dispatch="remote", websocket_factory=lambda url: websocket)
        await client.connect()
        received = asyncio.Event()

        await client.subscribe(subjects.AGENT_STARTED, lambda ctx: received.set())
        await websocket.wait_sent(1)

        await client.emit(subjects.AGENT_STARTED, {"agentId": "agent-1"})
        event_frame = await websocket.wait_sent(2)

        self.assertEqual(event_frame["type"], "event")
        self.assertFalse(received.is_set())
        await client.close()

    async def test_request_send_stays_bound_to_original_socket_during_reconnect(self):
        initial_websocket = FakeWebSocket()
        reconnect_websocket = FakeWebSocket()
        websockets = iter((initial_websocket, reconnect_websocket))
        client = RequestGateBusClient("ws://test", websocket_factory=lambda url: next(websockets))
        await client.connect()

        request_task = asyncio.create_task(client.request(subjects.TOOL_LIST, {"scope": "workspace"}))
        await asyncio.wait_for(client.request_send_started.wait(), timeout=1)

        reconnect_task = asyncio.create_task(client.reconnect())
        await asyncio.sleep(0.05)
        self.assertFalse(reconnect_task.done())

        client.release_request_send.set()

        request_frame = await initial_websocket.wait_sent(1)
        self.assertEqual(request_frame["type"], "request")
        self.assertEqual(reconnect_websocket.sent, [])

        await asyncio.wait_for(reconnect_task, timeout=1)

        with self.assertRaises(BusError) as raised:
            await asyncio.wait_for(request_task, timeout=1)

        self.assertEqual(raised.exception.code, "CONNECTION_CLOSED")
        self.assertTrue(initial_websocket.closed)
        self.assertEqual(reconnect_websocket.sent, [])

        await client.close()

    async def test_stale_socket_close_signal_does_not_clear_reconnected_connection(self):
        initial_websocket = FakeWebSocket()
        reconnect_websocket = FakeWebSocket()
        websockets = iter((initial_websocket, reconnect_websocket))
        client = BusClient("ws://test", websocket_factory=lambda url: next(websockets))
        await client.connect()
        await client.subscribe(subjects.AGENT_STARTED, lambda ctx: None)
        await initial_websocket.wait_sent(1)

        initial_transport = client._transport
        await client.reconnect()
        self.assertEqual(
            reconnect_websocket.sent,
            [{"type": "subscribe", "subjects": {subjects.AGENT_STARTED: []}}],
        )

        await client._mark_connection_closed("stale socket closed", transport=initial_transport)

        await client.emit(subjects.AGENT_STARTED, {"agentId": "agent-3"})
        event_frame = await reconnect_websocket.wait_sent(2)
        self.assertEqual(event_frame["type"], "event")

        await client.close()

    async def test_request_and_request_handler_reject_wildcards(self):
        async def handler(ctx: RequestContext):
            ctx.set_result(None)

        for subject in ("*", "agent.*", "adapter:*"):
            with self.subTest(operation="emit", subject=subject):
                with self.assertRaisesRegex(ValueError, "exact"):
                    await self.client.emit(subject, {})

            with self.subTest(operation="request", subject=subject):
                with self.assertRaisesRegex(ValueError, "exact"):
                    await self.client.request(subject, {})

            with self.subTest(operation="on_request", subject=subject):
                with self.assertRaisesRegex(ValueError, "exact"):
                    await self.client.on_request(subject, handler)

        self.assertEqual(self.websocket.sent, [])

    async def test_subscribe_rejects_unsupported_wildcard_shapes(self):
        async def handler(ctx: EventContext):
            pass

        for subject in ("agent.*.updated", "tool.ex*ecute", "adapter:**", "**"):
            with self.subTest(subject=subject):
                with self.assertRaisesRegex(ValueError, "subscription patterns"):
                    await self.client.subscribe(subject, handler)

        self.assertEqual(self.websocket.sent, [])

    async def test_slow_event_handler_does_not_block_response_processing(self):
        handler_started = asyncio.Event()
        release_handler = asyncio.Event()
        handler_finished = asyncio.Event()

        async def blocking_handler(ctx: EventContext):
            handler_started.set()
            await release_handler.wait()
            handler_finished.set()

        await self.client.subscribe(subjects.AGENT_STARTED, blocking_handler)
        await self.websocket.wait_sent(1)

        request_task = asyncio.create_task(self.client.request(subjects.TOOL_LIST, {"scope": "workspace"}))
        request_frame = await self.websocket.wait_sent(2)

        await self.websocket.receive(
            {
                "type": "event",
                "namespace": "agent",
                "subject": "started",
                "payload": {"agentId": "agent-1"},
                "messageId": "message-1",
            },
        )
        await asyncio.wait_for(handler_started.wait(), timeout=1)

        await self.websocket.receive(
            {
                "type": "response",
                "correlationId": request_frame["correlationId"],
                "result": {"tools": []},
            },
        )

        self.assertEqual(await asyncio.wait_for(request_task, timeout=1), {"tools": []})
        self.assertFalse(handler_finished.is_set())

        release_handler.set()
        await asyncio.wait_for(handler_finished.wait(), timeout=1)

    async def test_slow_request_handler_does_not_block_response_processing(self):
        handler_started = asyncio.Event()
        release_handler = asyncio.Event()

        async def blocking_handler(ctx: RequestContext):
            handler_started.set()
            await release_handler.wait()
            ctx.set_result({"ok": True})

        await self.client.on_request(subjects.TOOL_EXECUTE, blocking_handler, priority=10)
        await self.websocket.wait_sent(1)

        request_task = asyncio.create_task(self.client.request(subjects.TOOL_LIST, {"scope": "workspace"}))
        request_frame = await self.websocket.wait_sent(2)

        await self.websocket.receive(
            {
                "type": "request",
                "namespace": "tool",
                "subject": "execute",
                "payload": {"toolId": "tool-1"},
                "correlationId": "incoming-1",
                "messageId": "message-1",
            },
        )
        await asyncio.wait_for(handler_started.wait(), timeout=1)

        await self.websocket.receive(
            {
                "type": "response",
                "correlationId": request_frame["correlationId"],
                "result": {"tools": []},
            },
        )

        self.assertEqual(await asyncio.wait_for(request_task, timeout=1), {"tools": []})

        release_handler.set()
        response_frame = await self.websocket.wait_sent(3)
        self.assertEqual(response_frame, {"type": "response", "correlationId": "incoming-1", "result": {"ok": True}})

    async def test_close_cancels_background_event_handlers(self):
        handler_started = asyncio.Event()
        handler_cancelled = asyncio.Event()

        async def blocking_handler(ctx: EventContext):
            handler_started.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                handler_cancelled.set()
                raise

        await self.client.subscribe(subjects.AGENT_STARTED, blocking_handler)
        await self.websocket.wait_sent(1)

        await self.websocket.receive(
            {
                "type": "event",
                "namespace": "agent",
                "subject": "started",
                "payload": {"agentId": "agent-1"},
                "messageId": "message-1",
            },
        )
        await asyncio.wait_for(handler_started.wait(), timeout=1)

        await self.client.close()
        await asyncio.wait_for(handler_cancelled.wait(), timeout=1)

    async def test_close_cancels_background_request_handlers(self):
        handler_started = asyncio.Event()
        handler_cancelled = asyncio.Event()

        async def blocking_handler(ctx: RequestContext):
            handler_started.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                handler_cancelled.set()
                raise

        await self.client.on_request(subjects.TOOL_EXECUTE, blocking_handler, priority=10)
        await self.websocket.wait_sent(1)

        await self.websocket.receive(
            {
                "type": "request",
                "namespace": "tool",
                "subject": "execute",
                "payload": {"toolId": "tool-1"},
                "correlationId": "incoming-1",
                "messageId": "message-1",
            },
        )
        await asyncio.wait_for(handler_started.wait(), timeout=1)

        await self.client.close()
        await asyncio.wait_for(handler_cancelled.wait(), timeout=1)
        self.assertEqual(len(self.websocket.sent), 1)

    async def test_no_handler_request_response(self):
        await self.websocket.receive(conformance_message("request.tool.execute.no-handler"))

        response_frame = await self.websocket.wait_sent(1)
        self.assertEqual(response_frame, conformance_message("response.tool.execute.no-handler"))

    async def test_subscribe_replace_semantics_and_unsubscribe(self):
        async def first_handler(ctx: RequestContext):
            ctx.set_result({"handledBy": "first"})

        async def second_handler(ctx: RequestContext):
            ctx.set_result({"handledBy": "second"})

        first = await self.client.on_request(subjects.TOOL_EXECUTE, first_handler, priority=10)
        first_subscribe = await self.websocket.wait_sent(1)
        self.assertEqual(first_subscribe, {"type": "subscribe", "subjects": {subjects.TOOL_EXECUTE: [10]}})

        second = await self.client.on_request(subjects.TOOL_EXECUTE, second_handler, priority=5)
        second_subscribe = await self.websocket.wait_sent(2)
        self.assertEqual(second_subscribe, {"type": "subscribe", "subjects": {subjects.TOOL_EXECUTE: [10, 5]}})

        await first.close()
        replacement_subscribe = await self.websocket.wait_sent(3)
        self.assertEqual(replacement_subscribe, {"type": "subscribe", "subjects": {subjects.TOOL_EXECUTE: [5]}})

        await second.close()
        unsubscribe_frame = await self.websocket.wait_sent(4)
        self.assertEqual(unsubscribe_frame, {"type": "unsubscribe", "subjects": {subjects.TOOL_EXECUTE: [5]}})

    async def test_heartbeat_is_ignored(self):
        received = asyncio.Future()

        async def handler(ctx: EventContext):
            received.set_result(ctx.payload)

        await self.client.subscribe(subjects.AGENT_COMPLETE, handler)
        await self.websocket.wait_sent(1)

        await self.websocket.receive(conformance_message("heartbeat"))
        await asyncio.sleep(0.05)

        self.assertFalse(received.done())
        self.assertEqual(len(self.websocket.sent), 1)

    async def test_broadcast_and_broadcast_response_are_silently_ignored(self):
        received = asyncio.Future()

        async def handler(ctx: EventContext):
            received.set_result(ctx.payload)

        await self.client.subscribe(subjects.TOOL_EXECUTE, handler)
        await self.websocket.wait_sent(1)

        await self.websocket.receive(conformance_message("broadcast.tool.execute"))
        await self.websocket.receive(conformance_message("broadcast-response.tool.execute"))
        await asyncio.sleep(0.05)

        self.assertFalse(received.done())

    async def test_wildcard_agent_event_subscription(self):
        received = asyncio.Future()

        async def handler(ctx: EventContext):
            received.set_result((ctx.payload, ctx.message))

        await self.client.subscribe("agent.*", handler)
        subscribe_frame = await self.websocket.wait_sent(1)
        self.assertEqual(subscribe_frame, conformance_message("subscribe.agent.wildcard"))

        await self.websocket.receive(conformance_message("event.agent.complete"))

        payload, message = await asyncio.wait_for(received, timeout=1)
        self.assertEqual(payload, conformance_message("event.agent.complete")["payload"])
        self.assertEqual(message["subject"], "complete")

    async def test_global_and_namespace_wildcard_event_subscriptions_match_events(self):
        received = []
        seen = asyncio.Event()

        async def global_handler(ctx: EventContext):
            received.append(("global", ctx.message["namespace"], ctx.message["subject"], ctx.payload))
            if len(received) == 3:
                seen.set()

        async def adapter_handler(ctx: EventContext):
            received.append(("adapter", ctx.message["namespace"], ctx.message["subject"], ctx.payload))
            if len(received) == 3:
                seen.set()

        await self.client.subscribe("*", global_handler)
        first_subscribe = await self.websocket.wait_sent(1)
        self.assertEqual(first_subscribe, {"type": "subscribe", "subjects": {"*": []}})

        await self.client.subscribe("adapter:*", adapter_handler)
        second_subscribe = await self.websocket.wait_sent(2)
        self.assertEqual(second_subscribe, {"type": "subscribe", "subjects": {"*": [], "adapter:*": []}})

        await self.websocket.receive(
            {
                "type": "event",
                "namespace": "adapter:claudeCode",
                "subject": "initialized",
                "payload": {"adapterId": "adapter-1"},
                "messageId": "message-1",
            },
        )
        await self.websocket.receive(
            {
                "type": "event",
                "namespace": "tool",
                "subject": "list",
                "payload": {"scope": "workspace"},
                "messageId": "message-2",
            },
        )

        await asyncio.wait_for(seen.wait(), timeout=1)
        self.assertEqual(
            received,
            [
                ("global", "adapter:claudeCode", "initialized", {"adapterId": "adapter-1"}),
                ("adapter", "adapter:claudeCode", "initialized", {"adapterId": "adapter-1"}),
                ("global", "tool", "list", {"scope": "workspace"}),
            ],
        )

    async def test_duplicate_event_subscriptions_close_one_handle_at_a_time(self):
        calls = []
        received = asyncio.Event()

        async def handler(ctx: EventContext):
            calls.append((ctx.payload, ctx.message))
            received.set()

        first = await self.client.subscribe(subjects.AGENT_STARTED, handler)
        await self.websocket.wait_sent(1)
        second = await self.client.subscribe(subjects.AGENT_STARTED, handler)
        await self.websocket.wait_sent(2)

        await first.close()
        replacement_frame = await self.websocket.wait_sent(3)
        self.assertEqual(replacement_frame, {"type": "subscribe", "subjects": {subjects.AGENT_STARTED: []}})

        await self.websocket.receive(
            {
                "type": "event",
                "namespace": "agent",
                "subject": "started",
                "payload": {"agentId": "agent-1"},
                "messageId": "message-1",
            },
        )

        await asyncio.wait_for(received.wait(), timeout=1)
        self.assertEqual(len(calls), 1)

        await second.close()
        unsubscribe_frame = await self.websocket.wait_sent(4)
        self.assertEqual(unsubscribe_frame, {"type": "unsubscribe", "subjects": {subjects.AGENT_STARTED: []}})

    async def test_event_handler_exception_does_not_stop_later_event_delivery(self):
        received = asyncio.Future()

        async def failing_handler(ctx: EventContext):
            raise RuntimeError("handler failed")

        async def working_handler(ctx: EventContext):
            received.set_result(ctx.payload)

        await self.client.subscribe(subjects.AGENT_STARTED, failing_handler)
        await self.websocket.wait_sent(1)
        await self.client.subscribe(subjects.AGENT_COMPLETE, working_handler)
        await self.websocket.wait_sent(2)

        with self.assertLogs("makaio", level="ERROR") as logs:
            await self.websocket.receive(
                {
                    "type": "event",
                    "namespace": "agent",
                    "subject": "started",
                    "payload": {"agentId": "agent-1"},
                    "messageId": "message-1",
                },
            )
            await self.websocket.receive(
                {
                    "type": "event",
                    "namespace": "agent",
                    "subject": "complete",
                    "payload": {"agentId": "agent-2"},
                    "messageId": "message-2",
                },
            )

            self.assertEqual(await asyncio.wait_for(received, timeout=1), {"agentId": "agent-2"})

        self.assertIn("agent.started", logs.output[0])


class ConnectLifecycleTest(unittest.IsolatedAsyncioTestCase):
    async def test_connect_waits_for_subscribe_sync_complete(self):
        websocket = FakeWebSocket(auto_sync_complete=False)
        client = BusClient("ws://test", websocket_factory=lambda url: websocket, connect_timeout_ms=500)

        connect_task = asyncio.create_task(client.connect())
        await asyncio.sleep(0.05)
        self.assertFalse(connect_task.done())

        await websocket.receive({"type": "subscribe-sync-complete"})
        await asyncio.wait_for(connect_task, timeout=1)

        await client.close()

    async def test_connect_timeout_covers_readiness(self):
        websocket = FakeWebSocket(auto_sync_complete=False)
        client = BusClient("ws://test", websocket_factory=lambda url: websocket, connect_timeout_ms=25)

        with self.assertRaises(asyncio.TimeoutError):
            await client.connect()

        self.assertTrue(websocket.closed)

    async def test_connect_timeout_covers_transport_connect(self):
        started = asyncio.Event()

        async def factory(url):
            started.set()
            await asyncio.Future()

        client = BusClient("ws://test", auth=False, websocket_factory=factory, connect_timeout_ms=25)

        with self.assertRaises(asyncio.TimeoutError):
            await client.connect()

        await asyncio.wait_for(started.wait(), timeout=1)

    async def test_auth_false_skips_probe_and_handshake(self):
        websocket = FakeWebSocket()
        client = BusClient("ws://test", auth=False, websocket_factory=lambda url: websocket)

        with patch("makaio.bus.probe_health", new=AsyncMock(side_effect=AssertionError("probe called"))):
            await client.connect()

        self.assertEqual(websocket.sent, [])
        await client.close()

    async def test_from_stdio_connects_over_stdio_transport(self):
        reader = MemoryLineReader()
        writer = MemoryLineWriter()
        reader.push({"type": "subscribe-sync-complete"})
        client = BusClient.from_stdio(input_stream=reader, output_stream=writer, connect_timeout_ms=500)

        await client.connect()
        await client.emit(subjects.AGENT_STARTED, {"agentId": "agent-stdio"})

        self.assertEqual(len(writer.frames), 1)
        frame = json.loads(writer.frames[0].decode("utf-8"))
        self.assertEqual(frame["type"], "event")
        self.assertEqual(frame["namespace"], "agent")
        self.assertEqual(frame["subject"], "started")

        await client.close()

    async def test_auto_probe_auth_requires_secret(self):
        websocket = FakeWebSocket(auto_sync_complete=False)
        client = BusClient("ws://test", websocket_factory=lambda url: websocket)

        with patch("makaio.bus.probe_health", new=AsyncMock(return_value=MagicMock(auth=True))):
            with patch.dict("os.environ", {}, clear=True):
                with self.assertRaisesRegex(RuntimeError, "MAKAIO_BUS_SECRET"):
                    await client.connect()

        self.assertEqual(websocket.sent, [])

    async def test_auto_probe_auth_handshake_with_secret(self):
        websocket = FakeWebSocket(auto_sync_complete=False)
        websocket.push({"type": "auth-challenge", "nonce": "nonce-1"})
        websocket.push({"type": "auth-result", "success": True})
        websocket.push({"type": "subscribe-sync-complete"})
        client = BusClient("ws://test", websocket_factory=lambda url: websocket)

        with patch("makaio.bus.probe_health", new=AsyncMock(return_value=MagicMock(auth=True))):
            with patch.dict("os.environ", {"MAKAIO_BUS_SECRET": "secret-1"}, clear=True):
                await client.connect()

        self.assertEqual(len(websocket.sent), 1)
        self.assertEqual(websocket.sent[0]["type"], "auth-response")
        await client.close()

    async def test_failed_subscription_replay_rolls_back_connection(self):
        failing_websocket = FailingSendWebSocket()
        working_websocket = FakeWebSocket()
        attempts = [failing_websocket, working_websocket]

        async def factory(url):
            return attempts.pop(0)

        client = BusClient("ws://test", websocket_factory=factory)

        async def handler(ctx: EventContext):
            pass

        await client.subscribe(subjects.AGENT_STARTED, handler)

        with self.assertRaisesRegex(RuntimeError, "send failed"):
            await client.connect()

        self.assertTrue(failing_websocket.closed)

        await client.connect()
        subscribe_frame = await working_websocket.wait_sent(1)
        self.assertEqual(subscribe_frame, {"type": "subscribe", "subjects": {subjects.AGENT_STARTED: []}})

        await client.close()


class RegistrationRollbackTest(unittest.IsolatedAsyncioTestCase):
    async def test_connect_serializes_overlapping_connection_attempts(self):
        websockets = [FakeWebSocket()]
        started = asyncio.Event()
        release = asyncio.Event()
        calls = 0

        async def factory(url):
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return websockets[0]

        client = BusClient("ws://test", websocket_factory=factory)
        first = asyncio.create_task(client.connect())
        await asyncio.wait_for(started.wait(), timeout=1)
        second = asyncio.create_task(client.connect())
        await asyncio.sleep(0)
        release.set()

        await asyncio.gather(first, second)
        self.assertEqual(calls, 1)
        await client.close()

    async def test_subscribe_rolls_back_when_advertisement_fails(self):
        failing_websocket = FailingSendWebSocket()
        working_websocket = FakeWebSocket()
        attempts = [failing_websocket, working_websocket]

        async def factory(url):
            return attempts.pop(0)

        client = BusClient("ws://test", websocket_factory=factory)
        await client.connect()

        async def handler(ctx: EventContext):
            pass

        with self.assertRaisesRegex(RuntimeError, "send failed"):
            await client.subscribe(subjects.AGENT_STARTED, handler)

        await client.close()

        # After close, a new client is required to establish a fresh connection.
        client2 = BusClient("ws://test", websocket_factory=lambda url: working_websocket)
        await client2.connect()

        self.assertEqual(working_websocket.sent, [])

        await client2.close()

    async def test_on_request_rolls_back_when_advertisement_fails(self):
        failing_websocket = FailingSendWebSocket()
        working_websocket = FakeWebSocket()
        attempts = [failing_websocket, working_websocket]

        async def factory(url):
            return attempts.pop(0)

        client = BusClient("ws://test", websocket_factory=factory)
        await client.connect()

        async def handler(ctx: RequestContext):
            ctx.set_result({"success": True})

        with self.assertRaisesRegex(RuntimeError, "send failed"):
            await client.on_request(subjects.TOOL_EXECUTE, handler, priority=10)

        await client.close()

        # After close, a new client is required to establish a fresh connection.
        client2 = BusClient("ws://test", websocket_factory=lambda url: working_websocket)
        await client2.connect()

        self.assertEqual(working_websocket.sent, [])

        await client2.close()

    async def test_request_handler_serialization_failure_returns_handler_error(self):
        websocket = FakeWebSocket()
        client = BusClient("ws://test", websocket_factory=lambda url: websocket)
        await client.connect()

        async def bad_handler(ctx: RequestContext):
            ctx.set_result({"payload": {1, 2}})

        async def good_handler(ctx: RequestContext):
            ctx.set_result({"ok": True})

        await client.on_request(subjects.TOOL_EXECUTE, bad_handler, priority=10)
        await websocket.wait_sent(1)
        await client.on_request(subjects.TOOL_LIST, good_handler, priority=10)
        await websocket.wait_sent(2)

        await websocket.receive(
            {
                "type": "request",
                "namespace": "tool",
                "subject": "execute",
                "payload": {"toolId": "tool-1"},
                "correlationId": "correlation-1",
                "messageId": "message-1",
            },
        )

        handler_error_frame = await websocket.wait_sent(3)
        self.assertEqual(handler_error_frame["type"], "response")
        self.assertEqual(handler_error_frame["correlationId"], "correlation-1")
        self.assertEqual(handler_error_frame["error"]["code"], "HANDLER_ERROR")
        self.assertEqual(handler_error_frame["error"]["subject"], subjects.TOOL_EXECUTE)

        await websocket.receive(
            {
                "type": "request",
                "namespace": "tool",
                "subject": "list",
                "payload": {"scope": "workspace"},
                "correlationId": "correlation-2",
                "messageId": "message-2",
            },
        )

        success_frame = await websocket.wait_sent(4)
        self.assertEqual(
            success_frame,
            {"type": "response", "correlationId": "correlation-2", "result": {"ok": True}},
        )

        await client.close()

    async def test_close_from_background_handler_does_not_wait_on_itself(self):
        websocket = FakeWebSocket()
        client = BusClient("ws://test", websocket_factory=lambda url: websocket)
        await client.connect()

        handler_finished = asyncio.Event()

        async def handler(ctx: EventContext):
            await client.close()
            handler_finished.set()

        await client.subscribe(subjects.AGENT_STARTED, handler)
        await websocket.wait_sent(1)
        await websocket.receive(
            {
                "type": "event",
                "namespace": "agent",
                "subject": "started",
                "payload": {"agentId": "agent-1"},
                "messageId": "message-1",
            },
        )

        await asyncio.wait_for(handler_finished.wait(), timeout=1)
        self.assertTrue(websocket.closed)


class GeneratedSubjectsTest(unittest.TestCase):
    def test_all_subjects_matches_generated_constants(self):
        generated_subjects = frozenset(
            value
            for name, value in vars(subjects).items()
            if name.isupper() and name != "ALL_SUBJECTS" and isinstance(value, str)
        )

        self.assertGreater(len(generated_subjects), 0)
        self.assertEqual(frozenset(subjects.ALL_SUBJECTS), generated_subjects)


if __name__ == "__main__":
    unittest.main()
