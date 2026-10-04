package com.droidbridge.android

import com.droidbridge.android.execution.android.AndroidExecutionBridge
import com.droidbridge.android.execution.android.AndroidExecutionRegistry
import com.droidbridge.android.execution.android.AndroidExecutionResult
import com.droidbridge.android.execution.android.AndroidPrimitive
import com.droidbridge.android.execution.android.CapabilityRegistration
import com.droidbridge.android.execution.android.RegisteredCapabilityState
import com.droidbridge.android.execution.android.frameworkExecutorPresent
import com.droidbridge.android.runtimehost.DaemonErrorToken
import com.droidbridge.android.runtimehost.DaemonHostToken
import com.droidbridge.android.runtimehost.RuntimeFence
import com.droidbridge.android.runtimehost.RuntimeHealthClass
import com.droidbridge.android.runtimehost.RuntimeHealthGate
import com.droidbridge.android.runtimehost.RuntimeHealthPhase
import com.droidbridge.android.runtimehost.RuntimeHealthPort
import com.droidbridge.android.runtimehost.RuntimeProbeDepth
import com.droidbridge.android.runtimehost.RuntimeSessionState
import com.droidbridge.android.runtimehost.RuntimeStartException
import com.droidbridge.android.runtimehost.responseIndicatesInfrastructureFailure
import com.droidbridge.android.runtimehost.runtimeFailureMessage
import com.droidbridge.android.runtimehost.runtimeHealthFaultPhase
import com.droidbridge.android.runtimehost.serveApk
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Issue #2: a started APK Runtime is admitted only while a side-effect-free probe proves it is
 * still executable. The request that finds it unhealthy is failed and never replayed; authority is
 * withdrawn before the fault is recorded and the instance released; only a later request may
 * establish the next instance.
 */
class I16_RuntimeHealthGateTest {
    private val epoch = "00000000-0000-4000-8000-0000000000e1"
    private val first = RuntimeFence(epoch, 1, "00000000-0000-4000-8000-000000000001")
    private val second = RuntimeFence(epoch, 1, "00000000-0000-4000-8000-000000000002")

    private fun active(fence: RuntimeFence) = RuntimeSessionState(
        started = true,
        host = DaemonHostToken.ApkRuntime,
        activeFence = fence,
        startFailure = "",
    )

    private class FakePort(
        private val session: AtomicReference<RuntimeSessionState>,
        var verdict: (RuntimeFence, RuntimeProbeDepth) -> RuntimeHealthClass = { _, _ -> RuntimeHealthClass.Healthy },
    ) : RuntimeHealthPort {
        val events: MutableList<String> = Collections.synchronizedList(mutableListOf())
        val probes = AtomicInteger()
        val records = AtomicInteger()
        val quarantines = AtomicInteger()
        val depths: MutableList<RuntimeProbeDepth> = Collections.synchronizedList(mutableListOf())
        var recordResult: () -> Boolean = { true }
        var quarantineResult: () -> Boolean = { true }
        var startedWhenRecorded: Boolean? = null
        var startedWhenQuarantined: Boolean? = null
        val recordedPhases: MutableList<RuntimeHealthPhase> = Collections.synchronizedList(mutableListOf())

        override fun probe(fence: RuntimeFence, depth: RuntimeProbeDepth): RuntimeHealthClass {
            probes.incrementAndGet()
            depths += depth
            events += "probe"
            return verdict(fence, depth)
        }

        override fun recordFault(
            fence: RuntimeFence,
            healthClass: RuntimeHealthClass,
            phase: RuntimeHealthPhase,
        ): Boolean {
            records.incrementAndGet()
            recordedPhases += phase
            events += "record"
            startedWhenRecorded = session.get().started
            return recordResult()
        }

        override fun quarantine(fence: RuntimeFence): Boolean {
            quarantines.incrementAndGet()
            events += "quarantine"
            startedWhenQuarantined = session.get().started
            return quarantineResult()
        }
    }

