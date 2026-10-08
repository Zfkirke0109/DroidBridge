use crate::{
    CanonicalState, FileLock, RuntimeLive, RuntimeOwner, RuntimeResetIntent, WriterFence, io_error,
    sync_directory, validate_artifact_record, validate_reset_owner,
};
use contract::{ErrorCode, RuntimeHost};
use domain::DomainError;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::Instant,
};

pub const STORE_LIMIT_BYTES: usize = 8 * 1024 * 1024;

/// The S-UI-017 maintenance blocker observed from the canonical files alone.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MaintenanceBlocker {
    None,
    OwnerCorrupt,
    StoreCorrupt,
}

impl MaintenanceBlocker {
    pub const fn token(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::OwnerCorrupt => "owner_corrupt",
            Self::StoreCorrupt => "store_corrupt",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommitPhase {
    LockWait,
    Parse,
    DomainMutation,
    Serialize,
    TempWriteFsync,
    RenameDirectoryFsync,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CommitInstrumentation {
    pub lock_wait_ns: u128,
    pub parse_ns: u128,
    pub domain_mutation_ns: u128,
    pub serialize_ns: u128,
    pub temp_write_fsync_ns: u128,
    pub rename_directory_fsync_ns: u128,
    pub total_ns: u128,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CrashPoint {
    BeforeTempCreate,
    AfterTempFsync,
    AfterRename,
}

#[derive(Clone, Debug)]
pub struct StateStore {
    base: PathBuf,
}

pub struct LifetimeLease {
    base: PathBuf,
    live: RuntimeLive,
    _lock: FileLock,
}

impl LifetimeLease {
    pub fn live(&self) -> &RuntimeLive {
        &self.live
    }
}

impl StateStore {
    pub fn new(base: PathBuf) -> Self {
        Self { base }
    }

    pub(crate) fn base_path(&self) -> &Path {
        &self.base
    }

    pub fn initialize(
        &self,
        owner: &RuntimeOwner,
        state: &CanonicalState,
    ) -> Result<(), DomainError> {
        if owner.schema_version != 1 || owner.host_generation == 0 {
            return Err(DomainError::invalid("initial runtime owner is invalid"));
        }
        let state_bytes = serde_json::to_vec(state).map_err(|_| {
            DomainError::new(ErrorCode::InternalError, "store serialization failed")
        })?;
        validate_state(state, state_bytes.len())?;
        fs::create_dir_all(&self.base).map_err(io_error)?;
        write_new_json(&self.base.join("runtime-owner.json"), owner)?;
        write_new_json(&self.base.join("runtime-state.json"), state)?;
        open_lock_file(&self.base.join("runtime-live.lock"))?;
        open_lock_file(&self.base.join("runtime-state.lock"))?;
        sync_directory(&self.base)
    }

    pub fn read_owner(&self) -> Result<RuntimeOwner, DomainError> {
        let owner: RuntimeOwner = read_json(&self.base.join("runtime-owner.json"))?;
        if owner.schema_version != 1 || owner.host_generation == 0 {
            return Err(DomainError::new(
                ErrorCode::IoError,
                "runtime owner is corrupt",
            ));
        }
        Ok(owner)
    }

    pub fn record_reset_intent(
        &self,
        lease: &LifetimeLease,
        intent: &RuntimeResetIntent,
        synchronous_work_absent: bool,
        cleanup_verified: bool,
    ) -> Result<(), DomainError> {
        if !synchronous_work_absent || !cleanup_verified {
            return Err(DomainError::new(
                ErrorCode::IoError,
                "reset requires zero live work and verified cleanup",
            ));
        }
        self.validate_lease(lease)?;
        let owner = self.read_owner()?;
        let state = self.load(lease)?;
        let automation_work = state.automation_executions.iter().any(|execution| {
            matches!(
                execution.summary.state,
                contract::AutomationExecutionState::Queued
                    | contract::AutomationExecutionState::Running
            )
        });
        if state.tasks.iter().any(|task| {
            matches!(
                task.state,
                contract::TaskState::Created
                    | contract::TaskState::Queued
                    | contract::TaskState::Running
            )
        }) || automation_work
            || !state.reservations.is_empty()
            || intent.schema_version != 1
            || intent.runtime_epoch != owner.runtime_epoch
            || intent.source_host_generation != owner.host_generation
            || intent.target_host != owner.host
            || intent.target_host_generation
                != intent
                    .source_host_generation
                    .checked_add(1)
                    .ok_or_else(|| {
                        DomainError::new(ErrorCode::ResourceLimit, "host generation exhausted")
                    })?
        {
            return Err(DomainError::new(
                ErrorCode::StaleAuthority,
                "reset intent does not match zero-work owner state",
            ));
        }
        write_new_json(&self.base.join("runtime-reset-intent.json"), intent)?;
        sync_directory(&self.base)
    }

    pub fn acquire_lifetime(&self, live: RuntimeLive) -> Result<LifetimeLease, DomainError> {
        let lock = FileLock::acquire(&self.base.join("runtime-live.lock"))?;
        let owner: RuntimeOwner = read_json(&self.base.join("runtime-owner.json"))?;
        if self.base.join("runtime-reset-intent.json").exists() {
            return Err(DomainError::new(
                ErrorCode::HostTransitionPending,
                "Runtime reset is pending",
            ));
        }
        let fence = WriterFence {
            runtime_epoch: live.runtime_epoch.clone(),
            host: live.host,
            host_generation: live.host_generation,
            runtime_instance_id: live.runtime_instance_id.clone(),
        };
        if !fence.matches(&owner, &live) {
            return Err(DomainError::new(
                ErrorCode::StaleAuthority,
                "live identity does not match runtime owner",
            ));
        }
        atomic_replace_json(&self.base, "runtime-live.json", &live)?;
        Ok(LifetimeLease {
            base: self.base.clone(),
            live,
            _lock: lock,
        })
    }

    pub fn load(&self, lease: &LifetimeLease) -> Result<CanonicalState, DomainError> {
        self.load_measured(lease).map(|(state, _)| state)
    }

    /// The canonical state and its encoded size. The store is written as exactly this encoding,
    /// so the bytes read are the measurement and the state is never encoded again to learn it.
    pub fn load_measured(
        &self,
        lease: &LifetimeLease,
    ) -> Result<(CanonicalState, u64), DomainError> {
        let _state_lock = FileLock::acquire(&self.base.join("runtime-state.lock"))?;
        self.validate_lease(lease)?;
        let path = self.base.join("runtime-state.json");
        let bytes = fs::read(path).map_err(io_error)?;
        let state = decode_canonical_state(&bytes)?;
        Ok((state, bytes.len() as u64))
    }

    pub fn recover_confirmed_reset(
        &self,
        cleanup_verified: bool,
    ) -> Result<RuntimeOwner, DomainError> {
        if !cleanup_verified {
            return Err(DomainError::new(
                ErrorCode::IoError,
                "reset cannot bypass unverified cleanup",
            ));
        }
        let _lifetime_lock = FileLock::acquire(&self.base.join("runtime-live.lock"))?;
        let intent_path = self.base.join("runtime-reset-intent.json");
        let intent: RuntimeResetIntent = read_json(&intent_path)?;
        let owner: RuntimeOwner = read_json(&self.base.join("runtime-owner.json"))?;
        validate_reset_owner(&intent, &owner)?;
        let reset_trash = self.base.join("reset-trash").join(intent.reset_id.as_str());
        let artifacts = self.base.join("artifacts");
        let trashed_artifacts = reset_trash.join("artifacts");
        if artifacts.exists() {
            if trashed_artifacts.exists() {
                return Err(DomainError::new(
                    ErrorCode::IoError,
                    "reset artifact source and trash both exist",
                ));
            }
            fs::create_dir_all(&reset_trash).map_err(io_error)?;
            fs::rename(&artifacts, &trashed_artifacts).map_err(io_error)?;
            sync_directory(&self.base)?;
            sync_directory(&reset_trash)?;
        }
        let owner = {
            let _state_lock = FileLock::acquire(&self.base.join("runtime-state.lock"))?;
            let recorded_intent: RuntimeResetIntent = read_json(&intent_path)?;
            if recorded_intent != intent {
                return Err(DomainError::new(
                    ErrorCode::StaleAuthority,
                    "reset intent changed during recovery",
                ));
            }
            let mut owner: RuntimeOwner = read_json(&self.base.join("runtime-owner.json"))?;
            let owner_state = validate_reset_owner(&intent, &owner)?;
            let empty_state = CanonicalState::default();
            let expected = serde_json::to_vec(&empty_state).map_err(|_| {
                DomainError::new(ErrorCode::InternalError, "reset store encoding failed")
            })?;
            let state_path = self.base.join("runtime-state.json");
            let current_state = match fs::read(&state_path) {
                Ok(bytes) => Some(bytes),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(io_error(error)),
            };
            if current_state.as_deref() != Some(expected.as_slice()) {
                atomic_replace_json(&self.base, "runtime-state.json", &empty_state)?;
            }
            if owner_state == crate::ResetOwnerState::Source {
                owner = RuntimeOwner {
                    schema_version: 1,
                    runtime_epoch: intent.runtime_epoch.clone(),
                    host: intent.target_host,
                    host_generation: intent.target_host_generation,
                };
                atomic_replace_json(&self.base, "runtime-owner.json", &owner)?;
            }
            owner
        };
        if reset_trash.exists() {
            fs::remove_dir_all(&reset_trash).map_err(io_error)?;
            if let Some(parent) = reset_trash.parent() {
                sync_directory(parent)?;
            }
        }
        fs::remove_file(&intent_path).map_err(io_error)?;
        sync_directory(&self.base)?;
        Ok(owner)
    }

    /// Classifies an initialized canonical base for S-UI-017 without a lease or a Core. A base with
    /// neither owner nor state is uninitialized rather than corrupt; an unreadable file that exists
    /// is an I/O failure, never a guessed corruption.
    pub fn maintenance_blocker(&self) -> Result<MaintenanceBlocker, DomainError> {
        let owner_path = self.base.join("runtime-owner.json");
        let state_path = self.base.join("runtime-state.json");
        if !owner_path.exists() && !state_path.exists() {
            return Ok(MaintenanceBlocker::None);
        }
        let owner_valid = match fs::read(&owner_path) {
            Ok(bytes) => serde_json::from_slice::<RuntimeOwner>(&bytes)
                .is_ok_and(|owner| owner.schema_version == 1 && owner.host_generation != 0),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(io_error(error)),
        };
        if !owner_valid {
            return Ok(MaintenanceBlocker::OwnerCorrupt);
        }
        let _state_lock = FileLock::acquire(&self.base.join("runtime-state.lock"))?;
        match fs::read(&state_path) {
            Ok(bytes) if decode_canonical_state(&bytes).is_ok() => Ok(MaintenanceBlocker::None),
            Ok(_) => Ok(MaintenanceBlocker::StoreCorrupt),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(MaintenanceBlocker::StoreCorrupt)
            }
            Err(error) => Err(io_error(error)),
        }
    }

    /// Records the S-UPD-006 reset intent for a store whose business JSON cannot be loaded. Owner,
    /// live lock and guard evidence alone establish the reset, and `recover_confirmed_reset` then
    /// completes it; a live Runtime instance or any pending intent refuses the reset.
    pub fn record_corrupt_store_reset_intent(
        &self,
        intent: &RuntimeResetIntent,
        cleanup_verified: bool,
    ) -> Result<(), DomainError> {
        if !cleanup_verified {
            return Err(DomainError::new(
                ErrorCode::IoError,
                "reset cannot bypass unverified cleanup",
            ));
        }
        let _lifetime_lock = FileLock::try_acquire(&self.base.join("runtime-live.lock"))?
            .ok_or_else(|| {
                DomainError::new(
                    ErrorCode::HostTransitionPending,
                    "a Runtime instance holds the live lock",
                )
            })?;
        self.refuse_pending_intents()?;
        if self.maintenance_blocker()? != MaintenanceBlocker::StoreCorrupt {
            return Err(DomainError::new(
                ErrorCode::StaleAuthority,
                "the canonical store is not corrupt",
            ));
        }
        let owner = self.read_owner()?;
        if intent.runtime_epoch != owner.runtime_epoch
            || intent.source_host_generation != owner.host_generation
            || validate_reset_owner(intent, &owner)? != crate::ResetOwnerState::Source
        {
            return Err(DomainError::new(
                ErrorCode::StaleAuthority,
                "reset intent does not start from the current owner",
            ));
        }
        write_new_json(&self.base.join("runtime-reset-intent.json"), intent)?;
        sync_directory(&self.base)
    }

    /// The S-AUTH-001 malformed-owner reset (S-UI-017): under the live lock it replaces only the
    /// owner with a fresh epoch at generation 1 of [host] and leaves the canonical store for
    /// ordinary interruption reconciliation.
    pub fn reset_malformed_owner(
        &self,
        runtime_epoch: contract::UuidV4,
        host: RuntimeHost,
        cleanup_verified: bool,
    ) -> Result<RuntimeOwner, DomainError> {
        if !cleanup_verified {
            return Err(DomainError::new(
                ErrorCode::IoError,
                "reset cannot bypass unverified cleanup",
            ));
        }
        let _lifetime_lock = FileLock::try_acquire(&self.base.join("runtime-live.lock"))?
            .ok_or_else(|| {
                DomainError::new(
                    ErrorCode::HostTransitionPending,
                    "a Runtime instance holds the live lock",
                )
            })?;
        self.refuse_pending_intents()?;
        if self.maintenance_blocker()? != MaintenanceBlocker::OwnerCorrupt {
            return Err(DomainError::new(
                ErrorCode::StaleAuthority,
                "the runtime owner is not corrupt",
            ));
        }
        let owner = RuntimeOwner {
            schema_version: 1,
            runtime_epoch,
            host,
            host_generation: 1,
        };
        atomic_replace_json(&self.base, "runtime-owner.json", &owner)?;
        Ok(owner)
    }

    fn refuse_pending_intents(&self) -> Result<(), DomainError> {
        if self.base.join("runtime-reset-intent.json").exists() {
            return Err(DomainError::new(
                ErrorCode::StaleAuthority,
                "a pending Runtime intent must be recovered first",
            ));
        }
        Ok(())
    }

    pub fn compare_and_commit<F>(
        &self,
        lease: &LifetimeLease,
        expected_revision: u64,
        mutate: F,
    ) -> Result<CommitInstrumentation, DomainError>
    where
        F: FnOnce(&mut CanonicalState) -> Result<(), DomainError>,
    {
        self.compare_and_commit_with_crash(lease, expected_revision, mutate, |_| false)
    }

    pub fn compare_and_commit_with_crash<F, C>(
        &self,
        lease: &LifetimeLease,
        expected_revision: u64,
        mutate: F,
        crash: C,
    ) -> Result<CommitInstrumentation, DomainError>
    where
        F: FnOnce(&mut CanonicalState) -> Result<(), DomainError>,
        C: Fn(CrashPoint) -> bool,
    {
        let total_started = Instant::now();
        let lock_started = Instant::now();
        let state_lock = FileLock::acquire(&self.base.join("runtime-state.lock"))?;
        let lock_wait_ns = lock_started.elapsed().as_nanos();
        self.validate_lease(lease)?;

        let parse_started = Instant::now();
        let state_path = self.base.join("runtime-state.json");
        let state_bytes = fs::read(&state_path).map_err(io_error)?;
        let mut state = decode_canonical_state(&state_bytes)?;
        let parse_ns = parse_started.elapsed().as_nanos();
        if state.store_revision != expected_revision {
            return Err(DomainError::new(
                ErrorCode::RevisionConflict,
                "store revision does not match",
            ));
        }

        let mutation_started = Instant::now();
        mutate(&mut state)?;
        if state.store_revision != expected_revision {
            return Err(DomainError::new(
                ErrorCode::RevisionConflict,
                "domain mutation changed the store revision",
            ));
        }
        state.store_revision = expected_revision.checked_add(1).ok_or_else(|| {
            DomainError::new(ErrorCode::ResourceLimit, "store revision exhausted")
        })?;
        let domain_mutation_ns = mutation_started.elapsed().as_nanos();

        let serialize_started = Instant::now();
        let bytes = serde_json::to_vec(&state).map_err(|_| {
            DomainError::new(ErrorCode::InternalError, "store serialization failed")
        })?;
        validate_state(&state, bytes.len())?;
        let unused_reservations = state.reservations.iter().try_fold(0_usize, |sum, item| {
            usize::try_from(item.reserved_bytes)
                .ok()
                .and_then(|value| sum.checked_add(value))
        });
        if bytes.len() > STORE_LIMIT_BYTES
            || unused_reservations
                .and_then(|reserved| bytes.len().checked_add(reserved))
                .is_none_or(|total| total > STORE_LIMIT_BYTES)
        {
            return Err(DomainError::new(
                ErrorCode::ResourceLimit,
                "store plus reservations exceeds hard limit",
            ));
        }
        let serialize_ns = serialize_started.elapsed().as_nanos();
        if crash(CrashPoint::BeforeTempCreate) {
            return Err(injected_crash());
        }

        let write_started = Instant::now();
        // The name depends only on the revision this commit produces, and a commit that did not
        // land leaves the revision where it was, so the next attempt reuses the name. A file left
        // there by a writer that died mid-commit is removed under the state lock; one this commit
        // cannot finish is removed here.
        let temporary = self
            .base
            .join(format!(".runtime-state.{}.tmp", state.store_revision));
        match fs::remove_file(&temporary) {
            Ok(()) => sync_directory(&self.base)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
        let mut file = open_new_private(&temporary)?;
        let written = file
            .write_all(&bytes)
            .map_err(io_error)
            .and_then(|()| file.sync_all().map_err(io_error));
        drop(file);
        if let Err(error) = written {
            discard_temporary(&self.base, &temporary);
            return Err(error);
        }
        let temp_write_fsync_ns = write_started.elapsed().as_nanos();
        if crash(CrashPoint::AfterTempFsync) {
            return Err(injected_crash());
        }

        let rename_started = Instant::now();
        if let Err(error) = replace_file(&temporary, &self.base.join("runtime-state.json")) {
            discard_temporary(&self.base, &temporary);
            return Err(error);
        }
        if crash(CrashPoint::AfterRename) {
            return Err(injected_crash());
        }
        sync_directory(&self.base)?;
        state_lock.sync()?;
        let rename_directory_fsync_ns = rename_started.elapsed().as_nanos();
        Ok(CommitInstrumentation {
            lock_wait_ns,
            parse_ns,
            domain_mutation_ns,
            serialize_ns,
            temp_write_fsync_ns,
            rename_directory_fsync_ns,
            total_ns: total_started.elapsed().as_nanos(),
        })
    }

    pub fn cleanup_task_temporary(
        &self,
        lease: &LifetimeLease,
        task_id: &contract::TaskId,
        recovery: &crate::GuardRecovery,
    ) -> Result<bool, DomainError> {
        self.validate_lease(lease)?;
        if !matches!(recovery, crate::GuardRecovery::Clean { .. }) {
            return Err(DomainError::new(
                ErrorCode::IoError,
                "Task temporary data requires clean guard proof",
            ));
        }
        let temporary = self.base.join("tmp").join(task_id.as_str());
        if !temporary.exists() {
            return Ok(false);
        }
        fs::remove_dir_all(&temporary).map_err(io_error)?;
        sync_directory(&self.base.join("tmp"))?;
        Ok(true)
    }

    pub fn validate_lease(&self, lease: &LifetimeLease) -> Result<(), DomainError> {
        if lease.base != self.base {
            return Err(DomainError::new(
                ErrorCode::StaleAuthority,
                "lifetime lease belongs to another store",
            ));
        }
        let owner: RuntimeOwner = read_json(&self.base.join("runtime-owner.json"))?;
        let live: RuntimeLive = read_json(&self.base.join("runtime-live.json"))?;
        let fence = WriterFence {
            runtime_epoch: lease.live.runtime_epoch.clone(),
            host: lease.live.host,
            host_generation: lease.live.host_generation,
            runtime_instance_id: lease.live.runtime_instance_id.clone(),
        };
        if live != lease.live || !fence.matches(&owner, &live) {
            return Err(DomainError::new(
                ErrorCode::StaleAuthority,
                "lifetime lease is stale",
            ));
        }
        Ok(())
    }
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, DomainError> {
    let bytes = fs::read(path).map_err(io_error)?;
    serde_json::from_slice(&bytes)
        .map_err(|_| DomainError::new(ErrorCode::IoError, "canonical JSON is corrupt"))
}

pub fn decode_canonical_state(bytes: &[u8]) -> Result<CanonicalState, DomainError> {
    if bytes.len() > STORE_LIMIT_BYTES {
        return Err(DomainError::new(
            ErrorCode::ResourceLimit,
            "store is too large",
        ));
    }
    let state: CanonicalState = serde_json::from_slice(bytes)
        .map_err(|_| DomainError::new(ErrorCode::IoError, "canonical JSON is corrupt"))?;
    validate_state(&state, bytes.len())?;
    Ok(state)
}

pub(crate) fn atomic_replace_json<T: Serialize>(
    base: &Path,
    name: &str,
    value: &T,
) -> Result<(), DomainError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| DomainError::new(ErrorCode::InternalError, "JSON serialization failed"))?;
    let temporary = base.join(format!(".{name}.tmp"));
    if temporary.exists() {
        fs::remove_file(&temporary).map_err(io_error)?;
        sync_directory(base)?;
    }
    let mut file = open_new_private(&temporary)?;
    file.write_all(&bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    drop(file);
    replace_file(&temporary, &base.join(name))?;
    sync_directory(base)
}

fn write_new_json<T: Serialize>(path: &Path, value: &T) -> Result<(), DomainError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| DomainError::new(ErrorCode::InternalError, "JSON serialization failed"))?;
    let mut file = open_new_private(path)?;
    file.write_all(&bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)
}

/// Removes the temporary file of a commit that failed. The commit's own error is what the caller
/// reports; a temporary that cannot be removed now is removed by the next commit of that revision.
fn discard_temporary(base: &Path, temporary: &Path) {
    if fs::remove_file(temporary).is_ok() {
        let _ = sync_directory(base);
    }
}

fn open_new_private(path: &Path) -> Result<fs::File, DomainError> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(io_error)
}

fn open_lock_file(path: &Path) -> Result<(), DomainError> {
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .and_then(|file| file.sync_all())
        .map_err(io_error)
}

/// Creates each missing directory from the canonical `base` down to `directory`, each one
/// readable by its writer alone.
pub(crate) fn create_canonical_directory(base: &Path, directory: &Path) -> Result<(), DomainError> {
    let relative = directory.strip_prefix(base).map_err(|_| {
        DomainError::new(
            ErrorCode::InternalError,
            "store directory is outside the canonical base",
        )
    })?;
    let mut current = base.to_path_buf();
    for component in relative.components() {
        current.push(component);
        #[cfg_attr(not(unix), allow(unused_mut))]
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&current) {
            Ok(()) => sync_directory(current.parent().expect("created directory has a parent"))?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> Result<(), DomainError> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> Result<(), DomainError> {
    fs::rename(source, target).map_err(io_error)
}

fn exclusive_error(error: std::io::Error) -> DomainError {
    if error.kind() == std::io::ErrorKind::AlreadyExists {
        DomainError::new(
            ErrorCode::AlreadyExists,
            "exclusive commit destination already exists",
        )
    } else {
        io_error(error)
    }
}

#[cfg(any(target_os = "android", target_os = "linux"))]
pub(crate) fn replace_file_exclusive(source: &Path, target: &Path) -> Result<(), DomainError> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let invalid = || DomainError::new(ErrorCode::IoError, "commit path is invalid");
    let source = CString::new(source.as_os_str().as_bytes()).map_err(|_| invalid())?;
    let target = CString::new(target.as_os_str().as_bytes()).map_err(|_| invalid())?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::RENAME_NOREPLACE as libc::c_uint,
        )
    };
    if result != 0 {
        return Err(exclusive_error(std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "linux")))]
