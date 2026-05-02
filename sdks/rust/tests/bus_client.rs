use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use makaio_bus_sdk::bus::{
    BroadcastResponseMessage, BusMessage, BusTransportError, EventMessage, HeartbeatMessage,
    RequestMessage, RequestOptions, ResponseMessage,
};
use makaio_bus_sdk::generated::subjects::{self, SubjectKind, SUBJECTS};
use makaio_bus_sdk::{BusClient, BusClientError};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, Notify};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_async, WebSocketStream};

struct TestServer {
    url: String,
    task: tokio::task::JoinHandle<()>,
}

impl TestServer {
    async fn assert_completed(self) {
        tokio::time::timeout(Duration::from_secs(1), self.task)
            .await
            .expect("test server task should finish")
            .expect("test server task should complete without panicking");
    }
}

#[test]
fn serializes_and_deserializes_wire_envelopes() {
    let event = serde_json::from_value::<BusMessage>(json!({
        "type": "event",
        "namespace": "agent",
        "subject": "message",
        "payload": { "content": "hello" },
        "messageId": "msg-1",
    }))
    .expect("event envelope should deserialize");

    assert_eq!(
        event,
        BusMessage::Event(EventMessage {
            namespace: "agent".to_string(),
            subject: "message".to_string(),
            payload: json!({ "content": "hello" }),
            message_id: "msg-1".to_string(),
            correlation_id: None,
        })
    );

    let broadcast_response = BusMessage::BroadcastResponse(BroadcastResponseMessage {
        correlation_id: "corr-1".to_string(),
        results: None,
        error: Some(BusTransportError {
            message: "failed".to_string(),
            code: Some("TEST".to_string()),
            subject: Some("agent.message".to_string()),
            data: Some(json!({ "trace": "x" })),
        }),
    });

    assert_eq!(
        serde_json::to_value(broadcast_response).expect("broadcast response should serialize"),
        json!({
            "type": "broadcast-response",
            "correlationId": "corr-1",
            "error": {
                "message": "failed",
                "code": "TEST",
                "subject": "agent.message",
                "data": { "trace": "x" },
            },
        })
    );

    assert_eq!(
        serde_json::to_value(BusMessage::SubscribeSyncComplete {})
            .expect("sync complete should serialize"),
        json!({ "type": "subscribe-sync-complete" })
    );
}

#[test]
fn subject_constants_match_manifest_catalog() {
    assert_eq!(subjects::agent::MESSAGE, "agent.message");
    assert_eq!(subjects::approval::REQUEST, "approval.request");
    assert_eq!(subjects::tool::EXECUTE, "tool.execute");
    assert_eq!(
        SUBJECTS.len(),
        protocol_manifest()["subjects"]
            .as_array()
            .expect("protocol manifest should expose a subjects array")
            .len()
    );

    let approval_request = SUBJECTS
        .iter()
        .find(|subject| subject.full_subject == subjects::approval::REQUEST)
        .expect("approval.request should be present");
    assert_eq!(approval_request.kind, SubjectKind::Request);
    assert_eq!(approval_request.namespace, "approval");
    assert_eq!(approval_request.subject, "request");
}

#[test]
fn conformance_message_refs_resolve_and_deserialize() {
    let cases = conformance_cases();
    let messages = conformance_messages();

    for case in cases["cases"]
        .as_array()
        .expect("conformance cases should be an array")
    {
        let case_id = case["id"].as_str().expect("case should have an id");
        for wire_entry in case["wire"]
            .as_array()
            .expect("conformance case should have wire entries")
        {
            let message_ref = wire_entry["messageRef"]
                .as_str()
                .expect("wire entry should reference a message");
            let message = messages
                .get(message_ref)
                .unwrap_or_else(|| panic!("{case_id} references missing fixture {message_ref}"));
            serde_json::from_value::<BusMessage>(message.clone()).unwrap_or_else(|error| {
                panic!("{message_ref} should deserialize as BusMessage: {error}")
            });
        }
    }
}

#[test]
fn conformance_assertions_use_supported_kinds_and_shapes() {
    let cases = conformance_cases();
    let messages = conformance_messages();

    for case in cases["cases"]
        .as_array()
        .expect("conformance cases should be an array")
    {
        let case_id = case["id"].as_str().expect("case should have an id");
        for assertion in case["assertions"]
            .as_array()
            .expect("conformance case should have assertions")
        {
            assert_conformance_assertion_shape(case_id, assertion, &messages);
        }
    }
}

#[tokio::test]
async fn subscribe_and_emit_use_expected_event_framing() {
    let (seen_tx, mut seen_rx) = mpsc::unbounded_channel();
    let server = serve_once(move |mut ws| async move {
        let subscribe = read_bus_message(&mut ws).await;
        seen_tx
            .send(subscribe)
            .expect("subscribe frame should be sent");

        let event = read_bus_message(&mut ws).await;
        seen_tx.send(event).expect("event frame should be sent");
    })
    .await;

    let bus = BusClient::connect(&server.url)
        .await
        .expect("client should connect");
    let _subscription = bus
        .subscribe(subjects::agent::MESSAGE, |_| async {})
        .await
        .expect("subscribe should succeed");

    bus.emit(
        subjects::agent::MESSAGE,
        json!({
            "agentId": "agent-1",
            "adapterId": "adapter-1",
            "adapterName": "test",
            "adapterSessionId": "adapter-session-1",
            "content": "hello",
        }),
    )
    .await
    .expect("event should be emitted");

    assert_eq!(
        next_seen_message(&mut seen_rx).await,
        json!({
            "type": "subscribe",
            "subjects": {
                "agent.message": [],
            },
        })
    );

    let event = next_seen_message(&mut seen_rx).await;
    assert_eq!(event["type"], "event");
    assert_eq!(event["namespace"], "agent");
    assert_eq!(event["subject"], "message");
    assert_eq!(event["payload"]["content"], "hello");
    assert!(event["messageId"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));

    bus.close().await.expect("client should close");
    server.assert_completed().await;
}

