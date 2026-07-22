//! Rust SDK for participating in the Makaio bus protocol over WebSockets.

pub mod auth;
pub mod bus;
mod transport;

pub mod generated {
    pub mod subjects;
}

pub use auth::AuthMode;
pub use bus::{
    AuthChallengeMessage, AuthResponseMessage, AuthResultMessage, BroadcastMessage,
    BroadcastResponseMessage, BusClient, BusClientError, BusClientOptions, BusMessage, BusResult,
    BusTransportError, DispatchMode, EventMessage, EventSubject, IntoRequestHandlerResult,
    RequestContext, RequestHandlerRegistration, RequestMessage, RequestOptions, RequestSubject,
    ResponseMessage, SubscribeMessage, Subscription, SubscriptionDeliveryClass, UnsubscribeMessage,
};
