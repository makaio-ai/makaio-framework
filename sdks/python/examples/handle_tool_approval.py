"""Handle tool approval requests with risk-based decision logic."""

import asyncio
import os
import signal

from makaio import BusClient, BusError, RequestContext
from makaio._serialization import from_wire
from makaio.generated import approval, tool
from makaio.generated.payloads.approval import ApprovalRequestRequest
from makaio.generated.payloads.tool import ToolExecuteRequest, ToolExecuteResponse


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
        ctx: RequestContext[ApprovalRequestRequest, object],
    ) -> None:
        payload = from_wire(ctx.payload, ApprovalRequestRequest)
        caps_display = ", ".join(payload.capabilities) if payload.capabilities else "none"
        print(
            f"approval.request: tool={payload.tool_name}"
            f"  risk={payload.risk_level}"
            f"  capabilities=[{caps_display}]"
        )
        if payload.risk_level == "destructive":
            ctx.set_result({"action": "deny", "message": "Destructive operations require manual approval"})
        else:
            ctx.set_result({"action": "allow"})

    async def handle_tool(
        ctx: RequestContext[ToolExecuteRequest, ToolExecuteResponse],
    ) -> None:
        payload = from_wire(ctx.payload, ToolExecuteRequest)
        if payload.tool_name == "example.echo":
            ctx.set_result({"success": True, "data": payload.input})
            return
        raise BusError(
            "Unsupported tool",
            code="UNSUPPORTED_TOOL",
            subject=tool.execute.full_subject,
        )

    await client.on_request(approval.request, handle_approval, priority=100)
    await client.on_request(tool.execute, handle_tool, priority=0)
    print(f"Listening for approval requests on {url} — press Ctrl+C to stop")

    await stop.wait()
    await client.close()


if __name__ == "__main__":
    asyncio.run(main())
