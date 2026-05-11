"""Tool namespace subjects — generated from makaio-bus-protocol.json."""

from __future__ import annotations

from makaio.types import EventSubject, RequestSubject
from makaio.generated.payloads.tool import (
    ToolCompletedPayload,
    ToolErrorPayload,
    ToolExecuteRequest,
    ToolExecuteResponse,
    ToolListRequest,
    ToolListResponse,
    ToolRegisteredPayload,
    ToolRegistryChangedPayload,
    ToolStartedPayload,
)

completed: EventSubject[ToolCompletedPayload] = EventSubject("tool.completed", payload_type=ToolCompletedPayload)
error: EventSubject[ToolErrorPayload] = EventSubject("tool.error", payload_type=ToolErrorPayload)
execute: RequestSubject[ToolExecuteRequest, ToolExecuteResponse] = RequestSubject("tool.execute", request_type=ToolExecuteRequest, response_type=ToolExecuteResponse)
list: RequestSubject[ToolListRequest, ToolListResponse] = RequestSubject("tool.list", request_type=ToolListRequest, response_type=ToolListResponse)
registered: EventSubject[ToolRegisteredPayload] = EventSubject("tool.registered", payload_type=ToolRegisteredPayload)
registry_changed: EventSubject[ToolRegistryChangedPayload] = EventSubject("tool.registryChanged", payload_type=ToolRegistryChangedPayload)
started: EventSubject[ToolStartedPayload] = EventSubject("tool.started", payload_type=ToolStartedPayload)
