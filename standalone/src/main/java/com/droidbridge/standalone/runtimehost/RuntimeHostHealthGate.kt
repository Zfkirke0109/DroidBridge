package com.droidbridge.standalone.runtimehost

import java.util.concurrent.atomic.AtomicReference
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal enum class HostHealthPhase(val wire: String) {
    Admission("admission"),
    Settlement("settlement"),
}

internal interface RuntimeHostHealthPort {
    fun recordFault(fence: RuntimeFence, health: NativeHostHealth, phase: HostHealthPhase): Boolean
    fun quarantine(fence: RuntimeFence): Boolean
    fun lifetimeReleased(): Boolean
}

/** Withdraws one exact failed instance before recording and releasing it. A successor waits for
 * the native lifetime lease, including in-flight work, to drain. */
internal class RuntimeHostHealthGate(
    private val sessions: AtomicReference<RuntimeSessionState>,
    private val monitor: Any,
    private val port: RuntimeHostHealthPort,
    private val nowMillis: () -> Long = { System.nanoTime() / 1_000_000 },
    private val onWithdrawn: (RuntimeFence) -> Unit,
) {
    private data class Withdrawal(
        val health: NativeHostHealth,
        val phase: HostHealthPhase,
        val hostGeneration: Long,
        val atMillis: Long,
        val faultRecorded: Boolean,
        val quarantineAccepted: Boolean,
    )

    private data class HealthSnapshot(
        val consecutiveWithdrawals: Int,
        val releasePending: Boolean,
        val withdrawalInProgress: Boolean,
        val breakerUntilMillis: Long,
        val lastWithdrawal: Withdrawal?,
    )

    private var releasePending = false
    private var withdrawalInProgress = false
    private var pendingInitialProbe: RuntimeFence? = null
    private var consecutiveWithdrawals = 0
    private var breakerUntilMillis = 0L
    private var lastWithdrawal: Withdrawal? = null
    private val publishedSnapshot = AtomicReference(HealthSnapshot(0, false, false, 0L, null))

    /** Called under [monitor] after a change to a diagnostic fact. */
    private fun publishSnapshot() {
        publishedSnapshot.set(HealthSnapshot(
            consecutiveWithdrawals,
            releasePending,
            withdrawalInProgress,
            breakerUntilMillis,
            lastWithdrawal,
        ))
    }

    fun requireDeepProbe(fence: RuntimeFence) = synchronized(monitor) { pendingInitialProbe = fence }

    /** A late inconclusive probe from a withdrawn host cannot clear its successor's proof. */
    fun requireDeepProbeIfCurrent(observed: RuntimeSessionState): Boolean = synchronized(monitor) {
        if (sessions.get() !== observed || !observed.started) return@synchronized false
        pendingInitialProbe = observed.activeFence
        true
    }

    fun initialProbePending(fence: RuntimeFence): Boolean = synchronized(monitor) { pendingInitialProbe == fence }

    fun markInitialProbeHealthy(fence: RuntimeFence) = synchronized(monitor) {
        if (pendingInitialProbe == fence) pendingInitialProbe = null
    }

    fun admissionCompleted(observed: RuntimeSessionState): Boolean = synchronized(monitor) {
        observed.started && sessions.get() === observed && pendingInitialProbe != observed.activeFence
    }

    fun mayEstablish(): Boolean = synchronized(monitor) {
        if (nowMillis() < breakerUntilMillis) return@synchronized false
        if (!releasePending) return@synchronized true
        if (!runCatching { port.lifetimeReleased() }.getOrDefault(false)) return@synchronized false
        releasePending = false
        publishSnapshot()
        true
    }

    fun establishmentRetryMillis(): Long? = synchronized(monitor) {
        val remaining = breakerUntilMillis - nowMillis()
        when {
            remaining > 0 -> remaining
            releasePending -> RELEASE_RETRY_MILLIS
            pendingInitialProbe != null -> PROBE_RETRY_MILLIS
            else -> null
        }
    }

    /** Only a successful business reply from this still-active instance resets failure streak. */
    fun businessResponseServed(observed: RuntimeSessionState) = synchronized(monitor) {
        if (observed.started && sessions.get() === observed) {
            consecutiveWithdrawals = 0
            publishSnapshot()
        }
    }

    /** Reset Runtime data is explicit recovery and may clear the cooldown. */
    fun clearBreaker() = synchronized(monitor) {
        consecutiveWithdrawals = 0
        breakerUntilMillis = 0L
        publishSnapshot()
    }

    /** Reads immutable, credential-free facts without waiting on a native call under [monitor]. */
    fun snapshot(): JsonObject {
        val state = publishedSnapshot.get()
        val now = nowMillis()
        return buildJsonObject {
            put("consecutive_withdrawals", state.consecutiveWithdrawals)
            put("release_pending", state.releasePending)
            put("withdrawal_in_progress", state.withdrawalInProgress)
            put("breaker_open", now < state.breakerUntilMillis)
            if (now < state.breakerUntilMillis) put("breaker_remaining_ms", state.breakerUntilMillis - now)
            state.lastWithdrawal?.let { last ->
                put("last", buildJsonObject {
                    put("class", last.health.wire)
                    put("phase", last.phase.wire)
                    put("host_generation", last.hostGeneration)
                    put("age_ms", (now - last.atMillis).coerceAtLeast(0))
                    put("fault_recorded", last.faultRecorded)
                    put("quarantine_accepted", last.quarantineAccepted)
                })
            }
        }
    }

    fun withdraw(observed: RuntimeSessionState, health: NativeHostHealth, phase: HostHealthPhase): Boolean {
        val fence = observed.activeFence ?: return false
        val withdrawn = synchronized(monitor) {
            if (health == NativeHostHealth.Healthy) return@synchronized false
            if (!sessions.compareAndSet(observed, RuntimeSessionState(startFailure = health.failureCode))) {
                return@synchronized false
            }
            releasePending = true
            withdrawalInProgress = true
            if (pendingInitialProbe == fence) pendingInitialProbe = null
            val detectedAt = nowMillis()
            publishSnapshot()
            val recorded = runCatching { port.recordFault(fence, health, phase) }.getOrDefault(false)
            val quarantineAccepted = runCatching { port.quarantine(fence) }.getOrDefault(false)
            consecutiveWithdrawals += 1
            val now = nowMillis()
            if (consecutiveWithdrawals >= BREAKER_THRESHOLD) {
                val doublings = (consecutiveWithdrawals - BREAKER_THRESHOLD).coerceAtMost(MAX_BREAKER_DOUBLINGS)
                breakerUntilMillis = now +
                    (BREAKER_BASE_MILLIS shl doublings).coerceAtMost(BREAKER_MAX_MILLIS)
            }
            lastWithdrawal = Withdrawal(health, phase, fence.hostGeneration, detectedAt, recorded, quarantineAccepted)
            publishSnapshot()
            // start() uses this monitor: successor projections cannot appear before cleanup ends.
            runCatching { onWithdrawn(fence) }
            withdrawalInProgress = false
            publishSnapshot()
            true
        }
        return withdrawn
    }

    private companion object {
        const val BREAKER_THRESHOLD = 3
        const val BREAKER_BASE_MILLIS = 30_000L
        const val BREAKER_MAX_MILLIS = 15 * 60_000L
        const val MAX_BREAKER_DOUBLINGS = 5
        const val RELEASE_RETRY_MILLIS = 15_000L
        const val PROBE_RETRY_MILLIS = 5_000L
    }
}
