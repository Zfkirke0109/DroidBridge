#![deny(unsafe_op_in_unsafe_fn)]

use contract::{CapabilityState, ErrorCode, UuidV4};
use domain::DomainError;
use serde::{Deserialize, Serialize};

#[cfg(unix)]
mod android;
#[cfg(unix)]
mod visual;

pub const PROTOCOL_VERSION: u32 = 1;

/// The product versionCode this daemon was built as, `major * 1_000_000 + minor * 1_000 + patch`
/// of the crate version. The build requires that version to equal the one `gradle.properties`
/// stamps into the APK and `module.prop`, so the three can only disagree across builds.
pub const VERSION_CODE: u64 = parse_version_part(env!("CARGO_PKG_VERSION_MAJOR")) * 1_000_000
    + parse_version_part(env!("CARGO_PKG_VERSION_MINOR")) * 1_000
    + parse_version_part(env!("CARGO_PKG_VERSION_PATCH"));

const fn parse_version_part(part: &str) -> u64 {
    let bytes = part.as_bytes();
    assert!(!bytes.is_empty(), "version part is empty");
    let mut value = 0_u64;
    let mut index = 0;
    while index < bytes.len() {
        assert!(
            bytes[index].is_ascii_digit(),
            "version part is not a number"
        );
        value = value * 10 + (bytes[index] - b'0') as u64;
        index += 1;
    }
    value
}

/// The three independently probed helper families of S-MAGISK-005.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HelperFamily {
    Launch,
    Clipboard,
    Notifications,
}

impl HelperFamily {
    pub const ALL: [Self; 3] = [Self::Launch, Self::Clipboard, Self::Notifications];

    pub const fn key(self) -> &'static str {
        match self {
            Self::Launch => "magisk.launch",
            Self::Clipboard => "magisk.clipboard",
            Self::Notifications => "magisk.notifications",
        }
    }

    const fn probe_failure(self) -> &'static str {
        match self {
            Self::Launch => "LAUNCH_PROBE_FAILED",
            Self::Clipboard => "CLIPBOARD_PROBE_FAILED",
            Self::Notifications => "NOTIFICATION_PROBE_FAILED",
        }
    }

    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) const fn index(self) -> usize {
        match self {
            Self::Launch => 0,
            Self::Clipboard => 1,
            Self::Notifications => 2,
        }
    }
}