pub(crate) fn replace_file_exclusive(source: &Path, target: &Path) -> Result<(), DomainError> {
    fs::hard_link(source, target).map_err(exclusive_error)?;
    fs::remove_file(source).map_err(io_error)
}

fn validate_state(state: &CanonicalState, encoded_bytes: usize) -> Result<(), DomainError> {
    if state.schema_version != 1 {
        return Err(DomainError::new(
            ErrorCode::ProtocolIncompatible,
            "unsupported store schema",
        ));
    }
    if state.request_records.len() > 4096
        || state.automations.len() > 256
        || state.artifact_manifest.len() > crate::MAX_ARTIFACT_RECORDS
    {
        return Err(DomainError::new(
            ErrorCode::ResourceLimit,
            "store collection exceeds its record limit",
        ));
    }
    let mut identities = HashSet::new();
    if state
        .request_records
        .iter()
        .any(|record| !identities.insert(record.request_id.as_str().to_owned()))
    {
        return Err(DomainError::new(
            ErrorCode::IoError,
            "duplicate request identity",
        ));
    }
    identities.clear();
    for record in &state.automations {
        domain::validate_automation(&record.automation)
            .map_err(|_| DomainError::new(ErrorCode::IoError, "canonical Automation is invalid"))?;
    }
    if state
        .tasks
        .iter()
        .any(|task| !identities.insert(task.task_id.as_str().to_owned()))
    {
        return Err(DomainError::new(
            ErrorCode::IoError,
            "duplicate Task identity",
        ));
    }
    identities.clear();
    if state
        .tasks
        .iter()
        .any(|task| !identities.insert(task.execution_id.as_str().to_owned()))
    {
        return Err(DomainError::new(
            ErrorCode::IoError,
            "duplicate Task execution identity",
        ));
    }
    let running = state
        .tasks
        .iter()
        .filter(|task| task.state == contract::TaskState::Running)
        .count();
    let queued = state
        .tasks
        .iter()
        .filter(|task| {
            matches!(
                task.state,
                contract::TaskState::Created | contract::TaskState::Queued
            )
        })
        .count();
    let terminal = state.tasks.len().saturating_sub(running + queued);
    if running > 64 || queued > 256 || terminal > 500 {
        return Err(DomainError::new(
            ErrorCode::ResourceLimit,
            "Task registry exceeds its retention limit",
        ));
    }
    identities.clear();
    if state
        .automations
        .iter()
        .any(|record| !identities.insert(record.automation.automation_id.as_str().to_owned()))
    {
        return Err(DomainError::new(
            ErrorCode::IoError,
            "duplicate Automation identity",
        ));
    }
    identities.clear();
    let mut per_automation = HashMap::<String, usize>::new();
    let mut terminal_automation_executions = 0_usize;
    let mut non_terminal_automation_executions = 0_usize;
    for execution in &state.automation_executions {
        if !identities.insert(execution.summary.execution_id.as_str().to_owned()) {
            return Err(DomainError::new(
                ErrorCode::IoError,
                "duplicate AutomationExecution identity",
            ));
        }
        if matches!(
            execution.summary.state,
            contract::AutomationExecutionState::Queued
                | contract::AutomationExecutionState::Running
        ) {
            non_terminal_automation_executions += 1;
        } else {
            terminal_automation_executions += 1;
            *per_automation
                .entry(execution.automation_id.as_str().to_owned())
                .or_default() += 1;
        }
    }
    if terminal_automation_executions > 2000
        || non_terminal_automation_executions > 320
        || per_automation.values().any(|count| *count > 100)
    {
        return Err(DomainError::new(
            ErrorCode::ResourceLimit,
            "AutomationExecution history exceeds its retention limit",
        ));
    }
    identities.clear();
    let mut artifact_bytes = 0_u64;
    for artifact in &state.artifact_manifest {
        validate_artifact_record(artifact)?;
        if !identities.insert(artifact.artifact_ref.clone()) {
            return Err(DomainError::new(
                ErrorCode::IoError,
                "duplicate artifact reference",
            ));
        }
        artifact_bytes = artifact_bytes.checked_add(artifact.size).ok_or_else(|| {
            DomainError::new(
                ErrorCode::ResourceLimit,
                "artifact byte accounting overflow",
            )
        })?;
    }
    if artifact_bytes > crate::MAX_ARTIFACT_TOTAL_BYTES {
        return Err(DomainError::new(
            ErrorCode::ResourceLimit,
            "artifact manifest exceeds its byte limit",
        ));
    }
    identities.clear();
    let reserved_bytes = state
        .reservations
        .iter()
        .try_fold(0_usize, |sum, reservation| {
            if reservation.reserved_bytes < runtime::RESERVE_FLOOR_BYTES
                || !identities.insert(reservation.execution_id.as_str().to_owned())
            {
                return None;
            }
            usize::try_from(reservation.reserved_bytes)
                .ok()
                .and_then(|value| sum.checked_add(value))
        });
    if reserved_bytes
        .and_then(|reserved| encoded_bytes.checked_add(reserved))
        .is_none_or(|total| total > STORE_LIMIT_BYTES)
    {
        return Err(DomainError::new(
            ErrorCode::ResourceLimit,
            "store plus reservations exceeds hard limit",
        ));
    }
    runtime::RuntimeState::try_from(state.clone()).map_err(|_| {
        DomainError::new(
            ErrorCode::IoError,
            "canonical Task or request state is invalid",
        )
    })?;
    Ok(())
}