#[tokio::test]
async fn wildcard_subscription_dispatches_matching_agent_events() {
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<Value>();
    let server = serve_once(|mut ws| async move {
        let subscribe = read_bus_message(&mut ws).await;
        assert_eq!(
            serde_json::to_value(subscribe).expect("subscribe should serialize"),
            conformance_message("subscribe.agent.wildcard")
        );

        send_bus_message(
            &mut ws,
            serde_json::from_value(conformance_message("event.agent.complete"))
                .expect("event fixture should deserialize"),
        )
        .await;
        send_bus_message(
            &mut ws,
            BusMessage::Event(EventMessage {
                namespace: "tool".to_string(),
                subject: "started".to_string(),
                payload: json!({ "toolName": "ignored" }),
                message_id: "msg-tool".to_string(),
                correlation_id: None,
            }),
        )
        .await;
    })
    .await;

    let bus = BusClient::connect(&server.url)
        .await
        .expect("client should connect");
    let _subscription = bus
        .subscribe("agent.*", move |event| {
            let event_tx = event_tx.clone();
            async move {
                event_tx
                    .send(json!({ "subject": event.subject, "payload": event.payload }))
                    .expect("event payload should be delivered");
            }
        })
        .await
        .expect("wildcard subscribe should succeed");

    assert_eq!(
        next_payload(&mut event_rx).await,
        json!({
            "subject": "complete",
            "payload": conformance_message("event.agent.complete")["payload"],
        })
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), event_rx.recv())
            .await
            .is_err(),
        "non-matching events must not be delivered to an agent.* subscription"
    );

    bus.close().await.expect("client should close");
    server.assert_completed().await;
}

#[tokio::test]
async fn global_wildcard_subscription_is_publicly_supported() {
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<Value>();
    let server = serve_once(|mut ws| async move {
        let subscribe = read_bus_message(&mut ws).await;
        assert_eq!(
            serde_json::to_value(subscribe).expect("subscribe should serialize"),
            json!({
                "type": "subscribe",
                "subjects": {
                    "*": [],
                },
            })
        );

        send_bus_message(
            &mut ws,
            BusMessage::Event(EventMessage {
                namespace: "tool".to_string(),
                subject: "started".to_string(),
                payload: json!({ "toolName": "example" }),
                message_id: "msg-global".to_string(),
                correlation_id: None,
            }),
        )
        .await;
    })
    .await;

    let bus = BusClient::connect(&server.url)
        .await
        .expect("client should connect");
    let _subscription = bus
        .subscribe("*", move |event| {
            let event_tx = event_tx.clone();
            async move {
                event_tx
                    .send(json!({ "namespace": event.namespace, "subject": event.subject }))
                    .expect("event should be delivered");
            }
        })
        .await
        .expect("global wildcard subscribe should succeed");

    assert_eq!(
        next_payload(&mut event_rx).await,
        json!({ "namespace": "tool", "subject": "started" })
    );

    bus.close().await.expect("client should close");
    server.assert_completed().await;
}

#[tokio::test]
async fn namespace_wildcard_subscription_dispatches_child_namespace_events() {
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<Value>();
    let server = serve_once(|mut ws| async move {
        let subscribe = read_bus_message(&mut ws).await;
        assert_eq!(
            serde_json::to_value(subscribe).expect("subscribe should serialize"),
            json!({
                "type": "subscribe",
                "subjects": {
                    "adapter:*": [],
                },
            })
        );

        send_bus_message(
            &mut ws,
            BusMessage::Event(EventMessage {
                namespace: "adapter:claudeCode".to_string(),
                subject: "initialized".to_string(),
                payload: json!({ "adapter": "claude" }),
                message_id: "msg-child-namespace".to_string(),
                correlation_id: None,
            }),
        )
        .await;
        send_bus_message(
            &mut ws,
            BusMessage::Event(EventMessage {
                namespace: "adapter".to_string(),
                subject: "log".to_string(),
                payload: json!({ "adapter": "root" }),
                message_id: "msg-root-namespace".to_string(),
                correlation_id: None,
            }),
        )
        .await;
    })
    .await;

    let bus = BusClient::connect(&server.url)
        .await
        .expect("client should connect");
    let _subscription = bus
        .subscribe("adapter:*", move |event| {
            let event_tx = event_tx.clone();
            async move {
                event_tx
                    .send(json!({ "namespace": event.namespace, "subject": event.subject }))
                    .expect("event should be delivered");
            }
        })
        .await
        .expect("namespace wildcard subscribe should succeed");

    assert_eq!(
        next_payload(&mut event_rx).await,
        json!({ "namespace": "adapter:claudeCode", "subject": "initialized" })
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), event_rx.recv())
            .await
            .is_err(),
        "namespace wildcard must not match root namespace subjects"
    );

    bus.close().await.expect("client should close");
    server.assert_completed().await;
}

