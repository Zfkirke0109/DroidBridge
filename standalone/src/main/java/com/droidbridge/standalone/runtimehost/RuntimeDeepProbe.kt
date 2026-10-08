package com.droidbridge.standalone.runtimehost

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** A health result describes the APK host itself, never an individual capability or tool. */
internal enum class NativeHostHealth(val wire: String, val failureCode: String) {
    Healthy("healthy", ""),
    HostMissing("host_missing", ErrorToken.CapabilityUnavailable.wire),
    FenceMismatch("fence_mismatch", ErrorToken.StaleAuthority.wire),
    LeaseStale("lease_stale", ErrorToken.StaleAuthority.wire),
    NotReady("not_ready", ErrorToken.CapabilityUnavailable.wire),
    StoreUnreadable("store_unreadable", ErrorToken.IoError.wire),
    StoreUnwritable("store_unwritable", ErrorToken.IoError.wire),
    BridgeFault("bridge_fault", ErrorToken.IoError.wire),
    ExecutorMissing("executor_missing", ErrorToken.CapabilityUnavailable.wire),
    ProbeFailed("probe_failed", ErrorToken.InternalError.wire),
    ;

    companion object {
        fun decode(value: String?): NativeHostHealth = entries.firstOrNull { it.wire == value } ?: ProbeFailed
    }
}

/** Claims one bounded deep probe before running it, so concurrent failures cannot stampede JNI. */
internal class RuntimeDeepProbeBudget {
    private var last: Pair<RuntimeFence, Long>? = null

    @Synchronized
    fun claim(fence: RuntimeFence, nowMillis: Long): Boolean {
        val previous = last
        if (previous?.first == fence && nowMillis >= previous.second && nowMillis - previous.second < 5_000L) {
            return false
        }
        last = fence to nowMillis
        return true
    }
}

/** An unreadable reply or an infrastructure error merits one bounded post-dispatch probe. */
internal fun suspiciousRuntimeReply(response: ByteArray): Boolean {
    val envelope = runCatching { Json.parseToJsonElement(response.decodeToString()) as? JsonObject }.getOrNull()
        ?: return true
    return when ((envelope["outcome"] as? JsonPrimitive)?.content) {
        "success" -> false
        "error" -> {
            val code = ((envelope["error"] as? JsonObject)?.get("code") as? JsonPrimitive)?.content
            code == null || code in setOf(
                ErrorToken.IoError.wire,
                ErrorToken.InternalError.wire,
                ErrorToken.ResourceLimit.wire,
            )
        }
        else -> true
    }
}
