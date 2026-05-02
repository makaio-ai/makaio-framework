//! Rust SDK for participating in the Makaio bus protocol over WebSockets.

pub mod bus;

pub mod generated {
    pub mod subjects;
}

pub use bus::{
    BroadcastMessage, BroadcastResponseMessage, BusClient, BusClientError, BusMessage, BusResult,
    BusTransportError, EventMessage, RequestHandlerRegistration, RequestMessage, RequestOptions,
    ResponseMessage, SubscribeMessage, Subscription, UnsubscribeMessage,
};
