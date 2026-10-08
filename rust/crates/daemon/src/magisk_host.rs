use crate::{
    HelperFamily, HelperHello, HelperRegistry, MagiskExecutorFence, MagiskExecutorHandle,
    ModuleIdentity, ModuleObservation, SourceGeneration, WakeAlarmProbe,
    android::{HelperConnection, HelperPort, MagiskAndroidPort, run_clipboard_child},
    automation_wake::RealtimeAlarmWake,
    command::{CommandQuarantine, MagiskCommandProcessPort, RootCommandGuard},
    content::RootContentPort,
    helper_family_facts,
    magisk_guard_recovery::{
        FilesystemMagiskGuardRecovery, ProcFacts, execute_guard_recovery, probe_root_guard,
        read_boot_id, read_start_ticks,
    },
    network::{
        MagiskCaptureBackend, MagiskNetworkSource, NativeNetworkDefaultEventSource,
        NativeNetworkPort,
    },
    recycle::CleanupWatch,
    reprobe_families,
    unix_transport::{peer_uid, receive_json},
    visual::MagiskVisualPort,
};
use chrono::{SecondsFormat, Utc};
use contract::{
    Availability, CapabilityState, ContextCall, ErrorCode, PublicPayload, RunAs, RuntimeHost,
    UuidV4,
};
use domain::DomainError;
use persistence::{
    JsonPersistencePort, LifetimeLease, RuntimeArtifactPort, RuntimeLive, RuntimeOwner, StateStore,
    await_guard_recovery_plan,
};
use runtime::{
    ApkCapabilityPort, ApkRuntimeVertical, AutomationScheduler, BoottimeClock, CapabilityPort,
    CompositeExecutionSurface, HostControlPort, NativeAndroidExecutionSurface,
    NativeCommandExecutionSurface, NativeFilesystemExecutionSurface, NativeNetworkExecutionSurface,
    NativeVisualExecutionSurface, ProviderToken, RecoveryProof, RuntimeCore, VerticalEnvironment,
};
use std::{
    fs, io,
    os::fd::{AsRawFd, FromRawFd},
    os::unix::fs::{FileTypeExt, PermissionsExt},
    os::unix::net::{UnixListener, UnixStream},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

pub(crate) use crate::VERSION_CODE;

pub(crate) struct MagiskHost {
    submitter: HostSubmitter,
    store: Arc<StateStore>,
    lease: Arc<LifetimeLease>,
    instance_id: UuidV4,
    vertical: ApkRuntimeVertical,
    helper: Option<FrameworkHelper>,
    helper_port: HelperPort,
    family_probes: [bool; 3],
    family_probed_at: Instant,
    guard_ready: bool,
    module_ready: bool,
    wake_alarm_ready: bool,
    capability_generation: SourceGeneration,
    helper_generation: SourceGeneration,
    command_quarantine: Arc<CommandQuarantine>,
    cleanup_watch: CleanupWatch,
    executor: MagiskExecutorHandle,
    /// The fault that ended this instance's resident Automation scheduler, published as explicit
    /// capability loss by the next runtime fact refresh.
    automation_fault: Arc<StdMutex<Option<DomainError>>>,
    async_runtime: tokio::runtime::Runtime,
}

/// The one path from a public request to this host's Core, shared by the frontend and this
/// daemon's MCP ingress.
#[derive(Clone)]
pub(crate) struct HostSubmitter {
    core: MagiskCore,
    vertical: ApkRuntimeVertical,
    admission_open: Arc<AtomicBool>,
    store: Arc<StateStore>,
    lease: Arc<LifetimeLease>,
    artifacts: RuntimeArtifactPort,
    handle: tokio::runtime::Handle,
}

impl HostSubmitter {
    async fn submit(&self, encoded: Vec<u8>) -> Result<Vec<u8>, DomainError> {
        self.store.validate_lease(&self.lease)?;
        let now = Utc::now();
        let now_ms = u64::try_from(now.timestamp_millis())
            .map_err(|_| DomainError::new(ErrorCode::InternalError, "system time is invalid"))?;
        let admission_open = self.admission_open.load(Ordering::SeqCst);
        let vertical = &self.vertical;
        Ok(runtime::submit_public(
            &self.core,
            &encoded,
            now.to_rfc3339_opts(SecondsFormat::Millis, true),
            now_ms,
            admission_open,
            |request| {
                std::future::ready(
                    if admission_open
                        || matches!(
                            &request.payload,
                            PublicPayload::Context {
                                call: ContextCall::Status(_)
                            }
                        )
                    {
                        vertical.dispatch_installed(request)
                    } else {
                        Err(DomainError::new(
                            ErrorCode::HostTransitionPending,
                            "Runtime maintenance is in progress",
                        ))
                    },
                )
            },
        )
        .await)
    }

    /// Submits one public envelope from a thread outside this host's reactor.
    pub(crate) fn submit_blocking(&self, encoded: Vec<u8>) -> Result<Vec<u8>, DomainError> {
        let submitter = self.clone();
        self.handle
            .block_on(
                self.handle
                    .spawn(async move { submitter.submit(encoded).await }),
            )
            .map_err(|_| {
                DomainError::new(ErrorCode::InternalError, "Magisk Runtime submission ended")
            })?
    }

    fn answer_artifact_query(
        &self,
        payload: &serde_json::Value,
    ) -> Result<runtime::McpArtifactReply, DomainError> {
        self.store.validate_lease(&self.lease)?;
        let now_ms = u64::try_from(Utc::now().timestamp_millis())
            .map_err(|_| DomainError::new(ErrorCode::InternalError, "system time is invalid"))?;
        self.artifacts.answer_mcp_query(payload, now_ms)
    }
}

impl runtime::McpHost for HostSubmitter {
    fn submit<'a>(
        &'a self,
        envelope: Vec<u8>,
    ) -> runtime::PortFuture<'a, Result<Vec<u8>, DomainError>> {
        let submitter = self.clone();
        Box::pin(async move {
            // The Core runs on this host's own reactor, whatever reactor the caller serves on.
            self.handle
                .spawn(async move { submitter.submit(envelope).await })
                .await
                .map_err(|_| {
                    DomainError::new(ErrorCode::InternalError, "Magisk Runtime submission ended")
                })?
        })
    }

    fn artifact_query<'a>(
        &'a self,
        query: serde_json::Value,
    ) -> runtime::PortFuture<'a, Result<runtime::McpArtifactReply, DomainError>> {
        Box::pin(async move { self.answer_artifact_query(&query) })
    }
}

