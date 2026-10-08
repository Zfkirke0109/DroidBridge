use crate::app_guard_recovery::{AppCleanupVerification, reconcile_app_recovery};
use crate::automation_wake::ApkAlarmWake;
use crate::host_health::{
    HostHealthClass, bridge_fault_latched, classify_deep_probe, probe_descriptor_class,
    probe_store_writable,
};
use crate::{
    AndroidFrameworkFilesystemDispatcher, AndroidFrameworkFilesystemPort,
    AndroidShizukuFilesystemPort, ApkCommandProcessPort, ApkCore, ApkNetworkPort, ApkVisualPort,
    GetifaddrsInterfaces, NativeHost, ProcFacts, StartResult, guard, host_slot, io_error, new_uuid,
    read_boot_id, read_start_ticks,
};
use contract::{ErrorCode, RunAs, RuntimeHost, RuntimeReadiness, UuidV4};
use domain::{AdmissionFence, DomainError};
use persistence::{
    CanonicalState, FaultFileStore, FaultRecord, FaultRole, GuardProofDirectory,
    JsonPersistencePort, LifetimeLease, RuntimeArtifactPort, RuntimeLive, RuntimeOwner, StateStore,
    await_guard_recovery_plan,
};
use runtime::{
    AndroidNetworkDefaultEventSource, ApkCapabilityPort, ApkRuntimeVertical, AutomationScheduler,
    BoottimeClock, CapabilityPort, CompositeExecutionSurface, HostControlPort,
    NativeCommandExecutionSurface, NativeFilesystemExecutionSurface, NativeNetworkExecutionSurface,
    NativeVisualExecutionSurface, ProviderToken, RecoveryProof, RuntimeCore, VerticalEnvironment,
};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Clone)]
pub(super) struct AppHostControl {
    store: Arc<StateStore>,
    lease: Arc<LifetimeLease>,
    recovery_proof: RecoveryProof,
    capabilities: ApkCapabilityPort,
}

impl HostControlPort for AppHostControl {
    fn cleanup_unverified(
        &self,
        fence: &AdmissionFence,
        _execution_id: &UuidV4,
    ) -> Result<(), DomainError> {
        self.activate(fence)?;
        self.capabilities.withdraw_readiness()
    }

    fn prepare(&self) -> Result<(), DomainError> {
        self.store.validate_lease(&self.lease)
    }

    fn activate(&self, fence: &AdmissionFence) -> Result<(), DomainError> {
        self.store.validate_lease(&self.lease)?;
        let live = self.lease.live();
        if live.runtime_epoch != fence.runtime_epoch
            || live.host_generation != fence.host_generation
            || live.runtime_instance_id != fence.runtime_instance_id
        {
            return Err(DomainError::new(
                ErrorCode::StaleAuthority,
                "Runtime activation fence is stale",
            ));
        }
        Ok(())
    }

    fn recover(&self, _old_instance_id: &UuidV4) -> Result<RecoveryProof, DomainError> {
        self.store.validate_lease(&self.lease)?;
        if self.recovery_proof == RecoveryProof::CleanupUnverified {
            self.capabilities.withdraw_readiness()?;
        }
        Ok(self.recovery_proof)
    }

    fn store_write_failed(&self, error: &DomainError) {
        eprintln!(
            "DroidBridge canonical commit failed: {:?} {} errno={:?}",
            error.code, error.reason, error.os_error
        );
        if let Err(failed) = self.capabilities.withdraw_readiness_as("STORE_UNAVAILABLE") {
            eprintln!("DroidBridge cannot withdraw readiness: {:?}", failed.code);
        }
        if let Err(failed) = self.store.record_store_write_fault(&self.lease) {
            eprintln!(
                "DroidBridge cannot record the store fault: {:?}",
                failed.code
            );
        }
    }

    fn store_write_recovered(&self) {
        eprintln!("DroidBridge: canonical store takes writes again");
        if let Err(failed) = self
            .capabilities
            .restore_readiness_from("STORE_UNAVAILABLE")
        {
            eprintln!("DroidBridge: cannot restore readiness: {:?}", failed.code);
        }
    }

    fn task_activity_changed(&self, active_tasks: usize, canonical_revision: u64) {
        if let Err(error) = crate::publish_task_activity(
            active_tasks,
            canonical_revision,
            &self.lease.live().runtime_epoch,
        ) {
            eprintln!(
                "DroidBridge task activity projection failed: {:?}",
                error.code
            );
        }
    }
}

