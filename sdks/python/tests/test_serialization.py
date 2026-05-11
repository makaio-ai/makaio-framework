"""Tests for camelCase ↔ snake_case serialization."""

from dataclasses import dataclass
from typing import Literal, Union

from makaio._serialization import to_wire, from_wire, camel_to_snake, snake_to_camel
from makaio.generated.payloads.session import (
    SessionSendMessageRequest,
    SessionSendMessageRequestSessionContext,
    SessionSendMessageRequestSessionContextMessageHistoryItem,
)


def test_camel_to_snake_simple():
    assert camel_to_snake("agentId") == "agent_id"


def test_camel_to_snake_consecutive_caps():
    assert camel_to_snake("messageID") == "message_id"


def test_camel_to_snake_already_snake():
    assert camel_to_snake("agent_id") == "agent_id"


def test_snake_to_camel():
    assert snake_to_camel("agent_id") == "agentId"


def test_snake_to_camel_single_word():
    assert snake_to_camel("agent") == "agent"


@dataclass(frozen=True)
class SamplePayload:
    agent_id: str
    adapter_id: str
    message: str | None = None


@dataclass(frozen=True)
class TextBlock:
    text: str
    type: Literal["text"]


@dataclass(frozen=True)
class EmptyBlock:
    type: Literal["empty"]


@dataclass(frozen=True)
class BlockPayload:
    block: Union[TextBlock, EmptyBlock]


def test_to_wire():
    payload = SamplePayload(agent_id="a1", adapter_id="b2", message="hello")
    result = to_wire(payload)
    assert result == {"agentId": "a1", "adapterId": "b2", "message": "hello"}


def test_to_wire_skips_none():
    payload = SamplePayload(agent_id="a1", adapter_id="b2")
    result = to_wire(payload)
    assert result == {"agentId": "a1", "adapterId": "b2"}


def test_from_wire():
    data = {"agentId": "a1", "adapterId": "b2", "message": "hello"}
    result = from_wire(data, SamplePayload)
    assert result == SamplePayload(agent_id="a1", adapter_id="b2", message="hello")


def test_from_wire_missing_optional():
    data = {"agentId": "a1", "adapterId": "b2"}
    result = from_wire(data, SamplePayload)
    assert result == SamplePayload(agent_id="a1", adapter_id="b2", message=None)


def test_from_wire_extra_fields_ignored():
    data = {"agentId": "a1", "adapterId": "b2", "unknownField": True}
    result = from_wire(data, SamplePayload)
    assert result == SamplePayload(agent_id="a1", adapter_id="b2")


def test_roundtrip():
    original = SamplePayload(agent_id="a1", adapter_id="b2", message="test")
    assert from_wire(to_wire(original), SamplePayload) == original


def test_from_wire_nested_optional_list_items():
    data = {
        "message": {"text": "hello"},
        "sessionId": "session-1",
        "sessionContext": {
            "messageHistory": [
                {
                    "blocks": {"type": "text", "text": "hello"},
                    "role": "user",
                }
            ]
        },
    }

    result = from_wire(data, SessionSendMessageRequest)

    assert result == SessionSendMessageRequest(
        message={"text": "hello"},
        session_id="session-1",
        session_context=SessionSendMessageRequestSessionContext(
            message_history=[
                SessionSendMessageRequestSessionContextMessageHistoryItem(
                    blocks={"type": "text", "text": "hello"},
                    role="user",
                )
            ]
        ),
    )


def test_to_wire_nested_optional_list_items():
    payload = SessionSendMessageRequest(
        message={"text": "hello"},
        session_id="session-1",
        session_context=SessionSendMessageRequestSessionContext(
            message_history=[
                SessionSendMessageRequestSessionContextMessageHistoryItem(
                    blocks={"type": "text", "text": "hello"},
                    role="user",
                )
            ]
        ),
    )

    assert to_wire(payload) == {
        "message": {"text": "hello"},
        "sessionId": "session-1",
        "sessionContext": {
            "messageHistory": [
                {
                    "blocks": {"type": "text", "text": "hello"},
                    "role": "user",
                }
            ]
        },
    }


def test_from_wire_selects_one_of_variant_by_literal_discriminator():
    result = from_wire({"block": {"type": "text", "text": "hello"}}, BlockPayload)

    assert result == BlockPayload(block=TextBlock(type="text", text="hello"))
