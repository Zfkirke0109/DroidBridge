package com.droidbridge.standalone.runtimehost

import java.util.concurrent.atomic.AtomicReference

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
    private var releasePending = false
    private var pendingInitialProbe: RuntimeFence? = null
    private var consecutiveWithdrawals = 0
    private var breakerUntilMillis = 0L

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
        if (observed.started && sessions.get() === observed) consecutiveWithdrawals = 0
    }

    /** Reset Runtime data is explicit recovery and may clear the cooldown. */
    fun clearBreaker() = synchronized(monitor) {
        consecutiveWithdrawals = 0
        breakerUntilMillis = 0L
    }

    fun withdraw(observed: RuntimeSessionState, health: NativeHostHealth, phase: HostHealthPhase): Boolean {
        val fence = observed.activeFence ?: return false
        val withdrawn = synchronized(monitor) {
            if (health == NativeHostHealth.Healthy) return@synchronized false
            if (!sessions.compareAndSet(observed, RuntimeSessionState(startFailure = health.failureCode))) {
                return@synchronized false
            }
            releasePending = true
            if (pendingInitialProbe == fence) pendingInitialProbe = null
            runCatching { port.recordFault(fence, health, phase) }
            runCatching { port.quarantine(fence) }
            consecutiveWithdrawals += 1
            if (consecutiveWithdrawals >= BREAKER_THRESHOLD) {
                val doublings = (consecutiveWithdrawals - BREAKER_THRESHOLD).coerceAtMost(MAX_BREAKER_DOUBLINGS)
                breakerUntilMillis = nowMillis() +
                    (BREAKER_BASE_MILLIS shl doublings).coerceAtMost(BREAKER_MAX_MILLIS)
            }
            // start() uses this monitor: successor projections cannot appear before cleanup ends.
            runCatching { onWithdrawn(fence) }
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
