import asyncio
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from makaio import BusClient, BusError
from makaio.bus import _subject_matches_pattern
from makaio.generated import subjects

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
    raise AssertionError(f"{case_id} declares unsupported assertion kind {kind!r}")


class FakeWebSocket:
    def __init__(self):
        self.sent = []
        self.incoming = asyncio.Queue()
        self.closed = False

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


class SubjectPatternTest(unittest.TestCase):
    def test_dot_wildcard_matches_subject_prefixes(self):
        self.assertTrue(_subject_matches_pattern("agent.*", "agent.started"))
        self.assertTrue(_subject_matches_pattern("agent.*", "agent.contextWindow.updated"))
        self.assertFalse(_subject_matches_pattern("agent.*", "agent:worker.started"))

    def test_colon_wildcard_matches_child_namespace_prefixes(self):
        self.assertTrue(_subject_matches_pattern("tool.execute:*", "tool.execute:remote"))
        self.assertTrue(_subject_matches_pattern("adapter:*", "adapter:claudeCode:sdk.thinking"))
        self.assertFalse(_subject_matches_pattern("adapter:*", "adapter.initialized"))


class BusClientTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.websocket = FakeWebSocket()
        self.client = BusClient("ws://test", websocket_factory=lambda url: self.websocket)
        await self.client.connect()

    async def asyncTearDown(self):
        await self.client.close()

    async def test_event_subscribe_and_emit_framing(self):
        received = asyncio.Future()

        async def handler(payload, message):
            received.set_result((payload, message))

        await self.client.subscribe(subjects.AGENT_STARTED, handler)

        subscribe_frame = await self.websocket.wait_sent(1)
        self.assertEqual(subscribe_frame, {"type": "subscribe", "subjects": {subjects.AGENT_STARTED: []}})

        await self.client.emit(subjects.AGENT_STARTED, {"agentId": "agent-1"})
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

    async def test_request_wire_propagates_timeout_priority_and_deadline(self):
        request_task = asyncio.create_task(
            self.client.request(
                subjects.TOOL_LIST,
                {"scope": "workspace"},
                timeout=15,
                priority=250,
                deadline=1234567890,
                response_timeout=1,
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
        self.assertNotIn("response_timeout", request_frame)

        await self.websocket.receive(
            {
                "type": "response",
                "correlationId": request_frame["correlationId"],
                "result": {"tools": []},
            },
        )

        self.assertEqual(await asyncio.wait_for(request_task, timeout=1), {"tools": []})

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

        async def event_handler(payload, message):
            received.set_result(payload)

        async def request_handler(payload, message):
            return {"approved": True, "toolName": payload.get("toolName")}

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
        await client.subscribe(subjects.AGENT_STARTED, lambda payload, message: None)
        await initial_websocket.wait_sent(1)

        await client.reconnect()
        self.assertEqual(
            reconnect_websocket.sent,
            [{"type": "subscribe", "subjects": {subjects.AGENT_STARTED: []}}],
        )

        await client._mark_connection_closed("stale socket closed", websocket=initial_websocket)

        await client.emit(subjects.AGENT_STARTED, {"agentId": "agent-3"})
        event_frame = await reconnect_websocket.wait_sent(2)
        self.assertEqual(event_frame["type"], "event")

        await client.close()

    async def test_request_and_request_handler_reject_wildcards(self):
        async def handler(payload, message):
            return None

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
        async def handler(payload, message):
            return None

        for subject in ("agent.*.updated", "tool.ex*ecute", "adapter:**", "**"):
            with self.subTest(subject=subject):
                with self.assertRaisesRegex(ValueError, "subscription patterns"):
                    await self.client.subscribe(subject, handler)

        self.assertEqual(self.websocket.sent, [])

    async def test_slow_event_handler_does_not_block_response_processing(self):
        handler_started = asyncio.Event()
        release_handler = asyncio.Event()
        handler_finished = asyncio.Event()

        async def blocking_handler(payload, message):
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

        async def blocking_handler(payload, message):
            handler_started.set()
            await release_handler.wait()
            return {"ok": True}

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

        async def blocking_handler(payload, message):
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

        async def blocking_handler(payload, message):
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
        async def first_handler(payload, message):
            return {"handledBy": "first"}

        async def second_handler(payload, message):
            return {"handledBy": "second"}

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

        async def handler(payload, message):
            received.set_result(payload)

        await self.client.subscribe(subjects.AGENT_COMPLETE, handler)
        await self.websocket.wait_sent(1)

        await self.websocket.receive(conformance_message("heartbeat"))
        await asyncio.sleep(0.05)

        self.assertFalse(received.done())
        self.assertEqual(len(self.websocket.sent), 1)

    async def test_broadcast_and_broadcast_response_are_silently_ignored(self):
        received = asyncio.Future()

        async def handler(payload, message):
            received.set_result(payload)

        await self.client.subscribe(subjects.TOOL_EXECUTE, handler)
        await self.websocket.wait_sent(1)

        await self.websocket.receive(conformance_message("broadcast.tool.execute"))
        await self.websocket.receive(conformance_message("broadcast-response.tool.execute"))
        await asyncio.sleep(0.05)

        self.assertFalse(received.done())

    async def test_wildcard_agent_event_subscription(self):
        received = asyncio.Future()

        async def handler(payload, message):
            received.set_result((payload, message))

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

        async def global_handler(payload, message):
            received.append(("global", message["namespace"], message["subject"], payload))
            if len(received) == 3:
                seen.set()

        async def adapter_handler(payload, message):
            received.append(("adapter", message["namespace"], message["subject"], payload))
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

        async def handler(payload, message):
            calls.append((payload, message))
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

        async def failing_handler(payload, message):
            raise RuntimeError("handler failed")

        async def working_handler(payload, message):
            received.set_result(payload)

        await self.client.subscribe(subjects.AGENT_STARTED, failing_handler)
        await self.websocket.wait_sent(1)
        await self.client.subscribe(subjects.AGENT_COMPLETE, working_handler)
        await self.websocket.wait_sent(2)

        with self.assertLogs("makaio.bus", level="ERROR") as logs:
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

        self.assertIn("Makaio event handler failed for agent.started", logs.output[0])


class ConnectLifecycleTest(unittest.IsolatedAsyncioTestCase):
    async def test_failed_subscription_replay_rolls_back_connection(self):
        failing_websocket = FailingSendWebSocket()
        working_websocket = FakeWebSocket()
        attempts = [failing_websocket, working_websocket]

        async def factory(url):
            return attempts.pop(0)

        client = BusClient("ws://test", websocket_factory=factory)

        async def handler(payload, message):
            return None

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

        async def handler(payload, message):
            return None

        with self.assertRaisesRegex(RuntimeError, "send failed"):
            await client.subscribe(subjects.AGENT_STARTED, handler)

        await client.close()
        await client.connect()

        self.assertEqual(working_websocket.sent, [])

        await client.close()

    async def test_on_request_rolls_back_when_advertisement_fails(self):
        failing_websocket = FailingSendWebSocket()
        working_websocket = FakeWebSocket()
        attempts = [failing_websocket, working_websocket]

        async def factory(url):
            return attempts.pop(0)

        client = BusClient("ws://test", websocket_factory=factory)
        await client.connect()

        async def handler(payload, message):
            return {"success": True}

        with self.assertRaisesRegex(RuntimeError, "send failed"):
            await client.on_request(subjects.TOOL_EXECUTE, handler, priority=10)

        await client.close()
        await client.connect()

        self.assertEqual(working_websocket.sent, [])

        await client.close()

    async def test_request_handler_serialization_failure_returns_handler_error(self):
        websocket = FakeWebSocket()
        client = BusClient("ws://test", websocket_factory=lambda url: websocket)
        await client.connect()

        async def bad_handler(payload, message):
            return {"payload": {1, 2}}

        async def good_handler(payload, message):
            return {"ok": True}

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

        async def handler(payload, message):
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
