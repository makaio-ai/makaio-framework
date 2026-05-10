use makaio_sdk::generated::subjects::{AgentMessagePayload, AgentStartedPayload};
use makaio_sdk::BusClient;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url =
        std::env::var("MAKAIO_BUS_URL").unwrap_or_else(|_| "ws://localhost:6252/bus".to_string());
    let bus = BusClient::connect(&url).await?;

    let _subscription = bus
        .subscribe("agent.*", |event| async move {
            match event.subject.as_str() {
                "started" => {
                    match serde_json::from_value::<AgentStartedPayload>(event.payload.clone()) {
                        Ok(p) => println!(
                            "agent.started  model={} cwd={}",
                            p.model.as_deref().unwrap_or("(none)"),
                            p.cwd.as_deref().unwrap_or("(none)"),
                        ),
                        Err(e) => eprintln!("agent.started: {e}"),
                    }
                }
                "message" => {
                    match serde_json::from_value::<AgentMessagePayload>(event.payload.clone()) {
                        Ok(p) => println!("agent.message  content={}", p.content),
                        Err(e) => eprintln!("agent.message: {e}"),
                    }
                }
                "complete" => {
                    let outcome = event
                        .payload
                        .get("outcome")
                        .and_then(|v| v.as_str())
                        .unwrap_or("(none)");
                    println!("agent.complete  outcome={outcome}");
                }
                _ => {
                    println!("agent.{}  payload={}", event.subject, event.payload);
                }
            }
        })
        .await?;

    // ctrl_c() handles SIGINT cross-platform. SIGTERM requires unix-only
    // tokio::signal::unix which would need #[cfg(unix)] guards.
    tokio::signal::ctrl_c().await?;
    bus.close().await?;

    Ok(())
}
