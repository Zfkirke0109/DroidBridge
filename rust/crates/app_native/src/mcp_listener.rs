//! The APK `:runtime` side of the loopback MCP listener: tool calls and artifact queries go to the
//! Kotlin HostController, the single path to the authoritative Runtime host.

use contract::ErrorCode;
use domain::DomainError;
use jni::{
    EnvUnowned, Outcome,
    objects::{JClass, JString},
    sys::{JNI_FALSE, JNI_TRUE, jboolean, jint, jstring},
};
use runtime::{
    MCP_DEBUG_PORT, MCP_STABLE_PORT, McpArtifactReply, McpFacade, McpHost, McpListener, PortFuture,
};
use serde_json::Value;
use std::{
    ptr,
    sync::{Arc, Mutex},
};
use tokio::sync::{Semaphore, oneshot};

/// Bounds the Kotlin host calls in flight, each on its own short-lived thread.
const MAX_HOST_CALLS: usize = 16;

static LISTENER: Mutex<Option<McpListener>> = Mutex::new(None);

/// The Kotlin HostController, which submits to the APK Runtime.
pub(crate) struct KotlinMcpHost {
    permits: Arc<Semaphore>,
}

impl KotlinMcpHost {
    pub(crate) fn new() -> Self {
        Self {
            permits: Arc::new(Semaphore::new(MAX_HOST_CALLS)),
        }
    }

    async fn on_host_thread<T: Send + 'static>(
        &self,
        call: impl FnOnce() -> Result<T, DomainError> + Send + 'static,
    ) -> Result<T, DomainError> {
        let permit = Arc::clone(&self.permits)
            .acquire_owned()
            .await
            .map_err(|_| {
                DomainError::new(ErrorCode::CapabilityUnavailable, "MCP host is closed")
            })?;
        let (sender, receiver) = oneshot::channel();
        // A plain thread rather than `spawn_blocking`: the host call can block on the APK
        // Runtime's own executor, which refuses to start inside another Tokio runtime context.
        std::thread::Builder::new()
            .name("droidbridge-mcp-host".to_owned())
            .spawn(move || {
                // Keep capacity until the host thread actually exits. The async waiter can be
                // cancelled at a relay deadline while a JNI call is still running.
                let _permit = permit;
                complete_host_call(sender, call);
            })
            .map_err(|_| DomainError::new(ErrorCode::ResourceLimit, "MCP host thread failed"))?;
        receiver.await.map_err(|_| {
            DomainError::new(
                ErrorCode::InternalError,
                "MCP host call ended without a result",
            )
        })?
    }
}

fn complete_host_call<T>(
    sender: oneshot::Sender<Result<T, DomainError>>,
    call: impl FnOnce() -> Result<T, DomainError>,
) {
    // A thread scheduled after its client departed must not begin a new JNI call. Once the
    // call has begun, its result may still be unknown to the departed client.
    if sender.is_closed() {
        return;
    }
    // A departed client drops the receiver; the reply and any descriptor close here.
    let _ = sender.send(call());
}

pub(crate) fn initialize_host_bridge(env: &mut jni::Env<'_>) -> jni::errors::Result<()> {
    #[cfg(target_os = "android")]
    bridge::initialize(env)?;
    #[cfg(not(target_os = "android"))]
    let _ = env;
    Ok(())
}

pub(crate) fn kotlin_facade(
    port: u16,
    product_version: String,
) -> Result<McpFacade<KotlinMcpHost>, DomainError> {
    if port != MCP_STABLE_PORT && port != MCP_DEBUG_PORT {
        return Err(DomainError::invalid("MCP port is not a build endpoint"));
    }
    McpFacade::new(KotlinMcpHost::new(), port, product_version)
}

impl McpHost for KotlinMcpHost {
    fn submit<'a>(&'a self, envelope: Vec<u8>) -> PortFuture<'a, Result<Vec<u8>, DomainError>> {
        Box::pin(self.on_host_thread(move || bridge::submit(&envelope)))
    }

    fn artifact_query<'a>(
        &'a self,
        query: Value,
    ) -> PortFuture<'a, Result<McpArtifactReply, DomainError>> {
        Box::pin(async move {
            let encoded = serde_json::to_vec(&query).map_err(|_| {
                DomainError::new(ErrorCode::InternalError, "artifact query encoding failed")
            })?;
            self.on_host_thread(move || bridge::query_artifacts(&encoded))
                .await
        })
    }
}

#[cfg(target_os = "android")]
mod bridge {
    use super::*;
    use jni::{
        Env, JValue, JavaVM, jni_sig, jni_str,
        objects::{Global, JByteArray},
    };
    use std::{fs, os::fd::FromRawFd, sync::OnceLock};

    static MCP_HOST_BRIDGE: OnceLock<Global<JClass<'static>>> = OnceLock::new();

    /// Resolves the bridge class on a Java thread, where the App class loader is visible.
    pub(super) fn initialize(env: &mut Env<'_>) -> jni::errors::Result<()> {
        if MCP_HOST_BRIDGE.get().is_some() {
            return Ok(());
        }
        let class = env.find_class(jni_str!(
            "com/droidbridge/standalone/runtimehost/McpHostBridge"
        ))?;
        let global = env.new_global_ref(class)?;
        let _ = MCP_HOST_BRIDGE.set(global);
        Ok(())
    }

