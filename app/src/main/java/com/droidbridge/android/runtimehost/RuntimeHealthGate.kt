package com.droidbridge.android.runtimehost

import java.util.concurrent.atomic.AtomicReference
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/** Why a live APK Runtime instance is not executable. Nothing here is a capability fact. */
internal enum class RuntimeHealthClass(val wire: String, val faultCode: String) {
    Healthy("healthy", ""),
    HostMissing("host_missing", DaemonErrorToken.CapabilityUnavailable.wire),
    FenceMismatch("fence_mismatch", DaemonErrorToken.StaleAuthority.wire),
    LeaseStale("lease_stale", DaemonErrorToken.StaleAuthority.wire),
    StoreUnreadable("store_unreadable", DaemonErrorToken.IoError.wire),
    StoreUnwritable("store_unwritable", DaemonErrorToken.IoError.wire),
    ResourceExhausted("resource_exhausted", DaemonErrorToken.ResourceLimit.wire),
    BridgeFault("bridge_fault", DaemonErrorToken.IoError.wire),
    ExecutorMissing("executor_missing", DaemonErrorToken.CapabilityUnavailable.wire),
    ProbeFailed("probe_failed", DaemonErrorToken.InternalError.wire),
    ;

    companion object {
        /** A class this process does not know is a probe it cannot read, which never admits. */
        fun decode(wire: String?): RuntimeHealthClass = entries.firstOrNull { it.wire == wire } ?: ProbeFailed
    }
}

/**
 * How much a probe proves. [Admission] runs before every APK request and reads only in-memory
 * facts, the lease records and descriptor headroom; [Deep] adds the store read, a scratch write and
 * a JNI round trip to the executor registry. Neither runs an executor or changes canonical state.
 */
internal enum class RuntimeProbeDepth { Admission, Deep }

/** Where the unhealthy instance was found: before a request was dispatched, or after one failed. */
internal enum class RuntimeHealthPhase(val wire: String) {
    Admission("admission"),
    Settlement("settlement"),
}

/** What one dispatched request's reply proves about the instance that served it. */
internal enum class RuntimeSettlement {
    /** A business request completed: the instance demonstrably executes. */
    Served,

    /** Proves nothing either way: an ordinary refusal, or a status read served from projection. */
    Inconclusive,

    /** What an unusable instance produces: IO_ERROR, INTERNAL_ERROR, an unreadable reply, a throw. */
    Suspicious,
}

internal interface RuntimeHealthPort {
    fun probe(fence: RuntimeFence, depth: RuntimeProbeDepth): RuntimeHealthClass

    /** Records one fault under the instance that still holds the slot; false when nothing was written. */
    fun recordFault(fence: RuntimeFence, healthClass: RuntimeHealthClass, phase: RuntimeHealthPhase): Boolean

    /** Closes admission on that exact instance and releases it; false when it no longer holds the slot. */
    fun quarantine(fence: RuntimeFence): Boolean
}

/**
 * Issue #2: a started APK session is not evidence that its instance can still execute. Every APK
 * request is admitted only after a side-effect-free probe of the instance its fence names. An
 * unhealthy instance is handled in one order, under the same monitor as [RuntimeHostController.start]
 * so no establishment can interleave:
 *
 * 1. its authority is withdrawn (the session CAS, so exactly one caller does the rest);
 * 2. the fault is recorded while the instance still holds the slot that owns the fault file;
 * 3. the instance is quarantined and released;
 * 4. the current request fails. It is never replayed: before dispatch it never ran, and after
 *    dispatch its outcome is unknown and stays the caller's to settle.
 *
 * Only a later request establishes the next instance, which is deep-probed before it serves one.
 * Repeated unhealthy instances open a bounded breaker instead of a restart loop.
 */