    private class Harness(initial: RuntimeSessionState) {
        val session = AtomicReference(initial)
        val clock = AtomicLong(1_000_000)
        val withdrawnHints = AtomicInteger()
        val port = FakePort(session)
        val gate = RuntimeHealthGate(session, this, port, clock::get) { withdrawnHints.incrementAndGet() }
        val dispatches = AtomicInteger()
    }

    private fun ok(): ByteArray =
        """{"protocol_version":1,"request_id":"r","outcome":"success","result":{}}""".encodeToByteArray()

    private fun failed(code: String): ByteArray =
        """{"protocol_version":1,"request_id":"r","outcome":"error","error":{"code":"$code","operation":"command.run","retryable":false}}"""
            .encodeToByteArray()

    private fun expectRefused(block: () -> Unit): RuntimeStartException {
        try {
            block()
        } catch (refused: RuntimeStartException) {
            return refused
        }
        fail("the request was admitted")
        throw AssertionError()
    }

    @Test
    fun i16_healthyStartedApkHostIsReusedWithoutAuthorityChange() {
        val harness = Harness(active(first))
        val observed = harness.session.get()
        val response = harness.gate.serveApk(observed) {
            harness.dispatches.incrementAndGet()
            ok()
        }
        assertArrayEquals(ok(), response)
        assertEquals(1, harness.dispatches.get())
        assertSame(observed, harness.session.get())
        assertEquals(0, harness.port.records.get())
        assertEquals(0, harness.port.quarantines.get())
    }

    @Test
    fun i16_startedSessionAloneIsNotEvidenceOfHealth() {
        // The false-green state of issue #2: the session says started, the executor path is gone.
        for (unhealthy in RuntimeHealthClass.entries - RuntimeHealthClass.Healthy) {
            val harness = Harness(active(first))
            harness.port.verdict = { _, _ -> unhealthy }
            val refused = expectRefused {
                harness.gate.serveApk(harness.session.get()) {
                    harness.dispatches.incrementAndGet()
                    ok()
                }
            }
            assertEquals(unhealthy.wire, DaemonErrorToken.CapabilityUnavailable.wire, refused.code)
            assertTrue(refused.detail.orEmpty().contains(unhealthy.wire))
            assertTrue(refused.detail.orEmpty().contains("not executed"))
            assertEquals(unhealthy.wire, 0, harness.dispatches.get())
            assertFalse(unhealthy.wire, harness.session.get().started)
            assertNull(harness.session.get().activeFence)
        }
    }

    @Test
    fun i16_missingExecutorProjectionWithdrawsTheStartedHost() {
        val harness = Harness(active(first))
        harness.port.verdict = { _, _ -> RuntimeHealthClass.ExecutorMissing }
        expectRefused { harness.gate.admit(harness.session.get()) }
        assertFalse(harness.session.get().started)
        assertEquals(1, harness.port.quarantines.get())
    }

    @Test
    fun i16_nativeFenceUnhealthyWhileKotlinRegistryRemainsIsRefused() {
        for (native in listOf(
            RuntimeHealthClass.HostMissing,
            RuntimeHealthClass.FenceMismatch,
            RuntimeHealthClass.LeaseStale,
            RuntimeHealthClass.BridgeFault,
        )) {
            val harness = Harness(active(first))
            harness.port.verdict = { _, _ -> native }
            expectRefused { harness.gate.admit(harness.session.get()) }
            assertFalse(native.wire, harness.session.get().started)
        }
    }

    @Test
    fun i16_authorityIsWithdrawnBeforeTheFaultIsRecordedAndTheHostReleased() {
        val harness = Harness(active(first))
        harness.port.verdict = { _, _ -> RuntimeHealthClass.BridgeFault }
        expectRefused { harness.gate.admit(harness.session.get()) }
        assertEquals(listOf("probe", "record", "quarantine"), harness.port.events.toList())
        assertEquals(false, harness.port.startedWhenRecorded)
        assertEquals(false, harness.port.startedWhenQuarantined)
        assertEquals(listOf(RuntimeHealthPhase.Admission), harness.port.recordedPhases.toList())
        assertEquals(1, harness.withdrawnHints.get())
    }