#[tokio::test]
async fn request_resolves_matching_correlation_response() {
    let server = serve_once(|mut ws| async move {
        let request = match read_bus_message(&mut ws).await {
            BusMessage::Request(request) => request,
            other => panic!("expected request, received {other:?}"),
        };
        assert_eq!(request.priority, Some(7));
        assert_eq!(request.deadline, Some(123_456));
        assert_eq!(request.timeout, Some(1_000));

        send_bus_message(
            &mut ws,
            BusMessage::Response(ResponseMessage {
                correlation_id: request.correlation_id,
                result: Some(json!({ "ok": true })),
                error: None,
            }),
        )
        .await;
    })
    .await;

    let bus = BusClient::connect(&server.url)
        .await
        .expect("client should connect");
    let result = bus
        .request_with_options(
            subjects::tool::LIST,
            json!({ "adapterId": "adapter-1" }),
            RequestOptions {
                timeout: Duration::from_secs(1),
                priority: Some(7),
                deadline: Some(123_456),
            },
        )
        .await
        .expect("request should resolve");

    assert_eq!(result, json!({ "ok": true }));
    bus.close().await.expect("client should close");
    server.assert_completed().await;
}

#[tokio::test]
async fn request_with_zero_timeout_preserves_wire_timeout_and_waits_locally() {
    let server = serve_once(|mut ws| async move {
        let request = match read_bus_message(&mut ws).await {
            BusMessage::Request(request) => request,
            other => panic!("expected request, received {other:?}"),
        };
        assert_eq!(request.timeout, Some(0));

        tokio::time::sleep(Duration::from_millis(100)).await;
        send_bus_message(
            &mut ws,
            BusMessage::Response(ResponseMessage {
                correlation_id: request.correlation_id,
                result: Some(json!({ "ok": true })),
                error: None,
            }),
        )
        .await;
    })
    .await;

    let bus = BusClient::connect(&server.url)
        .await
        .expect("client should connect");
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        bus.request_with_options(
            subjects::tool::LIST,
            json!({ "adapterId": "adapter-1" }),
            RequestOptions {
                timeout: Duration::ZERO,
                priority: None,
                deadline: None,
            },
        ),
    )
    .await
    .expect("request should resolve without a local timeout")
    .expect("request should succeed");

    assert_eq!(result, json!({ "ok": true }));
    bus.close().await.expect("client should close");
    server.assert_completed().await;
}

#[tokio::test]
async fn server_disconnect_fails_pending_request_without_waiting_for_timeout() {
    let (request_seen_tx, request_seen_rx) = oneshot::channel();
    let server = serve_once(move |mut ws| async move {
        let _request = read_bus_message(&mut ws).await;
        let _ = request_seen_tx.send(());
        let _ = ws.next().await;
    })
    .await;

    let bus = BusClient::connect(&server.url)
        .await
        .expect("client should connect");
    let request_task = tokio::spawn({
        let bus = bus.clone();
        async move {
            bus.request_with_options(
                subjects::tool::LIST,
                json!({ "adapterId": "adapter-1" }),
                RequestOptions {
                    timeout: Duration::from_secs(60),
                    priority: None,
                    deadline: None,
                },
            )
            .await
        }
    });

    request_seen_rx
        .await
        .expect("server should observe the request");
    bus.close().await.expect("client should close");

    let error = tokio::time::timeout(Duration::from_secs(1), request_task)
        .await
        .expect("request should fail when close drains pending requests")
        .expect("request task should not panic")
        .expect_err("request should fail when the client closes");

    assert_connection_closed_error(error);
    server.assert_completed().await;
}

#[tokio::test]
async fn request_handler_priority_snapshots_update_and_remove_priorities() {
    let (seen_tx, mut seen_rx) = mpsc::unbounded_channel();
    let server = serve_once(move |mut ws| async move {
        while let Some(Ok(message)) = ws.next().await {
            if let Some(value) = wire_value(message) {
                seen_tx.send(value).expect("wire frame should be sent");
            }
        }
    })
    .await;

    let bus = BusClient::connect(&server.url)
        .await
        .expect("client should connect");
    let mut first = bus
        .on_request_with_priority(subjects::tool::EXECUTE, 100, |_| async {
            Ok(json!({ "ok": 100 }))
        })
        .await
        .expect("first handler should register");
    let mut second = bus
        .on_request_with_priority(subjects::tool::EXECUTE, 250, |_| async {
            Ok(json!({ "ok": 250 }))
        })
        .await
        .expect("second handler should register");

    assert_eq!(
        next_seen_value(&mut seen_rx).await,
        json!({
            "type": "subscribe",
            "subjects": {
                "tool.execute": [100],
            },
        })
    );
    assert_eq!(
        next_seen_value(&mut seen_rx).await,
        json!({
            "type": "subscribe",
            "subjects": {
                "tool.execute": [250, 100],
            },
        })
    );

    first
        .unregister()
        .await
        .expect("first handler should unregister");
    assert_eq!(
        next_seen_value(&mut seen_rx).await,
        json!({
            "type": "subscribe",
            "subjects": {
                "tool.execute": [250],
            },
        })
    );

    second
        .unregister()
        .await
        .expect("second handler should unregister");
    assert_eq!(
        next_seen_value(&mut seen_rx).await,
        json!({
            "type": "unsubscribe",
            "subjects": {
                "tool.execute": [250],
            },
        })
    );

    bus.close().await.expect("client should close");
    server.assert_completed().await;
}

