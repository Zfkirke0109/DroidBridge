//! The root edition's daemon. It owns its canonical store under `/data/adb/droidbridge`, is the
//! only Runtime host that store ever has, serves MCP itself and answers the frontend App, which
//! only shows and changes this daemon's state.

use crate::{
    ModuleIdentity, ModuleObservation,
    frontend::{self, Handler, error_payload},
    ingress::DaemonIngress,
    magisk_guard_recovery::{ProcFacts, read_boot_id},
    magisk_host::{HostSubmitter, MagiskHost, VERSION_CODE, fixed_property, observe_module},
    recycle::Recycle,
    settings::SettingsStore,
    unix_transport::connect_abstract,
};
use contract::{ErrorCode, RuntimeHost, UuidV4};
use domain::DomainError;
use persistence::{
    CanonicalState, FaultFileStore, MaintenanceBlocker, RuntimeOwner, RuntimeResetIntent,
    StateStore,
};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Path, PathBuf},
    process::ExitCode,
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

/// The main loop's period: how soon a newly opened frontend is connected.
const TICK: Duration = Duration::from_secs(1);
/// How often the host's facts (helper, module, quarantine) are observed again.
const REFRESH_EVERY: Duration = Duration::from_secs(5);
/// The waits before another activation attempt after a failed one.
const ACTIVATION_DELAYS_SECONDS: [u64; 6] = [1, 2, 4, 8, 16, 30];
/// How long a cleared stranded execution waits for an instance that still holds the live lock.
const STRANDED_CLEAR_WAIT: Duration = Duration::from_secs(20);
const LIVE_LOCK_RELEASE_WAIT: Duration = Duration::from_secs(5);
/// The S-SEC-005 bound on one fault file.
const FAULT_FILE_LIMIT_BYTES: u64 = 65_536;

pub fn main() -> ExitCode {
    // Magisk starts services with umask 0; everything this daemon creates is its own alone.
    unsafe { libc::umask(0o077) };
    match Daemon::discover().and_then(|daemon| Arc::new(daemon).run()) {
        Ok(()) => ExitCode::SUCCESS,
        // The supervisor records only the exit code; the reason goes to the daemon's stderr log.
        Err(error) => {
            eprintln!("droidbridged: exiting: {:?} {}", error.code, error.reason);
            ExitCode::from(1)
        }
    }
}

struct Daemon {
    identity: ModuleIdentity,
    module_root: PathBuf,
    base: PathBuf,
    sdk_int: u32,
    store: Arc<StateStore>,
    recycle: Arc<Recycle>,
    host: Mutex<HostSlot>,
    /// Taken after [host] whenever both are held.
    ingress: Mutex<DaemonIngress<HostSubmitter>>,
    frontend_connected: AtomicBool,
}

struct HostSlot {
    host: Option<MagiskHost>,
    observation: Option<ModuleObservation>,
    failure: Option<DomainError>,
    failures: usize,
    retry_at: Instant,
    refreshed_at: Instant,
}