fn injected_crash() -> DomainError {
    DomainError::new(ErrorCode::IoError, "injected commit crash")
}

/// Executions left `running` by a Runtime instance that is gone: a synchronous execution still
/// running, or a Task that is neither terminal nor an AutomationExecution container. A daemon that
/// finds one without a guard proof refuses to recover ("prior execution cleanup is unverified")
/// and exits, which no reboot changes; clearing them is the user's recovery until the settlement
/// path stops leaving them behind.
fn stranded(state: &CanonicalState) -> (Vec<usize>, Vec<usize>) {
    let requests = state
        .request_records
        .iter()
        .enumerate()
        .filter(|(_, request)| {
            request
                .synchronous_execution
                .as_ref()
                .is_some_and(|execution| !execution.state.is_terminal())
        })
        .map(|(index, _)| index)
        .collect();
    let tasks = state
        .tasks
        .iter()
        .enumerate()
        .filter(|(_, task)| {
            task.automation_owner.is_none()
                && matches!(
                    task.state,
                    contract::TaskState::Created
                        | contract::TaskState::Queued
                        | contract::TaskState::Running
                )
        })
        .map(|(index, _)| index)
        .collect();
    (requests, tasks)
}

/// How many stranded executions the store holds. While no Runtime holds the live lock every
/// unsettled execution is stranded; while one does (a daemon that keeps restarting and refusing to
/// recover holds it for most of each attempt), only those of an instance other than the live one.
pub fn stranded_execution_count(base: &Path) -> Result<usize, DomainError> {
    let path = base.join("runtime-state.json");
    if !path.exists() {
        return Ok(0);
    }
    let live_instance = match FileLock::try_acquire(&base.join("runtime-live.lock"))? {
        Some(_free) => None,
        None => {
            Some(read_json::<RuntimeLive>(&base.join("runtime-live.json"))?.runtime_instance_id)
        }
    };
    let _state_lock = FileLock::acquire(&base.join("runtime-state.lock"))?;
    let state = decode_canonical_state(&fs::read(path).map_err(io_error)?)?;
    let (requests, tasks) = stranded(&state);
    let foreign = |instance: Option<&contract::UuidV4>| match (&live_instance, instance) {
        (None, _) => true,
        (Some(live), Some(instance)) => live != instance,
        (Some(_), None) => false,
    };
    let requests = requests
        .into_iter()
        .filter(|index| {
            foreign(
                state.request_records[*index]
                    .synchronous_execution
                    .as_ref()
                    .map(|execution| &execution.executor.fence.runtime_instance_id),
            )
        })
        .count();
    let tasks = tasks
        .into_iter()
        .filter(|index| {
            foreign(
                state.tasks[*index]
                    .executor
                    .as_ref()
                    .map(|executor| &executor.fence.runtime_instance_id),
            )
        })
        .count();
    Ok(requests + tasks)
}