type MagiskCore = RuntimeCore<
    JsonPersistencePort,
    RuntimeArtifactPort,
    MagiskExecutionSurface,
    ApkCapabilityPort,
    MagiskHostControl,
>;

type MagiskFilesystemSurface =
    NativeFilesystemExecutionSurface<RuntimeArtifactPort, ApkCapabilityPort, RootContentPort>;

/// The root edition runs commands as root only.
const COMMAND_IDENTITIES: &[RunAs] = &[RunAs::Root];
/// How often a helper family whose probe failed is probed again while the helper lives.
const FAMILY_REPROBE_EVERY: Duration = Duration::from_secs(60);

/// The Magisk host's own capture backend and observation source, so this host owns every
/// `network.inspect` field family and the raw capture/injection primitive (S-NET-001, S-NET-005).
type MagiskNetworkPort =
    NativeNetworkPort<MagiskNetworkSource, MagiskCaptureBackend, RuntimeArtifactPort>;

type MagiskNetworkSurface =
    NativeNetworkExecutionSurface<RuntimeArtifactPort, ApkCapabilityPort, MagiskNetworkPort>;

type MagiskVisualSurface = NativeVisualExecutionSurface<
    RuntimeArtifactPort,
    ApkCapabilityPort,
    MagiskVisualPort<ApkCapabilityPort>,
>;

type MagiskAndroidSurface = NativeAndroidExecutionSurface<ApkCapabilityPort, MagiskAndroidPort>;

type MagiskExecutionSurface = CompositeExecutionSurface<
    MagiskFilesystemSurface,
    NativeCommandExecutionSurface<RuntimeArtifactPort, ApkCapabilityPort, MagiskCommandProcessPort>,
    MagiskNetworkSurface,
    MagiskVisualSurface,
    MagiskAndroidSurface,
>;