#[tokio::test]
async fn request_handler_priority_cursor_dispatch_selects_highest_lower_priority() {
    let (response_seen_tx, response_seen_rx) = oneshot::channel();
    let server = serve_once(|mut ws| async move {
        let first_subscribe = read_bus_message(&mut ws).await;
        assert_eq!(
            serde_json::to_value(first_subscribe).expect("subscribe should serialize"),
            json!({
                "type": "subscribe",
                "subjects": {
                    "approval.request": [100],
                },
            })
        );

        let second_subscribe = read_bus_message(&mut ws).await;
        assert_eq!(
            serde_json::to_value(second_subscribe).expect("subscribe should serialize"),
            json!({
                "type": "subscribe",
                "subjects": {
                    "approval.request": [250, 100],
                },
            })
        );

        send_bus_message(
            &mut ws,
            BusMessage::Request(RequestMessage {
                namespace: "approval".to_string(),
                subject: "request".to_string(),
                payload: json!({ "requestId": "request-high" }),
                correlation_id: "corr-high".to_string(),
                message_id: "msg-high".to_string(),
                timeout: Some(5_000),
                priority: Some(300),
                deadline: None,
            }),
        )
        .await;

        let high_response = match read_bus_message(&mut ws).await {
            BusMessage::Response(response) => response,
            other => panic!("expected response, received {other:?}"),
        };
        assert_eq!(high_response.correlation_id, "corr-high");
        assert_eq!(high_response.result, Some(json!({ "handledBy": 250 })));
        assert!(high_response.error.is_none());

        send_bus_message(
            &mut ws,
            BusMessage::Request(RequestMessage {
                namespace: "approval".to_string(),
                subject: "request".to_string(),
                payload: json!({ "requestId": "request-low" }),
                correlation_id: "corr-low".to_string(),
                message_id: "msg-low".to_string(),
                timeout: Some(5_000),
                priority: Some(200),
                deadline: None,
            }),
        )
        .await;

        let low_response = match read_bus_message(&mut ws).await {
            BusMessage::Response(response) => response,
            other => panic!("expected response, received {other:?}"),
        };
        assert_eq!(low_response.correlation_id, "corr-low");
        assert_eq!(low_response.result, Some(json!({ "handledBy": 100 })));
        assert!(low_response.error.is_none());
        let _ = response_seen_tx.send(());
    })
    .await;

    let bus = BusClient::connect(&server.url)
        .await
        .expect("client should connect");
    let _low = bus
        .on_request_with_priority(subjects::approval::REQUEST, 100, |_request| async {
            Ok(json!({ "handledBy": 100 }))
        })
        .await
        .expect("lower priority handler should register");
    let _high = bus
        .on_request_with_priority(subjects::approval::REQUEST, 250, |_request| async {
            Ok(json!({ "handledBy": 250 }))
        })
        .await
        .expect("higher priority handler should register");

    response_seen_rx
        .await
        .expect("server should observe the priority-cursor response");
    bus.close().await.expect("client should close");
    server.assert_completed().await;
}

#[tokio::test]
async fn removing_last_request_handler_keeps_event_subscription_advertised() {
    let (seen_tx, mut seen_rx) = mpsc::unbounded_channel();
    let server = serve_once(move |mut ws| async move {
        while let Some(Ok(message)) = ws.next().await {
            if let Some(value) = wire_value(message) {
                seen_tx.send(value).expect("wire frame should be sent");
            }
        }
    })
    .await;

    let bus = BusClient::connect(&server.url)
        .await
        .expect("client should connect");
    let _subscription = bus
        .subscribe(subjects::tool::EXECUTE, |_| async {})
        .await
        .expect("event subscription should register");
    let mut handler = bus
        .on_request_with_priority(subjects::tool::EXECUTE, 10, |_| async {
            Ok(json!({ "ok": true }))
        })
        .await
        .expect("request handler should register");

    assert_eq!(
        next_seen_value(&mut seen_rx).await,
        json!({
            "type": "subscribe",
            "subjects": {
                "tool.execute": [],
            },
        })
    );
    assert_eq!(
        next_seen_value(&mut seen_rx).await,
        json!({
            "type": "subscribe",
            "subjects": {
                "tool.execute": [10],
            },
        })
    );

    handler
        .unregister()
        .await
        .expect("request handler should unregister");
    assert_eq!(
        next_seen_value(&mut seen_rx).await,
        json!({
            "type": "subscribe",
            "subjects": {
                "tool.execute": [],
            },
        })
    );

    bus.close().await.expect("client should close");
    server.assert_completed().await;
}

#[tokio::test]
async fn request_handler_registration_sends_result_response() {
    let (response_seen_tx, response_seen_rx) = oneshot::channel();
    let server = serve_once(|mut ws| async move {
        let subscribe = read_bus_message(&mut ws).await;
        assert_eq!(
            serde_json::to_value(subscribe).expect("subscribe should serialize"),
            json!({
                "type": "subscribe",
                "subjects": {
                    "tool.execute": [0],
                },
            })
        );

        send_bus_message(
            &mut ws,
            BusMessage::Request(RequestMessage {
                namespace: "tool".to_string(),
                subject: "execute".to_string(),
                payload: json!({ "toolName": "example.echo", "input": { "text": "hello" } }),
                correlation_id: "corr-handler".to_string(),
                message_id: "msg-handler".to_string(),
                timeout: None,
                priority: None,
                deadline: None,
            }),
        )
        .await;

        let response = match read_bus_message(&mut ws).await {
            BusMessage::Response(response) => response,
            other => panic!("expected response, received {other:?}"),
        };
        assert_eq!(response.correlation_id, "corr-handler");
        assert_eq!(
            response.result,
            Some(json!({ "success": true, "data": { "text": "hello" } }))
        );
        assert!(response.error.is_none());
        let _ = response_seen_tx.send(());
    })
    .await;

    let bus = BusClient::connect(&server.url)
        .await
        .expect("client should connect");
    let _handler = bus
        .on_request(subjects::tool::EXECUTE, |request| async move {
            Ok(json!({
                "success": true,
                "data": request.payload.get("input").cloned().unwrap_or(Value::Null),
            }))
        })
        .await
        .expect("handler should register");

    response_seen_rx
        .await
        .expect("server should observe the handler response");
    bus.close().await.expect("client should close");
    server.assert_completed().await;
}

