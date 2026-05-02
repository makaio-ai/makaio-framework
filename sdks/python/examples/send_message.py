"""Send a message through session.sendMessage using a canonical model selection.

Environment variables
---------------------
MAKAIO_BUS_URL      WebSocket URL of the bus (default: ws://localhost:6252/bus)
MAKAIO_MESSAGE      Message text to send (default: "Hello, what can you help me with?")
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from collections.abc import Mapping
from uuid import uuid4

from makaio import BusClient, BusError
from makaio.generated import subjects

BUS_URL = os.environ.get("MAKAIO_BUS_URL", "ws://localhost:6252/bus")
DEFAULT_MESSAGE = "Hello, what can you help me with?"


def parse_args() -> argparse.Namespace:
    """Parse CLI arguments for the example."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="Canonical model name to resolve for the new session.")
    parser.add_argument("--message", default=os.environ.get("MAKAIO_MESSAGE", DEFAULT_MESSAGE), help="Message text.")
    return parser.parse_args()


async def main() -> None:
    """Connect to the bus and send one session message."""
    args = parse_args()

    session_id = str(uuid4())
    turn_completed = asyncio.Event()

    client = BusClient(BUS_URL)
    await client.connect()

    try:
        async def on_session_event(payload: object, message: Mapping[str, object]) -> None:
            if isinstance(payload, Mapping) and payload.get("sessionId") != session_id:
                return
            full_subject = f"{message.get('namespace')}.{message.get('subject')}"
            print(f"{full_subject}: {payload}")
            if full_subject == "session.turn.completed":
                turn_completed.set()

        async def on_agent_event(payload: object, message: Mapping[str, object]) -> None:
            if isinstance(payload, Mapping) and payload.get("sessionId") != session_id:
                return
            full_subject = f"{message.get('namespace')}.{message.get('subject')}"
            print(f"{full_subject}: {payload}")

        await client.subscribe("session.*", on_session_event)
        await client.subscribe("agent.*", on_agent_event)
        try:
            response = await client.request(
                subjects.SESSION_SEND_MESSAGE,
                {
                    "sessionId": session_id,
                    "agent": {
                        "kind": "canonical-model",
                        "model": args.model,
                    },
                    "message": args.message,
                },
                response_timeout=30,
            )
        except asyncio.TimeoutError:
            print("Timed out waiting for session.sendMessage acknowledgement", file=sys.stderr)
            raise SystemExit(1)

        print(f"session_id={session_id}")
        print(response)

        try:
            await asyncio.wait_for(turn_completed.wait(), timeout=30)
        except asyncio.TimeoutError:
            print("Timed out waiting for session.turn.completed", file=sys.stderr)
            raise SystemExit(1)
    except BusError as error:
        print(f"Bus error [{error.code}]: {error.message}", file=sys.stderr)
        raise SystemExit(1)
    finally:
        await client.close()


if __name__ == "__main__":
    asyncio.run(main())