impl MagiskHost {
    pub(crate) fn activate(
        store: Arc<StateStore>,
        identity: &ModuleIdentity,
        module_root: &Path,
        canonical_base: &Path,
        sdk_int: u32,
        owner: RuntimeOwner,
        recycle: Arc<crate::recycle::Recycle>,
    ) -> Result<Self, DomainError> {
        let instance_id = new_uuid()?;
        let boot_id = read_boot_id()?;
        let live = RuntimeLive {
            runtime_epoch: owner.runtime_epoch.clone(),
            host: owner.host,
            host_generation: owner.host_generation,
            runtime_instance_id: instance_id.clone(),
            boot_id: boot_id.clone(),
            pid: std::process::id(),
            start_ticks: read_start_ticks(Path::new("/proc/self/stat"))?,
        };
        let lease = Arc::new(store.acquire_lifetime(live)?);
        let state = store.load(&lease)?;
        let recovery = await_guard_recovery_plan(
            &state,
            &instance_id,
            &boot_id,
            &persistence::GuardProofDirectory::new(canonical_base),
            &ProcFacts,
        )?;
        let model = fixed_property("ro.product.model")?;
        let environment = VerticalEnvironment {
            sdk_int,
            abi: fixed_property("ro.product.cpu.abi")?,
            timezone: fixed_property("persist.sys.timezone")?,
            name: model.clone(),
            manufacturer: fixed_property("ro.product.manufacturer")?,
            model,
            device: fixed_property("ro.product.device")?,
            build_fingerprint: fixed_property("ro.build.fingerprint")?,
            version_name: env!("CARGO_PKG_VERSION").to_owned(),
            version_code: VERSION_CODE,
            runtime_epoch: owner.runtime_epoch.clone(),
            host_generation: owner.host_generation,
        };
        let vertical = ApkRuntimeVertical::new_for_host(environment, RuntimeHost::MagiskBackend)?;
        let mut guard_ready = recovery.guards_are_clean()
            && probe_root_guard(
                canonical_base,
                &module_root.join("bin/droidbridge-exec-guard"),
                lease.live(),
            )
            .unwrap_or(false);
        let mut capability_generation = SourceGeneration::initial();
        let helper_generation = SourceGeneration::initial();
        let wake_alarm_ready = probe_wake_alarm().available();
        register(
            &vertical,
            "magisk.module",
            CapabilityState::Available,
            None,
            false,
            capability_generation.current(),
        )?;
        register(
            &vertical,
            "magisk.root",
            capability_state(guard_ready),
            (!guard_ready).then_some("CLEANUP_UNVERIFIED"),
            guard_ready,
            capability_generation.current(),
        )?;
        register(
            &vertical,
            "execution.root_guard",
            capability_state(guard_ready),
            (!guard_ready).then_some("CLEANUP_UNVERIFIED"),
            guard_ready,
            capability_generation.current(),
        )?;
        register(
            &vertical,
            "magisk.wake_alarm",
            capability_state(wake_alarm_ready),
            (!wake_alarm_ready).then_some("WAKE_ALARM_UNAVAILABLE"),
            wake_alarm_ready,
            capability_generation.current(),
        )?;
        let helper = framework_boot_completed()
            .then(|| FrameworkHelper::start(module_root, sdk_int, helper_generation.current()).ok())
            .flatten();
        let helper_port = HelperPort::default();
        let family_probes = helper.as_ref().map_or([false; 3], |helper| {
            helper_port.publish(Arc::clone(&helper.connection), helper.jar.clone());
            name_device(&vertical);
            probe_families(helper)
        });
        register(
            &vertical,
            "magisk.framework",
            capability_state(helper.is_some()),
            helper.is_none().then_some("HELPER_UNAVAILABLE"),
            helper.is_some(),
            capability_generation.current(),
        )?;
        for fact in helper_family_facts(helper.is_some(), |family| {
            family_probes[family_index(family)]
        }) {
            register(
                &vertical,
                fact.family.key(),
                fact.state,
                fact.reason,
                fact.state == CapabilityState::Available,
                capability_generation.current(),
            )?;
        }
        if !guard_ready {
            vertical.set_unavailable("CLEANUP_UNVERIFIED")?;
        }
        let capabilities = vertical.capability_port(instance_id.clone());
        let cleanup_watch = CleanupWatch::new(
            Arc::clone(&store),
            Arc::clone(&lease),
            canonical_base.to_path_buf(),
            boot_id.clone(),
            capabilities.clone(),
            recycle,
        );
        // Guards this start found unsettled may still write their verdicts.
        if !recovery.guards_are_clean() {
            cleanup_watch.start()?;
        }
        let host_control = MagiskHostControl {
            store: Arc::clone(&store),
            lease: Arc::clone(&lease),
            cleanup_watch: cleanup_watch.clone(),
            capabilities: capabilities.clone(),
            recovery_proof: if recovery.guards_are_clean() {
                RecoveryProof::Clean
            } else {
                RecoveryProof::CleanupUnverified
            },
        };
        host_control.prepare()?;
        host_control.activate(&capabilities.current()?.fence)?;
        let artifacts = RuntimeArtifactPort::new(Arc::clone(&store), Arc::clone(&lease));
        let command_quarantine = Arc::new(CommandQuarantine::default());
        let command_root = Arc::new(RootCommandGuard::new(
            canonical_base.to_path_buf(),
            crate::command::guard_path(module_root),
            owner.runtime_epoch.clone(),
            instance_id.clone(),
            boot_id.clone(),
            Arc::clone(&command_quarantine),
        ));
        let content = RootContentPort::new(canonical_base.to_path_buf(), command_root.clone());
        let executions = CompositeExecutionSurface::new(
            NativeFilesystemExecutionSurface::new(
                canonical_base.to_path_buf(),
                artifacts.clone(),
                capabilities.clone(),
                ProviderToken::MagiskNative,
            )
            .with_framework(content.clone()),
        )
        .with_command(NativeCommandExecutionSurface::new(
            artifacts.clone(),
            capabilities.clone(),
            COMMAND_IDENTITIES,
            MagiskCommandProcessPort::new(command_root.clone()),
        ))
        .with_network(NativeNetworkExecutionSurface::new(
            artifacts.clone(),
            capabilities.clone(),
            NativeNetworkPort::new(
                MagiskNetworkSource::new(helper_port.clone()),
                MagiskCaptureBackend,
                artifacts.clone(),
            ),
        ))
        .with_android(
            NativeAndroidExecutionSurface::new(capabilities.clone(), identity.frontend_package)
                .with_primitives(MagiskAndroidPort::new(
                    command_root.clone(),
                    helper_port.clone(),
                )),
        )
        .with_visual(
            NativeVisualExecutionSurface::new(artifacts.clone(), capabilities.clone())
                .with_primitives(MagiskVisualPort::new(
                    canonical_base.to_path_buf(),
                    capabilities.clone(),
                    command_root,
                    content,
                    helper_port.clone(),
                    crate::framework_jar(module_root, sdk_int),
                )),
        );
        let core = RuntimeCore::new(
            JsonPersistencePort::new(Arc::clone(&store), Arc::clone(&lease)),
            artifacts.clone(),
            executions,
            capabilities,
            host_control,
        )
        .with_network_default_event_source(Arc::new(NativeNetworkDefaultEventSource::default()));
        let async_runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .map_err(|_| DomainError::new(ErrorCode::InternalError, "Runtime executor failed"))?;
        if !recovery.prior_instances().is_empty() {
            let now = Utc::now();
            let terminal_at_ms = u64::try_from(now.timestamp_millis()).map_err(|_| {
                DomainError::new(ErrorCode::InternalError, "system time is invalid")
            })?;
            let ended_at = now.to_rfc3339_opts(SecondsFormat::Millis, true);
            for old_instance_id in recovery.prior_instances() {
                async_runtime.block_on(core.recover_old_instance(
                    old_instance_id,
                    ended_at.clone(),
                    terminal_at_ms,
                ))?;
            }
        }
        let mut mechanics = FilesystemMagiskGuardRecovery::new(canonical_base, &store, &lease);
        if execute_guard_recovery(&recovery, &mut mechanics).is_err() {
            guard_ready = false;
            let generation = capability_generation.advance()?;
            register(
                &vertical,
                "magisk.root",
                CapabilityState::Unavailable,
                Some("CLEANUP_UNVERIFIED"),
                false,
                generation,
            )?;
            register(
                &vertical,
                "execution.root_guard",
                CapabilityState::Unavailable,
                Some("CLEANUP_UNVERIFIED"),
                false,
                generation,
            )?;
            vertical.set_unavailable("CLEANUP_UNVERIFIED")?;
        }
        let executor = MagiskExecutorHandle::new(
            MagiskExecutorFence {
                runtime_epoch: owner.runtime_epoch.clone(),
                host_generation: owner.host_generation,
                runtime_instance_id: instance_id.clone(),
                source_generation: capability_generation.current(),
            },
            helper.as_ref().map(|_| helper_generation.current()),
        )?;
        let automation_fault = Arc::new(StdMutex::new(None));
        spawn_automation_scheduler(
            &async_runtime,
            core.clone(),
            wake_alarm_ready,
            Arc::clone(&automation_fault),
        );
        let submitter = HostSubmitter {
            core,
            vertical: vertical.clone(),
            admission_open: Arc::new(AtomicBool::new(true)),
            store: Arc::clone(&store),
            lease: Arc::clone(&lease),
            artifacts,
            handle: async_runtime.handle().clone(),
        };
        Ok(Self {
            submitter,
            store,
            lease,
            instance_id,
            vertical,
            helper,
            helper_port,
            family_probes,
            family_probed_at: Instant::now(),
            guard_ready,
            module_ready: true,
            wake_alarm_ready,
            capability_generation,
            helper_generation,
            command_quarantine,
            cleanup_watch,
            executor,
            automation_fault,
            async_runtime,
        })
    }

