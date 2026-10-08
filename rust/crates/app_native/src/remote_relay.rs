//! The Claude connector's device side (relay/DESIGN.md): the tunnel's long-poll client pointed at
//! the user's own DroidBridge relay and authenticated with the relay's device key. The relay URL
//! and key are a credential domain of their own; nothing here reads or reuses the OpenAI
//! tunnel's settings, and the relay never receives the Local MCP token.

use crate::mcp_listener::{KotlinMcpHost, initialize_host_bridge, kotlin_facade};
use jni::{
    EnvUnowned, Outcome,
    objects::{JClass, JString},
    sys::{JNI_FALSE, JNI_TRUE, jboolean, jint, jlong, jstring},
};
use reqwest::{
    Method, Url,
    header::{self, HeaderValue},
};
use runtime::{
    McpFacade, McpHost, TunnelClient, TunnelError, TunnelRuntime, read_bounded, tunnel_transport,
};
use serde_json::{Value, json};
use std::{
    ptr,
    sync::{Mutex, MutexGuard},
    time::Duration,
};

/// The wire the relay names in `GET /device/v1/status`.
const CLIENT_NAME: &str = "droidbridge-android";
const RELAY_PROTOCOL: &str = "droidbridge-relay/1";
const DEVICE_KEY_PREFIX: &str = "dbrk_";
/// `dbrk_` and 43 base64url characters: 32 random bytes.
const DEVICE_KEY_LENGTH: usize = 48;
const MAX_RELAY_URL_BYTES: usize = 256;
const MAX_PAIRING_TTL_SECONDS: u32 = 600;
const MAX_DEVICE_REPLY_BYTES: usize = 64 * 1024;
const DEVICE_CALL_TIMEOUT: Duration = Duration::from_secs(15);

/// One-shot answers the settings controller maps to its own errors.
const CALL_OK: &str = "ok";
const CALL_VALID: &str = "valid";
const CALL_INVALID_KEY: &str = "invalid_key";
const CALL_INVALID_RELAY: &str = "invalid_relay";
const CALL_NOT_CONFIGURED: &str = "relay_not_configured";
const CALL_UNAVAILABLE: &str = "unavailable";

static RELAY: Mutex<Option<TunnelRuntime>> = Mutex::new(None);

/// The relay's origin: HTTPS with a host, and no credentials, query, fragment or path, so the
/// device routes are always `<origin>/device/v1/...`.
#[derive(Clone, Debug)]
pub(crate) struct RelayEndpoint {
    base: Url,
}

impl RelayEndpoint {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        Self::parse_with(value, false)
    }

    fn parse_with(value: &str, allow_loopback_http: bool) -> Option<Self> {
        if value.is_empty() || value.len() > MAX_RELAY_URL_BYTES {
            return None;
        }
        let mut url = Url::parse(value).ok()?;
        let secure = url.scheme() == "https";
        let loopback_http = allow_loopback_http
            && url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost"));
        if !(secure || loopback_http)
            || url.host_str().is_none_or(str::is_empty)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !matches!(url.path(), "" | "/")
        {
            return None;
        }
        url.set_path("/");
        Some(Self { base: url })
    }

    fn route(&self, path: &str) -> Result<Url, TunnelError> {
        self.base
            .join(path)
            .map_err(|_| TunnelError::InvalidConfig("relay URL is invalid"))
    }
}

pub(crate) fn valid_device_key(value: &str) -> bool {
    value.len() == DEVICE_KEY_LENGTH
        && value.starts_with(DEVICE_KEY_PREFIX)
        && value[DEVICE_KEY_PREFIX.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn valid_product_version(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.bytes().all(|byte| byte.is_ascii_graphic())
}

fn valid_code_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The tunnel client for one relay: it polls `device/v1/poll` and answers `device/v1/response`.
pub(crate) fn relay_client<H: McpHost + 'static>(
    facade: McpFacade<H>,
    endpoint: &RelayEndpoint,
    device_key: &str,
    product_version: &str,
) -> Result<TunnelClient<H>, TunnelError> {
    if !valid_device_key(device_key) {
        return Err(TunnelError::InvalidConfig("device key is invalid"));
    }
    TunnelClient::from_urls(
        facade,
        endpoint.route("device/v1/poll")?,
        endpoint.route("device/v1/response")?,
        device_key,
        product_version,
    )
}

fn relay_slot() -> Result<MutexGuard<'static, Option<TunnelRuntime>>, TunnelError> {
    RELAY.lock().map_err(|_| TunnelError::RuntimeUnavailable)
}

