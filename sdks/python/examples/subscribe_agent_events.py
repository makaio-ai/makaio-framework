"""Subscribe to agent lifecycle events."""

import asyncio
import os
import signal

from makaio import BusClient
from makaio.generated import subjects

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

    async def on_agent_event(payload, message) -> None:
        full_subject = f"{message['namespace']}.{message['subject']}"
        if full_subject == subjects.AGENT_STARTED:
            print(f"agent started — model: {payload.get('model')}, cwd: {payload.get('cwd')}")
        elif full_subject == subjects.AGENT_MESSAGE:
            print(f"agent message: {payload.get('content')}")
        elif full_subject == subjects.AGENT_TOOL_USE:
            print(f"tool use: {payload.get('toolName')} (id={payload.get('toolCallId')})")
        elif full_subject == subjects.AGENT_COMPLETE:
            print(f"agent complete — outcome: {payload.get('outcome')}")
        else:
            print(f"{full_subject}: {payload}")

    await client.subscribe("agent.*", on_agent_event)

    await stop.wait()
    await client.close()


if __name__ == "__main__":
    asyncio.run(main())