    @Test
    fun i16_requestThatFindsAmbiguousFailureIsNeverReplayed() {
        val harness = Harness(active(first))
        // Admission is healthy; the dispatched request then fails with an infrastructure code and the
        // deep probe proves the instance unhealthy. The request may have crossed a side-effect boundary.
        harness.port.verdict = { _, depth ->
            if (depth == RuntimeProbeDepth.Deep) RuntimeHealthClass.BridgeFault else RuntimeHealthClass.Healthy
        }
        harness.gate.onEstablished(first)
        harness.port.verdict = { _, depth ->
            if (harness.dispatches.get() == 0) {
                RuntimeHealthClass.Healthy
            } else if (depth == RuntimeProbeDepth.Deep) {
                RuntimeHealthClass.BridgeFault
            } else {
                RuntimeHealthClass.Healthy
            }
        }
        val original = failed(DaemonErrorToken.IoError.wire)
        val response = harness.gate.serveApk(harness.session.get()) {
            harness.dispatches.incrementAndGet()
            original
        }
        assertSame(original, response)
        assertEquals(1, harness.dispatches.get())
        assertFalse(harness.session.get().started)
        assertEquals(1, harness.port.quarantines.get())
        assertEquals(listOf(RuntimeHealthPhase.Settlement), harness.port.recordedPhases.toList())
        // The withdrawn session refuses the next request instead of replaying anything on it.
        val next = harness.session.get()
        expectRefused { harness.gate.serveApk(next) { harness.dispatches.incrementAndGet(); ok() } }
        assertEquals(1, harness.dispatches.get())
    }

    @Test
    fun i16_exactlyOneTeardownUnderConcurrentAdmissions() {
        val harness = Harness(active(first))
        harness.port.verdict = { _, _ -> RuntimeHealthClass.BridgeFault }
        val observed = harness.session.get()
        val callers = 16
        val ready = CountDownLatch(callers)
        val go = CountDownLatch(1)
        val refused = AtomicInteger()
        val pool = Executors.newFixedThreadPool(callers)
        repeat(callers) {
            pool.execute {
                ready.countDown()
                go.await()
                try {
                    harness.gate.serveApk(observed) { harness.dispatches.incrementAndGet(); ok() }
                } catch (_: RuntimeStartException) {
                    refused.incrementAndGet()
                }
            }
        }
        assertTrue(ready.await(5, TimeUnit.SECONDS))
        go.countDown()
        pool.shutdown()
        assertTrue(pool.awaitTermination(10, TimeUnit.SECONDS))
        assertEquals(callers, refused.get())
        assertEquals(0, harness.dispatches.get())
        assertEquals(1, harness.port.records.get())
        assertEquals(1, harness.port.quarantines.get())
        assertEquals(1, harness.withdrawnHints.get())
    }

    @Test
    fun i16_aLoserOfTheWithdrawalRaceNeverTearsDownTheReplacement() {
        val harness = Harness(active(first))
        val stale = harness.session.get()
        // Another caller already replaced the instance before this caller's verdict arrived.
        harness.session.set(active(second))
        harness.port.verdict = { fence, _ ->
            if (fence == first) RuntimeHealthClass.BridgeFault else RuntimeHealthClass.Healthy
        }
        expectRefused { harness.gate.admit(stale) }
        assertEquals(active(second), harness.session.get())
        assertEquals(0, harness.port.quarantines.get())
        assertEquals(0, harness.port.records.get())
    }

