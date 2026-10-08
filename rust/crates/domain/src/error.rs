use contract::ErrorCode;
use std::fmt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DomainError {
    pub code: ErrorCode,
    pub reason: &'static str,
    /// The operating-system error number behind this failure, when one was observed.
    pub os_error: Option<i32>,
    /// The step the peer that reported this failure names, when the failure crossed a process.
    pub peer_reason: Option<String>,
}

impl DomainError {
    pub const fn new(code: ErrorCode, reason: &'static str) -> Self {
        Self {
            code,
            reason,
            os_error: None,
            peer_reason: None,
        }
    }

    pub const fn invalid(reason: &'static str) -> Self {
        Self::new(ErrorCode::InvalidArgument, reason)
    }

    /// An operating-system failure met at the step [reason] names. Exhausted descriptors,
    /// memory or storage are a resource limit at whatever step they surface.
    pub fn os(code: ErrorCode, reason: &'static str, error: &std::io::Error) -> Self {
        let os_error = error.raw_os_error();
        Self {
            code: if cfg!(any(target_os = "linux", target_os = "android"))
                && os_error.is_some_and(linux_resource_exhausted)
            {
                ErrorCode::ResourceLimit
            } else {
                code
            },
            reason,
            os_error,
            peer_reason: None,
        }
    }
}

/// ENOMEM, ENFILE, EMFILE, ENOSPC and EDQUOT, by Linux number; another platform's errno
/// is never read through them.
const fn linux_resource_exhausted(errno: i32) -> bool {
    matches!(errno, 12 | 23 | 24 | 28 | 122)
}

impl fmt::Display for DomainError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.reason)
    }
}

impl std::error::Error for DomainError {}

#[cfg(test)]
mod tests {
    use super::DomainError;
    use contract::ErrorCode;

    #[test]
    fn os_failures_keep_their_step_and_errno() {
        let error = DomainError::os(
            ErrorCode::ExecutionFailed,
            "cannot launch",
            &std::io::Error::from_raw_os_error(2),
        );
        assert_eq!(error.code, ErrorCode::ExecutionFailed);
        assert_eq!(error.reason, "cannot launch");
        assert_eq!(error.os_error, Some(2));
        let synthetic = DomainError::os(ErrorCode::IoError, "x", &std::io::Error::other("x"));
        assert_eq!(synthetic, DomainError::new(ErrorCode::IoError, "x"));
    }

    #[test]
    #[cfg(any(target_os = "linux", target_os = "android"))]
    fn exhausted_descriptors_or_storage_are_a_resource_limit() {
        for errno in [12, 23, 24, 28, 122] {
            let error = DomainError::os(
                ErrorCode::IoError,
                "x",
                &std::io::Error::from_raw_os_error(errno),
            );
            assert_eq!(error.code, ErrorCode::ResourceLimit);
            assert_eq!(error.os_error, Some(errno));
        }
    }
}
