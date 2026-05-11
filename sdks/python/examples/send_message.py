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
from uuid import uuid4

from makaio import BusClient, BusError, EventContext, OnceTimeoutError, RequestTimeoutError, to_wire
from makaio.generated import session
from makaio.generated.payloads.session import (
    SessionSendMessageRequest,
    SessionTurnCompletedPayload,
)

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

    client = BusClient(BUS_URL)
    await client.connect()

    try:
        # Log every session event in this session.
        async def on_session_event(ctx: EventContext[object]) -> None:
            if isinstance(ctx.payload, dict) and ctx.payload.get("sessionId") != session_id:
                return
            print(f"{ctx.subject}: {ctx.payload}")

        await client.subscribe("session.*", on_session_event)

        turn_task = asyncio.create_task(
            client.once(
                session.turn_completed,
                filter={"sessionId": session_id},
                timeout_ms=30_000,
            )
        )

        # Send the message via session.sendMessage request.
        request_payload = SessionSendMessageRequest(
            session_id=session_id,
            message=args.message,
            agent={"kind": "canonical-model", "model": args.model},
        )

        try:
            response = await client.request(
                session.send_message,
                request_payload,
                timeout_ms=30_000,
            )
        except RequestTimeoutError:
            print("Timed out waiting for session.sendMessage acknowledgement", file=sys.stderr)
            raise SystemExit(1)

        print(f"session_id={session_id}")
        print(to_wire(response))

        # Wait for the turn to complete using once() with a session filter.
        try:
            ctx = await turn_task
            turn = ctx.payload
            if not isinstance(turn, SessionTurnCompletedPayload):
                raise TypeError(f"Expected SessionTurnCompletedPayload, got {type(turn).__name__}")
            print(f"turn completed — success={turn.success}, turn={turn.turn_number}")
        except OnceTimeoutError:
            print("Timed out waiting for session.turn.completed", file=sys.stderr)
            raise SystemExit(1)

    except BusError as error:
        print(f"Bus error [{error.code}]: {error.message}", file=sys.stderr)
        raise SystemExit(1)
    finally:
        await client.close()


if __name__ == "__main__":
    asyncio.run(main())
