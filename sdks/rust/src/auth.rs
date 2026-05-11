use std::time::Duration;

use hmac::{Hmac, KeyInit, Mac};
use serde::Deserialize;
use sha2::Sha256;

use crate::bus::{AuthResponseMessage, BusClientError, BusMessage, BusResult};
use crate::transport::{BoxTransportReader, BoxTransportWriter};

type HmacSha256 = Hmac<Sha256>;
const HEALTH_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Controls HMAC authentication during connection startup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    /// Probe `/health`; authenticate only when the server reports `auth: true`.
    Auto,
    /// Always run HMAC authentication with the configured or environment secret.
    Force,
    /// Skip authentication and health probing.
    Disabled,
}

impl Default for AuthMode {
    fn default() -> Self {
        Self::Auto
    }
}

#[derive(Debug, Clone, Deserialize)]
struct ServerHealth {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    auth: bool,
}

pub(crate) async fn resolve_auth_secret(
    url: &str,
    mode: AuthMode,
    explicit_secret: Option<&str>,
) -> BusResult<Option<String>> {
    match mode {
        AuthMode::Disabled => Ok(None),
        AuthMode::Force => require_bus_secret(explicit_secret).map(Some),
        AuthMode::Auto => match probe_health(url).await {
            Some(health) if health.auth => require_bus_secret(explicit_secret).map(Some),
            Some(_) => Ok(None),
            None => {
                eprintln!(
                    "makaio-sdk: health probe failed for {url}; continuing without HMAC auth in Auto mode"
                );
                Ok(None)
            }
        },
    }
}

pub(crate) async fn run_hmac_auth(
    writer: &mut BoxTransportWriter,
    reader: &mut BoxTransportReader,
    secret: &str,
) -> BusResult<()> {
    let challenge = reader.next().await?.ok_or_else(|| {
        BusClientError::Auth("transport closed before auth challenge".to_string())
    })?;
    let nonce = match challenge {
        BusMessage::AuthChallenge(challenge) => challenge.nonce,
        other => {
            return Err(BusClientError::Auth(format!(
                "expected auth-challenge, received {other:?}"
            )));
        }
    };

    writer
        .send(&BusMessage::AuthResponse(AuthResponseMessage {
            signature: hmac_sign(secret, &nonce)?,
        }))
        .await?;

    let result = reader
        .next()
        .await?
        .ok_or_else(|| BusClientError::Auth("transport closed before auth result".to_string()))?;
    match result {
        BusMessage::AuthResult(result) if result.success => Ok(()),
        BusMessage::AuthResult(result) => Err(BusClientError::Auth(
            result
                .error
                .unwrap_or_else(|| "server rejected HMAC auth".to_string()),
        )),
        other => Err(BusClientError::Auth(format!(
            "expected auth-result, received {other:?}"
        ))),
    }
}

fn require_bus_secret(explicit_secret: Option<&str>) -> BusResult<String> {
    normalize_bus_secret(explicit_secret)?.ok_or_else(|| {
        BusClientError::Auth("MAKAIO_BUS_SECRET is required but not set".to_string())
    })
}

fn normalize_bus_secret(explicit_secret: Option<&str>) -> BusResult<Option<String>> {
    let raw = explicit_secret
        .map(str::to_string)
        .or_else(|| std::env::var("MAKAIO_BUS_SECRET").ok());
    let Some(raw) = raw else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(BusClientError::Auth(
            "MAKAIO_BUS_SECRET is set but empty after trimming; refusing to use an empty secret"
                .to_string(),
        ));
    }
    Ok(Some(trimmed.to_string()))
}

async fn probe_health(bus_url: &str) -> Option<ServerHealth> {
    let health_url = health_url(bus_url)?;
    let client = reqwest::Client::builder()
        .timeout(HEALTH_PROBE_TIMEOUT)
        .build()
        .ok()?;
    let response = client.get(health_url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.text().await.ok()?;
    let trimmed = body.trim();
    if trimmed.eq_ignore_ascii_case("ok") {
        return Some(ServerHealth {
            ok: true,
            auth: false,
        });
    }
    serde_json::from_str::<ServerHealth>(trimmed)
        .ok()
        .filter(|health| health.ok)
}

fn health_url(bus_url: &str) -> Option<String> {
    // The public bus endpoint is documented as `/bus`; non-standard paths keep
    // health next to that path instead of guessing a different server root.
    let http_url = bus_url
        .strip_prefix("wss://")
        .map(|rest| format!("https://{rest}"))
        .or_else(|| {
            bus_url
                .strip_prefix("ws://")
                .map(|rest| format!("http://{rest}"))
        })?;
    if http_url.ends_with("/bus") {
        Some(http_url.trim_end_matches("/bus").to_string() + "/health")
    } else if http_url.ends_with("/bus/") {
        Some(http_url.trim_end_matches("/bus/").to_string() + "/health")
    } else {
        Some(http_url.trim_end_matches('/').to_string() + "/health")
    }
}

fn hmac_sign(secret: &str, nonce: &str) -> BusResult<String> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|error| BusClientError::Auth(error.to_string()))?;
    mac.update(nonce.as_bytes());
    Ok(mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}
