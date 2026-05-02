use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::net::TcpStream;
use tokio::sync::{oneshot, Mutex, Semaphore};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use uuid::Uuid;

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;
type WsWriter = SplitSink<WsStream, Message>;
type WsReader = SplitStream<WsStream>;
type BoxedEventFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
type EventHandler = Arc<dyn Fn(EventMessage) -> BoxedEventFuture + Send + Sync>;
type BoxedRequestFuture = Pin<Box<dyn Future<Output = Result<Value, BusTransportError>> + Send>>;
type RequestHandler = Arc<dyn Fn(RequestMessage) -> BoxedRequestFuture + Send + Sync>;
const MAX_INBOUND_HANDLER_TASKS: usize = 64;

/// SDK result type.
pub type BusResult<T> = Result<T, BusClientError>;

/// WebSocket Makaio bus participant.
#[derive(Clone)]
pub struct BusClient {
    inner: Arc<ClientInner>,
    read_task: Arc<Mutex<Option<JoinHandle<()>>>>,
    url: Arc<String>,
}

struct ClientInner {
    control_plane: Mutex<()>,
    writer: Mutex<Option<WsWriter>>,
    pending: Mutex<HashMap<String, oneshot::Sender<ResponseMessage>>>,
    event_handlers: Mutex<HashMap<String, HashMap<usize, EventHandler>>>,
    request_handlers: Mutex<HashMap<String, BTreeMap<i64, RequestHandler>>>,
    background_tasks: Mutex<Vec<JoinHandle<()>>>,
    inbound_handler_slots: Arc<Semaphore>,
    next_handler_id: Mutex<usize>,
}