impl Daemon {
    fn discover() -> Result<Self, DomainError> {
        let executable = fs::canonicalize(
            std::env::current_exe().map_err(|_| io_error("cannot resolve daemon executable"))?,
        )
        .map_err(|_| io_error("cannot canonicalize daemon executable"))?;
        let module_root = executable
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| io_error("daemon is outside a module root"))?
            .to_path_buf();
        let identity = build_identity();
        if executable != module_root.join("bin").join("droidbridged")
            || module_root.file_name().and_then(|value| value.to_str()) != Some(identity.module_id)
        {
            return Err(DomainError::new(
                ErrorCode::PermissionDenied,
                "daemon executable is outside its fixed module identity",
            ));
        }
        let sdk_int = fixed_property("ro.build.version.sdk")?
            .parse()
            .ok()
            .filter(|value| (33..=37).contains(value))
            .ok_or_else(|| {
                DomainError::new(
                    ErrorCode::CapabilityUnavailable,
                    "device SDK has no fixed helper",
                )
            })?;
        let base = identity.state_base();
        let store = Arc::new(initialize_store(&base)?);
        let port = if identity.module_id == ModuleIdentity::debug().module_id {
            runtime::MCP_ROOT_DEBUG_PORT
        } else {
            runtime::MCP_ROOT_STABLE_PORT
        };
        Ok(Self {
            identity,
            module_root,
            ingress: Mutex::new(DaemonIngress::new(SettingsStore::new(base.clone()), port)),
            base,
            sdk_int,
            store,
            recycle: Arc::default(),
            host: Mutex::new(HostSlot {
                host: None,
                observation: None,
                failure: None,
                failures: 0,
                retry_at: Instant::now(),
                refreshed_at: Instant::now(),
            }),
            frontend_connected: AtomicBool::new(false),
        })
    }

    fn run(self: Arc<Self>) -> Result<(), DomainError> {
        loop {
            if self.recycle.due() {
                Recycle::bound_shutdown();
                let host = self.slot().host.take();
                self.ingress().attach(None);
                if let Some(host) = host {
                    host.shutdown();
                }
                return Err(DomainError::new(
                    ErrorCode::IoError,
                    "execution cleanup is unverified; the supervisor restarts the daemon",
                ));
            }
            self.maintain_host();
            self.connect_frontend();
            self.recycle.sleep(TICK);
        }
    }

    /// Activates the host when its retry is due and observes an active host's facts.
    fn maintain_host(&self) {
        let mut slot = self.slot();
        let now = Instant::now();
        if slot.host.is_none() {
            if now >= slot.retry_at {
                self.activate(&mut slot);
            }
            return;
        }
        if now.duration_since(slot.refreshed_at) < REFRESH_EVERY {
            return;
        }
        slot.refreshed_at = now;
        let observed = observe_module(&self.module_root, &self.identity);
        let module_ready = observed
            .as_ref()
            .is_ok_and(|observation| observation.readiness(&self.identity, VERSION_CODE).is_ok());
        slot.observation = observed.ok();
        if let Some(host) = slot.host.as_mut()
            && let Err(error) =
                host.refresh_runtime_facts(&self.module_root, self.sdk_int, module_ready)
        {
            eprintln!(
                "droidbridged: runtime fact refresh failed: {:?} {}",
                error.code, error.reason
            );
        }
    }

    fn activate(&self, slot: &mut HostSlot) {
        let activated = (|| {
            let observation = observe_module(&self.module_root, &self.identity)?;
            slot.observation = Some(observation.clone());
            observation.readiness(&self.identity, VERSION_CODE)?;
            let owner = self.store.read_owner()?;
            if owner.host != RuntimeHost::MagiskBackend {
                return Err(DomainError::new(
                    ErrorCode::StaleAuthority,
                    "the canonical store belongs to another host",
                ));
            }
            MagiskHost::activate(
                Arc::clone(&self.store),
                &self.identity,
                &self.module_root,
                &self.base,
                self.sdk_int,
                owner,
                Arc::clone(&self.recycle),
            )
        })();
        match activated {
            Ok(host) => {
                self.ingress().attach(Some(host.submitter()));
                slot.host = Some(host);
                slot.failure = None;
                slot.failures = 0;
                slot.refreshed_at = Instant::now();
            }
            Err(error) => {
                eprintln!(
                    "droidbridged: Runtime activation failed: {:?} {}",
                    error.code, error.reason
                );
                let delay = ACTIVATION_DELAYS_SECONDS
                    [slot.failures.min(ACTIVATION_DELAYS_SECONDS.len() - 1)];
                slot.failures += 1;
                slot.retry_at = Instant::now() + Duration::from_secs(delay);
                slot.failure = Some(error);
            }
        }
    }

    /// Connects a frontend that is listening, unless one is already served.
    fn connect_frontend(self: &Arc<Self>) {
        if self.frontend_connected.load(Ordering::Acquire) {
            return;
        }
        let Ok(stream) = connect_abstract(self.identity.socket_name) else {
            return;
        };
        self.frontend_connected.store(true, Ordering::Release);
        let daemon = Arc::clone(self);
        thread::spawn(move || {
            let handler: Handler = {
                let daemon = Arc::clone(&daemon);
                Arc::new(move |operation, payload| daemon.handle(operation, payload))
            };
            if let Err(error) = frontend::serve(stream, &daemon.identity, handler) {
                // The only record of a frontend connection that ended or was refused.
                eprintln!(
                    "droidbridged: frontend connection ended: {:?} {}",
                    error.code, error.reason
                );
            }
            daemon.frontend_connected.store(false, Ordering::Release);
        });
    }

    fn handle(&self, operation: &str, payload: &Value) -> Value {
        let flag = |name: &str| payload.get(name).and_then(Value::as_bool);
        let text = |name: &str| payload.get(name).and_then(Value::as_str);
        let answered = match operation {
            "status" => Ok(self.status()),
            "submit" => self.submit(payload),
            "mcp_settings" => Ok(self.ingress().mcp_settings()),
            "mcp_set_enabled" => flag("enabled")
                .map(|enabled| self.ingress().mcp_set_enabled(enabled))
                .ok_or_else(invalid_payload),
            "mcp_rotate_token" => Ok(self.ingress().mcp_rotate()),
            "mcp_reveal_token" => Ok(self.ingress().mcp_reveal()),
            "tunnel_settings" => Ok(self.ingress().tunnel_settings()),
            "tunnel_configure" => match (text("tunnel_id"), text("api_key")) {
                (Some(tunnel_id), Some(api_key)) => {
                    Ok(self.ingress().tunnel_configure(tunnel_id, api_key))
                }
                _ => Err(invalid_payload()),
            },
            "tunnel_set_enabled" => flag("enabled")
                .map(|enabled| self.ingress().tunnel_set_enabled(enabled))
                .ok_or_else(invalid_payload),
            "tunnel_clear" => Ok(self.ingress().tunnel_clear()),
            "diagnostics_snapshot" => Ok(self.diagnostics_snapshot()),
            "maintenance_state" => self.maintenance_state(),
            "fault_files" => Ok(self.fault_files()),
            "reset_runtime_data" => Ok(self.reset_runtime_data()),
            "stranded_executions" => persistence::stranded_execution_count(&self.base)
                .map(|count| json!({"count": count})),
            "clear_stranded_executions" => Ok(self.clear_stranded_executions()),
            _ => Err(DomainError::new(
                ErrorCode::ProtocolIncompatible,
                "unknown frontend operation",
            )),
        };
        answered.unwrap_or_else(|error| error_payload(&error))
    }

    fn status(&self) -> Value {
        let slot = self.slot();
        let mut status = json!({
            "schema_version": 1,
            "module_id": self.identity.module_id,
            "version_name": env!("CARGO_PKG_VERSION"),
            "version_code": VERSION_CODE,
            "started": slot.host.is_some(),
        });
        if let Some(host) = &slot.host {
            status["runtime_instance_id"] = Value::from(host.instance_id().as_str());
            status["root_guard_ready"] = Value::from(host.guard_ready());
            status["helper_ready"] = Value::from(host.helper_ready());
        }
        if let Some(observation) = &slot.observation {
            status["module_version_code"] = Value::from(observation.module_version_code);
        }
        if let Some(error) = &slot.failure {
            status["start_failure"] = error_payload(error)["error"].clone();
        }
        status
    }

    fn submit(&self, payload: &Value) -> Result<Value, DomainError> {
        let envelope = payload
            .get("envelope")
            .filter(|value| value.is_object())
            .ok_or_else(invalid_payload)?;
        let submitter = self
            .slot()
            .host
            .as_ref()
            .map(MagiskHost::submitter)
            .ok_or_else(|| {
                DomainError::new(
                    ErrorCode::CapabilityUnavailable,
                    "Magisk Runtime is not started",
                )
            })?;
        let encoded = serde_json::to_vec(envelope).map_err(|_| invalid_payload())?;
        let response = submitter.submit_blocking(encoded)?;
        serde_json::from_slice(&response)
            .map_err(|_| io_error("Magisk Runtime response is invalid"))
    }

    /// The Runtime session plus a full status read, as the frontend's diagnostics show them.
    fn diagnostics_snapshot(&self) -> Value {
        let status = self.submit(&json!({"envelope": {
            "protocol_version": 1,
            "request_id": uuid::Uuid::new_v4().hyphenated().to_string(),
            "payload": {"tool": "context", "action": "status", "input": {"detail": "full"}},
        }}));
        let started = self.slot().host.is_some();
        let mut snapshot = json!({
            "schema_version": 1,
            "session": {"started": started, "host": "magisk_backend"},
        });
        if let Ok(response) = status
            && response.get("outcome").and_then(Value::as_str) == Some("success")
            && let Some(result) = response.get("result")
        {
            snapshot["status"] = result.clone();
        }
        snapshot
    }

    /// The S-SEC-005 fault files as stored, for the frontend's diagnostics export to validate.
    fn fault_files(&self) -> Value {
        let mut files = serde_json::Map::new();
        for role in ["runtime", "host", "supervisor", "maintenance"] {
            let path = self.base.join("diagnostics").join(format!("{role}.json"));
            let read = fs::File::open(&path).and_then(|file| {
                let mut bytes = Vec::new();
                std::io::Read::read_to_end(
                    &mut std::io::Read::take(file, FAULT_FILE_LIMIT_BYTES + 1),
                    &mut bytes,
                )?;
                Ok(bytes)
            });
            let entry = match read {
                Ok(bytes) if bytes.len() as u64 <= FAULT_FILE_LIMIT_BYTES => {
                    match String::from_utf8(bytes) {
                        Ok(content) => json!({"content": content}),
                        Err(_) => json!({"status": "corrupt"}),
                    }
                }
                Ok(_) => json!({"status": "corrupt"}),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    json!({"status": "missing"})
                }
                Err(_) => json!({"status": "unreadable"}),
            };
            files.insert(role.to_owned(), entry);
        }
        Value::Object(files)
    }

    fn maintenance_state(&self) -> Result<Value, DomainError> {
        let blocker = self.store.maintenance_blocker()?;
        let cleanup =
            persistence::guard_cleanup_verified(&self.base, &read_boot_id()?, &ProcFacts)?;
        Ok(json!({
            "schema_version": 1,
            "blocker": blocker.token(),
            "cleanup": if cleanup { "verified" } else { "unverified" },
        }))
    }

    /// Empties the store into a fresh generation of this same host, then starts that host. A
    /// live host is reset only once it holds no work; without one, only a corrupt store or owner
    /// qualifies.
    fn reset_runtime_data(&self) -> Value {
        let mut slot = self.slot();
        let reset = (|| -> Result<(), DomainError> {
            if let Some(host) = slot.host.as_ref() {
                let owner = self.store.read_owner()?;
                host.record_reset_intent(&reset_intent_for(&owner)?)?;
                self.ingress().attach(None);
                if let Some(host) = slot.host.take() {
                    host.shutdown();
                }
            } else {
                let cleanup =
                    persistence::guard_cleanup_verified(&self.base, &read_boot_id()?, &ProcFacts)?;
                match self.store.maintenance_blocker()? {
                    MaintenanceBlocker::OwnerCorrupt => {
                        self.store.reset_malformed_owner(
                            new_uuid()?,
                            RuntimeHost::MagiskBackend,
                            cleanup,
                        )?;
                        return Ok(());
                    }
                    MaintenanceBlocker::StoreCorrupt => {
                        let owner = self.store.read_owner()?;
                        self.store.record_corrupt_store_reset_intent(
                            &reset_intent_for(&owner)?,
                            cleanup,
                        )?;
                    }
                    MaintenanceBlocker::None
                        if !self.base.join("runtime-reset-intent.json").exists() =>
                    {
                        return Err(DomainError::new(
                            ErrorCode::HostTransitionPending,
                            "reset needs the started Runtime or a corrupt store",
                        ));
                    }
                    MaintenanceBlocker::None => {}
                }
            }
            await_live_lock_release(&self.base)?;
            let cleanup =
                persistence::guard_cleanup_verified(&self.base, &read_boot_id()?, &ProcFacts)?;
            self.store.recover_confirmed_reset(cleanup).map(|_| ())
        })();
        if let Err(error) = reset {
            return error_payload(&error);
        }
        slot.failures = 0;
        self.activate(&mut slot);
        match &slot.failure {
            None => json!({"reset": true}),
            Some(error) => error_payload(error),
        }
    }

    /// Settles the executions a lost instance left running, which keep this host from starting,
    /// then starts it. Refused while the host is started, since its executions are not stranded.
    fn clear_stranded_executions(&self) -> Value {
        let mut slot = self.slot();
        if slot.host.is_some() {
            return error_payload(&DomainError::new(
                ErrorCode::StaleAuthority,
                "the started Runtime owns its executions",
            ));
        }
        let cleared = runtime::AutomationClock::wall(&runtime::BoottimeClock).and_then(
            |(ended_at, now_ms)| {
                persistence::clear_stranded_executions(
                    &self.base,
                    &ended_at,
                    now_ms,
                    STRANDED_CLEAR_WAIT,
                )
            },
        );
        match cleared {
            Ok(cleared) => {
                slot.failures = 0;
                self.activate(&mut slot);
                json!({"cleared": cleared})
            }
            Err(error) => error_payload(&error),
        }
    }

    fn slot(&self) -> MutexGuard<'_, HostSlot> {
        self.host.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn ingress(&self) -> MutexGuard<'_, DaemonIngress<HostSubmitter>> {
        self.ingress.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Creates the daemon's root-only state directory and, on first start, a store this host owns.
