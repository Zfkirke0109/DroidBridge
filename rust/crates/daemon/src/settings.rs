//! The root edition's MCP listener and ChatGPT tunnel settings. The daemon is their only writer;
//! the frontend reads and changes them through the frontend link. Both files live in the daemon's
//! root-only state directory, so the tunnel API key is stored in plain form only where no App can
//! read it.

use base64::Engine as _;
use contract::ErrorCode;
use domain::DomainError;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

const MCP_FILE: &str = "mcp.json";
const TUNNEL_FILE: &str = "tunnel.json";
const SCHEMA_VERSION: u32 = 1;
const TOKEN_BYTES: usize = 32;
const MAX_API_KEY_BYTES: usize = 512;
const MAX_SETTINGS_BYTES: u64 = 4_096;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct McpSettings {
    schema_version: u32,
    pub(crate) enabled: bool,
    pub(crate) token: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TunnelSettings {
    schema_version: u32,
    pub(crate) enabled: bool,
    pub(crate) tunnel_id: String,
    pub(crate) api_key: String,
    /// When ChatGPT first called through this tunnel; kept so first setup stays finished across
    /// restarts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) first_call_epoch_ms: Option<i64>,
}

impl TunnelSettings {
    pub(crate) fn new(tunnel_id: String, api_key: String, enabled: bool) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            enabled,
            tunnel_id,
            api_key,
            first_call_epoch_ms: None,
        }
    }

    fn valid(&self) -> bool {
        self.schema_version == SCHEMA_VERSION
            && valid_tunnel_id(&self.tunnel_id)
            && valid_api_key(&self.api_key)
            && self.first_call_epoch_ms.is_none_or(|value| value > 0)
    }
}

pub(crate) struct SettingsStore {
    base: PathBuf,
}

impl SettingsStore {
    pub(crate) fn new(base: PathBuf) -> Self {
        Self { base }
    }

    /// The committed MCP settings; a first read commits MCP disabled with a fresh token.
    pub(crate) fn mcp(&self) -> Result<McpSettings, DomainError> {
        match read_settings::<McpSettings>(&self.base.join(MCP_FILE))? {
            Some(settings)
                if settings.schema_version == SCHEMA_VERSION && valid_token(&settings.token) =>
            {
                Ok(settings)
            }
            Some(_) => Err(DomainError::new(
                ErrorCode::IoError,
                "MCP settings are invalid",
            )),
            None => {
                let settings = McpSettings {
                    schema_version: SCHEMA_VERSION,
                    enabled: false,
                    token: new_token()?,
                };
                self.commit_mcp(&settings)?;
                Ok(settings)
            }
        }
    }

    pub(crate) fn commit_mcp(&self, settings: &McpSettings) -> Result<(), DomainError> {
        write_settings(&self.base, MCP_FILE, settings)
    }

    /// The committed tunnel settings, or none while no tunnel is configured.
    pub(crate) fn tunnel(&self) -> Result<Option<TunnelSettings>, DomainError> {
        match read_settings::<TunnelSettings>(&self.base.join(TUNNEL_FILE))? {
            Some(settings) if settings.valid() => Ok(Some(settings)),
            Some(_) => Err(DomainError::new(
                ErrorCode::IoError,
                "tunnel settings are invalid",
            )),
            None => Ok(None),
        }
    }

    pub(crate) fn commit_tunnel(&self, settings: &TunnelSettings) -> Result<(), DomainError> {
        write_settings(&self.base, TUNNEL_FILE, settings)
    }

    pub(crate) fn clear_tunnel(&self) -> Result<(), DomainError> {
        match fs::remove_file(self.base.join(TUNNEL_FILE)) {
            Ok(()) => sync_directory(&self.base),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(DomainError::os(
                ErrorCode::IoError,
                "cannot remove tunnel settings",
                &error,
            )),
        }
    }
}

