use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::sync::{oneshot, Mutex, Semaphore};
use tokio::task::JoinHandle;
use uuid::Uuid;

pub use crate::auth::AuthMode;
use crate::auth::{resolve_auth_secret, run_hmac_auth};
use crate::transport::{
    connect_websocket, stdio_transport, stdio_transport_parts, BoxTransportReader,
    BoxTransportWriter,
};

type BoxedEventFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
type EventHandler = Arc<dyn Fn(EventMessage) -> BoxedEventFuture + Send + Sync>;
type BoxedRequestFuture = Pin<Box<dyn Future<Output = Result<(), BusTransportError>> + Send>>;
type RequestHandler = Arc<dyn Fn(RequestContext) -> BoxedRequestFuture + Send + Sync>;
type RequestNextFuture = Pin<Box<dyn Future<Output = Result<(), BusTransportError>> + Send>>;
type RequestNextFn =
    Arc<dyn Fn(Arc<StdMutex<RequestContextState>>) -> RequestNextFuture + Send + Sync>;
const MAX_INBOUND_HANDLER_TASKS: usize = 64;
const STDIO_URL: &str = "stdio://local";

/// SDK result type.
pub type BusResult<T> = Result<T, BusClientError>;

/// Compile-time descriptor for a protocol event subject.
pub trait EventSubject {
    /// Payload type serialized for this event subject.
    type Payload: Serialize + DeserializeOwned + Send + 'static;
    /// Full protocol subject.
    const SUBJECT: &'static str;
}

/// Compile-time descriptor for a protocol request subject.
pub trait RequestSubject {
    /// Request payload serialized for this subject.
    type Request: Serialize + DeserializeOwned + Send + 'static;
    /// Response payload deserialized for this subject.
    type Response: Serialize + DeserializeOwned + Send + 'static;
    /// Full protocol subject.
    const SUBJECT: &'static str;
}

/// WebSocket Makaio bus participant.
#[derive(Clone)]
pub struct BusClient {
    inner: Arc<ClientInner>,
    read_task: Arc<Mutex<Option<JoinHandle<()>>>>,
    url: Arc<Mutex<String>>,
    dispatch: DispatchMode,
    auth: AuthMode,
    secret: Option<String>,
}

struct ClientInner {
    control_plane: Mutex<()>,
    writer: Mutex<Option<BoxTransportWriter>>,
    pending: Mutex<HashMap<String, oneshot::Sender<ResponseMessage>>>,
    event_handlers: Mutex<HashMap<String, HashMap<usize, EventHandlerEntry>>>,
    request_handlers: Mutex<HashMap<String, BTreeMap<i64, Vec<RequestHandlerEntry>>>>,
    remote_request_handlers: Mutex<BTreeMap<String, Vec<i64>>>,
    remote_subscribe_synced: AtomicBool,
    background_tasks: Mutex<Vec<JoinHandle<()>>>,
    inbound_handler_slots: Arc<Semaphore>,
    next_handler_id: Mutex<usize>,
}

#[derive(Clone)]
struct RequestHandlerEntry {
    handler_id: usize,
    handler: RequestHandler,
    delivery_class: SubscriptionDeliveryClass,
}

#[derive(Clone)]
struct EventHandlerEntry {
    handler: EventHandler,
    delivery_class: SubscriptionDeliveryClass,
}

#[derive(Default)]
struct LocalSubscriptionSnapshot {
    subjects: BTreeMap<String, Vec<i64>>,
    delivery_classes: BTreeMap<String, SubscriptionDeliveryClass>,
}

#[derive(Clone)]
enum RequestChainEntry {
    Local {
        priority: i64,
        handler: RequestHandler,
    },
    Remote {
        priority: i64,
    },
}

impl RequestChainEntry {
    fn priority(&self) -> i64 {
        match self {
            Self::Local { priority, .. } | Self::Remote { priority } => *priority,
        }
    }

    fn is_local(&self) -> bool {
        matches!(self, Self::Local { .. })
    }
}

enum SubjectAdvertisementAction {
    None,
    ReplaceSnapshot(LocalSubscriptionSnapshot),
    Unsubscribe(Vec<i64>),
}

/// Controls whether outbound requests consult local handlers before the remote transport.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DispatchMode {
    /// Run local request handlers first, then forward to the remote bus when none resolves.
    LocalFirst,
    /// Always forward outbound requests to the remote bus.
    Remote,
}

impl Default for DispatchMode {
    fn default() -> Self {
        Self::LocalFirst
    }
}

/// Connection options for [`BusClient`].
#[derive(Debug, Clone, Default)]
pub struct BusClientOptions {
    /// Request dispatch behavior.
    pub dispatch: DispatchMode,
    /// HMAC authentication mode.
    pub auth: AuthMode,
    /// Explicit HMAC secret. Falls back to `MAKAIO_BUS_SECRET` when omitted.
    pub secret: Option<String>,
}

/// Handle returned by [`BusClient::subscribe`].
pub struct Subscription {
    client: BusClient,
    subject: String,
    handler_id: usize,
    active: bool,
}

/// Handle returned by [`BusClient::on_request`] and [`BusClient::on_request_with_priority`].
pub struct RequestHandlerRegistration {
    client: BusClient,
    subject: String,
    priority: i64,
    handler_id: usize,
    active: bool,
}

/// Context passed to local request handlers.
#[derive(Clone)]
pub struct RequestContext {
    inner: Arc<StdMutex<RequestContextState>>,
    next: Option<RequestNextFn>,
    next_called: Arc<AtomicBool>,
    /// Full subject, for example `tool.execute`.
    pub subject: String,
    /// Wire message identifier.
    pub message_id: String,
    /// Request correlation identifier.
    pub correlation_id: String,
    /// Wire timeout hint, in milliseconds.
    pub timeout: Option<u64>,
    /// Priority cursor supplied by the sender, when present.
    pub priority: Option<i64>,
    /// Absolute deadline hint supplied by the sender, when present.
    pub deadline: Option<u64>,
}

#[derive(Debug)]
struct RequestContextState {
    payload: Value,
    result: Option<Value>,
    has_result: bool,
    executed_priorities: Vec<i64>,
}

/// Return value adapter for request handlers.
pub trait IntoRequestHandlerResult {
    /// Applies the handler return value to the shared request context.
    fn apply_to(self, context: &RequestContext);
}

impl IntoRequestHandlerResult for Value {
    fn apply_to(self, context: &RequestContext) {
        context.set_result(self);
    }
}

impl IntoRequestHandlerResult for () {
    fn apply_to(self, _context: &RequestContext) {}
}

#[derive(Debug, Clone, PartialEq)]
struct RequestDispatchOutcome {
    result: Option<Value>,
    has_result: bool,
    next_remote_cursor: Option<i64>,
}

/// Transport options for a Makaio bus request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestOptions {
    pub timeout: Duration,
    pub priority: Option<i64>,
    pub deadline: Option<u64>,
}

impl Default for RequestOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(30),
            priority: None,
            deadline: None,
        }
    }
}

impl RequestContext {
    fn new(
        request: &RequestMessage,
        full_subject: String,
        inner: Arc<StdMutex<RequestContextState>>,
        next: Option<RequestNextFn>,
        next_called: Arc<AtomicBool>,
    ) -> Self {
        Self {
            inner,
            next,
            next_called,
            subject: full_subject,
            message_id: request.message_id.clone(),
            correlation_id: request.correlation_id.clone(),
            timeout: request.timeout,
            priority: request.priority,
            deadline: request.deadline,
        }
    }

    /// Returns the current request payload, reflecting any `replace_payload` calls from prior handlers.
    pub fn payload(&self) -> Value {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .payload
            .clone()
    }

    /// Sets the response value and stops automatic handler advancement.
    pub fn set_result(&self, value: Value) {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.result = Some(value);
        state.has_result = true;
    }