#[tokio::test]
async fn request_handler_miss_sends_structured_no_handler_error() {
    let (response_seen_tx, response_seen_rx) = oneshot::channel();
    let server = serve_once(|mut ws| async move {
        send_bus_message(
            &mut ws,
            serde_json::from_value(conformance_message("request.tool.execute.no-handler"))
                .expect("request fixture should deserialize"),
        )
        .await;

        let response = match read_bus_message(&mut ws).await {
            BusMessage::Response(response) => response,
            other => panic!("expected response, received {other:?}"),
        };
        assert_eq!(
            serde_json::to_value(BusMessage::Response(response))
                .expect("response should serialize"),
            conformance_message("response.tool.execute.no-handler")
        );
        let _ = response_seen_tx.send(());
    })
    .await;

    let bus = BusClient::connect(&server.url)
        .await
        .expect("client should connect");
    response_seen_rx
        .await
        .expect("server should observe the no-handler response");
    bus.close().await.expect("client should close");
    server.assert_completed().await;
}

#[tokio::test]
async fn duplicate_request_handler_registration_is_rejected() {
    let server = serve_once(|mut ws| async move {
        let subscribe = read_bus_message(&mut ws).await;
        assert_eq!(
            serde_json::to_value(subscribe).expect("subscribe should serialize"),
            json!({
                "type": "subscribe",
                "subjects": {
                    "tool.execute": [0],
                },
            })
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    })
    .await;

    let bus = BusClient::connect(&server.url)
        .await
        .expect("client should connect");
    let _handler = bus
        .on_request(subjects::tool::EXECUTE, |_| async {
            Ok(json!({ "ok": true }))
        })
        .await
        .expect("first handler should register");

    let duplicate = bus
        .on_request(subjects::tool::EXECUTE, |_| async {
            Ok(json!({ "ok": false }))
        })
        .await;

    match duplicate {
        Err(BusClientError::DuplicateRequestHandler(subject)) => {
            assert_eq!(subject, subjects::tool::EXECUTE);
        }
        Err(error) => panic!("expected duplicate handler error, got {error}"),
        Ok(_) => panic!("second request handler should not register"),
    }

    bus.close().await.expect("client should close");
    server.assert_completed().await;
}

#[tokio::test]
async fn request_handler_registration_rejects_wildcard_patterns() {
    let server = serve_once(|_ws| async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
    })
    .await;

    let bus = BusClient::connect(&server.url)
        .await
        .expect("client should connect");

    let subject_wildcard = bus
        .on_request("agent.*", |_| async { Ok(json!({ "ok": true })) })
        .await;
    match subject_wildcard {
        Err(BusClientError::InvalidSubject(subject)) => assert_eq!(subject, "agent.*"),
        Err(error) => panic!("expected invalid subject error, got {error}"),
        Ok(_) => panic!("wildcard request handler should not register"),
    }

    let global_wildcard = bus
        .on_request("*", |_| async { Ok(json!({ "ok": true })) })
        .await;
    match global_wildcard {
        Err(BusClientError::InvalidSubject(subject)) => assert_eq!(subject, "*"),
        Err(error) => panic!("expected invalid subject error, got {error}"),
        Ok(_) => panic!("wildcard request handler should not register"),
    }

    bus.close().await.expect("client should close");
    server.assert_completed().await;
}

#[tokio::test]
async fn subscription_rejects_unmatchable_extra_wildcards() {
    let server = serve_once(|_ws| async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
    })
    .await;

    let bus = BusClient::connect(&server.url)
        .await
        .expect("client should connect");

    for pattern in ["agent.*.*", "adapter:*:*"] {
        let result = bus.subscribe(pattern, |_| async {}).await;
        match result {
            Err(BusClientError::InvalidSubject(subject)) => assert_eq!(subject, pattern),
            Err(error) => panic!("expected invalid subject error, got {error}"),
            Ok(_) => panic!("extra wildcard pattern should not register"),
        }
    }

    bus.close().await.expect("client should close");
    server.assert_completed().await;
}

#[tokio::test]
async fn heartbeat_is_ignored_by_application_handlers() {
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<Value>();
    let server = serve_once(|mut ws| async move {
        let _subscribe = read_bus_message(&mut ws).await;
        send_bus_message(
            &mut ws,
            BusMessage::Heartbeat(HeartbeatMessage { timestamp: 42 }),
        )
        .await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        send_bus_message(
            &mut ws,
            BusMessage::Event(EventMessage {
                namespace: "agent".to_string(),
                subject: "message".to_string(),
                payload: json!({ "content": "visible" }),
                message_id: "msg-visible".to_string(),
                correlation_id: None,
            }),
        )
        .await;
    })
    .await;

    let bus = BusClient::connect(&server.url)
        .await
        .expect("client should connect");
    let _subscription = bus
        .subscribe(subjects::agent::MESSAGE, move |event| {
            let event_tx = event_tx.clone();
            async move {
                event_tx
                    .send(event.payload)
                    .expect("event payload should be delivered");
            }
        })
        .await
        .expect("subscribe should succeed");

    assert_eq!(
        next_payload(&mut event_rx).await,
        json!({ "content": "visible" })
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), event_rx.recv())
            .await
            .is_err(),
        "heartbeat must not be delivered as an application event"
    );

    bus.close().await.expect("client should close");
    server.assert_completed().await;
}