    pub(crate) fn instance_id(&self) -> &UuidV4 {
        &self.instance_id
    }

    pub(crate) fn submitter(&self) -> HostSubmitter {
        self.submitter.clone()
    }

    pub(crate) fn guard_ready(&self) -> bool {
        self.guard_ready
    }

    pub(crate) fn helper_ready(&self) -> bool {
        self.helper.is_some()
    }

    /// Closes public admission and records the reset intent under this instance's lease, once the
    /// store holds no live work. A refused reset reopens admission unchanged.
    pub(crate) fn record_reset_intent(
        &self,
        intent: &persistence::RuntimeResetIntent,
    ) -> Result<(), DomainError> {
        self.submitter.admission_open.store(false, Ordering::SeqCst);
        let recorded = self
            .store
            .record_reset_intent(&self.lease, intent, true, self.guard_ready);
        if recorded.is_err() {
            self.submitter.admission_open.store(true, Ordering::SeqCst);
        }
        recorded
    }

    /// Ends this instance: its reactor stops first so no Task still holds the lease, which is
    /// released with the last reference.
    pub(crate) fn shutdown(self) {
        let Self {
            submitter,
            lease,
            async_runtime,
            ..
        } = self;
        drop(submitter);
        async_runtime.shutdown_timeout(Duration::from_secs(5));
        drop(lease);
    }