    /// Returns the current response value, if one has been set.
    pub fn result(&self) -> Option<Value> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .result
            .clone()
    }

    /// Shallow-merges object fields into the current response value.
    pub fn extend_result(&self, extension: serde_json::Map<String, Value>) {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut base = match state.result.take() {
            Some(Value::Object(map)) => map,
            _ => serde_json::Map::new(),
        };
        base.extend(extension);
        state.result = Some(Value::Object(base));
        state.has_result = true;
    }

    /// Replaces the request payload observed by subsequent handlers.
    pub fn replace_payload(&self, payload: Value) {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .payload = payload;
    }

    /// Delegates to the next lower-priority request handler in the chain.
    pub async fn next(&self) -> Result<(), BusTransportError> {
        self.next_called.store(true, Ordering::SeqCst);
        if let Some(next) = &self.next {
            next(self.inner.clone()).await?;
        }
        Ok(())
    }
}

/// Errors surfaced by the Rust SDK runtime.
#[derive(Debug, Error)]
pub enum BusClientError {
    #[error("websocket error: {0}")]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("client is not connected")]
    NotConnected,
    #[error("invalid full subject `{0}`")]
    InvalidSubject(String),
    #[error("request response channel closed")]
    ResponseChannelClosed,
    #[error("request timed out after {0:?}")]
    RequestTimeout(Duration),
    #[error("request handler already registered for `{0}`")]
    DuplicateRequestHandler(String),
    #[error("authentication failed: {0}")]
    Auth(String),
    #[error("bus error: {0}")]
    Bus(#[from] BusTransportError),
}

/// Structured error envelope used on the transport.
///
/// `serde_json::Value` implements `Eq` in the supported dependency version, so we keep the
/// derive here to preserve structural equality checks in SDK tests.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct BusTransportError {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl BusTransportError {
    /// Builds the canonical no-handler transport error for request forwarding.
    pub fn no_handler(subject: impl Into<String>) -> Self {
        let subject = subject.into();
        Self {
            message: format!("No handler registered for request subject \"{subject}\""),
            code: Some("NO_HANDLER".to_string()),
            subject: Some(subject),
            data: None,
        }
    }

    /// Builds a transport error for requests orphaned by a closed connection.
    pub fn connection_closed() -> Self {
        Self {
            message: "Makaio bus transport connection closed".to_string(),
            code: Some("CONNECTION_CLOSED".to_string()),
            subject: None,
            data: None,
        }
    }
}

