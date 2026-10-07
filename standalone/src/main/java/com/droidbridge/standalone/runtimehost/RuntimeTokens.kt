package com.droidbridge.standalone.runtimehost

/** The Contract error codes; a failure this process reports carries one of them. */
internal enum class ErrorToken(val wire: String) {
    InvalidArgument("INVALID_ARGUMENT"),
    NotFound("NOT_FOUND"),
    AlreadyExists("ALREADY_EXISTS"),
    PermissionDenied("PERMISSION_DENIED"),
    CapabilityUnavailable("CAPABILITY_UNAVAILABLE"),
    Unsupported("UNSUPPORTED"),
    StaleAuthority("STALE_AUTHORITY"),
    StaleReference("STALE_REFERENCE"),
    RevisionConflict("REVISION_CONFLICT"),
    Timeout("TIMEOUT"),
    Cancelled("CANCELLED"),
    IoError("IO_ERROR"),
    ProtocolIncompatible("PROTOCOL_INCOMPATIBLE"),
    ResourceLimit("RESOURCE_LIMIT"),
    InternalError("INTERNAL_ERROR"),
    NotEmpty("NOT_EMPTY"),
    ArchiveCorrupt("ARCHIVE_CORRUPT"),
    ArchiveEncrypted("ARCHIVE_ENCRYPTED"),
    RunAsUnavailable("RUN_AS_UNAVAILABLE"),
    ExecutionFailed("EXECUTION_FAILED"),
    CancelFailed("CANCEL_FAILED"),
    CaptureFailed("CAPTURE_FAILED"),
    HostTransitionPending("HOST_TRANSITION_PENDING"),
}

private val UUID_V4 = Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")

internal fun isUuid(value: String): Boolean = UUID_V4.matches(value)
