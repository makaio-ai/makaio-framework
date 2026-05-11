"""Subscribe to agent lifecycle events."""

import asyncio
import os
import signal

from makaio import BusClient, EventContext, from_wire
from makaio.generated import agent
from makaio.generated.payloads.agent import (
    AgentCompletePayload,
    AgentMessagePayload,
    AgentStartedPayload,
    AgentToolUsePayload,
)

BUS_URL = os.environ.get("MAKAIO_BUS_URL", "ws://localhost:6252/bus")


async def main() -> None:
    client = BusClient(BUS_URL)
    await client.connect()

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            signal.signal(sig, lambda *_: stop.set())

    # Subscribe to individual typed subjects for specific events.
    async def on_started(ctx: EventContext[AgentStartedPayload]) -> None:
        payload = from_wire(ctx.payload, AgentStartedPayload)
        print(f"agent started — model: {payload.model}, cwd: {payload.cwd}")

    async def on_message(ctx: EventContext[AgentMessagePayload]) -> None:
        payload = from_wire(ctx.payload, AgentMessagePayload)
        print(f"agent message: {payload.content}")

    async def on_tool_use(ctx: EventContext[AgentToolUsePayload]) -> None:
        payload = from_wire(ctx.payload, AgentToolUsePayload)
        print(f"tool use: {payload.tool_name} (id={payload.tool_call_id})")

    async def on_complete(ctx: EventContext[AgentCompletePayload]) -> None:
        payload = from_wire(ctx.payload, AgentCompletePayload)
        print(f"agent complete — outcome: {payload.outcome}")

    await client.subscribe(agent.started, on_started)
    await client.subscribe(agent.message, on_message)
    await client.subscribe(agent.tool_use, on_tool_use)
    await client.subscribe(agent.complete, on_complete)

    await stop.wait()
    await client.close()


if __name__ == "__main__":
    asyncio.run(main())