    pub(crate) fn refresh_runtime_facts(
        &mut self,
        module_root: &Path,
        sdk_int: u32,
        observed_module_ready: bool,
    ) -> Result<(), DomainError> {
        let scheduler_faulted = match self.automation_fault.lock() {
            Ok(fault) => fault.is_some(),
            Err(poisoned) => poisoned.into_inner().is_some(),
        };
        if scheduler_faulted && self.wake_alarm_ready {
            // Time-trigger admission stopped with the scheduler; persisted dues stay unchanged.
            self.wake_alarm_ready = false;
            let generation = self.capability_generation.advance()?;
            register(
                &self.vertical,
                "magisk.wake_alarm",
                CapabilityState::Unavailable,
                Some("WAKE_ALARM_UNAVAILABLE"),
                false,
                generation,
            )?;
        }
        if self.guard_ready && self.command_quarantine.is_flagged() {
            self.guard_ready = false;
            // A replacement already under way keeps reporting that it is recovering.
            if !self.cleanup_watch.active() {
                self.vertical.set_unavailable("CLEANUP_UNVERIFIED")?;
            }
            let generation = self.capability_generation.advance()?;
            for key in ["magisk.root", "execution.root_guard"] {
                register(
                    &self.vertical,
                    key,
                    CapabilityState::Unavailable,
                    Some("CLEANUP_UNVERIFIED"),
                    false,
                    generation,
                )?;
            }
            self.refresh_executor()?;
        }
        if self.module_ready != observed_module_ready {
            self.module_ready = observed_module_ready;
            if !observed_module_ready {
                self.guard_ready = false;
                self.vertical.set_unavailable("MODULE_UNAVAILABLE")?;
            }
            let generation = self.capability_generation.advance()?;
            register(
                &self.vertical,
                "magisk.module",
                capability_state(observed_module_ready),
                (!observed_module_ready).then_some("MODULE_UNAVAILABLE"),
                false,
                generation,
            )?;
            for key in ["magisk.root", "execution.root_guard"] {
                register(
                    &self.vertical,
                    key,
                    capability_state(observed_module_ready && self.guard_ready),
                    (!(observed_module_ready && self.guard_ready))
                        .then_some("MODULE_OR_GUARD_UNAVAILABLE"),
                    observed_module_ready && self.guard_ready,
                    generation,
                )?;
            }
            self.refresh_executor()?;
        }

        if self.helper.as_mut().is_some_and(FrameworkHelper::is_alive) {
            let retry_failed = self.family_probed_at.elapsed() >= FAMILY_REPROBE_EVERY;
            if retry_failed {
                self.family_probed_at = Instant::now();
            }
            if let Some(helper) = self.helper.as_ref() {
                let probes = reprobe_families(
                    self.family_probes,
                    |family| self.helper_port.take_denial(family),
                    retry_failed,
                    |family| probe_family(helper, family),
                );
                if probes != self.family_probes {
                    self.family_probes = probes;
                    self.publish_helper_state(true)?;
                }
            }
            return Ok(());
        }
        if self.helper.is_some() {
            self.helper = None;
            self.helper_port.withdraw();
            self.executor = self.executor.without_helper();
            self.publish_helper_state(false)?;
            return Ok(());
        }
        if !self.module_ready || !self.guard_ready || !framework_boot_completed() {
            return Ok(());
        }
        let helper_generation = self.helper_generation.advance()?;
        if let Ok(helper) = FrameworkHelper::start(module_root, sdk_int, helper_generation) {
            self.helper_port
                .publish(Arc::clone(&helper.connection), helper.jar.clone());
            name_device(&self.vertical);
            self.family_probes = probe_families(&helper);
            self.family_probed_at = Instant::now();
            self.helper = Some(helper);
            self.publish_helper_state(true)?;
        }
        Ok(())
    }

    fn publish_helper_state(&mut self, available: bool) -> Result<(), DomainError> {
        let generation = self.capability_generation.advance()?;
        register(
            &self.vertical,
            "magisk.framework",
            capability_state(available),
            (!available).then_some("HELPER_UNAVAILABLE"),
            available,
            generation,
        )?;
        for fact in
            helper_family_facts(available, |family| self.family_probes[family_index(family)])
        {
            register(
                &self.vertical,
                fact.family.key(),
                fact.state,
                fact.reason,
                fact.state == CapabilityState::Available,
                generation,
            )?;
        }
        self.refresh_executor()
    }