pub(super) fn start_host(
    base: PathBuf,
    environment_json: &str,
) -> Result<StartResult, DomainError> {
    let mut slot = host_slot()
        .lock()
        .map_err(|_| DomainError::new(ErrorCode::InternalError, "native host lock failed"))?;
    if let Some(host) = slot.as_ref() {
        return existing_host_result(host);
    }
    let environment: VerticalEnvironment = serde_json::from_str(environment_json)
        .map_err(|_| DomainError::invalid("invalid platform environment"))?;
    fs::create_dir_all(&base).map_err(io_error)?;
    let store = Arc::new(StateStore::new(base.clone()));
    let owner_path = base.join("runtime-owner.json");
    if !owner_path.exists() {
        let owner = RuntimeOwner {
            schema_version: 1,
            runtime_epoch: new_uuid()?,
            host: RuntimeHost::ApkRuntime,
            host_generation: 1,
        };
        store.initialize(&owner, &CanonicalState::default())?;
    }
    FaultFileStore::initialize_all_by_apk(&base)?;
    let owner = store.read_owner()?;
    if owner.host != RuntimeHost::ApkRuntime {
        return Err(DomainError::new(
            ErrorCode::CapabilityUnavailable,
            "APK Runtime is not the authoritative host",
        ));
    }
    let boot_id = read_boot_id()?;
    let runtime_instance_id = new_uuid()?;
    let live = RuntimeLive {
        runtime_epoch: owner.runtime_epoch.clone(),
        host: owner.host,
        host_generation: owner.host_generation,
        runtime_instance_id: runtime_instance_id.clone(),
        boot_id: boot_id.clone(),
        pid: std::process::id(),
        start_ticks: read_start_ticks(Path::new("/proc/self/stat"))?,
    };
    let lease = Arc::new(store.acquire_lifetime(live)?);
    activate_app_host(
        &mut slot,
        base,
        environment,
        store,
        owner,
        lease,
        boot_id,
        runtime_instance_id,
    )
}

#[allow(clippy::too_many_arguments)]
fn activate_app_host(
    slot: &mut Option<Arc<NativeHost>>,
    base: PathBuf,
    mut environment: VerticalEnvironment,
    store: Arc<StateStore>,
    owner: RuntimeOwner,
    lease: Arc<LifetimeLease>,
    boot_id: UuidV4,
    runtime_instance_id: UuidV4,
) -> Result<StartResult, DomainError> {
    let state = store.load(&lease)?;
    let recovery = await_guard_recovery_plan(
        &state,
        &runtime_instance_id,
        &boot_id,
        &GuardProofDirectory::new(&base),
        &ProcFacts,
    )?;
    environment.runtime_epoch = owner.runtime_epoch.clone();
    environment.host_generation = owner.host_generation;
    let product_version = environment.version_name.clone();
    let runtime = ApkRuntimeVertical::new(environment)?;
    guard::publish_scope(guard::GuardScope::new(
        base.clone(),
        owner.runtime_epoch.clone(),
        runtime_instance_id.clone(),
    )?)?;
    let capabilities = runtime.capability_port(runtime_instance_id.clone());
    let host_control = AppHostControl {
        store: Arc::clone(&store),
        lease: Arc::clone(&lease),
        capabilities: capabilities.clone(),
        recovery_proof: RecoveryProof::Clean,
    };
    host_control.prepare()?;
    host_control.activate(&capabilities.current()?.fence)?;
    let artifacts = RuntimeArtifactPort::new(Arc::clone(&store), Arc::clone(&lease));
    let executions = CompositeExecutionSurface::new(
        NativeFilesystemExecutionSurface::new(
            base.clone(),
            artifacts.clone(),
            capabilities.clone(),
            ProviderToken::AppNative,
        )
        .with_framework(AndroidFrameworkFilesystemPort::new(
            AndroidFrameworkFilesystemDispatcher,
        ))
        .with_primitives(AndroidShizukuFilesystemPort),
    )
    .with_command(NativeCommandExecutionSurface::new(
        artifacts.clone(),
        capabilities.clone(),
        &[RunAs::App, RunAs::Shell],
        ApkCommandProcessPort,
    ))
    .with_network(NativeNetworkExecutionSurface::new(
        artifacts.clone(),
        capabilities.clone(),
        ApkNetworkPort::new(
            AndroidFrameworkFilesystemDispatcher,
            GetifaddrsInterfaces,
            AndroidShizukuFilesystemPort,
        ),
    ))
    .with_visual(
        NativeVisualExecutionSurface::new(artifacts.clone(), capabilities.clone())
            .with_primitives(ApkVisualPort::new(base.clone(), capabilities.clone())),
    )
    .with_android(
        runtime::NativeAndroidExecutionSurface::new(
            capabilities.clone(),
            crate::android::running_package()?,
        )
        .with_primitives(crate::android::ApkAndroidPort),
    );
    let network_event_source = Arc::new(AndroidNetworkDefaultEventSource::new(
        AndroidFrameworkFilesystemDispatcher,
        capabilities.clone(),
    ));
    let core = RuntimeCore::new(
        JsonPersistencePort::new(Arc::clone(&store), Arc::clone(&lease)),
        artifacts.clone(),
        executions,
        capabilities,
        host_control,
    )
    .with_network_default_event_source(network_event_source);
    let async_runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .map_err(|_| DomainError::new(ErrorCode::InternalError, "Runtime executor failed"))?;
    let verification = reconcile_app_recovery(
        &base,
        &store,
        &lease,
        &runtime,
        &core,
        &async_runtime,
        &recovery,
    )?;
    let committed = store.load(&lease)?;
    let active_tasks = committed
        .tasks
        .iter()
        .filter(|task| {
            matches!(
                task.state,
                contract::TaskState::Created
                    | contract::TaskState::Queued
                    | contract::TaskState::Running
            )
        })
        .count();
    crate::publish_task_activity(
        active_tasks,
        committed.store_revision,
        &lease.live().runtime_epoch,
    )?;
    publish_ready_host(
        slot,
        base,
        store,
        lease,
        runtime,
        core,
        artifacts,
        async_runtime,
        boot_id,
        runtime_instance_id,
        product_version,
        owner,
        verification,
    )
}