fn start_relay(
    port: jint,
    relay_url: &str,
    device_key: &str,
    product_version: String,
) -> Result<(), TunnelError> {
    let port =
        u16::try_from(port).map_err(|_| TunnelError::InvalidConfig("MCP port is invalid"))?;
    let endpoint = RelayEndpoint::parse(relay_url)
        .ok_or(TunnelError::InvalidConfig("relay URL is invalid"))?;
    let mut slot = relay_slot()?;
    if slot.is_some() {
        return Ok(());
    }
    let facade = kotlin_facade(port, product_version.clone())
        .map_err(|_| TunnelError::InvalidConfig("MCP port or product version is invalid"))?;
    let client = relay_client::<KotlinMcpHost>(facade, &endpoint, device_key, &product_version)?;
    *slot = Some(TunnelRuntime::start(client)?);
    Ok(())
}

/// One authenticated request to a device route, outside the long-poll: the credential check,
/// pairing and revocation. Answers the JSON object the relay returned (Null for 204), or the
/// short token the settings controller names the failure by.
fn device_call(
    endpoint: &RelayEndpoint,
    device_key: &str,
    product_version: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, &'static str> {
    if !valid_device_key(device_key) || !valid_product_version(product_version) {
        return Err(CALL_UNAVAILABLE);
    }
    let url = endpoint.route(path).map_err(|_| CALL_UNAVAILABLE)?;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| CALL_UNAVAILABLE)?;
    runtime.block_on(async {
        let mut authorization =
            HeaderValue::from_str(&format!("Bearer {device_key}")).map_err(|_| CALL_UNAVAILABLE)?;
        authorization.set_sensitive(true);
        let user_agent = HeaderValue::from_str(&format!("{CLIENT_NAME}/{product_version}"))
            .map_err(|_| CALL_UNAVAILABLE)?;
        let client = tunnel_transport().build().map_err(|_| CALL_UNAVAILABLE)?;
        let mut request = client
            .request(method, url)
            .header(header::AUTHORIZATION, authorization)
            .header(header::ACCEPT, "application/json")
            .header(header::USER_AGENT, user_agent)
            .timeout(DEVICE_CALL_TIMEOUT);
        if let Some(body) = body {
            let encoded = serde_json::to_vec(&body).map_err(|_| CALL_UNAVAILABLE)?;
            request = request
                .header(header::CONTENT_TYPE, "application/json")
                .body(encoded);
        }
        let mut response = request.send().await.map_err(|_| CALL_UNAVAILABLE)?;
        let status = response.status().as_u16();
        match status {
            200 => {
                let bytes = read_bounded(&mut response, MAX_DEVICE_REPLY_BYTES)
                    .await
                    .map_err(|_| CALL_INVALID_RELAY)?;
                serde_json::from_slice::<Value>(&bytes)
                    .ok()
                    .filter(Value::is_object)
                    .ok_or(CALL_INVALID_RELAY)
            }
            204 => Ok(Value::Null),
            401 | 403 => Err(CALL_INVALID_KEY),
            404 | 405 => Err(CALL_INVALID_RELAY),
            503 => {
                let bytes = read_bounded(&mut response, MAX_DEVICE_REPLY_BYTES)
                    .await
                    .unwrap_or_default();
                let not_configured = serde_json::from_slice::<Value>(&bytes)
                    .ok()
                    .and_then(|reply| {
                        reply
                            .get("error")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .is_some_and(|error| error == CALL_NOT_CONFIGURED);
                Err(if not_configured {
                    CALL_NOT_CONFIGURED
                } else {
                    CALL_UNAVAILABLE
                })
            }
            _ => Err(CALL_UNAVAILABLE),
        }
    })
}

/// Whether `relay_url` is a DroidBridge relay that accepts `device_key`.
fn validate(endpoint: &RelayEndpoint, device_key: &str, product_version: &str) -> &'static str {
    match device_call(
        endpoint,
        device_key,
        product_version,
        Method::GET,
        "device/v1/status",
        None,
    ) {
        Ok(reply) if reply.get("protocol").and_then(Value::as_str) == Some(RELAY_PROTOCOL) => {
            CALL_VALID
        }
        Ok(_) => CALL_INVALID_RELAY,
        Err(token) => token,
    }
}

