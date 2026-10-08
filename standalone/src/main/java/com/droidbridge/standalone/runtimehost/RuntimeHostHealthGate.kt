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
    private val onWithdrawn: () -> Unit,
) {
    private var releasePending = false
    private var pendingInitialProbe: RuntimeFence? = null

    fun requireDeepProbe(fence: RuntimeFence) = synchronized(monitor) { pendingInitialProbe = fence }

    fun initialProbePending(fence: RuntimeFence): Boolean = synchronized(monitor) { pendingInitialProbe == fence }

    fun markInitialProbeHealthy(fence: RuntimeFence) = synchronized(monitor) {
        if (pendingInitialProbe == fence) pendingInitialProbe = null
    }

    fun admissionCompleted(observed: RuntimeSessionState): Boolean = synchronized(monitor) {
        observed.started && sessions.get() === observed && pendingInitialProbe != observed.activeFence
    }

    fun mayEstablish(): Boolean = synchronized(monitor) {
        if (!releasePending) return@synchronized true
        if (!runCatching { port.lifetimeReleased() }.getOrDefault(false)) return@synchronized false
        releasePending = false
        true
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
            true
        }
        if (withdrawn) runCatching { onWithdrawn() }
        return withdrawn
    }
}