enum SubjectAdvertisementAction {
    None,
    ReplaceSnapshot(BTreeMap<String, Vec<i64>>),
    Unsubscribe(Vec<i64>),
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
    active: bool,
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

/// Errors surfaced by the Rust SDK runtime.
#[derive(Debug, Error)]
pub enum BusClientError {
    #[error("websocket error: {0}")]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SubscribeMessage {
    pub subjects: BTreeMap<String, Vec<i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filters: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UnsubscribeMessage {
    pub subjects: BTreeMap<String, Vec<i64>>,
}

impl BusClient {
    /// Connects to a Makaio bus WebSocket endpoint.
    pub async fn connect(url: &str) -> BusResult<Self> {
        let (stream, _) = connect_async(url).await?;
        let (writer, reader) = stream.split();
        let client = Self {
            inner: Arc::new(ClientInner {
                control_plane: Mutex::new(()),
                writer: Mutex::new(Some(writer)),
                pending: Mutex::new(HashMap::new()),
                event_handlers: Mutex::new(HashMap::new()),
                request_handlers: Mutex::new(HashMap::new()),
                background_tasks: Mutex::new(Vec::new()),
                inbound_handler_slots: Arc::new(Semaphore::new(MAX_INBOUND_HANDLER_TASKS)),
                next_handler_id: Mutex::new(0),
            }),
            read_task: Arc::new(Mutex::new(None)),
            url: Arc::new(url.to_string()),
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

    async fn reconnect_locked(&self) -> BusResult<()> {
        if let Some(task) = self.read_task.lock().await.take() {
            task.abort();
            let _ = task.await;
        }

        self.fail_pending_requests(BusTransportError::connection_closed())
            .await;
        self.abort_background_tasks().await;

        let _ = self.disconnect_writer().await;

        let (stream, _) = connect_async(self.url.as_str()).await?;
        let (mut writer, reader) = stream.split();

        // Replay rollback only covers transport-level send failures here. The current protocol has
        // no subscribe acknowledgement, so reconnect completion still means "frames were written",
        // not "the server durably applied every replayed subscription".
        self.replay_local_subscriptions_with_writer(&mut writer)
            .await?;

        *self.inner.writer.lock().await = Some(writer);
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
        self.send_message(message).await?;
        Ok(message_id)
    }

    /// Sends a request and resolves exactly one response matching the correlation ID.
    pub async fn request<P>(&self, full_subject: &str, payload: P) -> BusResult<Value>
    where
        P: Serialize,
    {
        self.request_with_options(full_subject, payload, RequestOptions::default())
            .await
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
        let (sender, receiver) = oneshot::channel();
        self.inner
            .pending
            .lock()
            .await
            .insert(correlation_id.clone(), sender);

        let message = BusMessage::Request(RequestMessage {
            namespace: namespace.to_string(),
            subject: subject.to_string(),
            payload,
            correlation_id: correlation_id.clone(),
            message_id: new_message_id(),
            timeout: Some(options.timeout.as_millis().try_into().unwrap_or(u64::MAX)),
            priority: options.priority,
            deadline: options.deadline,
        });

        let await_response = async {
            self.send_message(message).await?;
            receiver
                .await
                .map_err(|_| BusClientError::ResponseChannelClosed)
        };

        let response = if options.timeout.is_zero() {
            match await_response.await {
                Ok(response) => response,
                Err(error) => {
                    self.inner.pending.lock().await.remove(&correlation_id);
                    return Err(error);
                }
            }
        } else {
            match tokio::time::timeout(options.timeout, await_response).await {
                Ok(Ok(response)) => response,
                Ok(Err(error)) => {
                    self.inner.pending.lock().await.remove(&correlation_id);
                    return Err(error);
                }
                Err(_) => {
                    self.inner.pending.lock().await.remove(&correlation_id);
                    return Err(BusClientError::RequestTimeout(options.timeout));
                }
            }
        };

        if let Some(error) = response.error {
            return Err(BusClientError::Bus(error));
        }

        Ok(response.result.unwrap_or(Value::Null))
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
                .insert(handler_id, handler.clone());
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
    pub async fn on_request_with_priority<F, Fut>(
        &self,
        full_subject: &str,
        priority: i64,
        handler: F,
    ) -> BusResult<RequestHandlerRegistration>
    where
        F: Fn(RequestMessage) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, BusTransportError>> + Send + 'static,
    {
        split_exact_full_subject(full_subject)?;
        let handler: RequestHandler = Arc::new(move |request| Box::pin(handler(request)));
        let _control_plane = self.inner.control_plane.lock().await;

        {
            let mut writer = self.inner.writer.lock().await;
            let writer = writer.as_mut().ok_or(BusClientError::NotConnected)?;

            {
                let mut handlers = self.inner.request_handlers.lock().await;
                let subject_handlers = handlers.entry(full_subject.to_string()).or_default();
                if subject_handlers.contains_key(&priority) {
                    return Err(BusClientError::DuplicateRequestHandler(
                        full_subject.to_string(),
                    ));
                }
                subject_handlers.insert(priority, handler.clone());
            }

            if let Err(error) = self.send_subscribe_snapshot_with_writer(writer).await {
                let mut handlers = self.inner.request_handlers.lock().await;
                if let Some(subject_handlers) = handlers.get_mut(full_subject) {
                    subject_handlers.remove(&priority);
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
            active: true,
        })
    }

    /// Registers one request handler for an exact full subject and advertises it with priority `0`.
    pub async fn on_request<F, Fut>(
        &self,
        full_subject: &str,
        handler: F,
    ) -> BusResult<RequestHandlerRegistration>
    where
        F: Fn(RequestMessage) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, BusTransportError>> + Send + 'static,
    {
        self.on_request_with_priority(full_subject, 0, handler)
            .await
    }

    async fn read_loop(&self, mut reader: WsReader) {
        while let Some(message) = reader.next().await {
            let Ok(message) = message else {
                break;
            };

            let text = match message_text(message) {
                Ok(Some(text)) => text,
                Ok(None) => continue,
                Err(()) => break,
            };

            // Conformance-focused clients currently fail fast on malformed or unknown wire
            // envelopes so pending callers do not hang behind silently ignored frames.
            let Ok(bus_message) = serde_json::from_str::<BusMessage>(&text) else {
                break;
            };

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
                BusMessage::Broadcast(_)
                | BusMessage::BroadcastResponse(_)
                | BusMessage::Subscribe(_)
                | BusMessage::Unsubscribe(_)
                | BusMessage::SubscribeSyncComplete {} => {}
            }
        }

        let _ = self.disconnect_writer().await;
        self.fail_pending_requests(BusTransportError::connection_closed())
            .await;
    }

    async fn dispatch_event(&self, event: EventMessage) {
        let full_subject = join_full_subject(&event.namespace, &event.subject);
        let handlers = {
            let handlers = self.inner.event_handlers.lock().await;
            handlers
                .iter()
                .filter(|(pattern, _)| matches_subscription(&full_subject, pattern))
                .flat_map(|(_, handlers)| handlers.values().cloned())
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
        let handler = {
            let handlers = self.inner.request_handlers.lock().await;
            handlers
                .get(&full_subject)
                .and_then(|handlers| match request.priority {
                    Some(cursor) => handlers
                        .range(..cursor)
                        .next_back()
                        .map(|(_, handler)| handler.clone()),
                    None => handlers
                        .iter()
                        .next_back()
                        .map(|(_, handler)| handler.clone()),
                })
        };

        let response = match handler {
            Some(handler) => match handler(request.clone()).await {
                Ok(result) => ResponseMessage {
                    correlation_id: request.correlation_id,
                    result: Some(result),
                    error: None,
                },
                Err(error) => ResponseMessage {
                    correlation_id: request.correlation_id,
                    result: None,
                    error: Some(error),
                },
            },
            None => ResponseMessage {
                correlation_id: request.correlation_id,
                result: None,
                error: Some(BusTransportError::no_handler(full_subject)),
            },
        };

        let _ = self.send_message(BusMessage::Response(response)).await;
    }

    async fn send_message(&self, message: BusMessage) -> BusResult<()> {
        // The websocket sink is single-writer, so sends are intentionally serialized here.
        // `close()` and `reconnect()` wait for the in-flight frame rather than racing ownership
        // of the sink; moving to a channel-backed write task would be a larger transport redesign.
        let mut writer = self.inner.writer.lock().await;
        let writer = writer.as_mut().ok_or(BusClientError::NotConnected)?;
        let text = serde_json::to_string(&message)?;
        writer.send(Message::Text(text.into())).await?;
        Ok(())
    }

    async fn disconnect_writer(&self) -> BusResult<()> {
        match self.inner.writer.lock().await.take() {
            Some(mut writer) => writer.close().await.map_err(BusClientError::from),
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
        writer: &mut WsWriter,
        full_subject: &str,
        action: SubjectAdvertisementAction,
    ) -> BusResult<()> {
        match action {
            SubjectAdvertisementAction::None => Ok(()),
            SubjectAdvertisementAction::ReplaceSnapshot(subjects) => {
                self.send_message_with_writer(
                    writer,
                    BusMessage::Subscribe(SubscribeMessage {
                        subjects,
                        filters: None,
                    }),
                )
                .await
            }
            SubjectAdvertisementAction::Unsubscribe(priorities) => {
                let mut subjects = BTreeMap::new();
                subjects.insert(full_subject.to_string(), priorities);
                self.send_message_with_writer(
                    writer,
                    BusMessage::Unsubscribe(UnsubscribeMessage { subjects }),
                )
                .await
            }
        }
    }

    async fn send_message_with_writer(
        &self,
        writer: &mut WsWriter,
        message: BusMessage,
    ) -> BusResult<()> {
        let text = serde_json::to_string(&message)?;
        writer.send(Message::Text(text.into())).await?;
        Ok(())
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

    async fn snapshot_local_subscriptions(&self) -> BTreeMap<String, Vec<i64>> {
        let mut subjects = BTreeMap::new();

        {
            let handlers = self.inner.event_handlers.lock().await;
            for subject in handlers.keys() {
                subjects.insert(subject.clone(), Vec::new());
            }
        }

        {
            let handlers = self.inner.request_handlers.lock().await;
            for (subject, priorities) in handlers.iter() {
                subjects.insert(
                    subject.clone(),
                    descending_priorities(priorities.keys().copied()),
                );
            }
        }

        subjects
    }

    async fn send_subscribe_snapshot_with_writer(&self, writer: &mut WsWriter) -> BusResult<()> {
        let subjects = self.snapshot_local_subscriptions().await;
        if subjects.is_empty() {
            return Ok(());
        }

        self.send_message_with_writer(
            writer,
            BusMessage::Subscribe(SubscribeMessage {
                subjects,
                filters: None,
            }),
        )
        .await
    }

    async fn replay_local_subscriptions_with_writer(&self, writer: &mut WsWriter) -> BusResult<()> {
        self.send_subscribe_snapshot_with_writer(writer).await
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
            .map(|handlers| handlers.keys().copied().collect::<Vec<_>>())
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

        let mut subjects = BTreeMap::new();
        for (subject, handlers) in event_handlers.iter() {
            let has_handlers = if subject == full_subject {
                handlers
                    .keys()
                    .any(|existing_handler_id| *existing_handler_id != handler_id)
            } else {
                !handlers.is_empty()
            };
            if has_handlers {
                subjects.insert(subject.clone(), Vec::new());
            }
        }

        for (subject, handlers) in request_handlers.iter() {
            subjects.insert(
                subject.clone(),
                descending_priorities(handlers.keys().copied()),
            );
        }

        if subjects.contains_key(full_subject) {
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
    ) -> SubjectAdvertisementAction {
        let event_handlers = self.inner.event_handlers.lock().await;
        let request_handlers = self.inner.request_handlers.lock().await;

        let mut subjects = BTreeMap::new();
        for (subject, handlers) in event_handlers.iter() {
            if !handlers.is_empty() {
                subjects.insert(subject.clone(), Vec::new());
            }
        }

        for (subject, handlers) in request_handlers.iter() {
            let priorities = if subject == full_subject {
                descending_priorities(
                    handlers
                        .keys()
                        .copied()
                        .filter(|priority| *priority != removed_priority),
                )
            } else {
                descending_priorities(handlers.keys().copied())
            };
            if !priorities.is_empty() || subjects.contains_key(subject) {
                subjects.insert(subject.clone(), priorities);
            }
        }

        if subjects.contains_key(full_subject) {
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
    ) -> SubjectAdvertisementAction {
        let event_handlers = self.inner.event_handlers.lock().await;
        let mut request_handlers = self.inner.request_handlers.lock().await;

        if let Some(subject_handlers) = request_handlers.get_mut(full_subject) {
            subject_handlers.remove(&removed_priority);
            if subject_handlers.is_empty() {
                request_handlers.remove(full_subject);
            }
        }

        let has_event_handlers = event_handlers
            .get(full_subject)
            .is_some_and(|handlers| !handlers.is_empty());
        let request_priorities = request_handlers
            .get(full_subject)
            .map(|handlers| descending_priorities(handlers.keys().copied()))
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
                    .preview_request_handler_removal(&self.subject, self.priority)
                    .await;
                self.client
                    .send_subject_action_with_writer(writer, &self.subject, action)
                    .await?;
            }
        }
        let _ = self
            .client
            .remove_request_handler_action(&self.subject, self.priority)
            .await;
        self.active = false;
        Ok(())
    }
}

fn message_text(message: Message) -> Result<Option<String>, ()> {
    match message {
        Message::Text(text) => Ok(Some(text.to_string())),
        Message::Binary(bytes) => String::from_utf8(bytes.to_vec()).map(Some).map_err(|_| ()),
        Message::Ping(_) | Message::Pong(_) | Message::Close(_) | Message::Frame(_) => Ok(None),
    }
}

fn descending_priorities(priorities: impl IntoIterator<Item = i64>) -> Vec<i64> {
    let mut priorities = priorities.into_iter().collect::<Vec<_>>();
    priorities.sort_unstable_by(|left, right| right.cmp(left));
    priorities
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
        return subject.starts_with(&format!("{prefix}:"));
    }

    if let Some(prefix) = pattern.strip_suffix(".*") {
        return subject.starts_with(&format!("{prefix}."));
    }

    false
}

fn join_full_subject(namespace: &str, subject: &str) -> String {
    format!("{namespace}.{subject}")
}

fn new_message_id() -> String {
    Uuid::new_v4().to_string()
}