#[allow(clippy::too_many_arguments)]
fn publish_ready_host(
    slot: &mut Option<Arc<NativeHost>>,
    base: PathBuf,
    store: Arc<StateStore>,
    lease: Arc<LifetimeLease>,
    runtime: ApkRuntimeVertical,
    core: ApkCore,
    artifacts: RuntimeArtifactPort,
    async_runtime: tokio::runtime::Runtime,
    boot_id: UuidV4,
    runtime_instance_id: UuidV4,
    product_version: String,
    owner: RuntimeOwner,
    _cleanup: AppCleanupVerification,
) -> Result<StartResult, DomainError> {
    store.validate_lease(&lease)?;
    let automation_wake = Arc::new(ApkAlarmWake::new(
        AndroidFrameworkFilesystemDispatcher,
        runtime.capability_port(runtime_instance_id.clone()),
    ));
    let automation_scheduler = spawn_automation_scheduler(
        &async_runtime,
        core.clone(),
        Arc::clone(&automation_wake),
        AutomationFaultContext {
            base: base.clone(),
            product_version: product_version.clone(),
            boot_id: boot_id.clone(),
            runtime_instance_id: runtime_instance_id.clone(),
        },
    );
    // A durable S-UPD-002 maintenance record keeps business admission closed across restarts.
    let admission_open = !base.join(crate::UPDATE_MAINTENANCE_RECORD).exists();
    *slot = Some(Arc::new(NativeHost {
        base,
        store,
        _lease: lease,
        runtime,
        core,
        artifacts,
        async_runtime,
        boot_id,
        runtime_instance_id: runtime_instance_id.clone(),
        product_version,
        admission_open: AtomicBool::new(admission_open),
        quarantined: AtomicBool::new(false),
        automation_wake,
        automation_scheduler,
    }));
    Ok(StartResult {
        ready: true,
        runtime_epoch: owner.runtime_epoch,
        host_generation: owner.host_generation,
        runtime_instance_id,
    })
}

fn existing_host_result(host: &NativeHost) -> Result<StartResult, DomainError> {
    validate_host_instance(host, None)?;
    if !host.admission_open.load(Ordering::SeqCst) {
        return Err(DomainError::new(
            ErrorCode::CapabilityUnavailable,
            "APK Runtime is not ready",
        ));
    }
    Ok(start_result(host._lease.live()))
}