internal class RuntimeHealthGate(
    private val session: AtomicReference<RuntimeSessionState>,
    private val lock: Any,
    private val port: RuntimeHealthPort,
    private val nowMillis: () -> Long,
    private val onWithdrawn: () -> Unit = {},
) {
    private class Withdrawal(
        val healthClass: RuntimeHealthClass,
        val phase: RuntimeHealthPhase,
        val hostGeneration: Long,
        val atMillis: Long,
        val faultRecorded: Boolean,
        val released: Boolean,
    )

    private val state = Any()
    private var deepProbePending: RuntimeFence? = null
    /** The last settlement deep probe that proved an instance healthy; it bounds how often one runs. */
    private var lastDeepProbe: Pair<RuntimeFence, Long>? = null
    private val quarantined = LinkedHashSet<String>()
    private var releasePending = false
    private var consecutiveWithdrawals = 0
    private var breakerUntilMillis = 0L
    private var last: Withdrawal? = null

    /** The next admission of this newly established instance runs the deep probe. */
    fun onEstablished(fence: RuntimeFence) {
        synchronized(state) { deepProbePending = fence }
    }

    /** Returns to admit [observed]; throws [RuntimeStartException] otherwise. Never dispatches. */
    fun admit(observed: RuntimeSessionState) {
        val fence = observed.activeFence ?: throw RuntimeStartException(observed.startFailure)
        val depth = synchronized(state) {
            if (deepProbePending == fence) RuntimeProbeDepth.Deep else RuntimeProbeDepth.Admission
        }
        val verdict = probe(fence, depth)
        if (verdict == RuntimeHealthClass.Healthy) {
            if (depth == RuntimeProbeDepth.Deep) {
                synchronized(state) { if (deepProbePending == fence) deepProbePending = null }
            }
            return
        }
        withdraw(observed, fence, verdict, RuntimeHealthPhase.Admission)
        throw RuntimeStartException(
            DaemonErrorToken.CapabilityUnavailable.wire,
            "Runtime health check failed (${verdict.wire}); the request was not executed",
        )
    }

    /**
     * Runs after one dispatched request. Only a business request the still-authoritative instance
     * served counts as proof it executes; an infrastructure failure deep-probes the instance and,
     * if it is unhealthy, withdraws it. The response itself is the caller's to return unchanged,
     * and an open breaker only expires or is cleared by an explicit recovery, never by a reply.
     */
    fun settle(observed: RuntimeSessionState, settlement: RuntimeSettlement) {
        val fence = observed.activeFence ?: return
        when (settlement) {
            RuntimeSettlement.Inconclusive -> return
            RuntimeSettlement.Served -> {
                synchronized(state) {
                    // A reply from an instance already withdrawn says nothing about the next one.
                    if (session.get() === observed && fence.runtimeInstanceId !in quarantined) {
                        consecutiveWithdrawals = 0
                    }
                }
                return
            }
            RuntimeSettlement.Suspicious -> Unit
        }
        val now = nowMillis()
        val recentlyProven = synchronized(state) {
            lastDeepProbe?.let { (proven, at) -> proven == fence && now - at < DEEP_PROBE_INTERVAL_MILLIS } == true
        }
        if (recentlyProven) return
        val verdict = probe(fence, RuntimeProbeDepth.Deep)
        if (verdict == RuntimeHealthClass.Healthy) {
            synchronized(state) { lastDeepProbe = fence to now }
            return
        }
        withdraw(observed, fence, verdict, RuntimeHealthPhase.Settlement)
    }

    /** True while repeated unhealthy instances hold off establishing another one. */
    fun establishmentBlocked(): Boolean = synchronized(state) { nowMillis() < breakerUntilMillis }

    /**
     * True from a withdrawal until [releaseObserved]: the withdrawn instance may still hold its
     * lifetime lease while requests it admitted finish.
     */
    fun releasePending(): Boolean = synchronized(state) { releasePending }

    fun releaseObserved() {
        synchronized(state) { releasePending = false }
    }

    /**
     * When establishment is being held off, how long until it may be tried again: the breaker's
     * remaining time, or a short wait while a withdrawn instance still drains. Null otherwise.
     */
    fun establishmentRetryMillis(): Long? = synchronized(state) {
        val remaining = breakerUntilMillis - nowMillis()
        when {
            remaining > 0 -> remaining
            releasePending -> RELEASE_RETRY_MILLIS
            else -> null
        }
    }

    /** True for an instance this gate already withdrew: it can never become authoritative again. */
    fun rejectsEstablishment(fence: RuntimeFence): Boolean =
        synchronized(state) { fence.runtimeInstanceId in quarantined }

    /** An explicit user recovery (Reset Runtime data) is a fresh start for the breaker. */
    fun clearBreaker() {
        synchronized(state) {
            consecutiveWithdrawals = 0
            breakerUntilMillis = 0L
        }
    }

    fun snapshot(): JsonObject = synchronized(state) {
        val now = nowMillis()
        buildJsonObject {
            put("consecutive_withdrawals", consecutiveWithdrawals)
            put("release_pending", releasePending)
            put("breaker_open", now < breakerUntilMillis)
            if (now < breakerUntilMillis) put("breaker_remaining_ms", breakerUntilMillis - now)
            last?.let { withdrawal ->
                put("last", buildJsonObject {
                    put("class", withdrawal.healthClass.wire)
                    put("phase", withdrawal.phase.wire)
                    put("host_generation", withdrawal.hostGeneration)
                    put("age_ms", (now - withdrawal.atMillis).coerceAtLeast(0))
                    put("fault_recorded", withdrawal.faultRecorded)
                    put("released", withdrawal.released)
                })
            }
        }
    }

    private fun probe(fence: RuntimeFence, depth: RuntimeProbeDepth): RuntimeHealthClass =
        runCatching { port.probe(fence, depth) }.getOrDefault(RuntimeHealthClass.ProbeFailed)

    private fun withdraw(
        observed: RuntimeSessionState,
        fence: RuntimeFence,
        verdict: RuntimeHealthClass,
        phase: RuntimeHealthPhase,
    ) {
        synchronized(lock) {
            val withdrawn = RuntimeSessionState(
                started = false,
                host = observed.host,
                activeFence = null,
                startFailure = DaemonErrorToken.CapabilityUnavailable.wire,
            )
            // A caller that lost this race observed an instance someone else already handled.
            if (!session.compareAndSet(observed, withdrawn)) return
            synchronized(state) {
                quarantined += fence.runtimeInstanceId
                while (quarantined.size > MAX_REMEMBERED_INSTANCES) quarantined.remove(quarantined.first())
                if (deepProbePending == fence) deepProbePending = null
                releasePending = true
            }
            val recorded = runCatching { port.recordFault(fence, verdict, phase) }.getOrDefault(false)
            val released = runCatching { port.quarantine(fence) }.getOrDefault(false)
            synchronized(state) {
                val now = nowMillis()
                consecutiveWithdrawals += 1
                if (consecutiveWithdrawals >= BREAKER_THRESHOLD) {
                    val doublings = (consecutiveWithdrawals - BREAKER_THRESHOLD).coerceAtMost(MAX_BREAKER_DOUBLINGS)
                    breakerUntilMillis = now + (BREAKER_BASE_MILLIS shl doublings).coerceAtMost(BREAKER_MAX_MILLIS)
                }
                last = Withdrawal(verdict, phase, fence.hostGeneration, now, recorded, released)
            }
        }
        runCatching { onWithdrawn() }
    }

    private companion object {
        const val BREAKER_THRESHOLD = 3
        const val BREAKER_BASE_MILLIS = 30_000L
        const val BREAKER_MAX_MILLIS = 15 * 60_000L
        const val MAX_BREAKER_DOUBLINGS = 5
        const val DEEP_PROBE_INTERVAL_MILLIS = 5_000L
        const val MAX_REMEMBERED_INSTANCES = 16
        const val RELEASE_RETRY_MILLIS = 15_000L
    }
}

