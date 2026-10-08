//! Side-effect-free evidence about an already published APK Runtime instance.

use chrono::{SecondsFormat, Utc};
use contract::{ErrorCode, UuidV4};
use domain::DomainError;
use persistence::{FaultFileStore, FaultRecord, FaultRole};
use std::{
    fs,
    io::{self, Write},
    path::Path,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HostHealthClass {
    Healthy,
    HostMissing,
    FenceMismatch,
    LeaseStale,
    NotReady,
    StoreUnreadable,
    StoreUnwritable,
    ResourceExhausted,
    BridgeFault,
    ExecutorMissing,
    ProbeFailed,
}

impl HostHealthClass {
    pub(crate) fn token(self) -> &'static str {
        match self {
            Self::Healthy => "healthy",
            Self::HostMissing => "host_missing",
            Self::FenceMismatch => "fence_mismatch",
            Self::LeaseStale => "lease_stale",
            Self::NotReady => "not_ready",
            Self::StoreUnreadable => "store_unreadable",
            Self::StoreUnwritable => "store_unwritable",
            Self::ResourceExhausted => "resource_exhausted",
            Self::BridgeFault => "bridge_fault",
            Self::ExecutorMissing => "executor_missing",
            Self::ProbeFailed => "probe_failed",
        }
    }

    pub(crate) fn from_token(value: &str) -> Option<Self> {
        Some(match value {
            "healthy" => Self::Healthy,
            "host_missing" => Self::HostMissing,
            "fence_mismatch" => Self::FenceMismatch,
            "lease_stale" => Self::LeaseStale,
            "not_ready" => Self::NotReady,
            "store_unreadable" => Self::StoreUnreadable,
            "store_unwritable" => Self::StoreUnwritable,
            "resource_exhausted" => Self::ResourceExhausted,
            "bridge_fault" => Self::BridgeFault,
            "executor_missing" => Self::ExecutorMissing,
            "probe_failed" => Self::ProbeFailed,
            _ => return None,
        })
    }

    fn fault_code(self) -> &'static str {
        match self {
            Self::Healthy | Self::ProbeFailed => "INTERNAL_ERROR",
            Self::HostMissing | Self::NotReady | Self::ExecutorMissing => "CAPABILITY_UNAVAILABLE",
            Self::FenceMismatch | Self::LeaseStale => "STALE_AUTHORITY",
            Self::StoreUnreadable | Self::StoreUnwritable | Self::BridgeFault => "IO_ERROR",
            Self::ResourceExhausted => "RESOURCE_LIMIT",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HostHealthPhase {
    Admission,
    Settlement,
}

impl HostHealthPhase {
    pub(crate) fn from_token(value: &str) -> Option<Self> {
        match value {
            "admission" => Some(Self::Admission),
            "settlement" => Some(Self::Settlement),
            _ => None,
        }
    }

    fn token(self) -> &'static str {
        match self {
            Self::Admission => "admission",
            Self::Settlement => "settlement",
        }
    }
}

/// A typed host-health fault is independent of the slot: a missing or replaced instance still
/// leaves evidence in the APK-owned host fault file.
pub(crate) fn record_host_health_fault(
    base: &Path,
    product_version: &str,
    boot_id: &UuidV4,
    instance: &UuidV4,
    class: HostHealthClass,
    phase: HostHealthPhase,
    generation: u64,
) -> Result<(), DomainError> {
    if class == HostHealthClass::Healthy {
        return Err(DomainError::new(
            ErrorCode::InternalError,
            "healthy host has no fault",
        ));
    }
    let now = Utc::now();
    let now_ms = u64::try_from(now.timestamp_millis())
        .map_err(|_| DomainError::new(ErrorCode::InternalError, "clock is before epoch"))?;
    FaultFileStore::new(base, FaultRole::Host).append(
        FaultRecord {
            record_id: crate::new_uuid()?,
            at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
            component: "apk_runtime_health".to_owned(),
            code: class.fault_code().to_owned(),
            phase: format!("health_{}:{}@g{generation}", phase.token(), class.token()),
            product_version: product_version.to_owned(),
            boot_id: boot_id.clone(),
            runtime_instance_id: Some(instance.clone()),
            execution_id: None,
            exit_code: None,
            signal: None,
            repeat_count: 1,
        },
        now_ms,
    )
}

#[cfg(any(unix, test))]
pub(crate) const MIN_DESCRIPTOR_HEADROOM: u64 = 64;

#[cfg(any(unix, test))]
pub(crate) fn descriptor_headroom(directory: &Path, soft_limit: u64) -> io::Result<u64> {
    let open = fs::read_dir(directory)?.try_fold(0_u64, |count, entry| {
        entry?;
        Ok::<u64, io::Error>(count.saturating_add(1))
    })?;
    Ok(soft_limit.saturating_sub(open))
}

#[cfg(any(unix, test))]
pub(crate) fn descriptor_class(headroom: io::Result<u64>) -> HostHealthClass {
    match headroom {
        Ok(free) if free >= MIN_DESCRIPTOR_HEADROOM => HostHealthClass::Healthy,
        _ => HostHealthClass::ResourceExhausted,
    }
}

#[cfg(unix)]
fn descriptor_soft_limit() -> u64 {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return 0;
    }
    limit.rlim_cur
}