pub(crate) fn new_token() -> Result<String, DomainError> {
    let mut bytes = [0_u8; TOKEN_BYTES];
    fs::File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut bytes))
        .map_err(|error| DomainError::os(ErrorCode::IoError, "cannot read random bytes", &error))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

fn valid_token(value: &str) -> bool {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(value)
        .is_ok_and(|bytes| bytes.len() == TOKEN_BYTES)
}

/// `tunnel_` followed by 32 lowercase ASCII letters or digits.
pub(crate) fn valid_tunnel_id(value: &str) -> bool {
    value.strip_prefix("tunnel_").is_some_and(|rest| {
        rest.len() == 32
            && rest
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    })
}

pub(crate) fn valid_api_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_API_KEY_BYTES
        && value.bytes().all(|byte| byte.is_ascii_graphic())
}

fn read_settings<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, DomainError> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(DomainError::os(
                ErrorCode::IoError,
                "cannot open settings",
                &error,
            ));
        }
    };
    let mode = file
        .metadata()
        .map_err(|error| DomainError::os(ErrorCode::IoError, "cannot inspect settings", &error))?
        .permissions()
        .mode();
    if mode & 0o077 != 0 {
        return Err(DomainError::new(
            ErrorCode::IoError,
            "settings are readable by others",
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_SETTINGS_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| DomainError::os(ErrorCode::IoError, "cannot read settings", &error))?;
    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return Err(DomainError::new(
            ErrorCode::IoError,
            "settings exceed their bound",
        ));
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| DomainError::new(ErrorCode::IoError, "settings are not valid JSON"))
}

fn write_settings<T: Serialize>(base: &Path, name: &str, value: &T) -> Result<(), DomainError> {
    let body = serde_json::to_vec(value)
        .map_err(|_| DomainError::new(ErrorCode::InternalError, "settings encoding failed"))?;
    let temporary = base.join(format!(".{name}.tmp"));
    let written = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)
        .and_then(|mut file| {
            file.write_all(&body)?;
            file.sync_all()
        })
        .and_then(|()| fs::rename(&temporary, base.join(name)));
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(DomainError::os(
            ErrorCode::IoError,
            "cannot commit settings",
            &error,
        ));
    }
    sync_directory(base)
}

fn sync_directory(path: &Path) -> Result<(), DomainError> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            DomainError::os(ErrorCode::IoError, "cannot sync settings directory", &error)
        })
}

#[cfg(test)]
mod tests {
    use super::{SettingsStore, TunnelSettings, valid_api_key, valid_tunnel_id};
    use std::fs;

    fn store(label: &str) -> (SettingsStore, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "droidbridge-settings-{label}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        (SettingsStore::new(base.clone()), base)
    }

    #[test]
    fn a_first_read_commits_disabled_mcp_with_a_stable_token() {
        let (store, base) = store("mcp");
        let first = store.mcp().unwrap();
        assert!(!first.enabled);
        assert_eq!(first.token.len(), 43);
        assert_eq!(store.mcp().unwrap(), first);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn tunnel_settings_round_trip_and_clear() {
        let (store, base) = store("tunnel");
        assert_eq!(store.tunnel().unwrap(), None);
        let settings = TunnelSettings::new(
            format!("tunnel_{}", "a1".repeat(16)),
            "sk-test".to_owned(),
            true,
        );
        store.commit_tunnel(&settings).unwrap();
        assert_eq!(store.tunnel().unwrap(), Some(settings));
        store.clear_tunnel().unwrap();
        assert_eq!(store.tunnel().unwrap(), None);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn identifiers_and_keys_are_bounded() {
        assert!(valid_tunnel_id(&format!("tunnel_{}", "0".repeat(32))));
        assert!(!valid_tunnel_id(&format!("tunnel_{}", "A".repeat(32))));
        assert!(!valid_tunnel_id("tunnel_short"));
        assert!(valid_api_key("sk-abc"));
        assert!(!valid_api_key("has space"));
        assert!(!valid_api_key(&"k".repeat(513)));
    }
}
