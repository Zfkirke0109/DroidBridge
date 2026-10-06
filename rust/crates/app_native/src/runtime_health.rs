//! Issue #2: side-effect-free health facts for the live APK Runtime instance.
//!
//! A started session only says an instance was established once. These checks say whether the
//! instance a fence names can still execute: it holds the slot, its lifetime lease still matches the
//! canonical owner, its JNI bridge has not failed, the process has descriptors left, and (deep) its
//! store reads, its directory takes a write, and the executor registry answers over JNI. None of
//! them runs an executor or changes canonical state; the scratch write is created and removed
//! inside a directory nothing else enumerates.

use contract::{ErrorCode, UuidV4};
use domain::DomainError;
use persistence::RuntimeLive;
use std::{
    fs,
    io::Write,
    path::Path,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

/// Fewer free descriptors than this and every adapter's next open, socket or spawn is at risk.
pub(crate) const MIN_DESCRIPTOR_HEADROOM: u64 = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HealthClass {
    Healthy,
    HostMissing,
    FenceMismatch,
    LeaseStale,
    StoreUnreadable,
    StoreUnwritable,
    ResourceExhausted,
    BridgeFault,
    // Only the Android JNI round trip can find the executor registry without its executor.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    ExecutorMissing,
}

impl HealthClass {
    /// Every class the native probe can report, in the order of the shared contract fixture.
    #[cfg(test)]
    pub(crate) const ALL: [Self; 9] = [
        Self::Healthy,
        Self::HostMissing,
        Self::FenceMismatch,
        Self::LeaseStale,
        Self::StoreUnreadable,
        Self::StoreUnwritable,
        Self::ResourceExhausted,
        Self::BridgeFault,
        Self::ExecutorMissing,
    ];

    pub(crate) fn token(self) -> &'static str {
        match self {
            Self::Healthy => "healthy",
            Self::HostMissing => "host_missing",
            Self::FenceMismatch => "fence_mismatch",
            Self::LeaseStale => "lease_stale",
            Self::StoreUnreadable => "store_unreadable",
            Self::StoreUnwritable => "store_unwritable",
            Self::ResourceExhausted => "resource_exhausted",
            Self::BridgeFault => "bridge_fault",
            Self::ExecutorMissing => "executor_missing",
        }
    }

    pub(crate) fn encode(self) -> String {
        serde_json::json!({"class": self.token()}).to_string()
    }
}

/// The fence one probe or release names, exactly as the App session holds it.
pub(crate) struct ExpectedFence<'a> {
    pub(crate) runtime_epoch: &'a str,
    pub(crate) host_generation: u64,
    pub(crate) runtime_instance_id: &'a str,
}

impl ExpectedFence<'_> {
    pub(crate) fn names(&self, live: &RuntimeLive) -> bool {
        live.runtime_epoch.as_str() == self.runtime_epoch
            && live.host_generation == self.host_generation
            && live.runtime_instance_id.as_str() == self.runtime_instance_id
    }
}

/// The lease check's verdict: a lease the owner no longer names is stale authority, anything else
/// means the canonical records themselves cannot be read.
pub(crate) fn lease_class(validated: Result<(), DomainError>) -> HealthClass {
    match validated {
        Ok(()) => HealthClass::Healthy,
        Err(error) if error.code == ErrorCode::StaleAuthority => HealthClass::LeaseStale,
        Err(_) => HealthClass::StoreUnreadable,
    }
}

/// Free descriptors under the soft limit, counted from the process's own descriptor directory.
pub(crate) fn descriptor_headroom(
    descriptor_directory: &Path,
    soft_limit: u64,
) -> std::io::Result<u64> {
    // The directory handle this read holds is itself one of the counted entries.
    let open = fs::read_dir(descriptor_directory)?.count() as u64;
    Ok(soft_limit.saturating_sub(open))
}

