package com.droidbridge.standalone.execution.android

import android.os.ParcelFileDescriptor

/** [reason] and [osError] are the native step and system error behind [code], when it reported them. */
internal open class AndroidExecutionException(
    val code: String,
    val reason: String? = null,
    val osError: Int? = null,
) : IllegalStateException(code)

enum class AndroidPrimitive {
    AppPathFsPrimitive,
    AppProcessStart,
    AppProcessCancel,
    ContentInspect,
    ContentOpenRead,
    PackageInspect,
    LaunchActivity,
    IntentStart,
    ClipboardRead,
    ClipboardWrite,
    ClipboardClear,
    NotificationSnapshot,
    NotificationDismiss,
    NotificationAction,
    AccessibilityObserve,
    VisualDisplaySnapshot,
    AccessibilityNodeAction,
    AccessibilityGesture,
    AccessibilityText,
    MediaProjectionCapture,
    VisualImageTransform,
    AndroidNetworkSnapshot,
    NetworkDefaultSubscribe,
    NetworkDefaultUnsubscribe,
    AlarmSchedule,
    AlarmCancel,
    ForegroundServiceSet,
    ShizukuBind,
    ShizukuProcessStart,
    ShizukuProcessCancel,
    ShizukuFsPrimitive,
    ShizukuPackagePrimitive,
}

data class AndroidExecutionRequest(
    val primitive: AndroidPrimitive,
    val payload: ByteArray,
    val executionId: String,
    val runtimeEpoch: String,
    val hostGeneration: Long,
    val runtimeInstanceId: String,
    val descriptors: List<RoleDescriptor> = emptyList(),
)

data class RoleDescriptor(
    val role: String,
    val descriptor: ParcelFileDescriptor,
)

data class AndroidExecutionResult(
    val payload: ByteArray,
    val descriptors: List<RoleDescriptor> = emptyList(),
    val errorCode: String? = null,
    val errorReason: String? = null,
    val errorOsError: Int? = null,
) {
    init {
        require(descriptors.size <= 4)
        require(errorCode == null || descriptors.isEmpty())
    }
}

fun interface AndroidExecutionBridge {
    suspend fun execute(request: AndroidExecutionRequest): AndroidExecutionResult
}
