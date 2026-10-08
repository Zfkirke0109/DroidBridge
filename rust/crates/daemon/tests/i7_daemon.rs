use contract::{CapabilityState, ErrorCode, UuidV4};
use daemon::{
    ExecutionGuardState, HelperHello, HelperRegistry, MagiskExecutorFence, MagiskExecutorHandle,
    MagiskPrimitiveFamily, ModuleIdentity, ModuleObservation, PackageListKind,
    PrimitiveProcessPlan, SourceGeneration, WakeAlarmProbe,
};
use domain::DomainError;
use persistence::{
    CanonicalState, GuardFinalizationDisposition, GuardProofReader, GuardProofRecord,
    GuardRecovery, ProcessFacts, await_guard_recovery_plan,
};
#[cfg(not(target_os = "android"))]
use std::path::PathBuf;

fn id(value: u8) -> UuidV4 {
    UuidV4::parse(format!("00000000-0000-4000-8000-{value:012x}")).unwrap()
}

struct VectorProofs(Vec<GuardProofRecord>);

impl GuardProofReader for VectorProofs {
    fn read_proof(
        &self,
        boot_id: &UuidV4,
        execution_id: &UuidV4,
    ) -> Result<Option<Vec<u8>>, DomainError> {
        Ok(self
            .0
            .iter()
            .find(|record| {
                &record.containing_boot_id == boot_id && &record.execution_id == execution_id
            })
            .map(|record| record.bytes.clone()))
    }

    fn list_proofs(&self) -> Result<Vec<GuardProofRecord>, DomainError> {
        Ok(self.0.clone())
    }
}

struct NeverLive;

impl ProcessFacts for NeverLive {
    fn is_same_process(&self, _pid: u32, _start_ticks: u64) -> Result<bool, DomainError> {
        Ok(false)
    }
}

fn observation() -> ModuleObservation {
    ModuleObservation {
        stable_present: true,
        debug_present: false,
        enabled: true,
        module_version_code: 1000,
        daemon_version_code: 1000,
    }
}

#[test]
fn i7_g01_module_identity_and_readiness_truth_are_exact() {
    let stable = ModuleIdentity::stable();
    assert_eq!(stable.module_id, "droidbridge");
    assert_eq!(stable.frontend_package, "com.droidbridge.root");
    assert_eq!(
        stable.state_base(),
        std::path::Path::new("/data/adb/droidbridge/droidbridge")
    );
    assert_eq!(
        ModuleIdentity::debug().frontend_package,
        "com.droidbridge.root.debug"
    );
    assert!(observation().readiness(&stable, 1000).is_ok());

    let mut conflict = observation();
    conflict.debug_present = true;
    assert_eq!(
        conflict.readiness(&stable, 1000).unwrap_err().code,
        ErrorCode::CapabilityUnavailable,
    );
    let mut disabled = observation();
    disabled.enabled = false;
    assert_eq!(
        disabled.readiness(&stable, 1000).unwrap_err().code,
        ErrorCode::CapabilityUnavailable,
    );
    let mut incompatible = observation();
    incompatible.module_version_code = 999;
    assert_eq!(
        incompatible.readiness(&stable, 1000).unwrap_err().code,
        ErrorCode::ProtocolIncompatible,
    );
}

#[test]
fn i7_g04_helper_sdk_authentication_and_loss_are_isolated() {
    let mut helper = HelperRegistry::new(35, 4).unwrap();
    assert_eq!(
        helper.jar(std::path::Path::new("/data/adb/modules/droidbridge")),
        std::path::Path::new(
            "/data/adb/modules/droidbridge/framework/droidbridge-framework-api35.jar"
        )
    );
    assert!(
        helper
            .accept_hello(
                0,
                HelperHello {
                    protocol_version: 1,
                    sdk_int: 35,
                    helper_generation: 4
                },
            )
            .is_ok()
    );
    assert_eq!(helper.framework_state(), CapabilityState::Available);
    assert!(
        helper
            .accept_hello(
                0,
                HelperHello {
                    protocol_version: 1,
                    sdk_int: 35,
                    helper_generation: 5
                },
            )
            .is_err()
    );
    helper.disconnected();
    assert_eq!(helper.framework_state(), CapabilityState::Unavailable);
    let mut generation = SourceGeneration::initial();
    assert_eq!(generation.current(), 1);
    assert_eq!(generation.advance().unwrap(), 2);
}

#[test]
fn i7_g09_root_guard_death_is_durable_quarantine_not_clean() {
    let mut state = ExecutionGuardState::Running;
    state.observe_guard_death();
    assert_eq!(state, ExecutionGuardState::CleanupUnverified);
    assert!(state.blocks_admission());
    state.observe_reboot();
    assert_eq!(state, ExecutionGuardState::Clean);
}