pub(crate) fn descriptor_class(headroom: std::io::Result<u64>) -> HealthClass {
    match headroom {
        Ok(free) if free >= MIN_DESCRIPTOR_HEADROOM => HealthClass::Healthy,
        // A descriptor table that cannot even be listed is the exhaustion this check exists for.
        _ => HealthClass::ResourceExhausted,
    }
}

#[cfg(unix)]
pub(crate) fn descriptor_soft_limit() -> u64 {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return 0;
    }
    limit.rlim_cur
}

#[cfg(not(unix))]
pub(crate) fn descriptor_soft_limit() -> u64 {
    u64::MAX
}

static SCRATCH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Proves the canonical directory still takes a durable write: one private scratch file is
/// created, synced and removed. Canonical files are never opened for writing.
pub(crate) fn probe_store_writable(base: &Path, instance: &UuidV4) -> std::io::Result<()> {
    let sequence = SCRATCH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let path = base.join(format!(
        "runtime-health-probe-{}-{sequence}.tmp",
        instance.as_str()
    ));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    // Only a file this call created is ever removed.
    let mut file = options.open(&path)?;
    let written = file.write_all(&[0]).and_then(|()| file.sync_all());
    drop(file);
    let removed = fs::remove_file(&path);
    written?;
    match removed {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// How many instances' bridge faults are remembered; a process only ever has a handful.
const MAX_LATCHED_INSTANCES: usize = 8;

/// Instances whose JNI dispatch bridge failed. The Kotlin dispatcher answers every exception an
/// executor throws as that operation's typed failure, so any JNI failure that still reaches here
/// comes from the path all Android primitives share. Each instance is latched on its own, so a
/// straggler from a released instance cannot clear or hide the live one's fault.
static BRIDGE_FAULT: Mutex<Vec<UuidV4>> = Mutex::new(Vec::new());

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn latch_bridge_fault(instance: &UuidV4) {
    if let Ok(mut latched) = BRIDGE_FAULT.lock()
        && !latched.contains(instance)
    {
        if latched.len() == MAX_LATCHED_INSTANCES {
            latched.remove(0);
        }
        latched.push(instance.clone());
    }
}

pub(crate) fn bridge_fault_latched(instance: &UuidV4) -> bool {
    BRIDGE_FAULT
        .lock()
        .map(|latched| latched.contains(instance))
        // A poisoned latch cannot prove the bridge is intact.
        .unwrap_or(true)
}

/// The first unhealthy class among already-ordered checks, so a probe reports the most basic fault.
pub(crate) fn first_unhealthy(checks: impl IntoIterator<Item = HealthClass>) -> HealthClass {
    checks
        .into_iter()
        .find(|class| *class != HealthClass::Healthy)
        .unwrap_or(HealthClass::Healthy)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(index: u64) -> UuidV4 {
        UuidV4::parse(format!("00000000-0000-4000-8000-{index:012x}")).unwrap()
    }

    fn live(instance: u64) -> RuntimeLive {
        RuntimeLive {
            runtime_epoch: id(1),
            host: contract::RuntimeHost::ApkRuntime,
            host_generation: 1,
            runtime_instance_id: id(instance),
            boot_id: id(9),
            pid: 1,
            start_ticks: 1,
        }
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "droidbridge-health-{name}-{}-{}",
            std::process::id(),
            SCRATCH_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn p0_fence_names_exactly_one_live_instance() {
        let epoch = id(1);
        let instance = id(2);
        let fence = ExpectedFence {
            runtime_epoch: epoch.as_str(),
            host_generation: 1,
            runtime_instance_id: instance.as_str(),
        };
        assert!(fence.names(&live(2)));
        assert!(!fence.names(&live(3)));
        let mut later = live(2);
        later.host_generation = 2;
        assert!(!fence.names(&later));
        let mut other_epoch = live(2);
        other_epoch.runtime_epoch = id(7);
        assert!(!fence.names(&other_epoch));
    }

    #[test]
    fn p0_lease_failures_separate_stale_authority_from_unreadable_records() {
        assert_eq!(lease_class(Ok(())), HealthClass::Healthy);
        assert_eq!(
            lease_class(Err(DomainError::new(ErrorCode::StaleAuthority, "stale"))),
            HealthClass::LeaseStale
        );
        assert_eq!(
            lease_class(Err(DomainError::new(ErrorCode::IoError, "corrupt"))),
            HealthClass::StoreUnreadable
        );
    }

    #[test]
    fn p0_descriptor_exhaustion_is_unhealthy_and_an_unlistable_table_fails_closed() {
        let directory = scratch("fds");
        for index in 0..5 {
            fs::write(directory.join(index.to_string()), b"").unwrap();
        }
        assert_eq!(descriptor_headroom(&directory, 100).unwrap(), 95);
        assert_eq!(descriptor_headroom(&directory, 3).unwrap(), 0);
        assert_eq!(
            descriptor_class(descriptor_headroom(&directory, 1_000)),
            HealthClass::Healthy
        );
        assert_eq!(
            descriptor_class(descriptor_headroom(
                &directory,
                5 + MIN_DESCRIPTOR_HEADROOM - 1
            )),
            HealthClass::ResourceExhausted
        );
        assert_eq!(
            descriptor_class(descriptor_headroom(&directory.join("absent"), 1_000)),
            HealthClass::ResourceExhausted
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn p0_this_process_has_descriptor_headroom() {
        assert_eq!(
            descriptor_class(descriptor_headroom(
                Path::new("/proc/self/fd"),
                descriptor_soft_limit()
            )),
            HealthClass::Healthy
        );
    }

    #[test]
    fn p0_store_write_probe_leaves_nothing_behind_and_reports_an_unwritable_directory() {
        let base = scratch("store");
        fs::write(base.join("runtime-state.json"), b"{}").unwrap();
        probe_store_writable(&base, &id(2)).unwrap();
        probe_store_writable(&base, &id(2)).unwrap();
        let mut names: Vec<_> = fs::read_dir(&base)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["runtime-state.json"]);
        assert_eq!(fs::read(base.join("runtime-state.json")).unwrap(), b"{}");
        assert!(probe_store_writable(&base.join("missing"), &id(2)).is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn p0_rust_health_classes_match_the_shared_contract_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../app/src/test/resources/contract/runtime-health-classes.v1.json"
        )))
        .unwrap();
        assert_eq!(fixture["schema_version"], 1);
        let classes: Vec<&str> = fixture["classes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect();
        let emitted: Vec<&str> = HealthClass::ALL.iter().map(|class| class.token()).collect();
        assert_eq!(emitted, classes);
    }

    #[test]
    fn p0_bridge_faults_latch_per_instance_and_a_straggler_never_hides_the_live_one() {
        let first = id(0x51);
        let second = id(0x52);
        let fresh = id(0x53);
        latch_bridge_fault(&second);
        assert!(bridge_fault_latched(&second));
        assert!(!bridge_fault_latched(&fresh));
        // A late failure on the released instance does not displace the live instance's latch.
        latch_bridge_fault(&first);
        assert!(bridge_fault_latched(&first));
        assert!(bridge_fault_latched(&second));
        assert!(!bridge_fault_latched(&fresh));
        latch_bridge_fault(&second);
        let latched = BRIDGE_FAULT.lock().unwrap();
        assert_eq!(latched.iter().filter(|value| **value == second).count(), 1);
        assert!(latched.len() <= MAX_LATCHED_INSTANCES);
    }

    #[test]
    fn p0_probe_reports_the_first_failed_check_in_order() {
        assert_eq!(
            first_unhealthy([HealthClass::Healthy, HealthClass::Healthy]),
            HealthClass::Healthy
        );
        assert_eq!(
            first_unhealthy([
                HealthClass::Healthy,
                HealthClass::LeaseStale,
                HealthClass::BridgeFault
            ]),
            HealthClass::LeaseStale
        );
        assert_eq!(
            HealthClass::BridgeFault.encode(),
            r#"{"class":"bridge_fault"}"#
        );
    }
}
