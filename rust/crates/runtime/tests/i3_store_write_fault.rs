//! A canonical commit that cannot be written withdraws readiness instead of leaving the Runtime
//! reporting `ready` while every request fails (issue #2).

use contract::{
    Availability, CapabilityState, ErrorCode, GrantFacts, RunAs, RuntimeHost, RuntimeReadiness,
    UuidV4,
};
use domain::{
    AdmissionFence, CapabilityContext, DomainError, ExecutorRequest, ProviderGenerations,
    ResolverFacts,
};
use runtime::{
    CapabilityPort, CapabilitySnapshot, ExecutionPayload, PersistencePort, RecoveryProof,
    RuntimeCore, RuntimeState, SynchronousAdmission,
    fakes::{FakeArtifacts, FakeCapabilities, FakeExecutions, FakeHostControl},
};

fn uuid(value: u64) -> UuidV4 {
    UuidV4::parse(format!("00000000-0000-4000-8000-{value:012x}")).unwrap()
}

fn available() -> Availability {
    Availability {
        state: CapabilityState::Available,
        reason: None,
    }
}

fn ready() -> CapabilitySnapshot {
    let state = CapabilityState::Available;
    CapabilitySnapshot {
        grants: GrantFacts {
            android_local_network: available(),
            android_notifications: available(),
            android_notification_listener: available(),
            automation_exact_alarm: available(),
            visual_accessibility: available(),
            visual_media_projection_session: available(),
            shizuku_shell: available(),
            magisk_module: available(),
            magisk_root: available(),
            magisk_framework: available(),
            magisk_launch: available(),
            magisk_clipboard: available(),
            magisk_notifications: available(),
            magisk_wake_alarm: available(),
            execution_app_guard: available(),
            execution_shell_guard: available(),
            execution_root_guard: available(),
        },
        context: CapabilityContext {
            sdk_int: 37,
            host: RuntimeHost::ApkRuntime,
            readiness: RuntimeReadiness::Ready,
            app_execution_surface: state,
        },
        resolver_facts: ResolverFacts {
            app_native: state,
            app_framework: state,
            shizuku: state,
            magisk_native: state,
            magisk_framework: state,
            magisk_launch: state,
            magisk_clipboard: state,
            magisk_notifications: state,
            accessibility: state,
            media_projection: state,
            notification_listener: state,
            generations: ProviderGenerations {
                app_native: 1,
                app_framework: 1,
                shizuku: 1,
                magisk_native: 1,
                magisk_framework: 1,
                accessibility: 1,
                media_projection: 1,
                notification_listener: 1,
            },
        },
        fence: AdmissionFence {
            runtime_epoch: uuid(1),
            host_generation: 1,
            runtime_instance_id: uuid(2),
        },
    }
}

/// A store that reads but can no longer be written.
#[derive(Clone)]
struct UnwritableStore;

impl PersistencePort for UnwritableStore {
    fn load(&self) -> Result<RuntimeState, DomainError> {
        Ok(RuntimeState::default())
    }

    fn compare_and_commit(&self, _: u64, _: RuntimeState) -> Result<(), DomainError> {
        Err(DomainError::new(
            ErrorCode::IoError,
            "canonical write failed",
        ))
    }
}

#[tokio::test]
async fn i3_an_unwritable_store_withdraws_readiness_and_reports_the_fault() {
    let capabilities = FakeCapabilities::new(ready());
    let host = FakeHostControl::new(RecoveryProof::Clean).with_capabilities(capabilities.clone());
    let core = RuntimeCore::new(
        UnwritableStore,
        FakeArtifacts::default(),
        FakeExecutions::default(),
        capabilities.clone(),
        host.clone(),
    );
    let failed = core
        .run_synchronous(
            SynchronousAdmission {
                request_id: uuid(10),
                payload_sha256: "10".repeat(32),
                execution_id: uuid(11),
                operation: "command.run".to_owned(),
                route: ExecutorRequest::Command(RunAs::App),
                payload: ExecutionPayload::OpaqueOperation("command.run".to_owned()),
                settlement_bound_bytes: runtime::RESERVE_FLOOR_BYTES,
                now_ms: 1_788_825_600_000,
            },
            "2026-09-08T00:00:01.000Z".to_owned(),
            1_788_825_601_000,
        )
        .await
        .unwrap_err();
    assert_eq!(failed.code, ErrorCode::IoError);
    assert_eq!(host.store_write_failures().len(), 1);
    assert_eq!(
        capabilities.current().unwrap().context.readiness,
        RuntimeReadiness::Unavailable
    );
}