/// Revalidates a cached App session without changing the native slot or closing read-only
/// requests during planned maintenance. The lease and native capability fence must still name
/// precisely the instance Kotlin previously adopted.
pub(super) fn validate_existing_host(expected: &AdmissionFence) -> Result<(), DomainError> {
    let host = host_slot()
        .lock()
        .map_err(|_| DomainError::new(ErrorCode::InternalError, "native host lock failed"))?
        .clone()
        .ok_or_else(|| {
            DomainError::new(
                ErrorCode::CapabilityUnavailable,
                "APK Runtime is not started",
            )
        })?;
    validate_host_instance(&host, Some(expected))
}

/// A deep probe reads the canonical state, proves this instance's private directory can take a
/// synced write, and checks the framework executor through the actual JNI bridge. It never runs
/// an executor or changes canonical state.
pub(super) fn probe_existing_host(expected: &AdmissionFence) -> HostHealthClass {
    let Some(host) = host_slot().lock().ok().and_then(|slot| slot.clone()) else {
        return HostHealthClass::HostMissing;
    };
    if !fence_names_live(expected, host._lease.live()) {
        return HostHealthClass::FenceMismatch;
    }
    if let Err(error) = host.store.validate_lease(&host._lease) {
        return if error.code == ErrorCode::StaleAuthority {
            HostHealthClass::LeaseStale
        } else {
            HostHealthClass::StoreUnreadable
        };
    }
    if probe_descriptor_class() != HostHealthClass::Healthy {
        return HostHealthClass::ResourceExhausted;
    }
    if bridge_fault_latched(&host.runtime_instance_id) {
        return HostHealthClass::BridgeFault;
    }
    match validate_host_instance(&host, Some(expected)) {
        Ok(()) => {}
        Err(error) if error.code == ErrorCode::StaleAuthority => {
            return HostHealthClass::FenceMismatch;
        }
        Err(error) if error.code == ErrorCode::IoError => {
            return if bridge_fault_latched(&host.runtime_instance_id) {
                HostHealthClass::BridgeFault
            } else {
                HostHealthClass::StoreUnreadable
            };
        }
        Err(error) if error.code == ErrorCode::CapabilityUnavailable => {
            return HostHealthClass::NotReady;
        }
        Err(error) if error.code == ErrorCode::ResourceLimit => {
            return HostHealthClass::ResourceExhausted;
        }
        Err(_) => return HostHealthClass::ProbeFailed,
    }
    classify_deep_probe(
        || host.store.load(&host._lease).map(|_| ()),
        || probe_store_writable(&host.base, &host.runtime_instance_id),
        || crate::probe_execution_bridge(&host, expected.host_generation),
    )
}

/// Remove only the exact unhealthy instance. Existing request Arcs keep its lease until they
/// finish; the release worker holds that lease through shutdown of the instance's reactor.
pub(super) fn quarantine_existing_host(expected: &AdmissionFence) -> Result<bool, DomainError> {
    let mut slot = host_slot()
        .lock()
        .map_err(|_| DomainError::new(ErrorCode::InternalError, "native host lock failed"))?;
    let Some(host) = slot.as_ref() else {
        return Ok(false);
    };
    if !fence_names_live(expected, host._lease.live()) {
        return Ok(false);
    }
    host.quarantined.store(true, Ordering::SeqCst);
    host.admission_open.store(false, Ordering::SeqCst);
    host.automation_scheduler.abort();
    let host = slot.take().expect("matching slot exists");
    drop(slot);

    let release_copy = Arc::clone(&host);
    if std::thread::Builder::new()
        .name("droidbridge-host-release".to_owned())
        .spawn(move || release_quarantined_host(release_copy))
        .is_err()
    {
        release_quarantined_host(host);
    }
    Ok(true)
}

fn release_quarantined_host(host: Arc<NativeHost>) {
    let owned = await_unshared(host);
    let lease = Arc::clone(&owned._lease);
    drop(owned);
    drop(lease);
}