    fn refresh_executor(&mut self) -> Result<(), DomainError> {
        let mut fence = self.executor.fence().clone();
        fence.source_generation = self.capability_generation.current();
        self.executor = MagiskExecutorHandle::new(
            fence,
            self.helper
                .as_ref()
                .map(|_| self.helper_generation.current()),
        )?;
        Ok(())
    }
}

pub(crate) fn observe_module(
    module_root: &Path,
    identity: &ModuleIdentity,
) -> Result<ModuleObservation, DomainError> {
    let stable = Path::new("/data/adb/modules/droidbridge");
    let debug = Path::new("/data/adb/modules/droidbridge_debug");
    let property = parse_module_property(&module_root.join("module.prop"), identity)?;
    Ok(ModuleObservation {
        stable_present: stable.is_dir() && !stable.join("remove").exists(),
        debug_present: debug.is_dir() && !debug.join("remove").exists(),
        enabled: !module_root.join("disable").exists() && !module_root.join("remove").exists(),
        module_version_code: property,
        daemon_version_code: VERSION_CODE,
    })
}

/// The framework helper probes each family once per generation (S-MAGISK-005), so it starts
/// only after the Android system services it probes have finished booting.
fn framework_boot_completed() -> bool {
    fixed_property("sys.boot_completed").is_ok_and(|value| value == "1")
}

/// Names the device after its Settings name once the framework answers, which the helper's start
/// proves; until then, and when it has none, the model stands.
fn name_device(vertical: &ApkRuntimeVertical) {
    if let Some(name) = device_name()
        && let Err(failed) = vertical.set_device_name(name)
    {
        eprintln!(
            "droidbridged: cannot set the device name: {:?}",
            failed.code
        );
    }
}

/// The name the owner gave this phone in Settings, bounded to the status contract's 256 bytes.
fn device_name() -> Option<String> {
    let output = Command::new("/system/bin/settings")
        .args(["get", "global", "device_name"])
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    let mut name = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    if name.is_empty() || name == "null" {
        return None;
    }
    let mut end = name.len().min(256);
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    name.truncate(end);
    Some(name)
}

pub(crate) fn fixed_property(name: &str) -> Result<String, DomainError> {
    let output = Command::new("/system/bin/getprop")
        .arg(name)
        .output()
        .map_err(|_| io_error("cannot read Android property"))?;
    if !output.status.success() {
        return Err(io_error("Android property query failed"));
    }
    String::from_utf8(output.stdout)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| io_error("Android property is empty"))
}

fn parse_module_property(path: &Path, identity: &ModuleIdentity) -> Result<u64, DomainError> {
    let contents = fs::read_to_string(path).map_err(|_| io_error("cannot read module property"))?;
    let mut id = None;
    let mut version_code = None;
    for line in contents.lines() {
        if let Some(value) = line.strip_prefix("id=") {
            id = Some(value);
        }
        if let Some(value) = line.strip_prefix("versionCode=") {
            version_code = value.parse().ok();
        }
    }
    if id != Some(identity.module_id) {
        return Err(DomainError::new(
            ErrorCode::ProtocolIncompatible,
            "module id does not match daemon build",
        ));
    }
    version_code.ok_or_else(|| {
        DomainError::new(ErrorCode::ProtocolIncompatible, "module version is missing")
    })
}

/// Starts this instance's resident Automation scheduler on the Runtime reactor (S-LIFE-003,
/// S-AUTO-001): it publishes `runtime.ready` once, then projects persisted dues onto the wake
/// alarm timerfd when `magisk.wake_alarm` is available, or runs event Automations only. The task
/// ends with the reactor when the host is released.
fn spawn_automation_scheduler(
    async_runtime: &tokio::runtime::Runtime,
    core: MagiskCore,
    wake_alarm_ready: bool,
    fault: Arc<StdMutex<Option<DomainError>>>,
) {
    // A failed pass is retried by the loop itself; the supervisor keeps this stderr line.
    let scheduler = AutomationScheduler::new(core, Arc::new(BoottimeClock)).reporting_faults(
        Arc::new(|error: &DomainError| {
            eprintln!(
                "droidbridged: automation scheduler pass failed: {:?} {} errno={:?}",
                error.code, error.reason, error.os_error
            );
        }),
    );
    async_runtime.spawn(async move {
        let ended = async {
            scheduler.publish_runtime_ready().await?;
            if wake_alarm_ready {
                let wake = RealtimeAlarmWake::new()?;
                scheduler.run(&wake).await
            } else {
                scheduler.run_events_only().await
            }
        }
        .await;
        if let Err(error) = ended {
            match fault.lock() {
                Ok(mut slot) => *slot = Some(error),
                Err(poisoned) => *poisoned.into_inner() = Some(error),
            }
        }
    });
}