/// Publishes the hash of a pairing code; the code itself never leaves the phone.
fn pair(
    endpoint: &RelayEndpoint,
    device_key: &str,
    code_sha256: &str,
    ttl_seconds: u32,
    product_version: &str,
) -> &'static str {
    if !valid_code_hash(code_sha256) || !(1..=MAX_PAIRING_TTL_SECONDS).contains(&ttl_seconds) {
        return CALL_UNAVAILABLE;
    }
    match device_call(
        endpoint,
        device_key,
        product_version,
        Method::POST,
        "device/v1/pairing",
        Some(json!({"code_sha256": code_sha256, "ttl_seconds": ttl_seconds})),
    ) {
        Ok(_) => CALL_OK,
        Err(token) => token,
    }
}

/// Revokes every grant Claude holds at the relay.
fn revoke(endpoint: &RelayEndpoint, device_key: &str, product_version: &str) -> &'static str {
    match device_call(
        endpoint,
        device_key,
        product_version,
        Method::POST,
        "device/v1/revoke",
        Some(json!({})),
    ) {
        Ok(_) => CALL_OK,
        Err(token) => token,
    }
}

fn with_endpoint(
    relay_url: &str,
    call: impl FnOnce(&RelayEndpoint) -> &'static str,
) -> &'static str {
    RelayEndpoint::parse(relay_url).map_or(CALL_INVALID_RELAY, |endpoint| call(&endpoint))
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_droidbridge_standalone_runtimehost_NativeRuntime_nativeRelayValidate(
    mut env: EnvUnowned,
    _class: JClass,
    relay_url: JString,
    device_key: JString,
    product_version: JString,
) -> jstring {
    match env
        .with_env(|owned| -> jni::errors::Result<jstring> {
            let relay_url = relay_url.mutf8_chars(owned)?.to_str().into_owned();
            let device_key = device_key.mutf8_chars(owned)?.to_str().into_owned();
            let product_version = product_version.mutf8_chars(owned)?.to_str().into_owned();
            let state = with_endpoint(&relay_url, |endpoint| {
                validate(endpoint, &device_key, &product_version)
            });
            Ok(owned.new_string(state)?.into_raw())
        })
        .into_outcome()
    {
        Outcome::Ok(value) => value,
        Outcome::Err(_) | Outcome::Panic(_) => ptr::null_mut(),
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_droidbridge_standalone_runtimehost_NativeRuntime_nativeRelayPair(
    mut env: EnvUnowned,
    _class: JClass,
    relay_url: JString,
    device_key: JString,
    code_sha256: JString,
    ttl_seconds: jint,
    product_version: JString,
) -> jstring {
    match env
        .with_env(|owned| -> jni::errors::Result<jstring> {
            let relay_url = relay_url.mutf8_chars(owned)?.to_str().into_owned();
            let device_key = device_key.mutf8_chars(owned)?.to_str().into_owned();
            let code_sha256 = code_sha256.mutf8_chars(owned)?.to_str().into_owned();
            let product_version = product_version.mutf8_chars(owned)?.to_str().into_owned();
            let state = match u32::try_from(ttl_seconds) {
                Ok(ttl) => with_endpoint(&relay_url, |endpoint| {
                    pair(endpoint, &device_key, &code_sha256, ttl, &product_version)
                }),
                Err(_) => CALL_UNAVAILABLE,
            };
            Ok(owned.new_string(state)?.into_raw())
        })
        .into_outcome()
    {
        Outcome::Ok(value) => value,
        Outcome::Err(_) | Outcome::Panic(_) => ptr::null_mut(),
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_droidbridge_standalone_runtimehost_NativeRuntime_nativeRelayRevoke(
    mut env: EnvUnowned,
    _class: JClass,
    relay_url: JString,
    device_key: JString,
    product_version: JString,
) -> jstring {
    match env
        .with_env(|owned| -> jni::errors::Result<jstring> {
            let relay_url = relay_url.mutf8_chars(owned)?.to_str().into_owned();
            let device_key = device_key.mutf8_chars(owned)?.to_str().into_owned();
            let product_version = product_version.mutf8_chars(owned)?.to_str().into_owned();
            let state = with_endpoint(&relay_url, |endpoint| {
                revoke(endpoint, &device_key, &product_version)
            });
            Ok(owned.new_string(state)?.into_raw())
        })
        .into_outcome()
    {
        Outcome::Ok(value) => value,
        Outcome::Err(_) | Outcome::Panic(_) => ptr::null_mut(),
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_droidbridge_standalone_runtimehost_NativeRuntime_nativeRelayStart(
    mut env: EnvUnowned,
    _class: JClass,
    port: jint,
    relay_url: JString,
    device_key: JString,
    product_version: JString,
) -> jboolean {
    match env
        .with_env(|owned| -> jni::errors::Result<jboolean> {
            initialize_host_bridge(owned)?;
            let relay_url = relay_url.mutf8_chars(owned)?.to_str().into_owned();
            let device_key = device_key.mutf8_chars(owned)?.to_str().into_owned();
            let product_version = product_version.mutf8_chars(owned)?.to_str().into_owned();
            Ok(
                if start_relay(port, &relay_url, &device_key, product_version).is_ok() {
                    JNI_TRUE
                } else {
                    JNI_FALSE
                },
            )
        })
        .into_outcome()
    {
        Outcome::Ok(value) => value,
        Outcome::Err(_) | Outcome::Panic(_) => JNI_FALSE,
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_droidbridge_standalone_runtimehost_NativeRuntime_nativeRelayStop(
    _env: EnvUnowned,
    _class: JClass,
) -> jboolean {
    match relay_slot() {
        Ok(mut slot) => {
            if let Some(relay) = slot.take() {
                relay.stop();
            }
            JNI_TRUE
        }
        Err(_) => JNI_FALSE,
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_droidbridge_standalone_runtimehost_NativeRuntime_nativeRelayState(
    mut env: EnvUnowned,
    _class: JClass,
) -> jstring {
    match env
        .with_env(|owned| -> jni::errors::Result<jstring> {
            let state = relay_slot()
                .map(|slot| slot.as_ref().map_or("stopped", TunnelRuntime::state))
                .unwrap_or("failed");
            Ok(owned.new_string(state)?.into_raw())
        })
        .into_outcome()
    {
        Outcome::Ok(value) => value,
        Outcome::Err(_) | Outcome::Panic(_) => ptr::null_mut(),
    }
}

/// The token of the relay's last poll failure, or null.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_droidbridge_standalone_runtimehost_NativeRuntime_nativeRelayLastError(
    mut env: EnvUnowned,
    _class: JClass,
) -> jstring {
    match env
        .with_env(|owned| -> jni::errors::Result<jstring> {
            let last = relay_slot()
                .ok()
                .and_then(|slot| slot.as_ref().and_then(TunnelRuntime::last_error));
            Ok(match last {
                Some(token) => owned.new_string(token)?.into_raw(),
                None => ptr::null_mut(),
            })
        })
        .into_outcome()
    {
        Outcome::Ok(value) => value,
        Outcome::Err(_) | Outcome::Panic(_) => ptr::null_mut(),
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_droidbridge_standalone_runtimehost_NativeRuntime_nativeRelayLastCall(
    _env: EnvUnowned,
    _class: JClass,
) -> jlong {
    relay_slot()
        .ok()
        .and_then(|slot| slot.as_ref().map(TunnelRuntime::last_call_epoch_ms))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use contract::ErrorCode;
    use domain::DomainError;
    use runtime::{MCP_DEBUG_PORT, McpArtifactReply, PortFuture};
    use std::{
        io::{Read, Write},
        net::{SocketAddr, TcpListener, TcpStream},
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
        thread,
        time::Instant,
    };

    const DEVICE_KEY: &str = "dbrk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const CODE_HASH: &str = "4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a";

    fn loopback(base_url: &str) -> RelayEndpoint {
        RelayEndpoint::parse_with(base_url, true).unwrap()
    }

    fn answer_once(status: u16, body: &'static str) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            write!(
                stream,
                "HTTP/1.1 {status} Result\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",
                body.len(),
            )
            .unwrap();
            request
        });
        (format!("http://{address}/"), handle)
    }

    fn read_request(stream: &mut TcpStream) -> String {
        let mut raw = Vec::new();
        let mut block = [0_u8; 4096];
        let end = loop {
            let count = stream.read(&mut block).unwrap();
            assert!(count > 0);
            raw.extend_from_slice(&block[..count]);
            if let Some(index) = raw.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let headers = String::from_utf8(raw[..end].to_vec()).unwrap();
        let content_length = headers
            .lines()
            .find_map(|line| {
                line.split_once(':').and_then(|(name, value)| {
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
            })
            .unwrap_or(0);
        while raw.len() - end < content_length {
            let count = stream.read(&mut block).unwrap();
            assert!(count > 0);
            raw.extend_from_slice(&block[..count]);
        }
        String::from_utf8(raw[..end + content_length].to_vec()).unwrap()
    }

    #[test]
    fn relay_requires_https_origin_and_a_device_key() {
        for valid in [
            "https://relay.example.com",
            "https://relay.example.com/",
            "https://relay.example.com:8443",
        ] {
            assert_eq!(
                RelayEndpoint::parse(valid)
                    .unwrap()
                    .route("device/v1/poll")
                    .unwrap()
                    .path(),
                "/device/v1/poll",
            );
        }
        for invalid in [
            "",
            "http://relay.example.com",
            "http://127.0.0.1:8765",
            "https://user:secret@relay.example.com",
            "https://relay.example.com/?key=secret",
            "https://relay.example.com/#fragment",
            "https://relay.example.com/mcp",
            "ftp://relay.example.com",
            "relay.example.com",
            &format!("https://{}.example.com", "a".repeat(250)),
        ] {
            assert!(RelayEndpoint::parse(invalid).is_none(), "{invalid}");
        }
        assert!(RelayEndpoint::parse_with("http://127.0.0.1:9/", true).is_some());
        assert!(RelayEndpoint::parse_with("http://example.com/", true).is_none());
        assert!(valid_device_key(DEVICE_KEY));
        assert!(!valid_device_key("dbrk_short"));
        assert!(!valid_device_key(
            "dbrk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+"
        ));
        assert!(valid_code_hash(CODE_HASH));
        assert!(!valid_code_hash(&CODE_HASH.to_uppercase()));
    }

    #[test]
    fn relay_validation_maps_status_and_protocol() {
        for (status, body, expected) in [
            (
                200,
                r#"{"schema_version":1,"protocol":"droidbridge-relay/1"}"#,
                CALL_VALID,
            ),
            (200, r#"{"schema_version":1}"#, CALL_INVALID_RELAY),
            (401, "", CALL_INVALID_KEY),
            (404, "", CALL_INVALID_RELAY),
            (
                503,
                r#"{"error":"relay_not_configured"}"#,
                CALL_NOT_CONFIGURED,
            ),
            (502, "", CALL_UNAVAILABLE),
        ] {
            let (base_url, server) = answer_once(status, body);
            assert_eq!(
                validate(&loopback(&base_url), DEVICE_KEY, "0.5.1"),
                expected
            );
            let request = server.join().unwrap();
            assert!(request.starts_with("GET /device/v1/status "));
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer ")
            );
        }
    }

    #[test]
    fn pairing_sends_only_a_hash_and_revoke_uses_its_route() {
        let (base_url, server) = answer_once(200, r#"{"expires_at":"2026-10-06T14:00:00Z"}"#);
        assert_eq!(
            pair(&loopback(&base_url), DEVICE_KEY, CODE_HASH, 600, "0.5.1"),
            CALL_OK
        );
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /device/v1/pairing "));
        let body = request.split_once("\r\n\r\n").unwrap().1;
        assert_eq!(
            serde_json::from_str::<Value>(body).unwrap(),
            json!({"code_sha256": CODE_HASH, "ttl_seconds": 600}),
        );
        let (base_url, server) = answer_once(200, r#"{"revoked_tokens":2}"#);
        assert_eq!(revoke(&loopback(&base_url), DEVICE_KEY, "0.5.1"), CALL_OK);
        assert!(
            server
                .join()
                .unwrap()
                .starts_with("POST /device/v1/revoke ")
        );

        let endpoint = loopback("http://127.0.0.1:9/");
        for (hash, ttl, key) in [
            ("invalid", 600, DEVICE_KEY),
            (CODE_HASH, 0, DEVICE_KEY),
            (CODE_HASH, 601, DEVICE_KEY),
            (CODE_HASH, 600, "dbrk_bad"),
        ] {
            assert_eq!(pair(&endpoint, key, hash, ttl, "0.5.1"), CALL_UNAVAILABLE);
        }
    }

    #[test]
    fn malformed_origin_and_device_key_are_refused_before_network_io() {
        assert_eq!(
            with_endpoint("http://127.0.0.1:9/", |_| unreachable!()),
            CALL_INVALID_RELAY,
        );
        let facade =
            McpFacade::new(CountingHost::default(), MCP_DEBUG_PORT, "0.5.1".to_owned()).unwrap();
        assert!(matches!(
            relay_client(
                facade,
                &loopback("http://127.0.0.1:9/"),
                "sk-not-a-device-key",
                "0.5.1",
            ),
            Err(TunnelError::InvalidConfig(_)),
        ));
    }

    #[derive(Clone, Default)]
    struct CountingHost(Arc<AtomicUsize>);

    impl McpHost for CountingHost {
        fn submit<'a>(&'a self, envelope: Vec<u8>) -> PortFuture<'a, Result<Vec<u8>, DomainError>> {
            Box::pin(async move {
                self.0.fetch_add(1, Ordering::SeqCst);
                let request: Value = serde_json::from_slice(&envelope).unwrap();
                Ok(serde_json::to_vec(&json!({
                    "protocol_version": 1,
                    "request_id": request["request_id"],
                    "outcome": "success",
                    "result": {"tasks": []},
                }))
                .unwrap())
            })
        }

        fn artifact_query<'a>(
            &'a self,
            _query: Value,
        ) -> PortFuture<'a, Result<McpArtifactReply, DomainError>> {
            Box::pin(async { Err(DomainError::new(ErrorCode::IoError, "no artifacts here")) })
        }
    }

    struct ScriptedRelay {
        base_url: String,
        address: SocketAddr,
        captured: Arc<Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
        handle: Option<thread::JoinHandle<()>>,
    }

    impl ScriptedRelay {
        fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let captured = Arc::new(Mutex::new(Vec::new()));
            let requests = Arc::clone(&captured);
            let stop = Arc::new(AtomicBool::new(false));
            let halted = Arc::clone(&stop);
            let handle = thread::spawn(move || {
                let mut polls = 0;
                loop {
                    let (mut stream, _) = listener.accept().unwrap();
                    if halted.load(Ordering::SeqCst) {
                        break;
                    }
                    let request = read_request(&mut stream);
                    let path = request
                        .lines()
                        .next()
                        .and_then(|line| line.split(' ').nth(1))
                        .unwrap_or_default()
                        .to_owned();
                    requests.lock().unwrap().push(request);
                    let (status, body) = if path.starts_with("/device/v1/poll?limit=") {
                        polls += 1;
                        if polls == 1 {
                            (200, json!({"commands": [relay_tools_call()]}).to_string())
                        } else {
                            thread::sleep(Duration::from_millis(10));
                            (204, String::new())
                        }
                    } else if path == "/device/v1/response" {
                        (200, "{}".to_owned())
                    } else {
                        panic!("unexpected relay route: {path}");
                    };
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status} Result\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",
                        body.len(),
                    );
                }
            });
            Self {
                base_url: format!("http://{address}/"),
                address,
                captured,
                stop,
                handle: Some(handle),
            }
        }

        fn response_count(&self) -> usize {
            self.captured
                .lock()
                .unwrap()
                .iter()
                .filter(|request| request.starts_with("POST /device/v1/response "))
                .count()
        }

        fn finish(mut self) -> Vec<String> {
            self.stop.store(true, Ordering::SeqCst);
            let _ = TcpStream::connect(self.address);
            self.handle.take().unwrap().join().unwrap();
            self.captured.lock().unwrap().clone()
        }
    }

    fn relay_tools_call() -> Value {
        json!({
            "request_id": "req_relay",
            "shard_token": "shard-secret",
            "command_type": "jsonrpc",
            "channel": "main",
            "created_at": "2026-09-15T00:00:00Z",
            "headers": {
                "MCP-Protocol-Version": ["2026-07-28"],
                "Mcp-Method": ["tools/call"],
                "Mcp-Name": ["task_control"],
            },
            "jsonrpc": {
                "jsonrpc": "2.0",
                "id": "rpc_relay",
                "method": "tools/call",
                "params": {
                    "name": "task_control",
                    "arguments": {"action": "list", "input": {}},
                    "_meta": {
                        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                        "io.modelcontextprotocol/clientCapabilities": {},
                    },
                },
            },
        })
    }

    #[test]
    fn relay_client_authenticates_poll_and_response_and_runs_once() {
        let host = CountingHost::default();
        let relay = ScriptedRelay::start();
        let client = relay_client(
            McpFacade::new(host.clone(), MCP_DEBUG_PORT, "0.5.1".to_owned()).unwrap(),
            &loopback(&relay.base_url),
            DEVICE_KEY,
            "0.5.1",
        )
        .unwrap();
        let running = TunnelRuntime::start(client).unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while relay.response_count() < 1 {
            assert!(Instant::now() < deadline, "relay response was never sent");
            thread::sleep(Duration::from_millis(10));
        }
        running.stop();
        let requests = relay.finish();
        assert!(
            requests
                .iter()
                .any(|request| request.starts_with("GET /device/v1/poll?limit="))
        );
        let responses: Vec<&String> = requests
            .iter()
            .filter(|request| request.starts_with("POST /device/v1/response "))
            .collect();
        assert_eq!(responses.len(), 1);
        assert!(requests.iter().all(|request| request.lines().any(|line| {
            line.split_once(':').is_some_and(|(name, value)| {
                name.eq_ignore_ascii_case("authorization")
                    && value.trim() == format!("Bearer {DEVICE_KEY}")
            })
        })));
        let body: Value =
            serde_json::from_str(responses[0].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["request_id"], "req_relay");
        assert_eq!(body["resp_type"], "jsonrpc_response");
        assert_eq!(body["resp_json"]["id"], "rpc_relay");
        assert_eq!(host.0.load(Ordering::SeqCst), 1);
    }
}
