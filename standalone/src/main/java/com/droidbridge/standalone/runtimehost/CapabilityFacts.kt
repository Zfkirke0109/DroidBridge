package com.droidbridge.standalone.runtimehost

internal data class CapabilityFact(
    val key: String,
    val state: String,
    val reason: String?,
    val sourceGeneration: Long,
    val hasExecutor: Boolean,
)

internal class CapabilityFacts {
    private val values = mutableMapOf<String, CapabilityFact>()

    @Synchronized
    fun register(
        key: String,
        state: String,
        reason: String,
        sourceGeneration: Long,
        hasExecutor: Boolean,
    ): Boolean {
        require(key in APP_CAPABILITY_KEYS)
        require(state in CAPABILITY_STATES)
        require(sourceGeneration > 0)
        require(state == "available" || !hasExecutor)
        require(if (state == "available") reason.isEmpty() else reason.isNotEmpty())
        val candidate = CapabilityFact(
            key = key,
            state = state,
            reason = reason.takeUnless(String::isEmpty),
            sourceGeneration = sourceGeneration,
            hasExecutor = hasExecutor,
        )
        val current = values[key]
        if (current != null && sourceGeneration < current.sourceGeneration) return false
        if (current != null && sourceGeneration == current.sourceGeneration) {
            return current == candidate
        }
        values[key] = candidate
        return true
    }

    /**
     * Facts to replay into a Runtime that started after they were recorded. The App guard is
     * excluded because each executor instance proves its own guard (S-EXEC-001).
     */
    @Synchronized
    fun replay(): List<CapabilityFact> =
        values.toSortedMap().values.filter { it.key != APP_GUARD_KEY }

    private companion object {
        const val APP_GUARD_KEY = "execution.app_guard"
        val CAPABILITY_STATES = setOf("available", "unavailable", "unknown")
        val APP_CAPABILITY_KEYS = setOf(
            "android.local_network",
            "android.notifications",
            "android.notification_listener",
            "automation.exact_alarm",
            "visual.accessibility",
            "visual.media_projection_session",
            "shizuku.shell",
            "execution.app_guard",
            "execution.shell_guard",
        )
    }
}
