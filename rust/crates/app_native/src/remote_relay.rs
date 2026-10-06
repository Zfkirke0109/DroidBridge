//! The Claude connector's device side (relay/DESIGN.md): the tunnel's long-poll client pointed at
//! the user's own DroidBridge relay and authenticated with the relay's device key. The relay URL
//! and key are a credential domain of their own; nothing here reads or reuses the OpenAI
//! tunnel's settings, and the relay never receives the Local MCP token.

use crate::mcp_listener::{KotlinMcpHost, initialize_host_bridge, kotlin_facade};
use crate::tunnel::{
    CLIENT_NAME, TunnelClient, TunnelError, TunnelRuntime, read_bounded, transport,
};
use jni::{
    EnvUnowned, Outcome,
    objects::{JClass, JString},
    sys::{JNI_FALSE, JNI_TRUE, jboolean, jint, jlong, jstring},
};
use reqwest::{
    Method, Url,
    header::{self, HeaderValue},
};
use runtime::{McpFacade, McpHost};
use serde_json::{Value, json};
use std::{
    ptr,
    sync::{Mutex, MutexGuard},
    time::Duration,
};

/// The wire the relay names in `GET /device/v1/status`.
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
    *slot = Some(TunnelRuntime::start(client, "droidbridge-relay")?);
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
        let client = transport().build().map_err(|_| CALL_UNAVAILABLE)?;
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
pub extern "system" fn Java_com_droidbridge_android_runtimehost_NativeRuntime_nativeRelayValidate(
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
pub extern "system" fn Java_com_droidbridge_android_runtimehost_NativeRuntime_nativeRelayPair(
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
pub extern "system" fn Java_com_droidbridge_android_runtimehost_NativeRuntime_nativeRelayRevoke(
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
pub extern "system" fn Java_com_droidbridge_android_runtimehost_NativeRuntime_nativeRelayStart(
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
pub extern "system" fn Java_com_droidbridge_android_runtimehost_NativeRuntime_nativeRelayStop(
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
pub extern "system" fn Java_com_droidbridge_android_runtimehost_NativeRuntime_nativeRelayState(
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
pub extern "system" fn Java_com_droidbridge_android_runtimehost_NativeRuntime_nativeRelayLastError(
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
pub extern "system" fn Java_com_droidbridge_android_runtimehost_NativeRuntime_nativeRelayLastCall(
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
    use crate::tunnel::tests::{
        GateHost, ScriptedControlPlane, read_request, tools_call, wait_for, write_response,
    };
    use runtime::MCP_DEBUG_PORT;
    use std::{
        net::TcpListener,
        sync::{Arc, atomic::AtomicBool},
        thread,
    };
    use tokio::sync::watch;

    const DEVICE_KEY: &str = "dbrk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const CODE_HASH: &str = "4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a";

    fn loopback(base_url: &str) -> RelayEndpoint {
        RelayEndpoint::parse_with(base_url, true).unwrap()
    }

    /// Answers one request with `status` and `body`, and hands back what was asked.
    fn answer_once(status: u16, body: &'static str) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            write_response(&mut stream, status, body).unwrap();
            format!(
                "{}{}",
                request.headers,
                String::from_utf8(request.body).unwrap()
            )
        });
        (format!("http://{address}/"), handle)
    }

    #[test]
    fn the_relay_url_is_an_https_origin_and_nothing_else() {
        for valid in [
            "https://droidbridge-relay.example.workers.dev",
            "https://droidbridge-relay.example.workers.dev/",
            "https://relay.example.com:8443",
        ] {
            let endpoint = RelayEndpoint::parse(valid).unwrap();
            assert_eq!(
                endpoint.route("device/v1/poll").unwrap().path(),
                "/device/v1/poll"
            );
        }
        for invalid in [
            "",
            "http://relay.example.com",
            "http://127.0.0.1:8765",
            "https://user:secret@relay.example.com",
            "https://relay.example.com/?q=1",
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
    }

    #[test]
    fn device_keys_and_code_hashes_have_one_shape() {
        assert!(valid_device_key(DEVICE_KEY));
        assert!(valid_device_key(
            "dbrk_abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE"
        ));
        assert!(!valid_device_key("dbrk_short"));
        assert!(!valid_device_key(
            "sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        ));
        assert!(!valid_device_key(
            "dbrk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+"
        ));
        assert!(valid_code_hash(CODE_HASH));
        assert!(!valid_code_hash(&CODE_HASH.to_uppercase()));
        assert!(!valid_code_hash(&CODE_HASH[1..]));
    }

    #[test]
    fn validation_maps_every_relay_answer() {
        let cases: [(u16, &'static str, &str); 6] = [
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
        ];
        for (status, body, expected) in cases {
            let (base_url, server) = answer_once(status, body);
            assert_eq!(
                validate(&loopback(&base_url), DEVICE_KEY, "0.4.3"),
                expected,
                "HTTP {status} {body}"
            );
            let request = server.join().unwrap();
            assert!(request.starts_with("GET /device/v1/status "));
            assert!(request.contains(&format!("authorization: Bearer {DEVICE_KEY}")));
        }
    }

    #[test]
    fn pairing_sends_only_the_code_hash_and_its_lifetime() {
        let (base_url, server) = answer_once(200, r#"{"expires_at":"2026-10-06T14:00:00Z"}"#);
        assert_eq!(
            pair(&loopback(&base_url), DEVICE_KEY, CODE_HASH, 600, "0.4.3"),
            CALL_OK
        );
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /device/v1/pairing "));
        let body = &request[request.find("\r\n\r\n").unwrap() + 4..];
        assert_eq!(
            serde_json::from_str::<Value>(body).unwrap(),
            json!({"code_sha256": CODE_HASH, "ttl_seconds": 600})
        );
        // Malformed input never reaches the network.
        let endpoint = loopback("http://127.0.0.1:9/");
        assert_eq!(
            pair(&endpoint, DEVICE_KEY, "abc", 600, "0.4.3"),
            CALL_UNAVAILABLE
        );
        assert_eq!(
            pair(&endpoint, DEVICE_KEY, CODE_HASH, 0, "0.4.3"),
            CALL_UNAVAILABLE
        );
        assert_eq!(
            pair(&endpoint, DEVICE_KEY, CODE_HASH, 601, "0.4.3"),
            CALL_UNAVAILABLE
        );
        assert_eq!(
            pair(&endpoint, "dbrk_bad", CODE_HASH, 600, "0.4.3"),
            CALL_UNAVAILABLE
        );
    }

    #[test]
    fn revocation_posts_to_the_revoke_route() {
        let (base_url, server) = answer_once(200, r#"{"revoked_tokens":2}"#);
        assert_eq!(revoke(&loopback(&base_url), DEVICE_KEY, "0.4.3"), CALL_OK);
        assert!(
            server
                .join()
                .unwrap()
                .starts_with("POST /device/v1/revoke ")
        );
        let (base_url, server) = answer_once(403, "");
        assert_eq!(
            revoke(&loopback(&base_url), DEVICE_KEY, "0.4.3"),
            CALL_INVALID_KEY
        );
        server.join().unwrap();
    }

    #[test]
    fn a_relay_url_that_is_not_an_https_origin_is_refused_before_any_call() {
        assert_eq!(
            with_endpoint("http://relay.example.com", |_| unreachable!()),
            CALL_INVALID_RELAY
        );
    }

    #[tokio::test]
    async fn the_relay_client_polls_and_answers_the_device_routes_with_the_device_key() {
        let host = GateHost::default();
        let relay =
            ScriptedControlPlane::new(vec![tools_call("req_relay", "rpc_relay")], vec![200]);
        let client = relay_client(
            McpFacade::new(host.clone(), MCP_DEBUG_PORT, "0.1.0".to_owned()).unwrap(),
            &loopback(&relay.base_url),
            DEVICE_KEY,
            "0.1.0",
        )
        .unwrap();
        let (shutdown, receiver) = watch::channel(false);
        let running =
            tokio::spawn(
                async move { client.run(receiver, Arc::new(AtomicBool::new(false))).await },
            );

        wait_for(|| host.started() == 1).await;
        host.release_one();
        wait_for(|| relay.request_count("/device/v1/response") == 1).await;
        let _ = shutdown.send(true);
        assert!(running.await.unwrap().is_ok());
        let requests = relay.captured();
        assert!(requests.iter().all(|request| {
            request
                .headers
                .contains(&format!("authorization: Bearer {DEVICE_KEY}"))
        }));
        assert!(
            requests
                .iter()
                .any(|request| request.path.starts_with("/device/v1/poll?limit="))
        );
        let response = requests
            .iter()
            .find(|request| request.path == "/device/v1/response")
            .unwrap();
        let body: Value = serde_json::from_slice(&response.body).unwrap();
        assert_eq!(body["request_id"], "req_relay");
        assert_eq!(body["resp_type"], "jsonrpc_response");
        assert_eq!(body["resp_json"]["id"], "rpc_relay");
        // The command ran exactly once.
        assert_eq!(host.started(), 1);
        relay.stop();
    }

    #[test]
    fn the_relay_client_refuses_a_malformed_device_key() {
        let facade =
            McpFacade::new(GateHost::default(), MCP_DEBUG_PORT, "0.1.0".to_owned()).unwrap();
        assert!(matches!(
            relay_client(
                facade,
                &loopback("http://127.0.0.1:9/"),
                "sk-not-a-device-key",
                "0.1.0"
            ),
            Err(TunnelError::InvalidConfig(_))
        ));
    }
}