    pub(super) fn submit(envelope: &[u8]) -> Result<Vec<u8>, DomainError> {
        let bridge = MCP_HOST_BRIDGE.get().ok_or_else(unavailable)?;
        let vm = JavaVM::singleton()
            .map_err(|_| DomainError::new(ErrorCode::InternalError, "Java VM is unavailable"))?;
        vm.attach_current_thread(|env| -> jni::errors::Result<Option<Vec<u8>>> {
            let envelope = env.byte_array_from_slice(envelope)?;
            let result = env.call_static_method(
                &**bridge,
                jni_str!("submit"),
                jni_sig!("([B)[B"),
                &[JValue::Object(envelope.as_ref())],
            );
            let result = match result {
                Ok(value) => value.into_object()?,
                Err(error) => {
                    env.exception_clear();
                    return Err(error);
                }
            };
            if result.is_null() {
                return Ok(None);
            }
            let bytes = env.cast_local::<JByteArray>(result)?;
            Ok(Some(env.convert_byte_array(&bytes)?))
        })
        .map_err(|_| DomainError::new(ErrorCode::IoError, "MCP host bridge failed"))?
        .ok_or_else(unavailable)
    }

    pub(super) fn query_artifacts(query: &[u8]) -> Result<McpArtifactReply, DomainError> {
        let bridge = MCP_HOST_BRIDGE.get().ok_or_else(unavailable)?;
        let vm = JavaVM::singleton()
            .map_err(|_| DomainError::new(ErrorCode::InternalError, "Java VM is unavailable"))?;
        let (payload, descriptor) = vm
            .attach_current_thread(
                |env| -> jni::errors::Result<(Option<Vec<u8>>, Option<fs::File>)> {
                    let query = env.byte_array_from_slice(query)?;
                    let slot = env.new_int_array(1)?;
                    slot.set_region(env, 0, &[-1])?;
                    let result = env.call_static_method(
                        &**bridge,
                        jni_str!("queryArtifacts"),
                        jni_sig!("([B[I)[B"),
                        &[
                            JValue::Object(query.as_ref()),
                            JValue::Object(slot.as_ref()),
                        ],
                    );
                    let result = match result {
                        Ok(value) => value.into_object()?,
                        Err(error) => {
                            env.exception_clear();
                            return Err(error);
                        }
                    };
                    let mut raw = [-1];
                    slot.get_region(env, 0, &mut raw)?;
                    // Owned at once, so every later failure still closes the descriptor.
                    let descriptor =
                        (raw[0] >= 0).then(|| unsafe { fs::File::from_raw_fd(raw[0]) });
                    if result.is_null() {
                        return Ok((None, descriptor));
                    }
                    let bytes = env.cast_local::<JByteArray>(result)?;
                    Ok((Some(env.convert_byte_array(&bytes)?), descriptor))
                },
            )
            .map_err(|_| DomainError::new(ErrorCode::IoError, "MCP host bridge failed"))?;
        let payload = payload.ok_or_else(unavailable)?;
        Ok(McpArtifactReply {
            payload: serde_json::from_slice(&payload).map_err(|_| {
                DomainError::new(ErrorCode::IoError, "artifact query reply is not JSON")
            })?,
            descriptor,
        })
    }

    fn unavailable() -> DomainError {
        DomainError::new(
            ErrorCode::CapabilityUnavailable,
            "authoritative Runtime host is unavailable",
        )
    }
}

#[cfg(not(target_os = "android"))]
mod bridge {
    use super::*;

    pub(super) fn submit(_envelope: &[u8]) -> Result<Vec<u8>, DomainError> {
        Err(unavailable())
    }

    pub(super) fn query_artifacts(_query: &[u8]) -> Result<McpArtifactReply, DomainError> {
        Err(unavailable())
    }

    fn unavailable() -> DomainError {
        DomainError::new(
            ErrorCode::CapabilityUnavailable,
            "the MCP host bridge requires Android",
        )
    }
}

fn listener_slot() -> Result<std::sync::MutexGuard<'static, Option<McpListener>>, DomainError> {
    LISTENER
        .lock()
        .map_err(|_| DomainError::new(ErrorCode::InternalError, "MCP listener slot is unavailable"))
}

#[cfg(test)]
mod host_call_tests {
    use super::*;
    use std::sync::{Condvar, Mutex as StdMutex};
    use std::time::Duration;
    use tokio::sync::mpsc;

    struct ReleaseOnDrop(Arc<(StdMutex<bool>, Condvar)>);

    impl Drop for ReleaseOnDrop {
        fn drop(&mut self) {
            let (released, signal) = &*self.0;
            *released.lock().unwrap() = true;
            signal.notify_all();
        }
    }