/// Marks every stranded execution interrupted the way `recover_old_instance` settles a lost
/// instance, and releases its reservation. Refused while a live Runtime owns the store; the live
/// lock is held for the whole rewrite so no host starts on the half-written state.
/// A daemon that keeps restarting holds the live lock for most of each attempt, so the lock is
/// retried until `wait` has passed before the clear is refused.
pub fn clear_stranded_executions(
    base: &Path,
    ended_at: &str,
    now_ms: u64,
    wait: std::time::Duration,
) -> Result<usize, DomainError> {
    let deadline = Instant::now() + wait;
    let _live = loop {
        if let Some(lock) = FileLock::try_acquire(&base.join("runtime-live.lock"))? {
            break lock;
        }
        if Instant::now() >= deadline {
            return Err(DomainError::new(
                ErrorCode::HostTransitionPending,
                "a live Runtime owns the store",
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    let _state_lock = FileLock::acquire(&base.join("runtime-state.lock"))?;
    let path = base.join("runtime-state.json");
    let mut state = decode_canonical_state(&fs::read(&path).map_err(io_error)?)?;
    let (requests, tasks) = stranded(&state);
    if requests.is_empty() && tasks.is_empty() {
        return Ok(0);
    }
    let expires_at_ms = now_ms.saturating_add(86_400_000);
    let mut released = HashSet::new();
    let interrupted_error = |operation: String| contract::PublicError {
        code: ErrorCode::IoError,
        operation,
        retryable: false,
        message: None,
        capability: None,
        details: None,
    };
    for index in &requests {
        let request = &mut state.request_records[*index];
        if let Some(execution) = request.synchronous_execution.as_mut() {
            execution.state = runtime::SynchronousExecutionState::Interrupted;
            execution.ended_at = Some(ended_at.to_owned());
            execution.error = Some(interrupted_error(execution.operation.clone()));
            execution.terminal_bytes = runtime::RESERVE_FLOOR_BYTES.min(execution.reserved_bytes);
            released.insert(execution.execution_id.as_str().to_owned());
        }
        request.expires_at_ms = Some(expires_at_ms);
    }
    for index in &tasks {
        let task = &mut state.tasks[*index];
        let tool = serde_json::to_value(task.tool)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_default();
        task.state = contract::TaskState::Interrupted;
        task.ended_at = Some(ended_at.to_owned());
        task.error = Some(interrupted_error(format!("{tool}.{}", task.action)));
        released.insert(task.execution_id.as_str().to_owned());
        let request_id = task.request_id.clone();
        if let Some(request_id) = request_id
            && let Some(request) = state
                .request_records
                .iter_mut()
                .find(|request| request.request_id == request_id)
        {
            request.expires_at_ms = Some(expires_at_ms);
        }
    }
    state
        .reservations
        .retain(|reservation| !released.contains(reservation.execution_id.as_str()));
    state.store_revision = state
        .store_revision
        .checked_add(1)
        .ok_or_else(|| DomainError::new(ErrorCode::ResourceLimit, "store revision exhausted"))?;
    // The rewritten state must still be a state the Runtime accepts.
    let encoded = serde_json::to_vec(&state)
        .map_err(|_| DomainError::new(ErrorCode::InternalError, "JSON serialization failed"))?;
    decode_canonical_state(&encoded)?;
    atomic_replace_json(base, "runtime-state.json", &state)?;
    Ok(requests.len() + tasks.len())
}