/// The families' probe facts after one refresh of a live helper. A denied operation is that
/// operation's own answer: the family's probe, run again at once, alone decides whether the
/// family is lost. A failed family is probed again when `retry_failed`, so it recovers while the
/// helper lives.
pub fn reprobe_families(
    current: [bool; 3],
    denied: impl Fn(HelperFamily) -> bool,
    retry_failed: bool,
    mut probe: impl FnMut(HelperFamily) -> bool,
) -> [bool; 3] {
    HelperFamily::ALL.map(|family| {
        let succeeded = current[family.index()];
        if denied(family) || (retry_failed && !succeeded) {
            probe(family)
        } else {
            succeeded
        }
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HelperFamilyFact {
    pub family: HelperFamily,
    pub state: CapabilityState,
    pub reason: Option<&'static str>,
}

/// Projects each family from its own probe fact only; a failed family never changes a sibling.
/// Helper loss alone withdraws every family.
pub fn helper_family_facts(
    helper_ready: bool,
    probe_succeeded: impl Fn(HelperFamily) -> bool,
) -> [HelperFamilyFact; 3] {
    HelperFamily::ALL.map(|family| {
        let reason = if !helper_ready {
            Some("HELPER_UNAVAILABLE")
        } else if !probe_succeeded(family) {
            Some(family.probe_failure())
        } else {
            None
        };
        HelperFamilyFact {
            family,
            state: if reason.is_none() {
                CapabilityState::Available
            } else {
                CapabilityState::Unavailable
            },
            reason,
        }
    })
}
/// The bound on one IPC frame; a frontend reply carries at most one bounded public result.
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
pub const PACKAGE_PRIMITIVE_TIMEOUT_MS: u64 = 15_000;
pub const PACKAGE_PRIMITIVE_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum MagiskPrimitiveFamily {
    Process,
    Filesystem,
    NetworkCapture,
    NetworkInjection,
    VisualCapture,
    Input,
    Package,
    PrivilegedAndroid,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MagiskExecutorFence {
    pub runtime_epoch: UuidV4,
    pub host_generation: u64,
    pub runtime_instance_id: UuidV4,
    pub source_generation: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MagiskExecutorHandle {
    fence: MagiskExecutorFence,
    helper_generation: Option<u64>,
}

impl MagiskExecutorHandle {
    pub fn new(
        fence: MagiskExecutorFence,
        helper_generation: Option<u64>,
    ) -> Result<Self, DomainError> {
        if fence.host_generation == 0
            || fence.source_generation == 0
            || helper_generation == Some(0)
        {
            return Err(DomainError::invalid(
                "invalid Magisk executor generation fence",
            ));
        }
        Ok(Self {
            fence,
            helper_generation,
        })
    }

    pub fn authorize(
        &self,
        expected: &MagiskExecutorFence,
        family: MagiskPrimitiveFamily,
    ) -> Result<(), DomainError> {
        if &self.fence != expected {
            return Err(DomainError::new(
                ErrorCode::StaleAuthority,
                "Magisk primitive fence is stale",
            ));
        }
        if family == MagiskPrimitiveFamily::PrivilegedAndroid && self.helper_generation.is_none() {
            return Err(DomainError::new(
                ErrorCode::CapabilityUnavailable,
                "Magisk framework helper is unavailable",
            ));
        }
        Ok(())
    }

    pub fn without_helper(&self) -> Self {
        Self {
            fence: self.fence.clone(),
            helper_generation: None,
        }
    }

    pub fn fence(&self) -> &MagiskExecutorFence {
        &self.fence
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PackageListKind {
    ThirdParty,
    System,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrimitiveProcessPlan {
    program: &'static str,
    arguments: Vec<String>,
    family: MagiskPrimitiveFamily,
    fixed_timeout_ms: Option<u64>,
    fixed_output_bytes: Option<usize>,
}

impl PrimitiveProcessPlan {
    pub fn root_shell(command: String) -> Result<Self, DomainError> {
        if command.is_empty() || command.contains('\0') {
            return Err(DomainError::invalid("invalid root command"));
        }
        Ok(Self {
            program: "/system/bin/sh",
            arguments: vec!["-c".to_owned(), command],
            family: MagiskPrimitiveFamily::Process,
            fixed_timeout_ms: None,
            fixed_output_bytes: None,
        })
    }

    pub fn screen_capture() -> Self {
        Self {
            program: "/system/bin/screencap",
            arguments: Vec::new(),
            family: MagiskPrimitiveFamily::VisualCapture,
            fixed_timeout_ms: None,
            fixed_output_bytes: None,
        }
    }

    pub fn input(arguments: Vec<String>) -> Result<Self, DomainError> {
        if arguments.is_empty()
            || arguments.len() > 16
            || arguments
                .iter()
                .any(|value| value.is_empty() || value.len() > 4_096 || value.contains('\0'))
        {
            return Err(DomainError::invalid("invalid input primitive arguments"));
        }
        Ok(Self {
            program: "/system/bin/input",
            arguments,
            family: MagiskPrimitiveFamily::Input,
            fixed_timeout_ms: None,
            fixed_output_bytes: None,
        })
    }

    pub fn package_list(kind: PackageListKind) -> Self {
        let selector = match kind {
            PackageListKind::ThirdParty => "-3",
            PackageListKind::System => "-s",
        };
        Self {
            program: "/system/bin/cmd",
            arguments: [
                "package",
                "list",
                "packages",
                selector,
                "--show-versioncode",
                "--user",
                "0",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            family: MagiskPrimitiveFamily::Package,
            fixed_timeout_ms: Some(PACKAGE_PRIMITIVE_TIMEOUT_MS),
            fixed_output_bytes: Some(PACKAGE_PRIMITIVE_OUTPUT_BYTES),
        }
    }

    pub fn package_force_stop(package_name: String) -> Result<Self, DomainError> {
        if !valid_package_name(&package_name) {
            return Err(DomainError::invalid("invalid package name"));
        }
        Ok(Self {
            program: "/system/bin/am",
            arguments: vec![
                "force-stop".to_owned(),
                "--user".to_owned(),
                "0".to_owned(),
                package_name,
            ],
            family: MagiskPrimitiveFamily::Package,
            fixed_timeout_ms: Some(PACKAGE_PRIMITIVE_TIMEOUT_MS),
            fixed_output_bytes: Some(PACKAGE_PRIMITIVE_OUTPUT_BYTES),
        })
    }

    pub const fn program(&self) -> &'static str {
        self.program
    }

    pub fn arguments(&self) -> &[String] {
        &self.arguments
    }

    pub const fn family(&self) -> MagiskPrimitiveFamily {
        self.family
    }

    pub const fn fixed_timeout_ms(&self) -> Option<u64> {
        self.fixed_timeout_ms
    }

    pub const fn fixed_output_bytes(&self) -> Option<usize> {
        self.fixed_output_bytes
    }
}

fn valid_package_name(value: &str) -> bool {
    if value.is_empty() || value.len() > 255 || !value.contains('.') {
        return false;
    }
    value.split('.').all(|segment| {
        let mut characters = segment.chars();
        characters
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
            && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
    })
}

/// The fixed identity of one module build: its Magisk module id, the frontend package it installs
/// and the abstract socket that frontend serves.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ModuleIdentity {
    pub module_id: &'static str,
    pub frontend_package: &'static str,
    pub socket_name: &'static str,
}

impl ModuleIdentity {
    pub const fn stable() -> Self {
        Self {
            module_id: "droidbridge",
            frontend_package: "com.droidbridge.root",
            socket_name: "droidbridge.com.droidbridge.root.u0.v1",
        }
    }

    pub const fn debug() -> Self {
        Self {
            module_id: "droidbridge_debug",
            frontend_package: "com.droidbridge.root.debug",
            socket_name: "droidbridge.com.droidbridge.root.debug.u0.v1",
        }
    }

    /// The daemon's own root-only state, apart from the module directory an update replaces.
    pub fn state_base(&self) -> std::path::PathBuf {
        std::path::Path::new("/data/adb/droidbridge").join(self.module_id)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModuleObservation {
    pub stable_present: bool,
    pub debug_present: bool,
    pub enabled: bool,
    pub module_version_code: u64,
    pub daemon_version_code: u64,
}

impl ModuleObservation {
    pub fn readiness(
        &self,
        identity: &ModuleIdentity,
        expected_version_code: u64,
    ) -> Result<(), DomainError> {
        if self.stable_present && self.debug_present {
            return Err(DomainError::new(
                ErrorCode::CapabilityUnavailable,
                "stable and debug modules conflict",
            ));
        }
        let present = if identity.module_id == ModuleIdentity::stable().module_id {
            self.stable_present
        } else {
            self.debug_present
        };
        if !present || !self.enabled {
            return Err(DomainError::new(
                ErrorCode::CapabilityUnavailable,
                "Magisk backend is not ready",
            ));
        }
        if self.module_version_code != expected_version_code
            || self.daemon_version_code != expected_version_code
        {
            return Err(DomainError::new(
                ErrorCode::ProtocolIncompatible,
                "Magisk backend version is incompatible",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SourceGeneration(u64);

impl SourceGeneration {
    pub const fn initial() -> Self {
        Self(1)
    }

    pub const fn current(self) -> u64 {
        self.0
    }

    pub fn advance(&mut self) -> Result<u64, DomainError> {
        self.0 = self.0.checked_add(1).ok_or_else(|| {
            DomainError::new(ErrorCode::ResourceLimit, "capability generation exhausted")
        })?;
        Ok(self.0)
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct WakeAlarmProbe {
    pub created: bool,
    pub clock_read: bool,
    pub armed: bool,
    pub disarmed: bool,
}

impl WakeAlarmProbe {
    pub const fn available(self) -> bool {
        self.created && self.clock_read && self.armed && self.disarmed
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HelperHello {
    pub protocol_version: u32,
    pub sdk_int: u32,
    pub helper_generation: u64,
}

/// The module's framework helper jar for this device's API level.
pub fn framework_jar(module_root: &std::path::Path, sdk_int: u32) -> std::path::PathBuf {
    module_root
        .join("framework")
        .join(format!("droidbridge-framework-api{sdk_int}.jar"))
}

pub struct HelperRegistry {
    sdk_int: u32,
    expected_generation: u64,
    generation: Option<u64>,
}

impl HelperRegistry {
    pub fn new(sdk_int: u32, expected_generation: u64) -> Result<Self, DomainError> {
        if !(33..=37).contains(&sdk_int) {
            return Err(DomainError::new(
                ErrorCode::CapabilityUnavailable,
                "device SDK has no fixed framework helper",
            ));
        }
        if expected_generation == 0 {
            return Err(DomainError::invalid("invalid framework helper generation"));
        }
        Ok(Self {
            sdk_int,
            expected_generation,
            generation: None,
        })
    }

    pub fn jar(&self, module_root: &std::path::Path) -> std::path::PathBuf {
        framework_jar(module_root, self.sdk_int)
    }

    pub fn accept_hello(&mut self, peer_uid: u32, hello: HelperHello) -> Result<(), DomainError> {
        if peer_uid != 0
            || hello.protocol_version != PROTOCOL_VERSION
            || hello.sdk_int != self.sdk_int
            || hello.helper_generation != self.expected_generation
        {
            return Err(DomainError::new(
                ErrorCode::PermissionDenied,
                "framework helper authentication failed",
            ));
        }
        self.generation = Some(hello.helper_generation);
        Ok(())
    }

    pub const fn framework_state(&self) -> CapabilityState {
        if self.generation.is_some() {
            CapabilityState::Available
        } else {
            CapabilityState::Unavailable
        }
    }

    pub fn disconnected(&mut self) {
        self.generation = None;
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutionGuardState {
    Clean,
    Running,
    CleanupUnverified,
}

pub mod network;

#[cfg(unix)]
pub mod unix_transport;

#[cfg(unix)]
pub mod frontend;

#[cfg(unix)]
mod settings;

#[cfg(unix)]
mod content;

#[cfg(unix)]
mod command;

#[cfg(unix)]
mod magisk_guard_recovery;

#[cfg(unix)]
mod magisk_host;

#[cfg(unix)]
mod recycle;

#[cfg(unix)]
mod ingress;

#[cfg(unix)]
mod automation_wake;

#[cfg(unix)]
pub mod process;

impl ExecutionGuardState {
    pub fn observe_guard_death(&mut self) {
        if *self == Self::Running {
            *self = Self::CleanupUnverified;
        }
    }

    pub fn observe_reboot(&mut self) {
        *self = Self::Clean;
    }

    pub const fn blocks_admission(self) -> bool {
        matches!(self, Self::CleanupUnverified)
    }
}