fn probe_wake_alarm() -> WakeAlarmProbe {
    let mut probe = WakeAlarmProbe::default();
    let descriptor = unsafe {
        libc::timerfd_create(
            libc::CLOCK_REALTIME_ALARM,
            libc::TFD_NONBLOCK | libc::TFD_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return probe;
    }
    let _descriptor = unsafe { fs::File::from_raw_fd(descriptor) };
    probe.created = true;
    let mut now = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    if unsafe { libc::clock_gettime(libc::CLOCK_REALTIME, &mut now) } != 0 {
        return probe;
    }
    probe.clock_read = true;
    let armed = libc::itimerspec {
        it_interval: libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        },
        it_value: libc::timespec {
            tv_sec: match now.tv_sec.checked_add(60) {
                Some(value) => value,
                None => return probe,
            },
            tv_nsec: now.tv_nsec,
        },
    };
    if unsafe {
        libc::timerfd_settime(
            descriptor,
            libc::TFD_TIMER_ABSTIME | libc::TFD_TIMER_CANCEL_ON_SET,
            &armed,
            std::ptr::null_mut(),
        )
    } != 0
    {
        return probe;
    }
    probe.armed = true;
    let disarmed = libc::itimerspec {
        it_interval: libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        },
        it_value: libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        },
    };
    if unsafe { libc::timerfd_settime(descriptor, 0, &disarmed, std::ptr::null_mut()) } == 0 {
        probe.disarmed = true;
    }
    probe
}

struct FrameworkHelper {
    child: Child,
    connection: Arc<HelperConnection>,
    jar: PathBuf,
    socket_path: PathBuf,
}

struct FrameworkHelperLaunch {
    child: Option<Child>,
    socket_path: Option<PathBuf>,
}

impl FrameworkHelperLaunch {
    fn finish(mut self) -> (Child, PathBuf) {
        (
            self.child.take().expect("helper child is present"),
            self.socket_path.take().expect("helper socket is present"),
        )
    }
}

impl Drop for FrameworkHelperLaunch {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(socket_path) = self.socket_path.as_ref() {
            let _ = fs::remove_file(socket_path);
        }
    }
}

impl FrameworkHelper {
    fn start(module_root: &Path, sdk_int: u32, generation: u64) -> Result<Self, DomainError> {
        let mut registry = HelperRegistry::new(sdk_int, generation)?;
        let run_directory = module_root.join("run");
        fs::create_dir_all(&run_directory)
            .map_err(|_| io_error("cannot create helper run directory"))?;
        fs::set_permissions(&run_directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| io_error("cannot protect helper run directory"))?;
        let socket_path = run_directory.join(format!("framework-api{sdk_int}.sock"));
        if socket_path.exists() {
            let metadata = fs::symlink_metadata(&socket_path)
                .map_err(|_| io_error("cannot inspect stale helper socket"))?;
            if !metadata.file_type().is_socket() {
                return Err(io_error("helper socket path is not a socket"));
            }
            fs::remove_file(&socket_path)
                .map_err(|_| io_error("cannot remove stale helper socket"))?;
        }
        let listener =
            UnixListener::bind(&socket_path).map_err(|_| io_error("cannot bind helper socket"))?;
        fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))
            .map_err(|_| io_error("cannot protect helper socket"))?;
        listener
            .set_nonblocking(true)
            .map_err(|_| io_error("cannot bound helper accept"))?;
        let jar = registry.jar(module_root);
        let listener_fd = listener.as_raw_fd();
        let mut command = Command::new("/system/bin/app_process");
        command
            .env("CLASSPATH", &jar)
            .arg("/system/bin")
            .arg("com.droidbridge.helper.DroidBridgeFrameworkHelper")
            .arg("3")
            .arg(sdk_int.to_string())
            .arg(generation.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(listener_fd, 3) < 0 || libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                let _ = fs::remove_file(&socket_path);
                return Err(io_error("cannot launch framework helper"));
            }
        };
        drop(listener);
        let mut launch = FrameworkHelperLaunch {
            child: Some(child),
            socket_path: Some(socket_path),
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut stream = loop {
            let socket_path = launch
                .socket_path
                .as_ref()
                .expect("helper socket is present");
            match UnixStream::connect(socket_path) {
                Ok(stream) => break stream,
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
                    ) =>
                {
                    if launch
                        .child
                        .as_mut()
                        .expect("helper child is present")
                        .try_wait()
                        .ok()
                        .flatten()
                        .is_some()
                        || Instant::now() >= deadline
                    {
                        return Err(io_error("framework helper did not accept"));
                    }
                    thread::sleep(Duration::from_millis(20));
                }
                Err(_) => return Err(io_error("framework helper connection failed")),
            }
        };
        let uid =
            peer_uid(&stream).map_err(|_| io_error("cannot authenticate framework helper"))?;
        let hello: HelperHello = receive_json(&mut stream)?;
        registry.accept_hello(uid, hello)?;
        let (child, socket_path) = launch.finish();
        Ok(Self {
            child,
            connection: Arc::new(HelperConnection::new(stream)),
            jar,
            socket_path,
        })
    }

    fn is_alive(&mut self) -> bool {
        !self.connection.is_broken() && self.child.try_wait().is_ok_and(|status| status.is_none())
    }
}