    #[test]
    fn cancelled_waiter_does_not_begin_a_queued_host_call() {
        let (sender, receiver) = oneshot::channel();
        drop(receiver);
        let mut called = false;
        complete_host_call(sender, || {
            called = true;
            Ok(())
        });
        assert!(!called);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_host_calls_hold_capacity_until_their_threads_exit() {
        let host = Arc::new(KotlinMcpHost::new());
        let gate = ReleaseOnDrop(Arc::new((StdMutex::new(false), Condvar::new())));
        let (started, mut starts) = mpsc::unbounded_channel();
        let mut calls = Vec::new();

        for _ in 0..MAX_HOST_CALLS {
            let host = Arc::clone(&host);
            let gate = Arc::clone(&gate.0);
            let started = started.clone();
            calls.push(tokio::spawn(async move {
                host.on_host_thread(move || {
                    started.send(()).unwrap();
                    let (released, signal) = &*gate;
                    let mut open = released.lock().unwrap();
                    while !*open {
                        open = signal.wait(open).unwrap();
                    }
                    Ok(())
                })
                .await
            }));
        }
        for _ in 0..MAX_HOST_CALLS {
            tokio::time::timeout(Duration::from_secs(5), starts.recv())
                .await
                .unwrap()
                .unwrap();
        }
        for call in calls {
            call.abort();
            let _ = call.await;
        }

        let permits_while_blocked = host.permits.available_permits();
        let extra = tokio::spawn({
            let host = Arc::clone(&host);
            let started = started.clone();
            async move {
                host.on_host_thread(move || {
                    started.send(()).unwrap();
                    Ok(())
                })
                .await
            }
        });
        let extra_started_while_blocked =
            tokio::time::timeout(Duration::from_millis(100), starts.recv())
                .await
                .is_ok();

        drop(gate);
        tokio::time::timeout(Duration::from_secs(5), extra)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(permits_while_blocked, 0);
        assert!(!extra_started_while_blocked);
    }
}

fn start_listener(port: jint, token: String, product_version: String) -> Result<(), DomainError> {
    let port = u16::try_from(port)
        .ok()
        .filter(|port| *port == MCP_STABLE_PORT || *port == MCP_DEBUG_PORT)
        .ok_or_else(|| DomainError::invalid("MCP port is not a build endpoint"))?;
    let mut slot = listener_slot()?;
    if let Some(previous) = slot.take() {
        previous.stop();
    }
    let facade = kotlin_facade(port, product_version)?;
    *slot = Some(McpListener::start(port, token, facade)?);
    Ok(())
}

/// Binds the build endpoint, replacing any previous listener, and returns once it is live.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_droidbridge_standalone_runtimehost_NativeRuntime_nativeMcpStart(
    mut env: EnvUnowned,
    _class: JClass,
    port: jint,
    token: JString,
    product_version: JString,
) -> jboolean {
    match env
        .with_env(|owned| -> jni::errors::Result<jboolean> {
            initialize_host_bridge(owned)?;
            let token = token.mutf8_chars(owned)?.to_str().into_owned();
            let product_version = product_version.mutf8_chars(owned)?.to_str().into_owned();
            Ok(if start_listener(port, token, product_version).is_ok() {
                JNI_TRUE
            } else {
                JNI_FALSE
            })
        })
        .into_outcome()
    {
        Outcome::Ok(value) => value,
        Outcome::Err(_) | Outcome::Panic(_) => JNI_FALSE,
    }
}

/// Replaces the accepted bearer token; the next admitted request sees only the new token.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_droidbridge_standalone_runtimehost_NativeRuntime_nativeMcpSetToken(
    mut env: EnvUnowned,
    _class: JClass,
    token: JString,
) -> jboolean {
    match env
        .with_env(|owned| -> jni::errors::Result<jboolean> {
            let token = token.mutf8_chars(owned)?.to_str().into_owned();
            let updated = listener_slot().and_then(|slot| match slot.as_ref() {
                Some(listener) => listener.set_token(token),
                None => Ok(()),
            });
            Ok(if updated.is_ok() { JNI_TRUE } else { JNI_FALSE })
        })
        .into_outcome()
    {
        Outcome::Ok(value) => value,
        Outcome::Err(_) | Outcome::Panic(_) => JNI_FALSE,
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_droidbridge_standalone_runtimehost_NativeRuntime_nativeMcpStop(
    _env: EnvUnowned,
    _class: JClass,
) -> jboolean {
    match listener_slot() {
        Ok(mut slot) => {
            if let Some(listener) = slot.take() {
                listener.stop();
            }
            JNI_TRUE
        }
        Err(_) => JNI_FALSE,
    }
}

/// The observed listener: `stopped`, `running`, or `failed` when its slot cannot be read.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_droidbridge_standalone_runtimehost_NativeRuntime_nativeMcpState(
    mut env: EnvUnowned,
    _class: JClass,
) -> jstring {
    match env
        .with_env(|owned| -> jni::errors::Result<jstring> {
            let state = match listener_slot() {
                Ok(slot) => slot.as_ref().map_or("stopped", McpListener::state),
                Err(_) => "failed",
            };
            Ok(owned.new_string(state)?.into_raw())
        })
        .into_outcome()
    {
        Outcome::Ok(value) => value,
        Outcome::Err(_) | Outcome::Panic(_) => ptr::null_mut(),
    }
}
