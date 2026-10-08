//! Side-effect-free evidence about an already published APK Runtime instance.

use contract::{ErrorCode, UuidV4};
use domain::DomainError;
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
            Self::BridgeFault => "bridge_fault",
            Self::ExecutorMissing => "executor_missing",
            Self::ProbeFailed => "probe_failed",
        }
    }
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
}