/// Strongly typed Makaio wire message envelope.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum BusMessage {
    #[serde(rename = "event")]
    Event(EventMessage),
    #[serde(rename = "request")]
    Request(RequestMessage),
    #[serde(rename = "response")]
    Response(ResponseMessage),
    #[serde(rename = "broadcast")]
    Broadcast(BroadcastMessage),
    #[serde(rename = "broadcast-response")]
    BroadcastResponse(BroadcastResponseMessage),
    #[serde(rename = "heartbeat")]
    Heartbeat(HeartbeatMessage),
    #[serde(rename = "subscribe")]
    Subscribe(SubscribeMessage),
    #[serde(rename = "unsubscribe")]
    Unsubscribe(UnsubscribeMessage),
    #[serde(rename = "subscribe-sync-complete")]
    SubscribeSyncComplete {},
    #[serde(rename = "auth-challenge")]
    AuthChallenge(AuthChallengeMessage),
    #[serde(rename = "auth-response")]
    AuthResponse(AuthResponseMessage),
    #[serde(rename = "auth-result")]
    AuthResult(AuthResultMessage),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EventMessage {
    pub namespace: String,
    pub subject: String,
    pub payload: Value,
    pub message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RequestMessage {
    pub namespace: String,
    pub subject: String,
    pub payload: Value,
    pub correlation_id: String,
    pub message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResponseMessage {
    pub correlation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BusTransportError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastMessage {
    pub namespace: String,
    pub subject: String,
    pub payload: Value,
    pub correlation_id: String,
    pub message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastResponseMessage {
    pub correlation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub results: Option<Vec<BroadcastResult>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BusTransportError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastResult {
    pub node_id: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HeartbeatMessage {
    pub timestamp: u64,
}

/// Routing scope advertised for a subscribed subject.
///
/// Rust SDK handlers are always directly owned by this client, so every local
/// advertisement currently uses [`SubscriptionDeliveryClass::Relayable`]. The
/// type still preserves the language-neutral wire contract when remote peers
/// advertise a stricter scope.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SubscriptionDeliveryClass {
    /// The subscribed handler may be reached through relay nodes.
    Relayable,
    /// The subscribed handler accepts direct ingress only and must not be relayed.
    FirstHopOnly,
}

impl Default for SubscriptionDeliveryClass {
    fn default() -> Self {
        Self::Relayable
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeMessage {
    pub subjects: BTreeMap<String, Vec<i64>>,
    /// Delivery class for every advertised subject.
    ///
    /// `default` keeps decoding older peers possible; all locally produced
    /// subscribe messages include an explicit entry for every subject.
    #[serde(default)]
    pub delivery_classes: BTreeMap<String, SubscriptionDeliveryClass>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filters: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UnsubscribeMessage {
    pub subjects: BTreeMap<String, Vec<i64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthChallengeMessage {
    pub nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthResponseMessage {
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthResultMessage {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl BusClient {
    /// Connects to a Makaio bus WebSocket endpoint.
    pub async fn connect(url: &str) -> BusResult<Self> {
        Self::connect_with_options(url, BusClientOptions::default()).await
    }

    /// Connects to a Makaio bus WebSocket endpoint with an explicit dispatch mode.
    pub async fn connect_with_dispatch(url: &str, dispatch: DispatchMode) -> BusResult<Self> {
        Self::connect_with_options(
            url,
            BusClientOptions {
                dispatch,
                ..BusClientOptions::default()
            },
        )
        .await
    }

    /// Connects to a Makaio bus WebSocket endpoint and always runs HMAC auth.
    pub async fn connect_with_auth(url: &str, secret: impl Into<String>) -> BusResult<Self> {
        Self::connect_with_options(
            url,
            BusClientOptions {
                auth: AuthMode::Force,
                secret: Some(secret.into()),
                ..BusClientOptions::default()
            },
        )
        .await
    }

    /// Connects to a Makaio bus WebSocket endpoint with explicit options.
    pub async fn connect_with_options(url: &str, options: BusClientOptions) -> BusResult<Self> {
        let resolved_secret =
            resolve_auth_secret(url, options.auth, options.secret.as_deref()).await?;
        let (mut writer, mut reader) = connect_websocket(url).await?;
        if let Some(secret) = resolved_secret.as_deref() {
            run_hmac_auth(&mut writer, &mut reader, secret).await?;
        }
        Self::from_transport(url, writer, reader, options).await
    }

    /// Connects over a bidirectional newline-delimited JSON stream.
    pub async fn from_stdio<T>(stream: T) -> BusResult<Self>
    where
        T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin + 'static,
    {
        let (writer, reader) = stdio_transport(stream);
        Self::from_transport(
            STDIO_URL,
            writer,
            reader,
            BusClientOptions {
                auth: AuthMode::Disabled,
                ..BusClientOptions::default()
            },
        )
        .await
    }

    /// Connects over separate newline-delimited JSON reader and writer streams.
    pub async fn from_stdio_parts<R, W>(reader: R, writer: W) -> BusResult<Self>
    where
        R: tokio::io::AsyncRead + Send + Unpin + 'static,
        W: tokio::io::AsyncWrite + Send + Unpin + 'static,
    {
        let (writer, reader) = stdio_transport_parts(reader, writer);
        Self::from_transport(
            STDIO_URL,
            writer,
            reader,
            BusClientOptions {
                auth: AuthMode::Disabled,
                ..BusClientOptions::default()
            },
        )
        .await
    }

    async fn from_transport(
        url: &str,
        writer: BoxTransportWriter,
        reader: BoxTransportReader,
        options: BusClientOptions,
    ) -> BusResult<Self> {
        let configured_secret = options.secret.clone();
        let client = Self {
            inner: Arc::new(ClientInner {
                control_plane: Mutex::new(()),
                writer: Mutex::new(Some(writer)),
                pending: Mutex::new(HashMap::new()),
                event_handlers: Mutex::new(HashMap::new()),
                request_handlers: Mutex::new(HashMap::new()),
                remote_request_handlers: Mutex::new(BTreeMap::new()),
                remote_subscribe_synced: AtomicBool::new(false),
                background_tasks: Mutex::new(Vec::new()),
                inbound_handler_slots: Arc::new(Semaphore::new(MAX_INBOUND_HANDLER_TASKS)),
                next_handler_id: Mutex::new(0),
            }),
            read_task: Arc::new(Mutex::new(None)),
            url: Arc::new(Mutex::new(url.to_string())),
            dispatch: options.dispatch,
            auth: options.auth,
            secret: configured_secret,
        };

        let read_client = client.clone();
        let task = tokio::spawn(async move {
            read_client.read_loop(reader).await;
        });
        *client.read_task.lock().await = Some(task);

        Ok(client)
    }

    /// Closes the WebSocket connection and stops the reader task.
    pub async fn close(&self) -> BusResult<()> {
        let _control_plane = self.inner.control_plane.lock().await;
        self.close_locked().await
    }

    async fn close_locked(&self) -> BusResult<()> {
        let close_result = self.disconnect_writer().await;

        if let Some(task) = self.read_task.lock().await.take() {
            task.abort();
            let _ = task.await;
        }

        self.abort_background_tasks().await;

        self.fail_pending_requests(BusTransportError::connection_closed())
            .await;

        close_result
    }

    /// Reconnects the client to the original WebSocket endpoint and replays current local subscriptions.
    ///
    /// @returns `Ok(())` after the new connection is established and local subscriptions are replayed.
    pub async fn reconnect(&self) -> BusResult<()> {
        let _control_plane = self.inner.control_plane.lock().await;
        self.reconnect_locked().await
    }

    /// Reconnects the client to a new WebSocket endpoint and replays current local subscriptions.
    pub async fn reconnect_to(&self, url: &str) -> BusResult<()> {
        let _control_plane = self.inner.control_plane.lock().await;
        self.reconnect_locked_to(url).await
    }

    async fn reconnect_locked(&self) -> BusResult<()> {
        let url = self.url.lock().await.clone();
        self.reconnect_locked_to(&url).await
    }

    async fn reconnect_locked_to(&self, url: &str) -> BusResult<()> {
        if let Some(task) = self.read_task.lock().await.take() {
            task.abort();
            let _ = task.await;
        }

        self.fail_pending_requests(BusTransportError::connection_closed())
            .await;
        self.abort_background_tasks().await;
        self.clear_remote_advertisements().await;

        let _ = self.disconnect_writer().await;

        let reconnect_secret = resolve_auth_secret(url, self.auth, self.secret.as_deref()).await?;

        let (mut writer, mut reader) = connect_websocket(url).await?;
        if let Some(secret) = reconnect_secret.as_deref() {
            run_hmac_auth(&mut writer, &mut reader, secret).await?;
        }

        // Replay rollback only covers transport-level send failures here. The current protocol has
        // no subscribe acknowledgement, so reconnect completion still means "frames were written",
        // not "the server durably applied every replayed subscription".
        self.send_subscribe_snapshot_with_writer(&mut writer)
            .await?;

        *self.inner.writer.lock().await = Some(writer);
        *self.url.lock().await = url.to_string();
        let read_client = self.clone();
        let task = tokio::spawn(async move {
            read_client.read_loop(reader).await;
        });
        *self.read_task.lock().await = Some(task);
        Ok(())
    }

    /// Emits an event to the given full subject.
    pub async fn emit<P>(&self, full_subject: &str, payload: P) -> BusResult<String>
    where
        P: Serialize,
    {
        let (namespace, subject) = split_exact_full_subject(full_subject)?;
        let message_id = new_message_id();
        let message = BusMessage::Event(EventMessage {
            namespace: namespace.to_string(),
            subject: subject.to_string(),
            payload: serde_json::to_value(payload)?,
            message_id: message_id.clone(),
            correlation_id: None,
        });
        if let BusMessage::Event(event) = &message {
            self.dispatch_event(event.clone()).await;
        }
        self.send_message(message).await?;
        Ok(message_id)
    }

    /// Emits an event using a generated typed subject descriptor.
    pub async fn emit_subject<S>(&self, payload: S::Payload) -> BusResult<String>
    where
        S: EventSubject,
    {
        self.emit(S::SUBJECT, payload).await
    }

    /// Sends a request and resolves exactly one response matching the correlation ID.
    pub async fn request<P>(&self, full_subject: &str, payload: P) -> BusResult<Value>
    where
        P: Serialize,
    {
        self.request_with_options(full_subject, payload, RequestOptions::default())
            .await
    }

    /// Sends a request using a generated typed subject descriptor.
    pub async fn request_subject<S>(&self, payload: S::Request) -> BusResult<S::Response>
    where
        S: RequestSubject,
    {
        let result = self.request(S::SUBJECT, payload).await?;
        serde_json::from_value(result).map_err(BusClientError::from)
    }

    /// Sends a request with a caller-provided timeout.
    pub async fn request_with_timeout<P>(
        &self,
        full_subject: &str,
        payload: P,
        timeout: Duration,
    ) -> BusResult<Value>
    where
        P: Serialize,
    {
        self.request_with_options(
            full_subject,
            payload,
            RequestOptions {
                timeout,
                priority: None,
                deadline: None,
            },
        )
        .await
    }

    /// Sends a request with caller-provided transport options.
    pub async fn request_with_options<P>(
        &self,
        full_subject: &str,
        payload: P,
        options: RequestOptions,
    ) -> BusResult<Value>
    where
        P: Serialize,
    {
        let (namespace, subject) = split_exact_full_subject(full_subject)?;
        let payload = serde_json::to_value(payload)?;
        let correlation_id = new_message_id();
        let message = RequestMessage {
            namespace: namespace.to_string(),
            subject: subject.to_string(),
            payload,
            correlation_id: correlation_id.clone(),
            message_id: new_message_id(),
            timeout: Some(options.timeout.as_millis().try_into().unwrap_or(u64::MAX)),
            priority: options.priority,
            deadline: options.deadline,
        };
        let path_deadline = options
            .deadline
            .or_else(|| (!options.timeout.is_zero()).then(|| deadline_after(options.timeout)));
        let path_timeout = match options.deadline {
            Some(deadline) => request_path_timeout(options.timeout, deadline)?,
            None => options.timeout,
        };

        let request_path = self.execute_request_path(message, options.timeout, path_deadline);

        if path_timeout.is_zero() {
            request_path.await
        } else {
            match tokio::time::timeout(path_timeout, request_path).await {
                Ok(result) => result,
                Err(_) => {
                    self.inner.pending.lock().await.remove(&correlation_id);
                    Err(BusClientError::RequestTimeout(path_timeout))
                }
            }
        }
    }

    async fn execute_request_path(
        &self,
        mut message: RequestMessage,
        timeout: Duration,
        path_deadline: Option<u64>,
    ) -> BusResult<Value> {
        if self.dispatch == DispatchMode::LocalFirst {
            let outcome = self
                .dispatch_outbound_request_chain(message.clone(), timeout, path_deadline)
                .await?;
            if outcome.has_result {
                return Ok(outcome.result.unwrap_or(Value::Null));
            }
            if let Some(cursor) = outcome.next_remote_cursor {
                message.priority = Some(cursor);
            }
        }

        self.send_remote_request(message, timeout, path_deadline)
            .await
    }

    async fn send_remote_request(
        &self,
        mut message: RequestMessage,
        timeout: Duration,
        path_deadline: Option<u64>,
    ) -> BusResult<Value> {
        let correlation_id = message.correlation_id.clone();
        let remote_timeout =
            self.prepare_remote_request_timing(&mut message, timeout, path_deadline)?;
        let (sender, receiver) = oneshot::channel();
        self.inner
            .pending
            .lock()
            .await
            .insert(correlation_id.clone(), sender);
        let message = BusMessage::Request(message);

        let await_response = async {
            self.send_message(message).await?;
            receiver
                .await
                .map_err(|_| BusClientError::ResponseChannelClosed)
        };

        let response = if remote_timeout.is_zero() {
            match await_response.await {
                Ok(response) => response,
                Err(error) => {
                    self.inner.pending.lock().await.remove(&correlation_id);
                    return Err(error);
                }
            }
        } else {
            match tokio::time::timeout(remote_timeout, await_response).await {
                Ok(Ok(response)) => response,
                Ok(Err(error)) => {
                    self.inner.pending.lock().await.remove(&correlation_id);
                    return Err(error);
                }
                Err(_) => {
                    self.inner.pending.lock().await.remove(&correlation_id);
                    return Err(BusClientError::RequestTimeout(remote_timeout));
                }
            }
        };

        if let Some(error) = response.error {
            return Err(BusClientError::Bus(error));
        }

        Ok(response.result.unwrap_or(Value::Null))
    }

    fn prepare_remote_request_timing(
        &self,
        message: &mut RequestMessage,
        timeout: Duration,
        path_deadline: Option<u64>,
    ) -> BusResult<Duration> {
        let deadline = message.deadline.or(path_deadline);
        if let Some(deadline) = deadline {
            let remaining_ms = deadline.saturating_sub(now_millis());
            if remaining_ms == 0 {
                return Err(BusClientError::RequestTimeout(Duration::from_millis(
                    remaining_ms,
                )));
            }
            message.deadline = Some(deadline);
            message.timeout = Some(remaining_ms);
            Ok(Duration::from_millis(remaining_ms))
        } else {
            message.timeout = Some(duration_millis(timeout));
            Ok(timeout)
        }
    }

    /// Subscribes to inbound events for an exact subject or bus wildcard pattern.
    pub async fn subscribe<F, Fut>(
        &self,
        subject_pattern: &str,
        handler: F,
    ) -> BusResult<Subscription>
    where
        F: Fn(EventMessage) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        self.subscribe_with_delivery_class(
            subject_pattern,
            SubscriptionDeliveryClass::Relayable,
            handler,
        )
        .await
    }

    /// Subscribes to inbound events with an explicit routing scope.
    pub async fn subscribe_with_delivery_class<F, Fut>(
        &self,
        subject_pattern: &str,
        delivery_class: SubscriptionDeliveryClass,
        handler: F,
    ) -> BusResult<Subscription>
    where
        F: Fn(EventMessage) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        validate_subscription_pattern(subject_pattern)?;
        let handler_id = self.next_handler_id().await;
        let handler: EventHandler = Arc::new(move |event| Box::pin(handler(event)));
        let _control_plane = self.inner.control_plane.lock().await;
        let mut writer = self.inner.writer.lock().await;
        let writer = writer.as_mut().ok_or(BusClientError::NotConnected)?;

        {
            let mut handlers = self.inner.event_handlers.lock().await;
            handlers
                .entry(subject_pattern.to_string())
                .or_default()
                .insert(
                    handler_id,
                    EventHandlerEntry {
                        handler: handler.clone(),
                        delivery_class,
                    },
                );
        }

        if let Err(error) = self.send_subscribe_snapshot_with_writer(writer).await {
            let mut handlers = self.inner.event_handlers.lock().await;
            if let Some(subject_handlers) = handlers.get_mut(subject_pattern) {
                subject_handlers.remove(&handler_id);
                if subject_handlers.is_empty() {
                    handlers.remove(subject_pattern);
                }
            }
            return Err(error);
        }
        Ok(Subscription {
            client: self.clone(),
            subject: subject_pattern.to_string(),
            handler_id,
            active: true,
        })
    }

    /// Registers one request handler for an exact full subject and advertises it with the given priority.
    ///
    /// @param full_subject - Exact full subject to register.
    /// @param priority - Wire-advertised local priority for the handler.
    /// @param handler - Async handler invoked for matching requests.
    /// @returns A registration handle that can unregister the handler later.
    pub async fn on_request_with_priority<F, Fut, R>(
        &self,
        full_subject: &str,
        priority: i64,
        handler: F,
    ) -> BusResult<RequestHandlerRegistration>
    where
        F: Fn(RequestContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<R, BusTransportError>> + Send + 'static,
        R: IntoRequestHandlerResult + Send + 'static,
    {
        self.on_request_with_priority_and_delivery_class(
            full_subject,
            priority,
            SubscriptionDeliveryClass::Relayable,
            handler,
        )
        .await
    }

    /// Registers one request handler with an explicit routing scope.
    pub async fn on_request_with_priority_and_delivery_class<F, Fut, R>(
        &self,
        full_subject: &str,
        priority: i64,
        delivery_class: SubscriptionDeliveryClass,
        handler: F,
    ) -> BusResult<RequestHandlerRegistration>
    where
        F: Fn(RequestContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<R, BusTransportError>> + Send + 'static,
        R: IntoRequestHandlerResult + Send + 'static,
    {
        split_exact_full_subject(full_subject)?;
        let handler_id = self.next_handler_id().await;
        let user_handler = Arc::new(handler);
        let handler: RequestHandler = Arc::new(move |context| {
            let user_handler = user_handler.clone();
            let returned_context = context.clone();
            Box::pin(async move {
                let result = user_handler(context).await?;
                result.apply_to(&returned_context);
                Ok(())
            })
        });
        let _control_plane = self.inner.control_plane.lock().await;

        {
            let mut writer = self.inner.writer.lock().await;
            let writer = writer.as_mut().ok_or(BusClientError::NotConnected)?;

            {
                let mut handlers = self.inner.request_handlers.lock().await;
                let subject_handlers = handlers.entry(full_subject.to_string()).or_default();
                subject_handlers
                    .entry(priority)
                    .or_default()
                    .push(RequestHandlerEntry {
                        handler_id,
                        handler: handler.clone(),
                        delivery_class,
                    });
            }

            if let Err(error) = self.send_subscribe_snapshot_with_writer(writer).await {
                let mut handlers = self.inner.request_handlers.lock().await;
                if let Some(subject_handlers) = handlers.get_mut(full_subject) {
                    remove_request_handler_entry(subject_handlers, priority, handler_id);
                    if subject_handlers.is_empty() {
                        handlers.remove(full_subject);
                    }
                }
                return Err(error);
            }
        }
        Ok(RequestHandlerRegistration {
            client: self.clone(),
            subject: full_subject.to_string(),
            priority,
            handler_id,
            active: true,
        })
    }

    /// Registers one request handler for an exact full subject and advertises it with priority `0`.
    pub async fn on_request<F, Fut, R>(
        &self,
        full_subject: &str,
        handler: F,
    ) -> BusResult<RequestHandlerRegistration>
    where
        F: Fn(RequestContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<R, BusTransportError>> + Send + 'static,
        R: IntoRequestHandlerResult + Send + 'static,
    {
        self.on_request_with_priority(full_subject, 0, handler)
            .await
    }

    /// Registers one priority-`0` request handler with an explicit routing scope.
    pub async fn on_request_with_delivery_class<F, Fut, R>(
        &self,
        full_subject: &str,
        delivery_class: SubscriptionDeliveryClass,
        handler: F,
    ) -> BusResult<RequestHandlerRegistration>
    where
        F: Fn(RequestContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<R, BusTransportError>> + Send + 'static,
        R: IntoRequestHandlerResult + Send + 'static,
    {
        self.on_request_with_priority_and_delivery_class(full_subject, 0, delivery_class, handler)
            .await
    }

    async fn read_loop(&self, mut reader: BoxTransportReader) {
        while let Ok(Some(bus_message)) = reader.next().await {
            match bus_message {
                BusMessage::Response(response) => {
                    if let Some(sender) = self
                        .inner
                        .pending
                        .lock()
                        .await
                        .remove(&response.correlation_id)
                    {
                        let _ = sender.send(response);
                    }
                }
                BusMessage::Request(request) => {
                    let client = self.clone();
                    self.spawn_inbound_handler_task(async move {
                        client.handle_request(request).await;
                    })
                    .await;
                }
                BusMessage::Event(event) => {
                    self.dispatch_event(event).await;
                }
                BusMessage::Heartbeat(_) => {}
                BusMessage::Subscribe(subscribe) => {
                    self.handle_remote_subscribe(subscribe).await;
                }
                BusMessage::Unsubscribe(unsubscribe) => {
                    self.handle_remote_unsubscribe(unsubscribe).await;
                }
                BusMessage::SubscribeSyncComplete {} => {
                    self.inner
                        .remote_subscribe_synced
                        .store(true, Ordering::SeqCst);
                }
                BusMessage::Broadcast(_)
                | BusMessage::BroadcastResponse(_)
                | BusMessage::AuthChallenge(_)
                | BusMessage::AuthResponse(_)
                | BusMessage::AuthResult(_) => {}
            }
        }

        let _ = self.disconnect_writer().await;
        self.clear_remote_advertisements().await;
        self.fail_pending_requests(BusTransportError::connection_closed())
            .await;
    }

    async fn handle_remote_subscribe(&self, subscribe: SubscribeMessage) {
        let mut remote_handlers = self.inner.remote_request_handlers.lock().await;
        for (subject, mut priorities) in subscribe.subjects {
            if priorities.is_empty() {
                remote_handlers.remove(&subject);
            } else {
                priorities.sort_unstable_by(|left, right| right.cmp(left));
                remote_handlers.insert(subject, priorities);
            }
        }
    }

    async fn handle_remote_unsubscribe(&self, unsubscribe: UnsubscribeMessage) {
        let mut remote_handlers = self.inner.remote_request_handlers.lock().await;
        for (subject, removed_priorities) in unsubscribe.subjects {
            if removed_priorities.is_empty() {
                remote_handlers.remove(&subject);
                continue;
            }

            let should_remove_subject = if let Some(priorities) = remote_handlers.get_mut(&subject)
            {
                for removed_priority in removed_priorities {
                    if let Some(index) = priorities
                        .iter()
                        .position(|priority| *priority == removed_priority)
                    {
                        priorities.remove(index);
                    }
                }
                priorities.is_empty()
            } else {
                false
            };

            if should_remove_subject {
                remote_handlers.remove(&subject);
            }
        }
    }

    async fn clear_remote_advertisements(&self) {
        self.inner.remote_request_handlers.lock().await.clear();
        self.inner
            .remote_subscribe_synced
            .store(false, Ordering::SeqCst);
    }

    async fn dispatch_event(&self, event: EventMessage) {
        let full_subject = join_full_subject(&event.namespace, &event.subject);
        let handlers = {
            let handlers = self.inner.event_handlers.lock().await;
            handlers
                .iter()
                .filter(|(pattern, _)| matches_subscription(&full_subject, pattern))
                .flat_map(|(_, handlers)| handlers.values().map(|entry| entry.handler.clone()))
                .collect::<Vec<_>>()
        };

        for handler in handlers {
            let event = event.clone();
            self.spawn_inbound_handler_task(async move {
                handler(event).await;
            })
            .await;
        }
    }

    async fn handle_request(&self, request: RequestMessage) {
        let full_subject = join_full_subject(&request.namespace, &request.subject);
        let response = match self.dispatch_request_chain(request.clone()).await {
            Ok(outcome) if outcome.has_result => ResponseMessage {
                correlation_id: request.correlation_id,
                result: Some(outcome.result.unwrap_or(Value::Null)),
                error: None,
            },
            Ok(_) => ResponseMessage {
                correlation_id: request.correlation_id,
                result: None,
                error: Some(BusTransportError::no_handler(full_subject)),
            },
            Err(error) => ResponseMessage {
                correlation_id: request.correlation_id,
                result: None,
                error: Some(error),
            },
        };

        let _ = self.send_message(BusMessage::Response(response)).await;
    }

    async fn dispatch_outbound_request_chain(
        &self,
        request: RequestMessage,
        timeout: Duration,
        path_deadline: Option<u64>,
    ) -> BusResult<RequestDispatchOutcome> {
        let full_subject = join_full_subject(&request.namespace, &request.subject);
        let chain = self
            .build_outbound_request_chain(&full_subject, request.priority)
            .await;

        if chain.is_empty() {
            return Ok(RequestDispatchOutcome {
                result: None,
                has_result: false,
                next_remote_cursor: None,
            });
        }

        let state = Arc::new(StdMutex::new(RequestContextState {
            payload: request.payload.clone(),
            result: None,
            has_result: false,
            executed_priorities: Vec::new(),
        }));
        step_outbound_request_chain(
            self.clone(),
            Arc::new(chain),
            0,
            state.clone(),
            Arc::new(request),
            Arc::from(full_subject),
            timeout,
            path_deadline,
        )
        .await
        .map_err(BusClientError::Bus)?;
        let state = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(RequestDispatchOutcome {
            result: state.result.clone(),
            has_result: state.has_result,
            next_remote_cursor: state.executed_priorities.iter().min().copied(),
        })
    }

    async fn build_outbound_request_chain(
        &self,
        full_subject: &str,
        cursor: Option<i64>,
    ) -> Vec<RequestChainEntry> {
        let mut chain = {
            let handlers = self.inner.request_handlers.lock().await;
            handlers
                .get(full_subject)
                .map(|handlers| {
                    handlers
                        .iter()
                        .rev()
                        .flat_map(|(&priority, entries)| {
                            entries.iter().filter_map(move |entry| {
                                cursor.map_or(true, |cursor| priority < cursor).then(|| {
                                    RequestChainEntry::Local {
                                        priority,
                                        handler: entry.handler.clone(),
                                    }
                                })
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };

        if self.inner.remote_subscribe_synced.load(Ordering::SeqCst) {
            let remote_priorities = {
                let remote_handlers = self.inner.remote_request_handlers.lock().await;
                remote_handlers
                    .get(full_subject)
                    .into_iter()
                    .flatten()
                    .copied()
                    .filter(|priority| cursor.map_or(true, |cursor| *priority < cursor))
                    .collect::<BTreeSet<_>>()
            };

            chain.extend(
                remote_priorities
                    .into_iter()
                    .map(|priority| RequestChainEntry::Remote { priority }),
            );
        }

        chain.sort_by(|left, right| {
            right
                .priority()
                .cmp(&left.priority())
                .then_with(|| right.is_local().cmp(&left.is_local()))
        });
        chain
    }

    async fn dispatch_request_chain(
        &self,
        request: RequestMessage,
    ) -> Result<RequestDispatchOutcome, BusTransportError> {
        let full_subject = join_full_subject(&request.namespace, &request.subject);
        let chain = {
            let handlers = self.inner.request_handlers.lock().await;
            handlers
                .get(&full_subject)
                .map(|handlers| {
                    handlers
                        .iter()
                        .rev()
                        .flat_map(|(&priority, entries)| {
                            entries.iter().filter_map(move |entry| {
                                request
                                    .priority
                                    .map_or(true, |cursor| priority < cursor)
                                    .then(|| (priority, entry.handler.clone()))
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };

        if chain.is_empty() {
            return Ok(RequestDispatchOutcome {
                result: None,
                has_result: false,
                next_remote_cursor: None,
            });
        }

        let state = Arc::new(StdMutex::new(RequestContextState {
            payload: request.payload.clone(),
            result: None,
            has_result: false,
            executed_priorities: Vec::new(),
        }));
        step_request_chain(
            Arc::new(chain),
            0,
            state.clone(),
            Arc::new(request),
            Arc::from(full_subject),
        )
        .await?;
        let state = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(RequestDispatchOutcome {
            result: state.result.clone(),
            has_result: state.has_result,
            next_remote_cursor: state.executed_priorities.iter().min().copied(),
        })
    }

    async fn send_message(&self, message: BusMessage) -> BusResult<()> {
        // Transports are single-writer, so sends are intentionally serialized here.
        // `close()` and `reconnect()` wait for the in-flight frame rather than racing ownership
        // of the sink; moving to a channel-backed write task would be a larger transport redesign.
        let mut writer = self.inner.writer.lock().await;
        let writer = writer.as_mut().ok_or(BusClientError::NotConnected)?;
        writer.send(&message).await
    }

    async fn disconnect_writer(&self) -> BusResult<()> {
        match self.inner.writer.lock().await.take() {
            Some(mut writer) => writer.close().await,
            None => Ok(()),
        }
    }

    async fn fail_pending_requests(&self, error: BusTransportError) {
        let pending = {
            let mut pending = self.inner.pending.lock().await;
            pending.drain().collect::<Vec<_>>()
        };

        for (correlation_id, sender) in pending {
            let _ = sender.send(ResponseMessage {
                correlation_id,
                result: None,
                error: Some(error.clone()),
            });
        }
    }

    async fn send_subject_action_with_writer(
        &self,
        writer: &mut BoxTransportWriter,
        full_subject: &str,
        action: SubjectAdvertisementAction,
    ) -> BusResult<()> {
        match action {
            SubjectAdvertisementAction::None => Ok(()),
            SubjectAdvertisementAction::ReplaceSnapshot(snapshot) => {
                writer
                    .send(&BusMessage::Subscribe(SubscribeMessage {
                        delivery_classes: snapshot.delivery_classes,
                        subjects: snapshot.subjects,
                        filters: None,
                    }))
                    .await
            }
            SubjectAdvertisementAction::Unsubscribe(priorities) => {
                let mut subjects = BTreeMap::new();
                subjects.insert(full_subject.to_string(), priorities);
                writer
                    .send(&BusMessage::Unsubscribe(UnsubscribeMessage { subjects }))
                    .await
            }
        }
    }

    async fn spawn_background_task<F>(&self, future: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let task = tokio::spawn(future);
        let mut tasks = self.inner.background_tasks.lock().await;
        tasks.retain(|existing| !existing.is_finished());
        tasks.push(task);
    }

    async fn spawn_inbound_handler_task<F>(&self, future: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let permit = self
            .inner
            .inbound_handler_slots
            .clone()
            .acquire_owned()
            .await
            .expect("inbound handler semaphore should remain open");
        self.spawn_background_task(async move {
            let _permit = permit;
            future.await;
        })
        .await;
    }

    async fn abort_background_tasks(&self) {
        let tasks = {
            let mut tasks = self.inner.background_tasks.lock().await;
            tasks.drain(..).collect::<Vec<_>>()
        };

        for task in &tasks {
            task.abort();
        }

        for task in tasks {
            let _ = task.await;
        }
    }

    async fn snapshot_local_subscriptions(&self) -> LocalSubscriptionSnapshot {
        let mut snapshot = LocalSubscriptionSnapshot::default();

        {
            let handlers = self.inner.event_handlers.lock().await;
            for (subject, entries) in handlers.iter() {
                if entries.is_empty() {
                    continue;
                }
                snapshot.subjects.insert(subject.clone(), Vec::new());
                snapshot.delivery_classes.insert(
                    subject.clone(),
                    aggregate_delivery_classes(entries.values().map(|entry| entry.delivery_class)),
                );
            }
        }

        {
            let handlers = self.inner.request_handlers.lock().await;
            for (subject, priorities) in handlers.iter() {
                snapshot
                    .subjects
                    .insert(subject.clone(), request_handler_priorities(priorities));
                snapshot.delivery_classes.insert(
                    subject.clone(),
                    aggregate_delivery_classes(
                        snapshot
                            .delivery_classes
                            .get(subject)
                            .copied()
                            .into_iter()
                            .chain(
                                priorities
                                    .values()
                                    .flatten()
                                    .map(|entry| entry.delivery_class),
                            ),
                    ),
                );
            }
        }

        snapshot
    }

    async fn send_subscribe_snapshot_with_writer(
        &self,
        writer: &mut BoxTransportWriter,
    ) -> BusResult<()> {
        let snapshot = self.snapshot_local_subscriptions().await;
        if snapshot.subjects.is_empty() {
            return Ok(());
        }

        writer
            .send(&BusMessage::Subscribe(SubscribeMessage {
                delivery_classes: snapshot.delivery_classes,
                subjects: snapshot.subjects,
                filters: None,
            }))
            .await
    }

    async fn remove_event_handler_action(
        &self,
        full_subject: &str,
        handler_id: usize,
    ) -> SubjectAdvertisementAction {
        let mut event_handlers = self.inner.event_handlers.lock().await;
        let request_handlers = self.inner.request_handlers.lock().await;

        if let Some(subject_handlers) = event_handlers.get_mut(full_subject) {
            subject_handlers.remove(&handler_id);
            if subject_handlers.is_empty() {
                event_handlers.remove(full_subject);
            }
        }

        let has_event_handlers = event_handlers
            .get(full_subject)
            .is_some_and(|handlers| !handlers.is_empty());
        let request_priorities = request_handlers
            .get(full_subject)
            .map(request_handler_priorities)
            .unwrap_or_default();

        if has_event_handlers || !request_priorities.is_empty() {
            SubjectAdvertisementAction::None
        } else {
            SubjectAdvertisementAction::Unsubscribe(Vec::new())
        }
    }

    async fn preview_event_handler_removal(
        &self,
        full_subject: &str,
        handler_id: usize,
    ) -> SubjectAdvertisementAction {
        let event_handlers = self.inner.event_handlers.lock().await;
        let request_handlers = self.inner.request_handlers.lock().await;

        let mut subjects = build_post_removal_snapshot(
            &event_handlers,
            &request_handlers,
            |subject, handlers| {
                if subject == full_subject {
                    handlers.keys().any(|id| *id != handler_id)
                } else {
                    !handlers.is_empty()
                }
            },
            |_, priorities| request_handler_priorities(priorities),
        );

        if subjects.subjects.contains_key(full_subject) {
            subjects.delivery_classes.insert(
                full_subject.to_string(),
                aggregate_delivery_classes(
                    event_handlers
                        .get(full_subject)
                        .into_iter()
                        .flatten()
                        .filter(|(id, _)| **id != handler_id)
                        .map(|(_, entry)| entry.delivery_class)
                        .chain(
                            request_handlers
                                .get(full_subject)
                                .into_iter()
                                .flatten()
                                .flat_map(|(_, entries)| entries.iter())
                                .map(|entry| entry.delivery_class),
                        ),
                ),
            );
        }

        if subjects.subjects.contains_key(full_subject) {
            SubjectAdvertisementAction::ReplaceSnapshot(subjects)
        } else if event_handlers.contains_key(full_subject) {
            SubjectAdvertisementAction::Unsubscribe(Vec::new())
        } else {
            SubjectAdvertisementAction::None
        }
    }

    async fn preview_request_handler_removal(
        &self,
        full_subject: &str,
        removed_priority: i64,
        removed_handler_id: usize,
    ) -> SubjectAdvertisementAction {
        let event_handlers = self.inner.event_handlers.lock().await;
        let request_handlers = self.inner.request_handlers.lock().await;

        let mut subjects = build_post_removal_snapshot(
            &event_handlers,
            &request_handlers,
            |_, handlers| !handlers.is_empty(),
            |subject, priorities| {
                if subject == full_subject {
                    request_handler_priorities_without(
                        priorities,
                        removed_priority,
                        removed_handler_id,
                    )
                } else {
                    request_handler_priorities(priorities)
                }
            },
        );

        if subjects.subjects.contains_key(full_subject) {
            subjects.delivery_classes.insert(
                full_subject.to_string(),
                aggregate_delivery_classes(
                    event_handlers
                        .get(full_subject)
                        .into_iter()
                        .flatten()
                        .map(|(_, entry)| entry.delivery_class)
                        .chain(
                            request_handlers
                                .get(full_subject)
                                .into_iter()
                                .flatten()
                                .flat_map(|(priority, entries)| {
                                    entries.iter().map(move |entry| (*priority, entry))
                                })
                                .filter(|(priority, entry)| {
                                    *priority != removed_priority
                                        || entry.handler_id != removed_handler_id
                                })
                                .map(|(_, entry)| entry.delivery_class),
                        ),
                ),
            );
        }

        if subjects.subjects.contains_key(full_subject) {
            SubjectAdvertisementAction::ReplaceSnapshot(subjects)
        } else if request_handlers.contains_key(full_subject) {
            SubjectAdvertisementAction::Unsubscribe(vec![removed_priority])
        } else {
            SubjectAdvertisementAction::None
        }
    }

    async fn remove_request_handler_action(
        &self,
        full_subject: &str,
        removed_priority: i64,
        removed_handler_id: usize,
    ) -> SubjectAdvertisementAction {
        let event_handlers = self.inner.event_handlers.lock().await;
        let mut request_handlers = self.inner.request_handlers.lock().await;

        if let Some(subject_handlers) = request_handlers.get_mut(full_subject) {
            remove_request_handler_entry(subject_handlers, removed_priority, removed_handler_id);
            if subject_handlers.is_empty() {
                request_handlers.remove(full_subject);
            }
        }

        let has_event_handlers = event_handlers
            .get(full_subject)
            .is_some_and(|handlers| !handlers.is_empty());
        let request_priorities = request_handlers
            .get(full_subject)
            .map(request_handler_priorities)
            .unwrap_or_default();

        if has_event_handlers || !request_priorities.is_empty() {
            SubjectAdvertisementAction::None
        } else {
            SubjectAdvertisementAction::Unsubscribe(vec![removed_priority])
        }
    }

    async fn next_handler_id(&self) -> usize {
        let mut next_handler_id = self.inner.next_handler_id.lock().await;
        let handler_id = *next_handler_id;
        *next_handler_id += 1;
        handler_id
    }
}

impl Subscription {
    /// Unregisters this local event handler.
    pub async fn unsubscribe(&mut self) -> BusResult<()> {
        if !self.active {
            return Ok(());
        }

        let _control_plane = self.client.inner.control_plane.lock().await;
        {
            let mut writer = self.client.inner.writer.lock().await;
            if let Some(writer) = writer.as_mut() {
                let action = self
                    .client
                    .preview_event_handler_removal(&self.subject, self.handler_id)
                    .await;
                self.client
                    .send_subject_action_with_writer(writer, &self.subject, action)
                    .await?;
            }
        }
        let _ = self
            .client
            .remove_event_handler_action(&self.subject, self.handler_id)
            .await;
        self.active = false;
        Ok(())
    }
}

impl RequestHandlerRegistration {
    /// Unregisters this local request handler.
    pub async fn unregister(&mut self) -> BusResult<()> {
        if !self.active {
            return Ok(());
        }

        let _control_plane = self.client.inner.control_plane.lock().await;
        {
            let mut writer = self.client.inner.writer.lock().await;
            if let Some(writer) = writer.as_mut() {
                let action = self
                    .client
                    .preview_request_handler_removal(&self.subject, self.priority, self.handler_id)
                    .await;
                self.client
                    .send_subject_action_with_writer(writer, &self.subject, action)
                    .await?;
            }
        }
        let _ = self
            .client
            .remove_request_handler_action(&self.subject, self.priority, self.handler_id)
            .await;
        self.active = false;
        Ok(())
    }
}

fn step_request_chain(
    chain: Arc<Vec<(i64, RequestHandler)>>,
    index: usize,
    state: Arc<StdMutex<RequestContextState>>,
    request: Arc<RequestMessage>,
    full_subject: Arc<str>,
) -> RequestNextFuture {
    Box::pin(async move {
        let Some((priority, handler)) = chain.get(index).cloned() else {
            return Ok(());
        };

        {
            let mut state = state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.executed_priorities.push(priority);
        }

        let next_called = Arc::new(AtomicBool::new(false));
        let next = {
            let chain = chain.clone();
            let request = request.clone();
            let full_subject = full_subject.clone();
            Some(Arc::new(move |state| {
                step_request_chain(
                    chain.clone(),
                    index + 1,
                    state,
                    request.clone(),
                    full_subject.clone(),
                )
            }) as RequestNextFn)
        };
        let context = RequestContext::new(
            &request,
            full_subject.to_string(),
            state.clone(),
            next,
            next_called.clone(),
        );

        handler(context.clone()).await?;

        let should_auto_advance = {
            let state = state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            !next_called.load(Ordering::SeqCst) && !state.has_result
        };

        if should_auto_advance {
            step_request_chain(chain, index + 1, state, request, full_subject).await?;
        }

        Ok(())
    })
}

fn step_outbound_request_chain(
    client: BusClient,
    chain: Arc<Vec<RequestChainEntry>>,
    index: usize,
    state: Arc<StdMutex<RequestContextState>>,
    request: Arc<RequestMessage>,
    full_subject: Arc<str>,
    timeout: Duration,
    path_deadline: Option<u64>,
) -> RequestNextFuture {
    Box::pin(async move {
        let Some(entry) = chain.get(index).cloned() else {
            return Ok(());
        };
        let priority = entry.priority();

        {
            let mut state = state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.executed_priorities.push(priority);
        }

        match entry {
            RequestChainEntry::Local { handler, .. } => {
                let next_called = Arc::new(AtomicBool::new(false));
                let next = {
                    let client = client.clone();
                    let chain = chain.clone();
                    let request = request.clone();
                    let full_subject = full_subject.clone();
                    Some(Arc::new(move |state| {
                        step_outbound_request_chain(
                            client.clone(),
                            chain.clone(),
                            index + 1,
                            state,
                            request.clone(),
                            full_subject.clone(),
                            timeout,
                            path_deadline,
                        )
                    }) as RequestNextFn)
                };
                let mut context_request = request.as_ref().clone();
                context_request.priority = local_entry_cursor(&chain, index, request.priority);
                let context = RequestContext::new(
                    &context_request,
                    full_subject.to_string(),
                    state.clone(),
                    next,
                    next_called.clone(),
                );

                handler(context.clone()).await?;

                let should_auto_advance = {
                    let state = state
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    !next_called.load(Ordering::SeqCst) && !state.has_result
                };

                if should_auto_advance {
                    step_outbound_request_chain(
                        client,
                        chain,
                        index + 1,
                        state,
                        request,
                        full_subject,
                        timeout,
                        path_deadline,
                    )
                    .await?;
                }
            }
            RequestChainEntry::Remote { .. } => {
                let mut remote_request = request.as_ref().clone();
                remote_request.payload = state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .payload
                    .clone();
                remote_request.priority = remote_entry_cursor(&chain, index, request.priority);

                match client
                    .send_remote_request(remote_request, timeout, path_deadline)
                    .await
                {
                    Ok(result) => {
                        let mut state = state
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        state.result = Some(result);
                        state.has_result = true;
                    }
                    Err(BusClientError::Bus(error))
                        if is_no_handler_error_for_subject(&error, &full_subject) =>
                    {
                        step_outbound_request_chain(
                            client,
                            chain,
                            index + 1,
                            state,
                            request,
                            full_subject,
                            timeout,
                            path_deadline,
                        )
                        .await?;
                    }
                    Err(error) => return Err(bus_client_error_for_context(error, &full_subject)),
                }
            }
        }

        Ok(())
    })
}

fn build_post_removal_snapshot(
    event_handlers: &HashMap<String, HashMap<usize, EventHandlerEntry>>,
    request_handlers: &HashMap<String, BTreeMap<i64, Vec<RequestHandlerEntry>>>,
    event_filter: impl Fn(&str, &HashMap<usize, EventHandlerEntry>) -> bool,
    request_priorities: impl Fn(&str, &BTreeMap<i64, Vec<RequestHandlerEntry>>) -> Vec<i64>,
) -> LocalSubscriptionSnapshot {
    let mut snapshot = LocalSubscriptionSnapshot::default();
    for (subject, handlers) in event_handlers.iter() {
        if event_filter(subject, handlers) {
            snapshot.subjects.insert(subject.clone(), Vec::new());
            snapshot.delivery_classes.insert(
                subject.clone(),
                aggregate_delivery_classes(handlers.values().map(|entry| entry.delivery_class)),
            );
        }
    }
    for (subject, handlers) in request_handlers.iter() {
        let priorities = request_priorities(subject, handlers);
        if !priorities.is_empty() || snapshot.subjects.contains_key(subject) {
            snapshot.subjects.insert(subject.clone(), priorities);
            snapshot.delivery_classes.insert(
                subject.clone(),
                aggregate_delivery_classes(
                    snapshot
                        .delivery_classes
                        .get(subject)
                        .copied()
                        .into_iter()
                        .chain(
                            handlers
                                .values()
                                .flatten()
                                .map(|entry| entry.delivery_class),
                        ),
                ),
            );
        }
    }
    snapshot
}

/// Combine registrations for one subject with a fail-closed routing rule.
fn aggregate_delivery_classes(
    classes: impl IntoIterator<Item = SubscriptionDeliveryClass>,
) -> SubscriptionDeliveryClass {
    if classes
        .into_iter()
        .any(|class| class == SubscriptionDeliveryClass::FirstHopOnly)
    {
        SubscriptionDeliveryClass::FirstHopOnly
    } else {
        SubscriptionDeliveryClass::Relayable
    }
}

fn request_handler_priorities(handlers: &BTreeMap<i64, Vec<RequestHandlerEntry>>) -> Vec<i64> {
    handlers
        .iter()
        .rev()
        .flat_map(|(&priority, entries)| std::iter::repeat(priority).take(entries.len()))
        .collect()
}

fn request_handler_priorities_without(
    handlers: &BTreeMap<i64, Vec<RequestHandlerEntry>>,
    removed_priority: i64,
    removed_handler_id: usize,
) -> Vec<i64> {
    handlers
        .iter()
        .rev()
        .flat_map(|(&priority, entries)| {
            entries
                .iter()
                .filter(move |entry| {
                    priority != removed_priority || entry.handler_id != removed_handler_id
                })
                .map(move |_| priority)
        })
        .collect()
}

fn remove_request_handler_entry(
    handlers: &mut BTreeMap<i64, Vec<RequestHandlerEntry>>,
    removed_priority: i64,
    removed_handler_id: usize,
) {
    if let Some(entries) = handlers.get_mut(&removed_priority) {
        entries.retain(|entry| entry.handler_id != removed_handler_id);
        if entries.is_empty() {
            handlers.remove(&removed_priority);
        }
    }
}

fn local_entry_cursor(
    chain: &[RequestChainEntry],
    index: usize,
    initial_cursor: Option<i64>,
) -> Option<i64> {
    let current_priority = chain[index].priority();
    chain[..index]
        .iter()
        .rev()
        .map(RequestChainEntry::priority)
        .find(|priority| *priority > current_priority)
        .or(initial_cursor)
}

fn remote_entry_cursor(
    chain: &[RequestChainEntry],
    index: usize,
    initial_cursor: Option<i64>,
) -> Option<i64> {
    if index == 0 {
        return initial_cursor;
    }

    let previous_priority = chain[index - 1].priority();
    let current_priority = chain[index].priority();
    if previous_priority == current_priority {
        Some(previous_priority.saturating_add(1))
    } else {
        Some(previous_priority)
    }
}

fn bus_client_error_for_context(error: BusClientError, full_subject: &str) -> BusTransportError {
    match error {
        BusClientError::Bus(error) => error,
        error => BusTransportError {
            message: error.to_string(),
            code: Some("REMOTE_REQUEST_FAILED".to_string()),
            subject: Some(full_subject.to_string()),
            data: None,
        },
    }
}

fn duration_millis(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

fn request_path_timeout(timeout: Duration, deadline: u64) -> BusResult<Duration> {
    let remaining_ms = deadline.saturating_sub(now_millis());
    if remaining_ms == 0 {
        return Err(BusClientError::RequestTimeout(Duration::from_millis(
            remaining_ms,
        )));
    }
    let deadline_timeout = Duration::from_millis(remaining_ms);
    if timeout.is_zero() {
        return Ok(deadline_timeout);
    }
    Ok(timeout.min(deadline_timeout))
}

fn deadline_after(duration: Duration) -> u64 {
    now_millis().saturating_add(duration_millis(duration))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn is_no_handler_error_for_subject(error: &BusTransportError, full_subject: &str) -> bool {
    error.code.as_deref() == Some("NO_HANDLER") && error.subject.as_deref() == Some(full_subject)
}

fn split_exact_full_subject(full_subject: &str) -> BusResult<(&str, &str)> {
    if full_subject.contains('*') {
        return Err(BusClientError::InvalidSubject(full_subject.to_string()));
    }

    full_subject
        .split_once('.')
        .filter(|(namespace, subject)| !namespace.is_empty() && !subject.is_empty())
        .ok_or_else(|| BusClientError::InvalidSubject(full_subject.to_string()))
}

fn validate_subscription_pattern(pattern: &str) -> BusResult<()> {
    if pattern == "*" {
        return Ok(());
    }

    if let Some(prefix) = pattern.strip_suffix(":*") {
        if !prefix.is_empty() && !prefix.contains('*') {
            return Ok(());
        }
    }

    if let Some(prefix) = pattern.strip_suffix(".*") {
        if !prefix.is_empty() && !prefix.contains('*') {
            return Ok(());
        }
    }

    split_exact_full_subject(pattern).map(|_| ())
}

fn matches_subscription(subject: &str, pattern: &str) -> bool {
    if pattern == "*" {
        return true;
    }

    if !pattern.ends_with('*') {
        return subject == pattern;
    }

    if let Some(prefix) = pattern.strip_suffix(":*") {
        return subject.len() > prefix.len()
            && subject.as_bytes().get(prefix.len()) == Some(&b':')
            && subject.starts_with(prefix);
    }

    if let Some(prefix) = pattern.strip_suffix(".*") {
        return subject.len() > prefix.len()
            && subject.as_bytes().get(prefix.len()) == Some(&b'.')
            && subject.starts_with(prefix);
    }

    false
}

fn join_full_subject(namespace: &str, subject: &str) -> String {
    format!("{namespace}.{subject}")
}

fn new_message_id() -> String {
    Uuid::new_v4().to_string()
}