fn await_unshared<T>(mut value: Arc<T>) -> T {
    loop {
        match Arc::try_unwrap(value) {
            Ok(owned) => return owned,
            Err(shared) => {
                value = shared;
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    }
}

pub(super) fn validate_host_instance(
    host: &NativeHost,
    expected: Option<&AdmissionFence>,
) -> Result<(), DomainError> {
    if host.quarantined.load(Ordering::Acquire) {
        return Err(DomainError::new(
            ErrorCode::CapabilityUnavailable,
            "APK Runtime instance is quarantined",
        ));
    }
    host.store.validate_lease(&host._lease)?;
    let live = host._lease.live();
    if expected.is_some_and(|fence| !fence_names_live(fence, live)) {
        return Err(DomainError::new(
            ErrorCode::StaleAuthority,
            "APK Runtime fence changed",
        ));
    }
    if probe_descriptor_class() != HostHealthClass::Healthy {
        return Err(DomainError::new(
            ErrorCode::ResourceLimit,
            "APK Runtime has insufficient file descriptors",
        ));
    }
    let capability = host
        .runtime
        .capability_port(host.runtime_instance_id.clone())
        .current()?;
    if expected.is_some_and(|fence| capability.fence != *fence) {
        return Err(DomainError::new(
            ErrorCode::StaleAuthority,
            "APK Runtime capability fence changed",
        ));
    }
    if crate::guard::is_quarantined() || capability.context.readiness != RuntimeReadiness::Ready {
        return Err(DomainError::new(
            ErrorCode::CapabilityUnavailable,
            "APK Runtime is not ready",
        ));
    }
    if bridge_fault_latched(&host.runtime_instance_id) {
        return Err(DomainError::new(
            ErrorCode::IoError,
            "Android execution bridge failed",
        ));
    }
    Ok(())
}

fn fence_names_live(fence: &AdmissionFence, live: &RuntimeLive) -> bool {
    fence.runtime_epoch == live.runtime_epoch
        && fence.host_generation == live.host_generation
        && fence.runtime_instance_id == live.runtime_instance_id
}

fn start_result(live: &RuntimeLive) -> StartResult {
    StartResult {
        ready: true,
        runtime_epoch: live.runtime_epoch.clone(),
        host_generation: live.host_generation,
        runtime_instance_id: live.runtime_instance_id.clone(),
    }
}

/// The host identity a scheduler fault is recorded under.
pub(super) struct AutomationFaultContext {
    pub(super) base: PathBuf,
    pub(super) product_version: String,
    pub(super) boot_id: UuidV4,
    pub(super) runtime_instance_id: UuidV4,
}

/// Starts this APK Runtime instance's resident Automation scheduler on its reactor (S-LIFE-003,
/// S-AUTO-001): it publishes `runtime.ready` once, then projects persisted dues onto the single
/// exact alarm. The task ends with the reactor when the host stops; a fault that ends it earlier
/// is appended to the host fault file rather than dropped.
fn spawn_automation_scheduler(
    async_runtime: &tokio::runtime::Runtime,
    core: ApkCore,
    wake: Arc<crate::ApkAutomationWake>,
    fault: AutomationFaultContext,
) -> tokio::task::JoinHandle<()> {
    let fault = Arc::new(fault);
    let pass_fault = Arc::clone(&fault);
    // A failed pass is retried by the loop itself; the fault file keeps the record of it.
    let scheduler = AutomationScheduler::new(core, Arc::new(BoottimeClock)).reporting_faults(
        Arc::new(move |error: &DomainError| {
            let _recorded = record_scheduler_fault(&pass_fault, error, "automation_scheduler_pass");
        }),
    );
    async_runtime.spawn(async move {
        let ended = async {
            scheduler.publish_runtime_ready().await?;
            scheduler.run(wake.as_ref()).await
        }
        .await;
        if let Err(error) = ended {
            // The fault file is the last channel a detached scheduler has; if it cannot be
            // written either, the stopped scheduler still leaves persisted dues unchanged.
            let _recorded = record_scheduler_fault(&fault, &error, "automation_scheduler_run");
        }
    })
}

fn record_scheduler_fault(
    fault: &AutomationFaultContext,
    error: &DomainError,
    phase: &str,
) -> Result<(), DomainError> {
    let now = chrono::Utc::now();
    let now_ms = u64::try_from(now.timestamp_millis())
        .map_err(|_| DomainError::new(ErrorCode::InternalError, "clock is before epoch"))?;
    FaultFileStore::new(&fault.base, FaultRole::Host).append(
        FaultRecord {
            record_id: new_uuid()?,
            at: now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            component: "automation_scheduler".to_owned(),
            code: crate::error_code_token(error.code).to_owned(),
            phase: phase.to_owned(),
            product_version: fault.product_version.clone(),
            boot_id: fault.boot_id.clone(),
            runtime_instance_id: Some(fault.runtime_instance_id.clone()),
            execution_id: None,
            exit_code: None,
            signal: None,
            repeat_count: 1,
        },
        now_ms,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_health::{HostHealthClass, classify_deep_probe, probe_store_writable};

    fn id(number: u64) -> UuidV4 {
        UuidV4::parse(format!("00000000-0000-4000-8000-{number:012x}")).unwrap()
    }

    #[test]
    fn cached_session_fence_must_name_the_exact_live_instance() {
        let live = RuntimeLive {
            runtime_epoch: id(1),
            host: RuntimeHost::ApkRuntime,
            host_generation: 7,
            runtime_instance_id: id(2),
            boot_id: id(3),
            pid: 42,
            start_ticks: 99,
        };
        let expected = AdmissionFence {
            runtime_epoch: id(1),
            host_generation: 7,
            runtime_instance_id: id(2),
        };
        assert!(fence_names_live(&expected, &live));
        assert!(!fence_names_live(
            &AdmissionFence {
                runtime_epoch: id(4),
                ..expected.clone()
            },
            &live
        ));
        assert!(!fence_names_live(
            &AdmissionFence {
                host_generation: 8,
                ..expected.clone()
            },
            &live
        ));
        assert!(!fence_names_live(
            &AdmissionFence {
                runtime_instance_id: id(5),
                ..expected
            },
            &live
        ));
    }

    #[test]
    fn deep_probe_keeps_canonical_bytes_untouched_and_cleans_its_private_scratch_file() {
        let base = std::env::temp_dir().join(format!("droidbridge-probe-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&base).unwrap();
        let canonical = base.join("runtime-state.json");
        fs::write(&canonical, b"canonical-before-probe").unwrap();

        probe_store_writable(&base, &id(2)).unwrap();
        probe_store_writable(&base, &id(2)).unwrap();

        assert_eq!(fs::read(&canonical).unwrap(), b"canonical-before-probe");
        let names: Vec<_> = fs::read_dir(&base)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, ["runtime-state.json"]);
        assert!(probe_store_writable(&base.join("missing"), &id(2)).is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn deep_probe_reports_the_first_failed_source_without_running_an_executor() {
        let executor_was_called = std::cell::Cell::new(false);
        assert_eq!(
            classify_deep_probe(
                || Err(DomainError::new(ErrorCode::IoError, "state read failed")),
                || Err(std::io::Error::other("scratch sync failed")),
                || {
                    executor_was_called.set(true);
                    HostHealthClass::ExecutorMissing
                },
            ),
            HostHealthClass::StoreUnreadable,
        );
        assert!(!executor_was_called.get());
        assert_eq!(
            classify_deep_probe(
                || Err(DomainError::new(ErrorCode::StaleAuthority, "lease moved")),
                || Ok(()),
                || HostHealthClass::Healthy,
            ),
            HostHealthClass::LeaseStale,
        );
        assert_eq!(
            classify_deep_probe(
                || Ok(()),
                || Err(std::io::Error::other("disk full")),
                || {
                    executor_was_called.set(true);
                    HostHealthClass::Healthy
                },
            ),
            HostHealthClass::StoreUnwritable,
        );
        assert!(!executor_was_called.get());
        assert_eq!(
            classify_deep_probe(
                || Ok(()),
                || Ok(()),
                || {
                    executor_was_called.set(true);
                    HostHealthClass::ExecutorMissing
                }
            ),
            HostHealthClass::ExecutorMissing,
        );
        assert!(executor_was_called.get());
    }

    #[test]
    fn quarantine_release_waits_for_the_last_in_flight_owner() {
        let directory =
            std::env::temp_dir().join(format!("droidbridge-lease-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let lock_path = directory.join("runtime-live.lock");
        let owned = Arc::new(persistence::FileLock::acquire(&lock_path).unwrap());
        let in_flight = Arc::clone(&owned);
        let (started, ready) = std::sync::mpsc::channel();
        let (released, finished) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            started.send(()).unwrap();
            drop(await_unshared(owned));
            released.send(()).unwrap();
        });
        ready.recv().unwrap();
        assert!(
            persistence::FileLock::try_acquire(&lock_path)
                .unwrap()
                .is_none()
        );
        assert!(
            finished
                .recv_timeout(std::time::Duration::from_millis(100))
                .is_err()
        );
        drop(in_flight);
        finished
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        assert!(
            persistence::FileLock::try_acquire(&lock_path)
                .unwrap()
                .is_some()
        );
        worker.join().unwrap();
        fs::remove_dir_all(directory).unwrap();
    }
}