fn initialize_store(base: &Path) -> Result<StateStore, DomainError> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(base)
        .map_err(|error| {
            DomainError::os(
                ErrorCode::IoError,
                "cannot create the state directory",
                &error,
            )
        })?;
    fs::set_permissions(base, fs::Permissions::from_mode(0o700)).map_err(|error| {
        DomainError::os(
            ErrorCode::IoError,
            "cannot protect the state directory",
            &error,
        )
    })?;
    let store = StateStore::new(base.to_path_buf());
    if !base.join("runtime-owner.json").exists() && !base.join("runtime-state.json").exists() {
        store.initialize(
            &RuntimeOwner {
                schema_version: 1,
                runtime_epoch: new_uuid()?,
                host: RuntimeHost::MagiskBackend,
                host_generation: 1,
            },
            &CanonicalState::default(),
        )?;
    }
    FaultFileStore::initialize_all_by_apk(base)?;
    Ok(store)
}

fn reset_intent_for(owner: &RuntimeOwner) -> Result<RuntimeResetIntent, DomainError> {
    Ok(RuntimeResetIntent {
        schema_version: 1,
        reset_id: new_uuid()?,
        runtime_epoch: owner.runtime_epoch.clone(),
        source_host_generation: owner.host_generation,
        target_host: owner.host,
        target_host_generation: owner.host_generation.checked_add(1).ok_or_else(|| {
            DomainError::new(ErrorCode::ResourceLimit, "host generation exhausted")
        })?,
    })
}

