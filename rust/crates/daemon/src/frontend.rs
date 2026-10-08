//! The frontend link. The root edition's frontend App shows and changes this daemon's state and
//! runs nothing itself. The App listens on its abstract socket and this daemon connects, so each
//! side authenticates the other by peer credentials: the App accepts only root, and this daemon
//! answers only the uid that owns the frontend package's data directory.
//!
//! After one hello each way, every frame is a request from the App or the response to one, with
//! the request's `id`. Requests are served concurrently up to [MAX_IN_FLIGHT]; beyond that a
//! request is answered `RESOURCE_LIMIT` without running.

use crate::{
    ModuleIdentity,
    unix_transport::{peer_uid, receive_json, send_json},
};
use contract::ErrorCode;
use domain::DomainError;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::{fs::MetadataExt, net::UnixStream},
    path::Path,
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
};

pub const FRONTEND_PROTOCOL_VERSION: u32 = 1;
pub const MAX_IN_FLIGHT: usize = 8;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DaemonHello {
    pub protocol_version: u32,
    pub role: String,
    pub module_id: String,
    pub version_name: String,
    pub version_code: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrontendHello {
    pub protocol_version: u32,
    pub role: String,
    pub package: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrontendRequest {
    pub id: u64,
    pub operation: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrontendResponse {
    pub id: u64,
    pub payload: Value,
}

/// Answers one request: its operation name and payload in, the response payload out.
pub type Handler = Arc<dyn Fn(&str, &Value) -> Value + Send + Sync>;

/// The response payload of a refused request.
pub fn error_payload(error: &DomainError) -> Value {
    let mut body = json!({"code": error.code, "reason": error.reason});
    if let Some(peer) = &error.peer_reason {
        body["peer_reason"] = Value::from(peer.clone());
    }
    json!({"error": body})
}

/// Serves one connected frontend until the connection ends.
pub(crate) fn serve(
    mut stream: UnixStream,
    identity: &ModuleIdentity,
    handler: Handler,
) -> Result<(), DomainError> {
    // Any App can bind the abstract name while the frontend is not running, so the peer is
    // authenticated before this daemon tells it anything.
    let expected_uid = fs::metadata(Path::new("/data/user_de/0").join(identity.frontend_package))
        .map_err(|error| {
            DomainError::os(
                ErrorCode::NotFound,
                "frontend package data directory is missing",
                &error,
            )
        })?
        .uid();
    let peer = peer_uid(&stream).map_err(|error| {
        DomainError::os(
            ErrorCode::IoError,
            "cannot authenticate frontend socket",
            &error,
        )
    })?;
    if peer != expected_uid {
        return Err(DomainError::new(
            ErrorCode::PermissionDenied,
            "frontend socket peer is not the frontend package",
        ));
    }
    send_json(
        &mut stream,
        &DaemonHello {
            protocol_version: FRONTEND_PROTOCOL_VERSION,
            role: "droidbridged".to_owned(),
            module_id: identity.module_id.to_owned(),
            version_name: env!("CARGO_PKG_VERSION").to_owned(),
            version_code: crate::VERSION_CODE,
        },
    )?;
    let hello: FrontendHello = receive_json(&mut stream)?;
    if hello.protocol_version != FRONTEND_PROTOCOL_VERSION
        || hello.role != "frontend"
        || hello.package != identity.frontend_package
    {
        return Err(DomainError::new(
            ErrorCode::ProtocolIncompatible,
            "frontend hello does not match this module",
        ));
    }
    let writer = Arc::new(Mutex::new(stream.try_clone().map_err(|error| {
        DomainError::os(ErrorCode::IoError, "cannot share frontend socket", &error)
    })?));
    let in_flight = Arc::new(AtomicUsize::new(0));
    loop {
        let request: FrontendRequest = receive_json(&mut stream)?;
        if in_flight.fetch_add(1, Ordering::AcqRel) >= MAX_IN_FLIGHT {
            in_flight.fetch_sub(1, Ordering::AcqRel);
            respond(
                &writer,
                request.id,
                error_payload(&DomainError::new(
                    ErrorCode::ResourceLimit,
                    "frontend request slots are full",
                )),
            );
            continue;
        }
        let handler = Arc::clone(&handler);
        let writer = Arc::clone(&writer);
        let in_flight = Arc::clone(&in_flight);
        thread::spawn(move || {
            let payload = handler(&request.operation, &request.payload);
            respond(&writer, request.id, payload);
            in_flight.fetch_sub(1, Ordering::AcqRel);
        });
    }
}

/// A response that cannot be written belongs to a connection that has ended; the read loop
/// observes that end on its own.
fn respond(writer: &Mutex<UnixStream>, id: u64, payload: Value) {
    let mut stream = writer.lock().unwrap_or_else(PoisonError::into_inner);
    let _ = send_json(&mut stream, &FrontendResponse { id, payload });
}