    @Test
    fun i16_subsequentRequestEstablishesAndDeepProbesTheNextInstance() {
        val harness = Harness(active(first))
        harness.port.verdict = { fence, _ ->
            if (fence == first) RuntimeHealthClass.BridgeFault else RuntimeHealthClass.Healthy
        }
        expectRefused { harness.gate.admit(harness.session.get()) }
        // The stale instance can never be adopted again, the next one can.
        assertTrue(harness.gate.rejectsEstablishment(first))
        assertFalse(harness.gate.rejectsEstablishment(second))
        assertFalse(harness.gate.establishmentBlocked())
        harness.session.set(active(second))
        harness.gate.onEstablished(second)
        harness.port.depths.clear()
        val response = harness.gate.serveApk(harness.session.get()) { harness.dispatches.incrementAndGet(); ok() }
        assertArrayEquals(ok(), response)
        assertEquals(1, harness.dispatches.get())
        assertEquals(listOf(RuntimeProbeDepth.Deep), harness.port.depths.toList())
        harness.gate.serveApk(harness.session.get()) { harness.dispatches.incrementAndGet(); ok() }
        assertEquals(listOf(RuntimeProbeDepth.Deep, RuntimeProbeDepth.Admission), harness.port.depths.toList())
    }

    @Test
    fun i16_faultRecordingFailureStillFailsClosed() {
        for (recording in listOf<() -> Boolean>({ false }, { throw IllegalStateException("fault file") })) {
            val harness = Harness(active(first))
            harness.port.verdict = { _, _ -> RuntimeHealthClass.StoreUnwritable }
            harness.port.recordResult = recording
            expectRefused { harness.gate.admit(harness.session.get()) }
            assertFalse(harness.session.get().started)
            assertEquals(1, harness.port.quarantines.get())
            val last = harness.gate.snapshot()["last"]!!.jsonObject
            assertFalse(last["fault_recorded"]!!.jsonPrimitive.boolean)
            assertEquals("store_unwritable", last["class"]!!.jsonPrimitive.content)
        }
    }