#[test]
fn i7_g03_magisk_primitive_handle_is_fenced_and_process_identities_are_fixed() {
    let fence = MagiskExecutorFence {
        runtime_epoch: id(100),
        host_generation: 7,
        runtime_instance_id: id(101),
        source_generation: 3,
    };
    let handle = MagiskExecutorHandle::new(fence.clone(), Some(4)).unwrap();
    assert!(
        handle
            .authorize(&fence, MagiskPrimitiveFamily::NetworkCapture)
            .is_ok()
    );
    let mut stale = fence.clone();
    stale.source_generation += 1;
    assert_eq!(
        handle
            .authorize(&stale, MagiskPrimitiveFamily::Filesystem)
            .unwrap_err()
            .code,
        ErrorCode::StaleAuthority,
    );
    assert_eq!(
        handle
            .without_helper()
            .authorize(&fence, MagiskPrimitiveFamily::PrivilegedAndroid)
            .unwrap_err()
            .code,
        ErrorCode::CapabilityUnavailable,
    );

    let root = PrimitiveProcessPlan::root_shell("id".to_owned()).unwrap();
    assert_eq!(root.program(), "/system/bin/sh");
    assert_eq!(root.arguments(), ["-c", "id"]);
    let capture = PrimitiveProcessPlan::screen_capture();
    assert_eq!(capture.program(), "/system/bin/screencap");
    assert!(capture.arguments().is_empty());
    let packages = PrimitiveProcessPlan::package_list(PackageListKind::ThirdParty);
    assert_eq!(packages.program(), "/system/bin/cmd");
    assert_eq!(
        packages.arguments(),
        [
            "package",
            "list",
            "packages",
            "-3",
            "--show-versioncode",
            "--user",
            "0",
        ],
    );
    let force_stop =
        PrimitiveProcessPlan::package_force_stop("com.example.app".to_owned()).unwrap();
    assert_eq!(force_stop.program(), "/system/bin/am");
    assert!(PrimitiveProcessPlan::package_force_stop("bad package".to_owned()).is_err());
}

#[test]
fn i4_g04_i7_g11_shared_guard_recovery_vectors_drive_magisk_plan() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/guard-recovery-vectors.json"
    ))
    .unwrap();
    let vector = fixture["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|vector| vector["name"] == "orphan_old_boot_proof")
        .unwrap();
    let execution = vector["proofs"][0]["execution"].as_u64().unwrap();
    let plan = await_guard_recovery_plan(
        &CanonicalState::default(),
        &id(110),
        &id(3),
        &VectorProofs(vec![GuardProofRecord {
            containing_boot_id: id(4),
            execution_id: UuidV4::parse(format!("00000000-0000-4000-8000-{execution:012x}"))
                .unwrap(),
            bytes: Vec::new(),
        }]),
        &NeverLive,
    )
    .unwrap();
    assert!(plan.guards_are_clean());
    assert_eq!(plan.records().len(), 1);
    assert!(matches!(
        plan.records()[0].recovery,
        GuardRecovery::Clean { .. }
    ));
    assert_eq!(
        plan.records()[0].finalization,
        GuardFinalizationDisposition::RemoveProof
    );
}

#[test]
fn i7_g12_wake_alarm_requires_create_clock_arm_and_disarm() {
    assert!(
        WakeAlarmProbe {
            created: true,
            clock_read: true,
            armed: true,
            disarmed: true,
        }
        .available()
    );
    for missing in [
        WakeAlarmProbe {
            created: false,
            clock_read: true,
            armed: true,
            disarmed: true,
        },
        WakeAlarmProbe {
            created: true,
            clock_read: false,
            armed: true,
            disarmed: true,
        },
        WakeAlarmProbe {
            created: true,
            clock_read: true,
            armed: false,
            disarmed: true,
        },
        WakeAlarmProbe {
            created: true,
            clock_read: true,
            armed: true,
            disarmed: false,
        },
    ] {
        assert!(!missing.available());
    }
}

// Inspects the checked-out crate sources, which do not exist on a device deployment.
#[cfg(not(target_os = "android"))]
#[test]
fn i7_g11_daemon_composition_delegates_magisk_host_and_shared_recovery() {
    let source_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let process = std::fs::read_to_string(source_root.join("process.rs")).unwrap();
    let host = std::fs::read_to_string(source_root.join("magisk_host.rs")).unwrap();
    let recovery = std::fs::read_to_string(source_root.join("magisk_guard_recovery.rs")).unwrap();

    assert!(!process.contains("struct MagiskHost"));
    assert!(!process.contains("finalize_clean_guard_records"));
    assert!(host.contains("struct MagiskHost"));
    assert!(host.contains("execute_guard_recovery"));
    assert!(recovery.contains("GuardRecoveryPlan"));
    assert!(!host.contains("MagiskRecoveryPlan"));
    assert!(!host.contains("prior_runtime_instance_ids"));
    assert!(!recovery.contains("prior_runtime_instance_ids"));
}

#[test]
fn daemon_version_code_is_the_product_version_code() {
    // The module readiness check requires module.prop's versionCode, which the build stamps from
    // gradle.properties, to equal the daemon's own; a daemon built with another value never
    // becomes ready.
    let properties = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../gradle.properties"),
    )
    .unwrap();
    let product = properties
        .lines()
        .find_map(|line| line.strip_prefix("droidbridgeVersionCode="))
        .unwrap()
        .trim()
        .parse::<u64>()
        .unwrap();
    assert_eq!(daemon::VERSION_CODE, product);
}