/// Waits a bounded time for the released instance's live lock, so a lingering reference fails the
/// reset explicitly, leaving its intent for the next attempt.
fn await_live_lock_release(base: &Path) -> Result<(), DomainError> {
    let deadline = Instant::now() + LIVE_LOCK_RELEASE_WAIT;
    loop {
        if persistence::FileLock::try_acquire(&base.join("runtime-live.lock"))?.is_some() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(DomainError::new(
                ErrorCode::IoError,
                "the released Runtime instance still holds the live lock",
            ));
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn new_uuid() -> Result<UuidV4, DomainError> {
    UuidV4::parse(uuid::Uuid::new_v4().hyphenated().to_string())
        .map_err(|_| DomainError::new(ErrorCode::InternalError, "UUID generation failed"))
}

fn invalid_payload() -> DomainError {
    DomainError::invalid("invalid frontend request payload")
}

const fn io_error(reason: &'static str) -> DomainError {
    DomainError::new(ErrorCode::IoError, reason)
}

#[cfg(feature = "debug-module")]
pub(crate) const fn build_identity() -> ModuleIdentity {
    ModuleIdentity::debug()
}

#[cfg(not(feature = "debug-module"))]
pub(crate) const fn build_identity() -> ModuleIdentity {
    ModuleIdentity::stable()
}
