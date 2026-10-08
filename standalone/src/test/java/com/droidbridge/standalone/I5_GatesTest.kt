package com.droidbridge.standalone

import com.droidbridge.ui.client.AvailabilityFact
import com.droidbridge.ui.client.AvailabilityState
import com.droidbridge.ui.client.CapabilityAction
import com.droidbridge.ui.client.CapabilityRowKey
import com.droidbridge.ui.client.CapabilityRowState
import com.droidbridge.standalone.client.CapabilityRows
import com.droidbridge.ui.client.RefreshCoordinator
import com.droidbridge.ui.client.RuntimeReadiness
import com.droidbridge.ui.client.RuntimeSnapshot
import com.droidbridge.ui.client.ClientState
import com.droidbridge.ui.client.resolveContextRefresh
import com.droidbridge.standalone.execution.android.AndroidExecutionBridge
import com.droidbridge.standalone.execution.android.AndroidExecutionRegistry
import com.droidbridge.standalone.execution.android.AndroidExecutionResult
import com.droidbridge.standalone.execution.android.NativeAndroidExecutionDispatcher
import com.droidbridge.standalone.execution.android.CapabilityRegistration
import com.droidbridge.standalone.execution.android.RegisteredCapabilityState
import com.droidbridge.standalone.runtimehost.NativeRuntime
import com.droidbridge.standalone.runtimehost.NativeHostHealth
import com.droidbridge.standalone.runtimehost.RuntimeFence
import com.droidbridge.standalone.runtimehost.RuntimeHostController
import com.droidbridge.standalone.runtimehost.RuntimeSessionState
import com.droidbridge.standalone.runtimehost.RuntimeDeepProbeBudget
import com.droidbridge.standalone.runtimehost.RuntimeHostHealthGate
import com.droidbridge.standalone.runtimehost.RuntimeHostHealthPort
import com.droidbridge.standalone.runtimehost.HostHealthPhase
import com.droidbridge.standalone.runtimehost.diagnosticSession
import com.droidbridge.standalone.runtimehost.suspiciousRuntimeReply
import com.droidbridge.standalone.runtimehost.businessReplyProvesExecution
import com.droidbridge.standalone.runtimehost.validatedByNativeHealth
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class I5_GatesTest {
    @Test
    fun I5_G01_apkRuntimeProjectionRetainsAuthoritativeHostIdentity() {
        val snapshot = snapshot(readiness = RuntimeReadiness.Ready, hostGeneration = 7)

        assertEquals("apk_runtime", snapshot.host)
        assertEquals(7, snapshot.hostGeneration)
        assertEquals(RuntimeReadiness.Ready, snapshot.readiness)
    }

    @Test
    fun I5_G02_binderHintsRequireAnAuthoritativeRefresh() {
        val coordinator = RefreshCoordinator()

        assertEquals(0L, coordinator.hint(1_000))
        coordinator.started(1_000)
        assertNull(coordinator.hint(1_001))
        assertEquals(99L, coordinator.finished(1_001))
    }

    @Test
    fun I5_G03_androidRegistrationRejectsStaleGenerationAndInvalidExecutorState() {
        val calls = mutableListOf<List<Any>>()
        val registry = AndroidExecutionRegistry { key, state, reason, generation, hasExecutor ->
            calls += listOf(key, state, reason, generation, hasExecutor)
            true
        }
        val executor = AndroidExecutionBridge { AndroidExecutionResult(byteArrayOf()) }

        assertTrue(registry.register(registration("visual.accessibility", 2, executor)))
        assertFalse(registry.register(registration("visual.accessibility", 1, executor)))
        assertSame(executor, registry.executor("visual.accessibility", 2))
        assertNull(registry.executor("visual.accessibility", 1))
        assertEquals(1, calls.size)
        val rejected = runCatching {
            registry.register(
                CapabilityRegistration(
                    "visual.accessibility",
                    RegisteredCapabilityState.Unavailable,
                    "DISCONNECTED",
                    3,
                    executor,
                ),
            )
        }
        assertTrue(rejected.isFailure)
    }

    @Test
    fun I5_G04_uiProjectsCapabilityTruthWithoutOwningIt() {
        val rows = CapabilityRows.project(
            snapshot(
                grants = allUnavailable(),
                capabilities = allCapabilitiesUnavailable(),
            ),
            notificationListenerGranted = true,
        )

        assertEquals(
            listOf(
                CapabilityRowKey.Runtime,
                CapabilityRowKey.Shizuku,
                CapabilityRowKey.LocalNetwork,
                CapabilityRowKey.NotificationAccess,
                CapabilityRowKey.ExactAlarm,
                CapabilityRowKey.Accessibility,
                CapabilityRowKey.ScreenCapture,
            ),
            rows.map { it.key },
        )
        assertEquals(CapabilityAction.StartCapture, rows.last().action)
    }

    @Test
    fun I5_G04_defaultAndRuntimeProcessesHaveDisjointGraphRoles() {
        val packageName = "com.droidbridge.standalone"

        assertEquals(ProcessRole.Default, classifyProcess(packageName, packageName))
        assertEquals(ProcessRole.Runtime, classifyProcess("$packageName:runtime", packageName))
        assertEquals(ProcessRole.Unexpected, classifyProcess("$packageName:other", packageName))
    }

    @Test
    fun I5_G03_downstreamAdaptersRegisterThroughOneGenerationFencedSurface() {
        val accepted = mutableListOf<String>()
        val registry = AndroidExecutionRegistry { key, _, _, _, _ -> accepted += key; true }
        val shizuku = AndroidExecutionBridge { AndroidExecutionResult(byteArrayOf(1)) }
        val androidFramework = AndroidExecutionBridge { AndroidExecutionResult(byteArrayOf(2)) }

        assertTrue(registry.register(registration("shizuku.shell", 11, shizuku)))
        assertTrue(registry.register(registration("android.framework", 12, androidFramework)))
        assertSame(shizuku, registry.executor("shizuku.shell", 11))
        assertSame(androidFramework, registry.executor("android.framework", 12))
        assertEquals(listOf("shizuku.shell", "android.framework"), accepted)
    }

    @Test
    fun I5_G09_refreshStartsAreRateLimitedAndDirtyHintsCoalesce() {
        val coordinator = RefreshCoordinator(100)

        assertEquals(0L, coordinator.hint(0))
        coordinator.started(0)
        repeat(20) { assertNull(coordinator.hint(it.toLong() + 1)) }
        assertEquals(79L, coordinator.finished(21))
        coordinator.started(100)
        assertNull(coordinator.finished(101))
        assertEquals(0L, coordinator.hint(200))
    }

    @Test
    fun I5_G08_cleanupQuarantineHasDiagnosticsAndNeverRetry() {
        val rows = CapabilityRows.project(
            snapshot(
                readiness = RuntimeReadiness.Unavailable,
                runtimeReason = "CLEANUP_UNVERIFIED",
            ),
            notificationListenerGranted = true,
        )
        val runtime = rows.first { it.key == CapabilityRowKey.Runtime }

        assertEquals(CapabilityRowState.Unavailable, runtime.state)
        assertEquals(CapabilityAction.Diagnostics, runtime.action)
        assertFalse(rows.any { it.key == CapabilityRowKey.Runtime && it.action == CapabilityAction.Retry })
    }

    @Test
    fun I5_G09_failedRefreshWithdrawsStaleProjectionUntilValidatedSnapshot() {
        val response = byteArrayOf(1)
        val rejected: (ByteArray) -> RuntimeSnapshot = { error("invalid response") }

        assertEquals(ClientState.Unavailable("RUNTIME_UNAVAILABLE"), resolveContextRefresh(null))
        assertEquals(
            ClientState.Unavailable("STORE_UNAVAILABLE"),
            resolveContextRefresh(response, rejected) { "STORE_UNAVAILABLE" },
        )
        assertEquals(
            ClientState.Unavailable("PROTOCOL_MISMATCH"),
            resolveContextRefresh(response, rejected) { null },
        )
        val restored = resolveContextRefresh(response, decode = { snapshot(hostGeneration = 9) })

        assertTrue(restored is ClientState.Available)
        assertEquals(9L, (restored as ClientState.Available).snapshot.hostGeneration)
    }

    @Test
    fun I5_G02_activationRecoveryRemainsInsideTheNativeAuthoritativeHost() {
        val nativeMethods = NativeRuntime::class.java.declaredMethods
            .filter { java.lang.reflect.Modifier.isNative(it.modifiers) }
            .map { it.name }

        assertTrue("nativeStart" in nativeMethods)
        assertTrue("nativeValidateHost" in nativeMethods)
        assertTrue("nativeProbeHost" in nativeMethods)
        assertTrue("nativeRecordHostHealthFault" in nativeMethods)
        assertTrue("nativeQuarantineHost" in nativeMethods)
        assertTrue("nativeLifetimeReleased" in nativeMethods)
        assertTrue("nativeSubmit" in nativeMethods)
        assertEquals(
            listOf(ByteArray::class.java, String::class.java, java.lang.Long.TYPE, String::class.java),
            NativeRuntime::class.java.getDeclaredMethod(
                "nativeSubmit",
                ByteArray::class.java,
                String::class.java,
                java.lang.Long.TYPE,
                String::class.java,
            ).parameterTypes.toList(),
        )
    }

    @Test
    fun I5_G05_runtimeSessionReadersObserveOnlyWholeGenerationBoundSnapshots() {
        val inactive = RuntimeSessionState()
        val first = RuntimeSessionState(
            started = true,
            activeFence = RuntimeFence("epoch-a", 1, "instance-a"),
            startFailure = "",
        )
        val second = RuntimeSessionState(
            started = true,
            activeFence = RuntimeFence("epoch-a", 2, "instance-b"),
            startFailure = "",
        )
        val session = AtomicReference(inactive)
        val invalid = AtomicBoolean(false)
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(3)
        val futures = listOf(
            pool.submit {
                start.await()
                repeat(10_000) {
                    session.set(first)
                    session.compareAndSet(first, inactive)
                }
            },
            pool.submit {
                start.await()
                repeat(10_000) {
                    session.set(second)
                    session.compareAndSet(second, inactive)
                }
            },
            pool.submit {
                start.await()
                repeat(20_000) {
                    val observed = session.get()
                    if (observed.started != (observed.activeFence != null) ||
                        (observed.started && observed.startFailure.isNotEmpty())
                    ) {
                        invalid.set(true)
                    }
                }
            },
        )
        start.countDown()
        futures.forEach { it.get() }
        pool.shutdownNow()

        assertFalse(invalid.get())
        assertTrue(first.validates("epoch-a", 1, "instance-a"))
        assertFalse(first.validates("epoch-a", 2, "instance-b"))
    }

    @Test
    fun I5_G05_cachedSessionRequiresTheSameReadyNativeInstance() {
        val session = RuntimeSessionState(
            started = true,
            activeFence = RuntimeFence("epoch-a", 7, "instance-a"),
            startFailure = "",
        )
        assertSame(session, session.validatedByNativeHealth("READY"))
        for (failure in listOf("STALE_AUTHORITY", "CAPABILITY_UNAVAILABLE", "IO_ERROR")) {
            val withdrawn = session.validatedByNativeHealth(failure)
            assertFalse(withdrawn.started)
            assertEquals(failure, withdrawn.startFailure)
        }
        assertEquals("INTERNAL_ERROR", session.validatedByNativeHealth(null).startFailure)
        assertEquals("CAPABILITY_UNAVAILABLE", session.validatedByNativeHealth("unknown").startFailure)
    }

    @Test
    fun I5_G05_diagnosticsNeverReportsAStartedSessionWithoutMatchingStatus() {
        val active = RuntimeSessionState(
            started = true,
            activeFence = RuntimeFence("epoch-a", 7, "instance-a"),
            startFailure = "",
        )
        assertSame(active, diagnosticSession(active, active, statusAvailable = true))
        val noStatus = diagnosticSession(active, active, statusAvailable = false)
        assertFalse(noStatus.started)
        assertEquals("CAPABILITY_UNAVAILABLE", noStatus.startFailure)
        val withdrawn = active.validatedByNativeHealth("STALE_AUTHORITY")
        assertEquals("STALE_AUTHORITY", diagnosticSession(active, withdrawn, false).startFailure)
        val replacement = active.copy(activeFence = RuntimeFence("epoch-a", 8, "instance-b"))
        assertFalse(diagnosticSession(active, replacement, statusAvailable = true).started)
    }

    @Test
    fun I5_G05_frameworkProbeReadsTheLiveGenerationWithoutRunningAnExecutor() {
        val executions = java.util.concurrent.atomic.AtomicInteger()
        val registry = AndroidExecutionRegistry { _, _, _, _, _ -> true }
        val executor = AndroidExecutionBridge {
            executions.incrementAndGet()
            AndroidExecutionResult(byteArrayOf())
        }
        NativeAndroidExecutionDispatcher.install(registry)
        try {
            assertFalse(NativeAndroidExecutionDispatcher.probeExecutor("android.framework", 7))
            assertTrue(registry.register(registration("android.framework", 7, executor)))
            assertTrue(NativeAndroidExecutionDispatcher.probeExecutor("android.framework", 7))
            assertFalse(NativeAndroidExecutionDispatcher.probeExecutor("android.framework", 8))
            assertFalse(NativeAndroidExecutionDispatcher.probeExecutor("shizuku.shell", 7))
            assertEquals(0, executions.get())
        } finally {
            NativeAndroidExecutionDispatcher.uninstall(registry)
        }
    }

    @Test
    fun I5_G05_suspiciousFailuresReprobeAtMostOncePerFiveSecondsPerInstance() {
        val budget = RuntimeDeepProbeBudget()
        val first = RuntimeFence("epoch-a", 7, "instance-a")
        val replacement = RuntimeFence("epoch-a", 8, "instance-b")
        assertTrue(budget.claim(first, 1_000))
        assertFalse(budget.claim(first, 5_999))
        assertTrue(budget.claim(first, 6_000))
        assertTrue(budget.claim(replacement, 6_001))
        assertFalse(budget.claim(first, 6_002))
        assertFalse(budget.claim(replacement, 6_003))
        for (code in listOf("IO_ERROR", "INTERNAL_ERROR", "RESOURCE_LIMIT")) {
            assertTrue(suspiciousRuntimeReply("""{"outcome":"error","error":{"code":"$code"}}""".encodeToByteArray()))
        }
        assertTrue(suspiciousRuntimeReply(byteArrayOf()))
        assertTrue(suspiciousRuntimeReply("not json".encodeToByteArray()))
        assertFalse(suspiciousRuntimeReply("""{"outcome":"error","error":{"code":"NOT_FOUND"}}""".encodeToByteArray()))
        assertFalse(suspiciousRuntimeReply("""{"outcome":"success","result":{}}""".encodeToByteArray()))
        assertEquals(NativeHostHealth.StoreUnwritable, NativeHostHealth.decode("store_unwritable"))
        assertEquals(NativeHostHealth.ProbeBusy, NativeHostHealth.decode("probe_busy"))
        assertTrue(NativeHostHealth.ProbeBusy.defersAdmission)
        assertTrue(NativeHostHealth.NotReady.defersAdmission)
        assertFalse(NativeHostHealth.BridgeFault.defersAdmission)
        assertFalse(NativeHostHealth.ResourceExhausted.defersAdmission)
        assertEquals(NativeHostHealth.ProbeFailed, NativeHostHealth.decode("unknown"))
        assertEquals(NativeHostHealth.ProbeFailed, NativeHostHealth.decode(null))
    }

    @Test
    fun I5_G05_unhealthyHostWithdrawsRecordsThenQuarantinesBeforeReplacement() {
        val fence = RuntimeFence("epoch", 7, "instance")
        val active = RuntimeSessionState(started = true, activeFence = fence, startFailure = "")
        val sessions = AtomicReference(active)
        val events = mutableListOf<String>()
        var released = false
        val port = object : RuntimeHostHealthPort {
            override fun recordFault(fence: RuntimeFence, health: NativeHostHealth, phase: HostHealthPhase): Boolean {
                events += "record:${health.wire}:${phase.wire}"
                return true
            }
            override fun quarantine(fence: RuntimeFence): Boolean {
                events += "quarantine"
                return true
            }
            override fun lifetimeReleased(): Boolean = released
        }
        val gate = RuntimeHostHealthGate(sessions, Any(), port) { events += "projection" }
        assertTrue(gate.admissionCompleted(active))
        assertTrue(gate.withdraw(active, NativeHostHealth.ResourceExhausted, HostHealthPhase.Admission))
        assertFalse(gate.admissionCompleted(active))
        assertEquals("RESOURCE_LIMIT", sessions.get().startFailure)
        assertFalse(gate.mayEstablish())
        assertEquals(15_000L, gate.establishmentRetryMillis())
        assertFalse(gate.withdraw(active, NativeHostHealth.ResourceExhausted, HostHealthPhase.Admission))
        released = true
        assertTrue(gate.mayEstablish())
        assertEquals(listOf("record:resource_exhausted:admission", "quarantine", "projection"), events)
    }

    @Test
    fun I5_G05_initialProbeCannotAdmitASessionWithdrawnWhileItWasBlocked() {
        val active = RuntimeSessionState(
            started = true,
            activeFence = RuntimeFence("epoch", 7, "instance"),
            startFailure = "",
        )
        val sessions = AtomicReference(active)
        val gate = RuntimeHostHealthGate(sessions, Any(), object : RuntimeHostHealthPort {
            override fun recordFault(fence: RuntimeFence, health: NativeHostHealth, phase: HostHealthPhase) = true
            override fun quarantine(fence: RuntimeFence) = true
            override fun lifetimeReleased() = true
        }) {}
        gate.requireDeepProbe(requireNotNull(active.activeFence))
        assertFalse(gate.admissionCompleted(active))
        assertEquals(5_000L, gate.establishmentRetryMillis())
        assertTrue(gate.initialProbePending(requireNotNull(active.activeFence)))
        gate.markInitialProbeHealthy(requireNotNull(active.activeFence))
        assertTrue(gate.admissionCompleted(active))
        sessions.set(RuntimeSessionState(startFailure = "HOST_TRANSITION_PENDING"))
        assertFalse(gate.admissionCompleted(active))
        sessions.set(RuntimeSessionState(
            started = true,
            activeFence = RuntimeFence("next-epoch", 8, "next-instance"),
            startFailure = "",
        ))
        assertFalse(gate.admissionCompleted(active))
    }

    @Test
    fun I5_G05_oldInconclusiveProbeCannotReplaceSuccessorsPendingDeepProof() {
        val old = RuntimeSessionState(true, RuntimeFence("epoch", 7, "old"), "")
        val next = RuntimeSessionState(true, RuntimeFence("epoch", 8, "next"), "")
        val sessions = AtomicReference(old)
        val gate = RuntimeHostHealthGate(sessions, Any(), object : RuntimeHostHealthPort {
            override fun recordFault(fence: RuntimeFence, health: NativeHostHealth, phase: HostHealthPhase) = true
            override fun quarantine(fence: RuntimeFence) = true
            override fun lifetimeReleased() = true
        }) {}
        sessions.set(next)
        gate.requireDeepProbe(requireNotNull(next.activeFence))
        assertFalse(gate.requireDeepProbeIfCurrent(old))
        assertTrue(gate.initialProbePending(requireNotNull(next.activeFence)))
        assertFalse(gate.admissionCompleted(next))
    }

    @Test
    fun I5_G05_withdrawnProjectionCleanupFinishesBeforeSuccessorAdmission() {
        val monitor = Any()
        val old = RuntimeSessionState(true, RuntimeFence("epoch", 7, "old"), "")
        val next = RuntimeSessionState(true, RuntimeFence("epoch", 8, "next"), "")
        val sessions = AtomicReference(old)
        val callbackEntered = CountDownLatch(1)
        val finishCallback = CountDownLatch(1)
        val establishAttempted = CountDownLatch(1)
        val nextInstalled = CountDownLatch(1)
        val gate = RuntimeHostHealthGate(sessions, monitor, object : RuntimeHostHealthPort {
            override fun recordFault(fence: RuntimeFence, health: NativeHostHealth, phase: HostHealthPhase) = true
            override fun quarantine(fence: RuntimeFence) = true
            override fun lifetimeReleased() = true
        }) {
            callbackEntered.countDown()
            check(finishCallback.await(2, TimeUnit.SECONDS))
        }
        val workers = Executors.newFixedThreadPool(2)
        try {
            val withdraw = workers.submit<Boolean> {
                gate.withdraw(old, NativeHostHealth.HostMissing, HostHealthPhase.Settlement)
            }
            assertTrue(callbackEntered.await(2, TimeUnit.SECONDS))
            val establish = workers.submit {
                establishAttempted.countDown()
                synchronized(monitor) { sessions.set(next) }
                nextInstalled.countDown()
            }
            assertTrue(establishAttempted.await(2, TimeUnit.SECONDS))
            assertFalse(nextInstalled.await(100, TimeUnit.MILLISECONDS))
            finishCallback.countDown()
            assertTrue(withdraw.get(2, TimeUnit.SECONDS))
            establish.get(2, TimeUnit.SECONDS)
            assertSame(next, sessions.get())
        } finally {
            finishCallback.countDown()
            workers.shutdownNow()
        }
    }

    @Test
    fun I5_G05_consecutiveWithdrawalsBackOffAndOnlyBusinessSuccessResetsTheCount() {
        var now = 1_000L
        val sessions = AtomicReference(RuntimeSessionState())
        val port = object : RuntimeHostHealthPort {
            override fun recordFault(fence: RuntimeFence, health: NativeHostHealth, phase: HostHealthPhase) = true
            override fun quarantine(fence: RuntimeFence) = true
            override fun lifetimeReleased() = true
        }
        val gate = RuntimeHostHealthGate(sessions, Any(), port, nowMillis = { now }) {}
        fun fail(generation: Long) {
            val active = RuntimeSessionState(true, RuntimeFence("epoch", generation, "instance-$generation"), "")
            sessions.set(active)
            assertTrue(gate.withdraw(active, NativeHostHealth.StoreUnreadable, HostHealthPhase.Admission))
        }

        fail(1)
        assertTrue(gate.mayEstablish())
        fail(2)
        assertTrue(gate.mayEstablish())
        fail(3)
        assertFalse(gate.mayEstablish())
        assertEquals(30_000L, gate.establishmentRetryMillis())
        now += 30_000
        assertTrue(gate.mayEstablish())
        fail(4)
        assertEquals(60_000L, gate.establishmentRetryMillis())
        now += 60_000
        assertTrue(gate.mayEstablish())

        val active = RuntimeSessionState(true, RuntimeFence("epoch", 5, "instance-5"), "")
        sessions.set(active)
        gate.businessResponseServed(active)
        fail(6)
        assertTrue(gate.mayEstablish())
        fail(7)
        assertTrue(gate.mayEstablish())
        fail(8)
        assertEquals(30_000L, gate.establishmentRetryMillis())
        gate.clearBreaker()
        assertTrue(gate.mayEstablish())
    }

    @Test
    fun I5_G05_onlySuccessfulBusinessRepliesProveHostRecovery() {
        val success = """{"outcome":"success","result":{}}""".encodeToByteArray()
        val status = """{"payload":{"tool":"context"}}""".encodeToByteArray()
        val taskControl = """{"payload":{"tool":"task_control"}}""".encodeToByteArray()
        val business = """{"payload":{"tool":"device"}}""".encodeToByteArray()
        assertFalse(businessReplyProvesExecution(status, success))
        assertFalse(businessReplyProvesExecution(taskControl, success))
        assertTrue(businessReplyProvesExecution(business, success))
        assertFalse(businessReplyProvesExecution(business, """{"outcome":"error","error":{"code":"NOT_FOUND"}}""".encodeToByteArray()))
        assertFalse(businessReplyProvesExecution("not json".encodeToByteArray(), success))
    }

    @Test
    fun I5_G07_physicalFixtureBenchmarkHasOneBoundedNativeEntryPoint() {
        val benchmark = NativeRuntime::class.java.getDeclaredMethod(
            "nativeRunI5DeviceBenchmark",
            String::class.java,
        )

        assertEquals(String::class.java, benchmark.returnType)
        assertEquals(listOf(String::class.java), benchmark.parameterTypes.toList())
    }

    @Test
    fun I5_G11_hostControllerPublishesOneSessionAuthorityField() {
        val fields = RuntimeHostController::class.java.declaredFields.map { it.name }

        assertTrue("runtimeSession" in fields)
        assertFalse("started" in fields)
        assertFalse("host" in fields)
        assertFalse("activeFence" in fields)
        assertFalse("startFailure" in fields)
        assertTrue(
            runCatching {
                RuntimeSessionState(
                    started = true,
                    activeFence = null,
                    startFailure = "",
                )
            }.isFailure,
        )
    }

    @Test
    fun I5_G04_providerFixturesHideOnlyActuallyCoveredAccessRows() {
        val grants = allUnavailable().toMutableMap().apply {
            this["shizuku.shell"] = available()
        }
        val capabilities = allCapabilitiesUnavailable().toMutableMap().apply {
            this["visual.hierarchy"] = available()
            this["visual.image"] = available()
        }
        val keys = CapabilityRows.project(snapshot(grants = grants, capabilities = capabilities), notificationListenerGranted = true).map { it.key }

        assertTrue(CapabilityRowKey.Shizuku in keys)
        assertFalse(CapabilityRowKey.Accessibility in keys)
        assertFalse(CapabilityRowKey.ScreenCapture in keys)
        assertTrue(CapabilityRowKey.NotificationAccess in keys)
    }

    @Test
    fun I5_G04_unknownProviderFactsNeverOfferAuthorizationOrCapture() {
        val rows = CapabilityRows.project(
            snapshot(
                grants = allUnknown(),
                capabilities = capabilityKeys.associateWith { unknown() },
            ),
            notificationListenerGranted = true,
        )
        val conditionalRows = rows.filter { it.key !in providerKeys }

        assertTrue(conditionalRows.isNotEmpty())
        assertTrue(conditionalRows.all { it.state == CapabilityRowState.Unknown })
        assertTrue(conditionalRows.all { it.action == CapabilityAction.Recheck })
    }

    private fun registration(
        key: String,
        generation: Long,
        executor: AndroidExecutionBridge,
    ) = CapabilityRegistration(
        key = key,
        state = RegisteredCapabilityState.Available,
        reason = null,
        sourceGeneration = generation,
        executor = executor,
    )

    private fun snapshot(
        readiness: RuntimeReadiness = RuntimeReadiness.Ready,
        runtimeReason: String? = null,
        hostGeneration: Long = 1,
        grants: Map<String, AvailabilityFact> = allUnknown(),
        capabilities: Map<String, AvailabilityFact> = allCapabilitiesUnavailable(),
    ) = RuntimeSnapshot(
        sdkInt = 37,
        host = "apk_runtime",
        hostGeneration = hostGeneration,
        readiness = readiness,
        runtimeReason = runtimeReason,
        grants = grants,
        capabilities = capabilities,
    )

    private fun allUnknown() = grantKeys.associateWith { unknown() }
    private fun allUnavailable() = grantKeys.associateWith { unavailable() }
    private fun allCapabilitiesUnavailable() = capabilityKeys.associateWith { unavailable() }
    private fun available() = AvailabilityFact(AvailabilityState.Available)
    private fun unavailable() = AvailabilityFact(AvailabilityState.Unavailable, "MISSING")
    private fun unknown() = AvailabilityFact(AvailabilityState.Unknown, "ADAPTER_NOT_READY")

    private companion object {
        val grantKeys = listOf(
            "android.local_network",
            "android.notification_listener",
            "automation.exact_alarm",
            "visual.accessibility",
            "visual.media_projection_session",
            "shizuku.shell",
        )
        val capabilityKeys = listOf("automation.persistent_time", "visual.hierarchy", "visual.image")
        val providerKeys = setOf(
            CapabilityRowKey.Runtime,
            CapabilityRowKey.Shizuku,
        )
    }
}