#[tokio::test]
async fn broadcast_and_broadcast_response_are_silently_ignored() {
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<Value>();
    let server = serve_once(|mut ws| async move {
        let _subscribe = read_bus_message(&mut ws).await;
        // Send broadcast and broadcast-response frames
        let broadcast: BusMessage =
            serde_json::from_value(conformance_message("broadcast.tool.execute"))
                .expect("broadcast fixture should deserialize");
        send_bus_message(&mut ws, broadcast).await;
        let broadcast_response: BusMessage =
            serde_json::from_value(conformance_message("broadcast-response.tool.execute"))
                .expect("broadcast-response fixture should deserialize");
        send_bus_message(&mut ws, broadcast_response).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        // Send a real event to prove the connection is still working
        send_bus_message(
            &mut ws,
            BusMessage::Event(EventMessage {
                namespace: "tool".to_string(),
                subject: "started".to_string(),
                payload: json!({ "toolName": "visible" }),
                message_id: "msg-visible".to_string(),
                correlation_id: None,
            }),
        )
        .await;
    })
    .await;

    let bus = BusClient::connect(&server.url)
        .await
        .expect("client should connect");
    let _subscription = bus
        .subscribe(subjects::tool::STARTED, move |event| {
            let event_tx = event_tx.clone();
            async move {
                event_tx
                    .send(event.payload)
                    .expect("event payload should be delivered");
            }
        })
        .await
        .expect("subscribe should succeed");

    // Only the real event should arrive; broadcast frames must not trigger handlers
    assert_eq!(
        next_payload(&mut event_rx).await,
        json!({ "toolName": "visible" })
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), event_rx.recv())
            .await
            .is_err(),
        "broadcast frames must not be delivered as application events"
    );

    bus.close().await.expect("client should close");
    server.assert_completed().await;
}

#[tokio::test]
async fn reconnect_replays_local_subscriptions() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener should bind");
    let address = listener
        .local_addr()
        .expect("test listener should have an address");
    let (initial_connection_closed_tx, initial_connection_closed_rx) = oneshot::channel();
    let (reconnect_ready_tx, reconnect_ready_rx) = oneshot::channel();
    let (reconnect_response_seen_tx, reconnect_response_seen_rx) = oneshot::channel();

    let server = tokio::spawn(async move {
        let (stream, _) = listener
            .accept()
            .await
            .expect("first websocket should connect");
        let mut ws = accept_async(stream)
            .await
            .expect("first websocket handshake should complete");

        let first_event_subscribe = read_bus_message(&mut ws).await;
        assert_eq!(
            serde_json::to_value(first_event_subscribe).expect("subscribe should serialize"),
            json!({
                "type": "subscribe",
                "subjects": {
                    "agent.message": [],
                },
            })
        );

        let first_request_subscribe = read_bus_message(&mut ws).await;
        assert_eq!(
            serde_json::to_value(first_request_subscribe).expect("subscribe should serialize"),
            json!({
                "type": "subscribe",
                "subjects": {
                    "agent.message": [],
                    "approval.request": [100],
                },
            })
        );

        ws.close(None)
            .await
            .expect("first websocket close frame should send");
        let _ = initial_connection_closed_tx.send(());

        let (stream, _) = listener
            .accept()
            .await
            .expect("reconnect websocket should connect");
        let mut ws = accept_async(stream)
            .await
            .expect("reconnect websocket handshake should complete");

        let replay_subscribe = read_bus_message(&mut ws).await;
        assert_eq!(
            serde_json::to_value(replay_subscribe).expect("subscribe should serialize"),
            json!({
                "type": "subscribe",
                "subjects": {
                    "agent.message": [],
                    "approval.request": [100],
                },
            })
        );

        let _ = reconnect_ready_tx.send(());

        send_bus_message(
            &mut ws,
            BusMessage::Event(EventMessage {
                namespace: "agent".to_string(),
                subject: "message".to_string(),
                payload: json!({ "content": "replayed" }),
                message_id: "msg-replayed".to_string(),
                correlation_id: None,
            }),
        )
        .await;

        send_bus_message(
            &mut ws,
            BusMessage::Request(RequestMessage {
                namespace: "approval".to_string(),
                subject: "request".to_string(),
                payload: json!({ "toolName": "example.echo" }),
                correlation_id: "corr-reconnect".to_string(),
                message_id: "msg-reconnect".to_string(),
                timeout: Some(5_000),
                priority: Some(250),
                deadline: None,
            }),
        )
        .await;

        let response = match read_bus_message(&mut ws).await {
            BusMessage::Response(response) => response,
            other => panic!("expected response, received {other:?}"),
        };
        assert_eq!(response.correlation_id, "corr-reconnect");
        assert_eq!(
            response.result,
            Some(json!({
                "approved": true,
                "toolName": "example.echo",
            }))
        );
        assert!(response.error.is_none());
        let _ = reconnect_response_seen_tx.send(());
    });

    let bus = BusClient::connect(&format!("ws://{address}"))
        .await
        .expect("client should connect");
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<Value>();
    let _event_subscription = bus
        .subscribe(subjects::agent::MESSAGE, move |event| {
            let event_tx = event_tx.clone();
            async move {
                event_tx
                    .send(event.payload)
                    .expect("event should be delivered");
            }
        })
        .await
        .expect("event subscription should register");
    let _approval_handler = bus
        .on_request_with_priority(subjects::approval::REQUEST, 100, |request| async move {
            Ok(json!({
                "approved": true,
                "toolName": request.payload.get("toolName").cloned().unwrap_or(Value::Null),
            }))
        })
        .await
        .expect("request handler should register");

    initial_connection_closed_rx
        .await
        .expect("server should close the initial connection");

    bus.reconnect().await.expect("client should reconnect");

    reconnect_ready_rx
        .await
        .expect("server should observe replayed subscriptions");

    assert_eq!(
        next_payload(&mut event_rx).await,
        json!({ "content": "replayed" })
    );
    reconnect_response_seen_rx
        .await
        .expect("server should observe the request response");

    bus.close().await.expect("client should close");
    server
        .await
        .expect("reconnect server task should complete without panicking");
}