#[cfg(unix)]
pub(crate) fn probe_descriptor_class() -> HostHealthClass {
    descriptor_class(descriptor_headroom(
        Path::new("/proc/self/fd"),
        descriptor_soft_limit(),
    ))
}

#[cfg(not(unix))]
pub(crate) fn probe_descriptor_class() -> HostHealthClass {
    HostHealthClass::Healthy
}

/// Keep the most basic failed proof, even if later checks also fail.
pub(crate) fn classify_deep_probe(
    canonical_read: impl FnOnce() -> Result<(), DomainError>,
    scratch_write: impl FnOnce() -> io::Result<()>,
    executor_bridge: impl FnOnce() -> HostHealthClass,
) -> HostHealthClass {
    match canonical_read() {
        Err(error) if error.code == ErrorCode::StaleAuthority => {
            return HostHealthClass::LeaseStale;
        }
        Err(_) => return HostHealthClass::StoreUnreadable,
        Ok(()) => {}
    }
    if scratch_write().is_err() {
        HostHealthClass::StoreUnwritable
    } else {
        executor_bridge()
    }
}

static SCRATCH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Create, fsync, and remove only this probe's private file. Canonical state is never opened for
/// writing, and a failed sync still removes the scratch file before returning its error.
pub(crate) fn probe_store_writable(base: &Path, instance: &UuidV4) -> io::Result<()> {
    let sequence = SCRATCH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let path = base.join(format!(
        ".runtime-health-{}-{}-{sequence}.tmp",
        instance.as_str(),
        std::process::id(),
    ));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    let written = file.write_all(&[0]).and_then(|()| file.sync_all());
    drop(file);
    let removed = fs::remove_file(&path);
    written?;
    removed
}

const MAX_LATCHED_INSTANCES: usize = 8;
static BRIDGE_FAULTS: Mutex<Vec<UuidV4>> = Mutex::new(Vec::new());

/// A JNI failure escaped the dispatcher's typed executor-error boundary. Bind it to the exact
/// instance so a late failure from an old host cannot poison its replacement.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn latch_bridge_fault(instance: &UuidV4) {
    if let Ok(mut faults) = BRIDGE_FAULTS.lock()
        && !faults.contains(instance)
    {
        if faults.len() == MAX_LATCHED_INSTANCES {
            faults.remove(0);
        }
        faults.push(instance.clone());
    }
}

pub(crate) fn bridge_fault_latched(instance: &UuidV4) -> bool {
    BRIDGE_FAULTS
        .lock()
        .map(|faults| faults.contains(instance))
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use persistence::{FaultFileStore, FaultRole};

    fn id(number: u64) -> UuidV4 {
        UuidV4::parse(format!("00000000-0000-4000-8000-{number:012x}")).unwrap()
    }

    #[test]
    fn bridge_fault_is_latched_only_for_its_instance() {
        let old = id(0x501);
        let live = id(0x502);
        latch_bridge_fault(&old);
        assert!(bridge_fault_latched(&old));
        assert!(!bridge_fault_latched(&live));
    }

    #[test]
    fn descriptor_headroom_fails_closed_below_sixty_four_free_slots() {
        let directory =
            std::env::temp_dir().join(format!("droidbridge-fds-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        for index in 0..5 {
            fs::write(directory.join(index.to_string()), []).unwrap();
        }
        assert_eq!(
            descriptor_class(descriptor_headroom(&directory, 69)),
            HostHealthClass::Healthy
        );
        assert_eq!(
            descriptor_class(descriptor_headroom(&directory, 68)),
            HostHealthClass::ResourceExhausted
        );
        assert_eq!(
            descriptor_class(descriptor_headroom(&directory.join("missing"), 1000)),
            HostHealthClass::ResourceExhausted
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn typed_health_fault_records_class_phase_generation_and_instance() {
        let directory =
            std::env::temp_dir().join(format!("droidbridge-health-fault-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        FaultFileStore::initialize_all_by_apk(&directory).unwrap();
        record_host_health_fault(
            &directory,
            "0.5.1",
            &id(7),
            &id(8),
            HostHealthClass::ResourceExhausted,
            HostHealthPhase::Admission,
            9,
        )
        .unwrap();
        let records = FaultFileStore::new(&directory, FaultRole::Host)
            .read()
            .unwrap()
            .records;
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].component, "apk_runtime_health");
        assert_eq!(records[0].code, "RESOURCE_LIMIT");
        assert_eq!(records[0].phase, "health_admission:resource_exhausted@g9");
        assert_eq!(records[0].runtime_instance_id, Some(id(8)));
        fs::remove_dir_all(directory).unwrap();
    }
}
