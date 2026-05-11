use makaio_sdk::generated::subjects::{
    self, ApprovalRequest, ApprovalResponse, RiskLevel, ToolExecuteRequest, ToolExecuteResponse,
    ToolExecuteSuccessResponse,
};
use makaio_sdk::{BusClient, BusTransportError};
use serde_json::Value;

fn serialize<T: serde::Serialize>(value: T, subject: &str) -> Result<Value, BusTransportError> {
    serde_json::to_value(value).map_err(|e| BusTransportError {
        message: e.to_string(),
        code: Some("SERIALIZE_ERROR".to_string()),
        subject: Some(subject.to_string()),
        data: None,
    })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url =
        std::env::var("MAKAIO_BUS_URL").unwrap_or_else(|_| "ws://localhost:6252/bus".to_string());
    let bus = BusClient::connect(&url).await?;

    let _approval_handler = bus
        .on_request_with_priority(subjects::approval::REQUEST, 100, |ctx| async move {
            let req: ApprovalRequest =
                serde_json::from_value(ctx.payload()).map_err(|e| BusTransportError {
                    message: e.to_string(),
                    code: Some("DESERIALIZE_ERROR".to_string()),
                    subject: Some(subjects::approval::REQUEST.to_string()),
                    data: None,
                })?;

            println!(
                "approval.request received request_id={} tool_name={:?} risk_level={:?} capabilities={:?}",
                req.request_id, req.tool_name, req.risk_level, req.capabilities,
            );

            let response = if req.risk_level == Some(RiskLevel::Destructive) {
                ApprovalResponse::Deny {
                    message: Some("Destructive operations require manual approval".to_string()),
                }
            } else {
                ApprovalResponse::Allow { updated_input: None }
            };

            ctx.set_result(serialize(response, subjects::approval::REQUEST)?);
            Ok(())
        })
        .await?;

    let _tool_handler = bus
        .on_request(subjects::tool::EXECUTE, |ctx| async move {
            let req: ToolExecuteRequest =
                serde_json::from_value(ctx.payload()).map_err(|e| BusTransportError {
                    message: e.to_string(),
                    code: Some("DESERIALIZE_ERROR".to_string()),
                    subject: Some(subjects::tool::EXECUTE.to_string()),
                    data: None,
                })?;

            if req.tool_name == "example.echo" {
                let response = ToolExecuteResponse::Success(ToolExecuteSuccessResponse {
                    success: true,
                    data: req.input,
                });
                ctx.set_result(serialize(response, subjects::tool::EXECUTE)?);
                Ok(())
            } else {
                Err(BusTransportError {
                    message: format!("Unsupported tool `{}`", req.tool_name),
                    code: Some("UNSUPPORTED_TOOL".to_string()),
                    subject: Some(subjects::tool::EXECUTE.to_string()),
                    data: None,
                })
            }
        })
        .await?;

    // ctrl_c() handles SIGINT cross-platform. SIGTERM requires unix-only
    // tokio::signal::unix which would need #[cfg(unix)] guards.
    tokio::signal::ctrl_c().await?;
    bus.close().await?;

    Ok(())
}