#[tokio::test]
async fn malformed_inbound_frame_closes_connection_and_fails_pending_request() {
    let server = serve_once(|mut ws| async move {
        let request = match read_bus_message(&mut ws).await {
            BusMessage::Request(request) => request,
            other => panic!("expected request, received {other:?}"),
        };

        ws.send(Message::Text("{".into()))
            .await
            .expect("malformed frame should send");

        tokio::time::sleep(Duration::from_millis(50)).await;

        send_bus_message(
            &mut ws,
            BusMessage::Response(ResponseMessage {
                correlation_id: request.correlation_id,
                result: Some(json!({ "ok": true })),
                error: None,
            }),
        )
        .await;
    })
    .await;

    let bus = BusClient::connect(&server.url)
        .await
        .expect("client should connect");
    let error = bus
        .request(subjects::tool::LIST, json!({ "scope": "workspace" }))
        .await
        .expect_err("malformed frame should close the connection");

    assert_connection_closed_error(error);
    assert!(matches!(
        bus.emit(
            subjects::tool::STARTED,
            json!({ "toolName": "after-close" })
        )
        .await,
        Err(BusClientError::NotConnected)
    ));

    bus.close().await.expect("client should close");
    server.assert_completed().await;
}

#[tokio::test]
async fn invalid_binary_frame_closes_connection_and_fails_pending_request() {
    let server = serve_once(|mut ws| async move {
        let request = match read_bus_message(&mut ws).await {
            BusMessage::Request(request) => request,
            other => panic!("expected request, received {other:?}"),
        };

        ws.send(Message::Binary(vec![0xff].into()))
            .await
            .expect("invalid binary frame should send");

        tokio::time::sleep(Duration::from_millis(50)).await;

        send_bus_message(
            &mut ws,
            BusMessage::Response(ResponseMessage {
                correlation_id: request.correlation_id,
                result: Some(json!({ "ok": true })),
                error: None,
            }),
        )
        .await;
    })
    .await;

    let bus = BusClient::connect(&server.url)
        .await
        .expect("client should connect");
    let error = bus
        .request(subjects::tool::LIST, json!({ "scope": "workspace" }))
        .await
        .expect_err("invalid binary frame should close the connection");

    assert_connection_closed_error(error);
    assert!(matches!(
        bus.emit(
            subjects::tool::STARTED,
            json!({ "toolName": "after-close" })
        )
        .await,
        Err(BusClientError::NotConnected)
    ));

    bus.close().await.expect("client should close");
    server.assert_completed().await;
}

#[tokio::test]
async fn close_cancels_background_event_handlers() {
    let (cancelled_tx, cancelled_rx) = oneshot::channel();
    let cancelled_tx = Arc::new(StdMutex::new(Some(cancelled_tx)));
    let started = Arc::new(Notify::new());

    let server = serve_once(|mut ws| async move {
        let _subscribe = read_bus_message(&mut ws).await;
        send_bus_message(
            &mut ws,
            BusMessage::Event(EventMessage {
                namespace: "agent".to_string(),
                subject: "message".to_string(),
                payload: json!({ "content": "blocking" }),
                message_id: "msg-blocking".to_string(),
                correlation_id: None,
            }),
        )
        .await;
    })
    .await;

    let bus = BusClient::connect(&server.url)
        .await
        .expect("client should connect");
    let _subscription = bus
        .subscribe(subjects::agent::MESSAGE, {
            let cancelled_tx = cancelled_tx.clone();
            let started = started.clone();
            move |_| {
                let cancelled_tx = cancelled_tx.clone();
                let started = started.clone();
                async move {
                    let _signal = DropSignal(cancelled_tx);
                    started.notify_one();
                    std::future::pending::<()>().await;
                }
            }
        })
        .await
        .expect("subscribe should succeed");

    started.notified().await;
    bus.close().await.expect("client should close");
    cancelled_rx
        .await
        .expect("background handler should be aborted");
    server.assert_completed().await;
}

struct DropSignal(Arc<StdMutex<Option<oneshot::Sender<()>>>>);

impl Drop for DropSignal {
    fn drop(&mut self) {
        if let Some(sender) = self
            .0
            .lock()
            .expect("drop signal mutex should not be poisoned")
            .take()
        {
            let _ = sender.send(());
        }
    }
}