    @Test
    fun i16_releaseFailureStillFailsClosedAndNeverReadoptsTheStaleInstance() {
        val harness = Harness(active(first))
        harness.port.verdict = { _, _ -> RuntimeHealthClass.LeaseStale }
        harness.port.quarantineResult = { throw IllegalStateException("slot") }
        expectRefused { harness.gate.admit(harness.session.get()) }
        assertFalse(harness.session.get().started)
        assertTrue(harness.gate.rejectsEstablishment(first))
        val last = harness.gate.snapshot()["last"]!!.jsonObject
        assertFalse(last["released"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun i16_aProbeThatCannotRunNeverAdmits() {
        val harness = Harness(active(first))
        harness.port.verdict = { _, _ -> throw IllegalStateException("jni") }
        val refused = expectRefused { harness.gate.admit(harness.session.get()) }
        assertTrue(refused.detail.orEmpty().contains(RuntimeHealthClass.ProbeFailed.wire))
        assertFalse(harness.session.get().started)
        assertEquals(RuntimeHealthClass.ProbeFailed, RuntimeHealthClass.decode("not-a-class"))
        assertEquals(RuntimeHealthClass.ProbeFailed, RuntimeHealthClass.decode(null))
    }

    @Test
    fun i16_contextStatusIsUnavailableNotGreenAfterAFailedHealthCheck() {
        val harness = Harness(active(first))
        harness.port.verdict = { _, _ -> RuntimeHealthClass.BridgeFault }
        // context.status is a request like any other: it is not served from the stale projection.
        val refused = expectRefused {
            harness.gate.serveApk(harness.session.get()) { harness.dispatches.incrementAndGet(); ok() }
        }
        assertEquals(DaemonErrorToken.CapabilityUnavailable.wire, refused.code)
        assertEquals(0, harness.dispatches.get())
        val session = harness.session.get()
        assertFalse(session.started)
        assertEquals(DaemonErrorToken.CapabilityUnavailable.wire, session.startFailure)
        val snapshot = harness.gate.snapshot()
        assertEquals("bridge_fault", snapshot["last"]!!.jsonObject["class"]!!.jsonPrimitive.content)
        assertEquals(1L, snapshot["last"]!!.jsonObject["host_generation"]!!.jsonPrimitive.long)
        assertEquals("admission", snapshot["last"]!!.jsonObject["phase"]!!.jsonPrimitive.content)
        // The reason reaches the caller without any request content or identifier.
        val message = runtimeFailureMessage(refused).orEmpty()
        assertTrue(message.contains("bridge_fault"))
        assertFalse(message.contains(first.runtimeInstanceId))
        assertFalse(message.contains(epoch))
    }

    @Test
    fun i16_ordinaryOperationFailuresDoNotProbeOrReset() {
        val harness = Harness(active(first))
        for (code in listOf("NOT_FOUND", "PERMISSION_DENIED", "EXECUTION_FAILED", "CAPABILITY_UNAVAILABLE", "TIMEOUT")) {
            harness.gate.serveApk(harness.session.get()) { failed(code) }
        }
        assertEquals(listOf(RuntimeProbeDepth.Admission).let { a -> List(5) { a[0] } }, harness.port.depths.toList())
        assertTrue(harness.session.get().started)
    }

    @Test
    fun i16_infrastructureFailureOnAHealthyInstanceKeepsIt() {
        val harness = Harness(active(first))
        val response = harness.gate.serveApk(harness.session.get()) { failed(DaemonErrorToken.IoError.wire) }
        assertTrue(responseIndicatesInfrastructureFailure(response))
        assertEquals(listOf(RuntimeProbeDepth.Admission, RuntimeProbeDepth.Deep), harness.port.depths.toList())
        assertTrue(harness.session.get().started)
        assertEquals(0, harness.port.quarantines.get())
    }

    @Test
    fun i16_settlementDeepProbesAreBoundedPerInstance() {
        val harness = Harness(active(first))
        repeat(5) { harness.gate.serveApk(harness.session.get()) { failed(DaemonErrorToken.IoError.wire) } }
        assertEquals(1, harness.port.depths.count { it == RuntimeProbeDepth.Deep })
        harness.clock.addAndGet(60_000)
        harness.gate.serveApk(harness.session.get()) { failed(DaemonErrorToken.IoError.wire) }
        assertEquals(2, harness.port.depths.count { it == RuntimeProbeDepth.Deep })
    }

    @Test
    fun i16_repeatedUnhealthyInstancesOpenABreakerInsteadOfARestartLoop() {
        val harness = Harness(active(first))
        harness.port.verdict = { _, _ -> RuntimeHealthClass.StoreUnwritable }
        val fences = (1..3).map { RuntimeFence(epoch, 1, "00000000-0000-4000-8000-00000000010$it") }
        for (fence in fences) {
            assertFalse(harness.gate.establishmentBlocked())
            harness.session.set(active(fence))
            harness.gate.onEstablished(fence)
            expectRefused { harness.gate.admit(harness.session.get()) }
        }
        assertTrue(harness.gate.establishmentBlocked())
        val snapshot = harness.gate.snapshot()
        assertTrue(snapshot["breaker_open"]!!.jsonPrimitive.boolean)
        assertEquals(3L, snapshot["consecutive_withdrawals"]!!.jsonPrimitive.long)
        harness.clock.addAndGet(29_000)
        assertTrue(harness.gate.establishmentBlocked())
        harness.clock.addAndGet(2_000)
        assertFalse(harness.gate.establishmentBlocked())
        // The next failure doubles the wait, bounded.
        val fourth = RuntimeFence(epoch, 1, "00000000-0000-4000-8000-000000000104")
        harness.session.set(active(fourth))
        expectRefused { harness.gate.admit(harness.session.get()) }
        harness.clock.addAndGet(59_000)
        assertTrue(harness.gate.establishmentBlocked())
        harness.clock.addAndGet(2_000)
        assertFalse(harness.gate.establishmentBlocked())
        // An explicit user recovery clears it at once.
        harness.session.set(active(RuntimeFence(epoch, 1, "00000000-0000-4000-8000-000000000105")))
        expectRefused { harness.gate.admit(harness.session.get()) }
        assertTrue(harness.gate.establishmentBlocked())
        harness.gate.clearBreaker()
        assertFalse(harness.gate.establishmentBlocked())
    }

    @Test
    fun i16_aServedRequestResetsTheWithdrawalCount() {
        val harness = Harness(active(first))
        harness.port.verdict = { fence, _ ->
            if (fence == first) RuntimeHealthClass.BridgeFault else RuntimeHealthClass.Healthy
        }
        expectRefused { harness.gate.admit(harness.session.get()) }
        harness.session.set(active(second))
        harness.gate.serveApk(harness.session.get()) { ok() }
        assertEquals(0L, harness.gate.snapshot()["consecutive_withdrawals"]!!.jsonPrimitive.long)
    }

    @Test
    fun i16_shizukuOrCapabilityLossIsNotARuntimeHealthFailure() {
        // Ordinary Shizuku binder death withdraws `shizuku.shell` only; the framework executor the
        // Runtime dispatches through is unchanged, so the probe's executor check still passes.
        val registry = AndroidExecutionRegistry { _, _, _, _, _ -> true }
        val framework = AndroidExecutionBridge { AndroidExecutionResult(byteArrayOf()) }
        assertFalse(frameworkExecutorPresent(registry, 1))
        assertTrue(
            registry.register(
                CapabilityRegistration(
                    key = "android.framework",
                    state = RegisteredCapabilityState.Available,
                    reason = null,
                    sourceGeneration = 1,
                    executor = framework,
                    primitives = setOf(AndroidPrimitive.ShizukuProcessStart),
                ),
            ),
        )
        assertTrue(
            registry.register(
                CapabilityRegistration("shizuku.shell", RegisteredCapabilityState.Unavailable, "SHIZUKU_DEAD", 7),
            ),
        )
        assertTrue(frameworkExecutorPresent(registry, 1))
        assertFalse(frameworkExecutorPresent(registry, 2))
        assertFalse(frameworkExecutorPresent(null, 1))
        // No health class names a capability: the gate cannot reset the Runtime for one.
        assertTrue(RuntimeHealthClass.entries.none { it.wire.contains("shizuku") || it.wire.contains("capability") })
    }

    @Test
    fun i16_responseClassificationOnlyFlagsInfrastructureCodes() {
        assertTrue(responseIndicatesInfrastructureFailure(failed("IO_ERROR")))
        assertTrue(responseIndicatesInfrastructureFailure(failed("INTERNAL_ERROR")))
        assertFalse(responseIndicatesInfrastructureFailure(ok()))
        assertFalse(responseIndicatesInfrastructureFailure(failed("NOT_FOUND")))
        assertFalse(responseIndicatesInfrastructureFailure("not json".encodeToByteArray()))
        assertFalse(responseIndicatesInfrastructureFailure(byteArrayOf()))
        assertFalse(
            responseIndicatesInfrastructureFailure(
                """{"outcome":"success","result":{"text":"IO_ERROR"}}""".encodeToByteArray(),
            ),
        )
    }

    @Test
    fun i16_faultPhaseIsBoundedAsciiThatNamesClassPhaseAndGeneration() {
        assertEquals(
            "health_admission:bridge_fault@g1",
            runtimeHealthFaultPhase(RuntimeHealthPhase.Admission, RuntimeHealthClass.BridgeFault, 1),
        )
        for (phase in RuntimeHealthPhase.entries) {
            for (healthClass in RuntimeHealthClass.entries) {
                val value = runtimeHealthFaultPhase(phase, healthClass, Long.MAX_VALUE)
                assertTrue(value, value.isNotEmpty() && value.length <= 64 && value.all { it.code < 128 })
            }
        }
        for (healthClass in RuntimeHealthClass.entries - RuntimeHealthClass.Healthy) {
            assertNotNull(DaemonErrorToken.entries.firstOrNull { it.wire == healthClass.faultCode })
        }
    }
}
