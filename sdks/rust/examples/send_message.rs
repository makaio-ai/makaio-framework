//! Send a message through `session.sendMessage` using a canonical model selection.
//!
//! # Usage
//!
//! ```text
//! cargo run --example send_message -- --model <canonical-model>
//! ```
//!
//! # Environment variables
//!
//! | Variable | Required | Description |
//! |----------|----------|-------------|
//! | `MAKAIO_BUS_URL` | no | WebSocket URL (default: `ws://localhost:6252/bus`) |
//! | `MAKAIO_MESSAGE` | no | Message text (default: `"Hello, what can you help me with?"`) |

use makaio_sdk::generated::subjects;
use makaio_sdk::{BusClient, BusClientError};
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use tokio::time::{timeout, Duration};

const DEFAULT_MESSAGE: &str = "Hello, what can you help me with?";
const USAGE: &str = "Usage: send_message --model <canonical-model>";

fn create_session_id() -> Result<String, std::time::SystemTimeError> {
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    Ok(format!("session-{}-{timestamp}", std::process::id()))
}

fn parse_model_arg() -> Result<String, String> {
    let mut args = std::env::args().skip(1);

    while let Some(arg) = args.next() {
        if arg == "--model" {
            return args
                .next()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| USAGE.to_string());
        }
        if let Some(value) = arg.strip_prefix("--model=") {
            return (!value.is_empty())
                .then(|| value.to_string())
                .ok_or_else(|| USAGE.to_string());
        }
        if arg == "--help" || arg == "-h" {
            println!("{USAGE}");
            std::process::exit(0);
        }

        return Err(format!("Unknown argument: {arg}\n{USAGE}"));
    }

    Err(USAGE.to_string())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url =
        std::env::var("MAKAIO_BUS_URL").unwrap_or_else(|_| "ws://localhost:6252/bus".to_string());

    let model = match parse_model_arg() {
        Ok(value) => value,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    };

    let session_id = create_session_id()?;
    let message = std::env::var("MAKAIO_MESSAGE").unwrap_or_else(|_| DEFAULT_MESSAGE.to_string());

    let bus = BusClient::connect(&url).await?;
    let event_session_id = session_id.clone();
    let (turn_completed_tx, mut turn_completed_rx) = mpsc::unbounded_channel();
    let _subscription = bus
        .subscribe("session.*", move |event| {
            let event_session_id = event_session_id.clone();
            let turn_completed_tx = turn_completed_tx.clone();
            async move {
                if event.payload.get("sessionId").and_then(Value::as_str)
                    != Some(event_session_id.as_str())
                {
                    return;
                }
                println!("session.{}: {}", event.subject, event.payload);
                if event.subject == "turn.completed" {
                    let _ = turn_completed_tx.send(());
                }
            }
        })
        .await?;

    let agent_session_id = session_id.clone();
    let _agent_subscription = bus
        .subscribe("agent.*", move |event| {
            let agent_session_id = agent_session_id.clone();
            async move {
                if event.payload.get("sessionId").and_then(Value::as_str)
                    != Some(agent_session_id.as_str())
                {
                    return;
                }
                println!("agent.{}: {}", event.subject, event.payload);
            }
        })
        .await?;

    let response: Value = match bus
        .request_subject::<subjects::session::SendMessage>(json!({
            "sessionId": session_id.clone(),
            "agent": {
                "kind": "canonical-model",
                "model": model,
            },
            "message": message,
        }))
        .await
    {
        Ok(response) => response,
        Err(BusClientError::Bus(err)) => {
            eprintln!(
                "bus error: code={} message={}",
                err.code.as_deref().unwrap_or("(none)"),
                err.message,
            );
            bus.close().await?;
            return Err(Box::<dyn std::error::Error>::from(BusClientError::Bus(err)));
        }
        Err(BusClientError::RequestTimeout(duration)) => {
            eprintln!("request timed out after {duration:?}");
            bus.close().await?;
            return Err(Box::<dyn std::error::Error>::from(
                BusClientError::RequestTimeout(duration),
            ));
        }
        Err(err) => {
            eprintln!("{err:?}");
            bus.close().await?;
            return Err(Box::<dyn std::error::Error>::from(err));
        }
    };

    println!("session_id={session_id}");
    println!("{response}");

    let completion_result: Result<(), Box<dyn std::error::Error>> =
        match timeout(Duration::from_secs(30), turn_completed_rx.recv()).await {
            Ok(Some(())) => Ok(()),
            Ok(None) => Err("session event stream ended before session.turn.completed".into()),
            Err(_) => Err("timed out waiting for session.turn.completed".into()),
        };

    if let Err(error) = completion_result {
        eprintln!("{error}");
        bus.close().await?;
        return Err(error);
    }

    let session_close_result = bus
        .request("session.close", json!({ "sessionId": session_id }))
        .await;
    let bus_close_result = bus.close().await;

    if let Err(error) = session_close_result {
        return Err(Box::<dyn std::error::Error>::from(error));
    }
    bus_close_result?;

    Ok(())
}