async fn serve_once<F, Fut>(handler: F) -> TestServer
where
    F: FnOnce(WebSocketStream<TcpStream>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener should bind");
    let address = listener
        .local_addr()
        .expect("test listener should have an address");
    let task = tokio::spawn(async move {
        let (stream, _) = listener
            .accept()
            .await
            .expect("test websocket should connect");
        let ws = accept_async(stream)
            .await
            .expect("test websocket handshake should complete");
        handler(ws).await;
    });
    TestServer {
        url: format!("ws://{address}"),
        task,
    }
}

async fn read_bus_message(ws: &mut WebSocketStream<TcpStream>) -> BusMessage {
    loop {
        let message = ws
            .next()
            .await
            .expect("websocket should remain open")
            .expect("message should be valid");
        if let Some(value) = wire_value(message) {
            return serde_json::from_value(value).expect("wire message should deserialize");
        }
    }
}

async fn send_bus_message(ws: &mut WebSocketStream<TcpStream>, message: BusMessage) {
    let text = serde_json::to_string(&message).expect("wire message should serialize");
    ws.send(Message::Text(text.into()))
        .await
        .expect("wire message should send");
}

async fn next_seen_message(rx: &mut mpsc::UnboundedReceiver<BusMessage>) -> Value {
    let message = rx.recv().await.expect("expected a wire message");
    serde_json::to_value(message).expect("wire message should serialize")
}

async fn next_seen_value(rx: &mut mpsc::UnboundedReceiver<Value>) -> Value {
    rx.recv().await.expect("expected a wire message")
}

async fn next_payload(rx: &mut mpsc::UnboundedReceiver<Value>) -> Value {
    rx.recv().await.expect("expected an event payload")
}

fn wire_value(message: Message) -> Option<Value> {
    match message {
        Message::Text(text) => Some(serde_json::from_str(&text).expect("text should be json")),
        Message::Binary(bytes) => {
            Some(serde_json::from_slice(&bytes).expect("binary should be json"))
        }
        Message::Ping(_) | Message::Pong(_) | Message::Close(_) | Message::Frame(_) => None,
    }
}

fn assert_connection_closed_error(error: BusClientError) {
    match error {
        BusClientError::Bus(error) => {
            assert_eq!(error.code.as_deref(), Some("CONNECTION_CLOSED"));
            assert!(error.message.contains("connection closed"));
        }
        error => panic!("expected connection closed bus error, got {error}"),
    }
}

fn conformance_cases() -> Value {
    serde_json::from_str(include_str!("../../conformance/cases.json"))
        .expect("conformance cases fixture should parse")
}

fn protocol_manifest() -> Value {
    serde_json::from_str(include_str!("../../manifest/makaio-bus-protocol.json"))
        .expect("protocol manifest fixture should parse")
}

fn conformance_messages() -> serde_json::Map<String, Value> {
    serde_json::from_str::<Value>(include_str!("../../conformance/fixtures/messages.json"))
        .expect("conformance message fixture should parse")["messages"]
        .as_object()
        .expect("conformance messages should be an object")
        .clone()
}

fn conformance_message(message_ref: &str) -> Value {
    conformance_messages()
        .remove(message_ref)
        .unwrap_or_else(|| panic!("missing conformance message fixture {message_ref}"))
}

fn assert_conformance_assertion_shape(
    case_id: &str,
    assertion: &Value,
    messages: &serde_json::Map<String, Value>,
) {
    let kind = assertion["kind"]
        .as_str()
        .unwrap_or_else(|| panic!("{case_id} assertions must declare a string kind"));

    match kind {
        "delivers" => {
            let targets = assertion["targets"]
                .as_array()
                .unwrap_or_else(|| panic!("{case_id} delivers assertions must declare targets"));
            assert!(
                !targets.is_empty(),
                "{case_id} delivers assertions must declare targets"
            );
        }
        "matches" => {
            assert!(
                assertion["subject"].is_string(),
                "{case_id} matches assertions must declare a subject"
            );
            if let Some(pattern) = assertion.get("pattern") {
                assert!(
                    pattern.is_string(),
                    "{case_id} matches assertions must declare a string pattern"
                );
            }
        }
        "correlates" => {
            assert!(
                assertion["correlationId"].is_string(),
                "{case_id} correlates assertions must declare a correlationId"
            );
        }
        "error" => {
            assert!(
                assertion["code"].is_string(),
                "{case_id} error assertions must declare a code"
            );
            assert!(
                assertion["subject"].is_string(),
                "{case_id} error assertions must declare a subject"
            );
        }
        "replaces" => {
            assert!(
                assertion["subject"].is_string(),
                "{case_id} replaces assertions must declare a subject"
            );
            assert!(
                assertion["priorities"].is_array(),
                "{case_id} replaces assertions must declare priorities"
            );
        }
        "unsubscribes-when-empty" => {
            assert!(
                assertion["subject"].is_string(),
                "{case_id} unsubscribes-when-empty assertions must declare a subject"
            );
        }
        "replays" => {
            let replay_messages = assertion["messages"]
                .as_array()
                .unwrap_or_else(|| panic!("{case_id} replays assertions must declare messages"));
            assert!(
                !replay_messages.is_empty(),
                "{case_id} replays assertions must declare messages"
            );
        }
        "handshake" | "ignored" => {
            let message_ref = assertion["messageRef"]
                .as_str()
                .unwrap_or_else(|| panic!("{case_id} {kind} assertions must declare a messageRef"));
            assert!(
                messages.contains_key(message_ref),
                "{case_id} references missing fixture {message_ref}"
            );
        }
        _ => panic!("{case_id} declares unsupported assertion kind {kind}"),
    }
}