/**
 * One APK request through the gate: probe, dispatch exactly once, settle. The response is returned
 * unchanged whatever the settlement finds, and a dispatch that throws is settled as suspicious and
 * rethrown, so nothing here can run the request a second time.
 */
internal fun RuntimeHealthGate.serveApk(
    observed: RuntimeSessionState,
    provesExecution: Boolean,
    dispatch: () -> ByteArray,
): ByteArray {
    admit(observed)
    val response = try {
        dispatch()
    } catch (failure: Throwable) {
        settle(observed, RuntimeSettlement.Suspicious)
        throw failure
    }
    settle(observed, runtimeSettlement(response, provesExecution))
    return response
}

/**
 * What one Runtime reply proves. IO_ERROR and INTERNAL_ERROR are the codes a lost bridge, store or
 * descriptor table collapse into, and a reply that cannot be read proves nothing was answered.
 * Only a successful business request ([provesExecution]) shows the instance executes.
 */
internal fun runtimeSettlement(response: ByteArray, provesExecution: Boolean): RuntimeSettlement {
    val envelope = runCatching { Json.parseToJsonElement(response.decodeToString()).jsonObject }.getOrNull()
        ?: return RuntimeSettlement.Suspicious
    return when ((envelope["outcome"] as? JsonPrimitive)?.content) {
        "success" -> if (provesExecution) RuntimeSettlement.Served else RuntimeSettlement.Inconclusive
        "error" -> {
            val code = ((envelope["error"] as? JsonObject)?.get("code") as? JsonPrimitive)?.content
            if (code == DaemonErrorToken.IoError.wire || code == DaemonErrorToken.InternalError.wire) {
                RuntimeSettlement.Suspicious
            } else {
                RuntimeSettlement.Inconclusive
            }
        }
        else -> RuntimeSettlement.Suspicious
    }
}

/**
 * Whether one submission exercises execution. `context` reads are projections and `task_control`
 * reads the store, so neither proves an executor works.
 */
internal fun submissionProvesExecution(envelope: ByteArray): Boolean = runCatching {
    val tool = (Json.parseToJsonElement(envelope.decodeToString()).jsonObject["payload"] as? JsonObject)
        ?.get("tool") as? JsonPrimitive
    tool?.content !in setOf("context", "task_control")
}.getOrDefault(false)

/** The fault record phase: bounded ASCII naming where, why and at which host generation. */
internal fun runtimeHealthFaultPhase(
    phase: RuntimeHealthPhase,
    healthClass: RuntimeHealthClass,
    hostGeneration: Long,
): String = "health_${phase.wire}:${healthClass.wire}@g$hostGeneration"
