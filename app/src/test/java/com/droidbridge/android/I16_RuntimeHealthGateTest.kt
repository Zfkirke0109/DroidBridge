package com.droidbridge.android

import com.droidbridge.android.execution.android.AndroidExecutionBridge
import com.droidbridge.android.execution.android.AndroidExecutionException
import com.droidbridge.android.execution.android.AndroidExecutionRequest
import com.droidbridge.android.execution.android.AndroidExecutionRegistry
import com.droidbridge.android.execution.android.AndroidExecutionResult
import com.droidbridge.android.execution.android.AndroidPrimitive
import com.droidbridge.android.execution.android.CapabilityRegistration
import com.droidbridge.android.execution.android.NativeAndroidExecutionDispatcher
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
import com.droidbridge.android.runtimehost.RuntimeSettlement
import com.droidbridge.android.runtimehost.RuntimeStartException
import com.droidbridge.android.runtimehost.runtimeFailureMessage
import com.droidbridge.android.runtimehost.runtimeHealthFaultPhase
import com.droidbridge.android.runtimehost.runtimeSettlement
import com.droidbridge.android.runtimehost.serveApk
import com.droidbridge.android.runtimehost.submissionProvesExecution
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
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
        val response = harness.gate.serveApk(observed, true) {
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
                harness.gate.serveApk(harness.session.get(), true) {
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
        val response = harness.gate.serveApk(harness.session.get(), true) {
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
        expectRefused { harness.gate.serveApk(next, true) { harness.dispatches.incrementAndGet(); ok() } }
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
                    harness.gate.serveApk(observed, true) { harness.dispatches.incrementAndGet(); ok() }
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
        val response = harness.gate.serveApk(harness.session.get(), true) { harness.dispatches.incrementAndGet(); ok() }
        assertArrayEquals(ok(), response)
        assertEquals(1, harness.dispatches.get())
        assertEquals(listOf(RuntimeProbeDepth.Deep), harness.port.depths.toList())
        harness.gate.serveApk(harness.session.get(), true) { harness.dispatches.incrementAndGet(); ok() }
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
            harness.gate.serveApk(harness.session.get(), true) { harness.dispatches.incrementAndGet(); ok() }
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
            harness.gate.serveApk(harness.session.get(), true) { failed(code) }
        }
        assertEquals(listOf(RuntimeProbeDepth.Admission).let { a -> List(5) { a[0] } }, harness.port.depths.toList())
        assertTrue(harness.session.get().started)
    }

    @Test
    fun i16_infrastructureFailureOnAHealthyInstanceKeepsIt() {
        val harness = Harness(active(first))
        val response = harness.gate.serveApk(harness.session.get(), true) { failed(DaemonErrorToken.IoError.wire) }
        assertEquals(RuntimeSettlement.Suspicious, runtimeSettlement(response, provesExecution = true))
        assertEquals(listOf(RuntimeProbeDepth.Admission, RuntimeProbeDepth.Deep), harness.port.depths.toList())
        assertTrue(harness.session.get().started)
        assertEquals(0, harness.port.quarantines.get())
    }

    @Test
    fun i16_settlementDeepProbesAreBoundedPerInstance() {
        val harness = Harness(active(first))
        repeat(5) { harness.gate.serveApk(harness.session.get(), true) { failed(DaemonErrorToken.IoError.wire) } }
        assertEquals(1, harness.port.depths.count { it == RuntimeProbeDepth.Deep })
        harness.clock.addAndGet(60_000)
        harness.gate.serveApk(harness.session.get(), true) { failed(DaemonErrorToken.IoError.wire) }
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
        harness.gate.serveApk(harness.session.get(), true) { ok() }
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
        // Every App capability the companion can publish goes away and comes back, the way Shizuku
        // death and rebind, Accessibility toggles and permission changes reach the registry: the
        // executor the probe checks never moves.
        val capabilityKeys = listOf(
            "shizuku.shell", "execution.shell_guard", "execution.app_guard", "visual.accessibility",
            "visual.media_projection_session", "android.notifications", "android.notification_listener",
            "android.local_network", "automation.exact_alarm",
        )
        capabilityKeys.forEachIndexed { index, key ->
            assertTrue(
                registry.register(
                    CapabilityRegistration(key, RegisteredCapabilityState.Unavailable, "LOST", 10L + index),
                ),
            )
            assertTrue(key, frameworkExecutorPresent(registry, 1))
            assertTrue(
                registry.register(
                    CapabilityRegistration(key, RegisteredCapabilityState.Available, null, 20L + index),
                ),
            )
            assertTrue(key, frameworkExecutorPresent(registry, 1))
        }
        // Only the executor's own generation decides: a host transition republishes it.
        assertFalse(frameworkExecutorPresent(registry, 2))
        assertTrue(
            registry.register(
                CapabilityRegistration(
                    key = "android.framework",
                    state = RegisteredCapabilityState.Available,
                    reason = null,
                    sourceGeneration = 2,
                    executor = framework,
                    primitives = setOf(AndroidPrimitive.ShizukuProcessStart),
                ),
            ),
        )
        assertTrue(frameworkExecutorPresent(registry, 2))
        assertFalse(frameworkExecutorPresent(registry, 1))
        assertFalse(frameworkExecutorPresent(null, 1))
        // No health class names a capability: the gate cannot reset the Runtime for one.
        assertTrue(RuntimeHealthClass.entries.none { it.wire.contains("shizuku") || it.wire.contains("capability") })
    }

    @Test
    fun i16_replyClassificationSeparatesProofFromSuspicion() {
        assertEquals(RuntimeSettlement.Suspicious, runtimeSettlement(failed("IO_ERROR"), true))
        assertEquals(RuntimeSettlement.Suspicious, runtimeSettlement(failed("INTERNAL_ERROR"), true))
        assertEquals(RuntimeSettlement.Served, runtimeSettlement(ok(), true))
        // A status read is served from projection: issue #2's false green is exactly that answer.
        assertEquals(RuntimeSettlement.Inconclusive, runtimeSettlement(ok(), false))
        assertEquals(RuntimeSettlement.Inconclusive, runtimeSettlement(failed("NOT_FOUND"), true))
        assertEquals(RuntimeSettlement.Inconclusive, runtimeSettlement(failed("CAPABILITY_UNAVAILABLE"), true))
        // A reply nobody can read proves nothing was answered.
        assertEquals(RuntimeSettlement.Suspicious, runtimeSettlement("not json".encodeToByteArray(), true))
        assertEquals(RuntimeSettlement.Suspicious, runtimeSettlement(byteArrayOf(), true))
        assertEquals(
            RuntimeSettlement.Served,
            runtimeSettlement("""{"outcome":"success","result":{"text":"IO_ERROR"}}""".encodeToByteArray(), true),
        )
        fun submission(tool: String) =
            """{"protocol_version":1,"request_id":"r","payload":{"tool":"$tool","action":"x","input":{}}}"""
                .encodeToByteArray()
        assertFalse(submissionProvesExecution(submission("context")))
        assertFalse(submissionProvesExecution(submission("task_control")))
        assertTrue(submissionProvesExecution(submission("command")))
        assertTrue(submissionProvesExecution(submission("filesystem")))
        assertFalse(submissionProvesExecution("not json".encodeToByteArray()))
    }

    @Test
    fun i16_noReplyAfterWithdrawalCanCloseTheBreakerOrResetItsCount() {
        val harness = Harness(active(first))
        val f1 = RuntimeFence(epoch, 1, "00000000-0000-4000-8000-0000000000a1")
        val f2 = RuntimeFence(epoch, 1, "00000000-0000-4000-8000-0000000000a2")
        val f3 = RuntimeFence(epoch, 1, "00000000-0000-4000-8000-0000000000a3")
        harness.port.verdict = { fence, _ -> if (fence == f3) RuntimeHealthClass.Healthy else RuntimeHealthClass.BridgeFault }
        for (fence in listOf(f1, f2)) {
            harness.session.set(active(fence))
            expectRefused { harness.gate.admit(harness.session.get()) }
        }
        // A request admitted on f3 while it still probed healthy...
        harness.session.set(active(f3))
        val stale = harness.session.get()
        harness.gate.admit(stale)
        // ...then a concurrent failure proves f3 unhealthy and opens the breaker.
        harness.port.verdict = { _, _ -> RuntimeHealthClass.BridgeFault }
        harness.gate.settle(stale, RuntimeSettlement.Suspicious)
        assertTrue(harness.gate.establishmentBlocked())
        // The admitted request's late reply, whatever it is, changes nothing.
        harness.gate.settle(stale, RuntimeSettlement.Served)
        harness.gate.settle(stale, RuntimeSettlement.Inconclusive)
        assertTrue(harness.gate.establishmentBlocked())
        assertEquals(3L, harness.gate.snapshot()["consecutive_withdrawals"]!!.jsonPrimitive.long)
    }

    @Test
    fun i16_aStatusReadNeverCountsAsProofOfExecution() {
        val harness = Harness(active(first))
        harness.port.verdict = { fence, _ ->
            if (fence == first) RuntimeHealthClass.BridgeFault else RuntimeHealthClass.Healthy
        }
        expectRefused { harness.gate.admit(harness.session.get()) }
        harness.session.set(active(second))
        harness.gate.serveApk(harness.session.get(), provesExecution = false) { ok() }
        assertEquals(1L, harness.gate.snapshot()["consecutive_withdrawals"]!!.jsonPrimitive.long)
        harness.gate.serveApk(harness.session.get(), provesExecution = true) { ok() }
        assertEquals(0L, harness.gate.snapshot()["consecutive_withdrawals"]!!.jsonPrimitive.long)
    }

    @Test
    fun i16_aDispatchThatThrowsIsSettledAsSuspiciousAndNeverRetried() {
        val harness = Harness(active(first))
        harness.port.verdict = { _, depth ->
            if (depth == RuntimeProbeDepth.Deep) RuntimeHealthClass.BridgeFault else RuntimeHealthClass.Healthy
        }
        val thrown = IllegalStateException("jni returned null")
        try {
            harness.gate.serveApk(harness.session.get(), true) {
                harness.dispatches.incrementAndGet()
                throw thrown
            }
            fail("the throw was swallowed")
        } catch (caught: IllegalStateException) {
            assertSame(thrown, caught)
        }
        assertEquals(1, harness.dispatches.get())
        assertFalse(harness.session.get().started)
        assertEquals(listOf(RuntimeHealthPhase.Settlement), harness.port.recordedPhases.toList())
    }

    @Test
    fun i16_withdrawalHoldsTheEstablishmentMonitorSoStartCannotInterleave() {
        val harness = Harness(active(first))
        harness.port.verdict = { _, _ -> RuntimeHealthClass.LeaseStale }
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val holder = Thread {
            synchronized(harness) {
                entered.countDown()
                release.await()
            }
        }
        holder.start()
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        val admitter = Thread { runCatching { harness.gate.admit(harness.session.get()) } }
        admitter.start()
        // While another caller holds the controller monitor (as start() does), nothing is withdrawn.
        Thread.sleep(200)
        assertTrue(harness.session.get().started)
        assertEquals(0, harness.port.records.get())
        release.countDown()
        admitter.join(5_000)
        holder.join(5_000)
        assertFalse(harness.session.get().started)
        assertEquals(1, harness.port.records.get())
        assertTrue(harness.gate.releasePending())
        harness.gate.releaseObserved()
        assertFalse(harness.gate.releasePending())
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

    @Test
    fun i16_anExecutorsOwnExceptionIsItsTypedFailureNotABridgeFault() {
        fun request() = AndroidExecutionRequest(
            primitive = AndroidPrimitive.PackageInspect,
            payload = byteArrayOf(),
            executionId = "00000000-0000-4000-8000-0000000000f1",
            runtimeEpoch = epoch,
            hostGeneration = 1,
            runtimeInstanceId = first.runtimeInstanceId,
        )
        // Before issue #2's fix this escaped to JNI and was answered as IO_ERROR on the shared bridge.
        val thrown = NativeAndroidExecutionDispatcher.dispatch(
            AndroidExecutionBridge { throw IllegalStateException("SecurityException from the platform") },
            request(),
        )
        assertEquals("INTERNAL_ERROR", thrown.errorCode)
        val typed = NativeAndroidExecutionDispatcher.dispatch(
            AndroidExecutionBridge { throw AndroidExecutionException("PERMISSION_DENIED") },
            request(),
        )
        assertEquals("PERMISSION_DENIED", typed.errorCode)
        val served = NativeAndroidExecutionDispatcher.dispatch(
            AndroidExecutionBridge { AndroidExecutionResult("ok".encodeToByteArray()) },
            request(),
        )
        assertNull(served.errorCode)
    }

    @Test
    fun i16_aWithdrawnInstancesTaskCountStopsHoldingTheForegroundService() {
        val seen = mutableListOf<Long>()
        NativeAndroidExecutionDispatcher.installTaskActivitySink(seen::add)
        seen.clear()
        NativeAndroidExecutionDispatcher.taskActivityChanged("epoch-i16", 2, 5)
        NativeAndroidExecutionDispatcher.forgetRuntimeTaskActivity()
        // The next instance republishes from a clean slate, even at the same store revision.
        NativeAndroidExecutionDispatcher.taskActivityChanged("epoch-i16", 2, 5)
        // A daemon-published count is the daemon's to forget, never the App Runtime's.
        NativeAndroidExecutionDispatcher.daemonTaskActivityChanged("epoch-i16-daemon", 1, 1)
        NativeAndroidExecutionDispatcher.forgetRuntimeTaskActivity()
        NativeAndroidExecutionDispatcher.forgetDaemonTaskActivity()
        NativeAndroidExecutionDispatcher.installTaskActivitySink(null)
        assertEquals(listOf(2L, 0L, 2L, 1L, 0L), seen)
    }

    @Test
    fun i16_kotlinHealthClassesMatchTheSharedNativeContract() {
        val text = checkNotNull(
            javaClass.classLoader?.getResourceAsStream("contract/runtime-health-classes.v1.json"),
        ).bufferedReader(Charsets.UTF_8).use { it.readText() }
        val fixture = Json.parseToJsonElement(text).jsonObject
        assertEquals(1L, fixture["schema_version"]!!.jsonPrimitive.long)
        val native = fixture["classes"]!!.jsonArray.map { it.jsonPrimitive.content }
        // Every class the native probe reports decodes to itself; only the Kotlin-side probe
        // failure is not a native class, so a rename can never silently become probe_failed.
        assertEquals(
            native,
            (RuntimeHealthClass.entries - RuntimeHealthClass.ProbeFailed).map { it.wire },
        )
        native.forEach { wire -> assertEquals(wire, RuntimeHealthClass.decode(wire).wire) }
    }
}