/// Runs each S-MAGISK-005 family probe once for this helper generation. A failed probe
/// records only its own family.
fn probe_families(helper: &FrameworkHelper) -> [bool; 3] {
    HelperFamily::ALL.map(|family| probe_family(helper, family))
}

fn probe_family(helper: &FrameworkHelper, family: HelperFamily) -> bool {
    match family {
        HelperFamily::Launch => helper
            .connection
            .request(&serde_json::json!({"operation": "probe_launch"}))
            .is_ok(),
        HelperFamily::Notifications => helper
            .connection
            .request(&serde_json::json!({"operation": "probe_notifications"}))
            .is_ok(),
        HelperFamily::Clipboard => {
            run_clipboard_child(&helper.jar, "probe", &serde_json::json!({}), None).is_ok()
        }
    }
}

const fn family_index(family: HelperFamily) -> usize {
    family.index()
}

impl Drop for FrameworkHelper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_file(&self.socket_path);
    }
}

#[derive(Clone)]
struct MagiskHostControl {
    store: Arc<StateStore>,
    lease: Arc<LifetimeLease>,
    recovery_proof: RecoveryProof,
    cleanup_watch: CleanupWatch,
    capabilities: ApkCapabilityPort,
}

impl HostControlPort for MagiskHostControl {
    fn cleanup_unverified(
        &self,
        fence: &domain::AdmissionFence,
        _execution_id: &UuidV4,
    ) -> Result<(), DomainError> {
        self.activate(fence)?;
        self.cleanup_watch.start()
    }

    fn prepare(&self) -> Result<(), DomainError> {
        self.store.validate_lease(&self.lease)
    }

    fn activate(&self, fence: &domain::AdmissionFence) -> Result<(), DomainError> {
        self.store.validate_lease(&self.lease)?;
        let live = self.lease.live();
        if live.runtime_epoch != fence.runtime_epoch
            || live.host_generation != fence.host_generation
            || live.runtime_instance_id != fence.runtime_instance_id
        {
            return Err(DomainError::new(
                ErrorCode::StaleAuthority,
                "Magisk Runtime activation fence is stale",
            ));
        }
        Ok(())
    }

    fn recover(&self, _: &UuidV4) -> Result<RecoveryProof, DomainError> {
        self.store.validate_lease(&self.lease)?;
        if self.recovery_proof == RecoveryProof::CleanupUnverified {
            self.cleanup_watch.start()?;
        }
        Ok(self.recovery_proof)
    }

    fn store_write_failed(&self, error: &DomainError) {
        eprintln!(
            "droidbridged: canonical commit failed: {:?} {} errno={:?}",
            error.code, error.reason, error.os_error
        );
        if let Err(failed) = self.capabilities.withdraw_readiness_as("STORE_UNAVAILABLE") {
            eprintln!("droidbridged: cannot withdraw readiness: {:?}", failed.code);
        }
        if let Err(failed) = self.store.record_store_write_fault(&self.lease) {
            eprintln!(
                "droidbridged: cannot record the store fault: {:?}",
                failed.code
            );
        }
    }

    fn store_write_recovered(&self) {
        eprintln!("droidbridged: canonical store takes writes again");
        if let Err(failed) = self
            .capabilities
            .restore_readiness_from("STORE_UNAVAILABLE")
        {
            eprintln!("droidbridged: cannot restore readiness: {:?}", failed.code);
        }
    }
}

fn register(
    vertical: &ApkRuntimeVertical,
    key: &str,
    state: CapabilityState,
    reason: Option<&str>,
    has_executor: bool,
    source_generation: u64,
) -> Result<(), DomainError> {
    vertical.register_capability(
        key,
        Availability {
            state,
            reason: reason.map(str::to_owned),
        },
        source_generation,
        has_executor,
    )?;
    Ok(())
}

pub(crate) fn new_uuid() -> Result<UuidV4, DomainError> {
    UuidV4::parse(uuid::Uuid::new_v4().hyphenated().to_string())
        .map_err(|_| DomainError::new(ErrorCode::InternalError, "UUID generation failed"))
}

const fn capability_state(available: bool) -> CapabilityState {
    if available {
        CapabilityState::Available
    } else {
        CapabilityState::Unavailable
    }
}

const fn io_error(reason: &'static str) -> DomainError {
    DomainError::new(ErrorCode::IoError, reason)
}
