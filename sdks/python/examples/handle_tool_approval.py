"""Handle tool approval requests with risk-based decision logic."""

import asyncio
import os
import signal
from collections.abc import Mapping
from typing import Any

from makaio import BusClient, BusError
from makaio.generated import subjects

_DENY_RESPONSE: dict[str, str] = {
    "action": "deny",
    "message": "Destructive operations require manual approval",
}
_ALLOW_RESPONSE: dict[str, str] = {"action": "allow"}


async def main() -> None:
    """Connect to the bus and handle approval requests until interrupted."""
    url = os.environ.get("MAKAIO_BUS_URL", "ws://localhost:6252/bus")
    client = BusClient(url)
    await client.connect()

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            signal.signal(sig, lambda *_: stop.set())

    async def handle_approval(
        payload: object,
        message: Mapping[str, Any],
    ) -> dict[str, str]:
        if not isinstance(payload, dict):
            raise BusError("Expected object payload", code="INVALID_PAYLOAD", subject=subjects.APPROVAL_REQUEST)
        tool_name = payload.get("toolName", "<unknown>")
        risk_level = payload.get("riskLevel", "unknown")
        capabilities: list[str] = payload.get("capabilities") or []
        # capabilities are wire-level strings ("file.read", "shell.execute", etc.)
        caps_display = ", ".join(str(c) for c in capabilities) if capabilities else "none"
        print(
            f"approval.request: tool={tool_name}"
            f"  risk={risk_level}"
            f"  capabilities=[{caps_display}]"
        )
        if risk_level == "destructive":
            return _DENY_RESPONSE
        return _ALLOW_RESPONSE

    async def handle_tool(
        payload: object,
        message: Mapping[str, Any],
    ) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise BusError("Expected object payload", code="INVALID_PAYLOAD", subject=subjects.TOOL_EXECUTE)
        tool_name = payload.get("toolName")
        if tool_name == "example.echo":
            return {"success": True, "data": payload.get("input")}
        raise BusError(
            "Unsupported tool",
            code="UNSUPPORTED_TOOL",
            subject=subjects.TOOL_EXECUTE,
        )

    await client.on_request(subjects.APPROVAL_REQUEST, handle_approval, priority=100)
    await client.on_request(subjects.TOOL_EXECUTE, handle_tool, priority=0)
    print(f"Listening for approval requests on {url} — press Ctrl+C to stop")

    await stop.wait()
    await client.close()


if __name__ == "__main__":
    asyncio.run(main())
