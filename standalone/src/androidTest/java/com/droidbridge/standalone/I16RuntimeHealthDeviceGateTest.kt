package com.droidbridge.standalone

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Bundle
import android.os.IBinder
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.droidbridge.standalone.runtimehost.IDroidBridgeRuntime
import com.droidbridge.standalone.runtimehost.IRuntimeCallback
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Issue #2 against only the separate debug APK. Ordinary requests must leave a healthy host
 * alone; a stale lifetime lease must refuse execution, record the fault and admit a successor.
 * The test binds the Runtime directly, so it never changes the app's local MCP settings.
 */
@RunWith(AndroidJUnit4::class)
class I16RuntimeHealthDeviceGateTest {
    private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private val canonicalBase = File(context.createDeviceProtectedStorageContext().filesDir, "droidbridge")

    @Test
    fun healthSnapshotReportsSessionAndWithdrawalState() {
        withDebugRuntime { runtime -> reportDiagnostic(runtime, "standalone_snapshot") }
    }

    @Test
    fun ordinaryTrafficNeverWithdrawsAHealthyApkRuntime() {
        withDebugRuntime { runtime ->
            awaitHealthyRuntime(runtime)
            val faultsBefore = healthFaults()
            repeat(ORDINARY_CALLS) { index ->
                served(submit(runtime, request("context", "status", JSONObject().put("detail", "full"))))
                val command = served(submit(runtime, commandRequest("printf health-$index")))
                assertEquals(command.toString(), "completed", command.getString("state"))
                assertEquals(command.toString(), "health-$index", command.getString("stdout"))
            }
            assertEquals("ordinary traffic created a health fault", faultsBefore, healthFaults())
        }
    }

    @Test
    fun aStaleLeaseIsRefusedRecordedAndReplacedByTheNextRequest() {
        withDebugRuntime { runtime ->
            awaitHealthyRuntime(runtime)
            val faultsBefore = healthFaults().toSet()
            val live = File(canonicalBase, "runtime-live.json")
            assertTrue("debug Runtime has no live lease", live.isFile)
            val stale = JSONObject(live.readText())
            val generation = stale.getLong("host_generation")
            val injectedInstanceId = UUID.randomUUID().toString()
            stale.put("runtime_instance_id", injectedInstanceId)
            val replacement = File(canonicalBase, "runtime-live.json.i16-${UUID.randomUUID()}")
            try {
                replacement.writeText(stale.toString())
                assertTrue("could not atomically replace the debug lease", replacement.renameTo(live))
            } finally {
                replacement.delete()
            }

            val refused = submit(runtime, commandRequest("printf must-not-run"))
            assertEquals(refused.toString(), "error", refused.getString("outcome"))
            assertEquals(refused.toString(), "STALE_AUTHORITY", refused.getJSONObject("error").getString("code"))
            assertTrue(
                "the stale lease was not recorded",
                (healthFaults().toSet() - faultsBefore).contains("health_admission:lease_stale@g$generation"),
            )
            reportDiagnostic(runtime, "after_refusal")

            // The refused request is never retried. A later request establishes the successor.
            val deadline = SystemClock.elapsedRealtime() + REPLACEMENT_TIMEOUT_MS
            var status: JSONObject
            while (true) {
                status = submit(runtime, request("context", "status", JSONObject().put("detail", "full")))
                if (status.optString("outcome") == "success" && appGuardAvailable(status)) break
                if (SystemClock.elapsedRealtime() >= deadline) {
                    reportDiagnostic(runtime, "successor_timeout")
                    error("no successor Runtime with an available App command guard: $status")
                }
                SystemClock.sleep(POLL_MS)
            }
            assertEquals("apk_runtime", status.getJSONObject("result").getJSONObject("runtime").getString("host"))
            val command = served(submit(runtime, commandRequest("printf replaced")))
            assertEquals(command.toString(), "completed", command.getString("state"))
            assertEquals(command.toString(), "replaced", command.getString("stdout"))
            val health = JSONObject(runtime.getDiagnosticsSnapshot()).getJSONObject("health")
            assertEquals("lease_stale", health.getJSONObject("last").getString("class"))
            assertEquals("admission", health.getJSONObject("last").getString("phase"))
            assertFalse("diagnostics still show a withdrawal in progress", health.getBoolean("withdrawal_in_progress"))
            assertFalse("diagnostics exposed a Runtime instance ID", health.toString().contains("runtime_instance_id"))
            val successor = JSONObject(live.readText())
            assertFalse("injected lease still owns the Runtime", successor.getString("runtime_instance_id") == injectedInstanceId)
        }
    }

    private fun healthFaults(): List<String> {
        val file = File(canonicalBase, "diagnostics/host.json")
        if (!file.exists()) return emptyList()
        val records = JSONObject(file.readText()).getJSONArray("records")
        return (0 until records.length())
            .map { records.getJSONObject(it) }
            .filter { it.getString("component") == "apk_runtime_health" }
            .map { it.getString("phase") }
    }

    private fun awaitHealthyRuntime(runtime: IDroidBridgeRuntime) {
        val deadline = SystemClock.elapsedRealtime() + RUNTIME_AVAILABLE_TIMEOUT_MS
        while (true) {
            val status = submit(runtime, request("context", "status", JSONObject().put("detail", "full")))
            if (status.optString("outcome") == "success") {
                assertEquals("apk_runtime", status.getJSONObject("result").getJSONObject("runtime").getString("host"))
                if (appGuardAvailable(status)) return
            }
            assertTrue(
                "debug APK Runtime's App command guard never became ready: $status",
                SystemClock.elapsedRealtime() < deadline,
            )
            SystemClock.sleep(POLL_MS)
        }
    }

    private fun appGuardAvailable(status: JSONObject): Boolean = status.optJSONObject("result")
        ?.optJSONObject("grants")
        ?.optJSONObject("execution.app_guard")
        ?.optString("state") == "available"

    private fun reportDiagnostic(runtime: IDroidBridgeRuntime, phase: String) {
        val snapshot = JSONObject(runtime.getDiagnosticsSnapshot())
        val summary = JSONObject()
            .put("phase", phase)
            .put("session", snapshot.optJSONObject("session") ?: JSONObject())
            .put("health", snapshot.optJSONObject("health") ?: JSONObject())
            .toString()
            .take(MAX_DIAGNOSTIC_CHARS)
        InstrumentationRegistry.getInstrumentation().sendStatus(
            0,
            Bundle().apply { putString("i16_health_snapshot", summary) },
        )
        assertTrue("debug Runtime snapshot has no session", snapshot.has("session"))
        assertTrue("debug Runtime snapshot has no health", snapshot.has("health"))
    }

    private fun served(response: JSONObject): JSONObject {
        assertEquals(response.toString(), "success", response.getString("outcome"))
        return response.getJSONObject("result")
    }

    private fun commandRequest(command: String): ByteArray = request(
        "command",
        "run",
        JSONObject().put("command", command).put("run_as", "app"),
    )

    private fun request(tool: String, action: String, input: JSONObject): ByteArray = JSONObject()
        .put("protocol_version", 1)
        .put("request_id", UUID.randomUUID().toString())
        .put("payload", JSONObject().put("tool", tool).put("action", action).put("input", input))
        .toString()
        .toByteArray(Charsets.UTF_8)

    private fun submit(runtime: IDroidBridgeRuntime, request: ByteArray): JSONObject {
        val latch = CountDownLatch(1)
        var response: ByteArray? = null
        runtime.submit(request, object : IRuntimeCallback.Stub() {
            override fun onResponse(value: ByteArray?) {
                response = value
                latch.countDown()
            }
        })
        assertTrue("Runtime did not answer", latch.await(CALL_TIMEOUT_SECONDS, TimeUnit.SECONDS))
        return JSONObject(requireNotNull(response).toString(Charsets.UTF_8))
    }

    private fun withDebugRuntime(block: (IDroidBridgeRuntime) -> Unit) {
        // Check before binding, and especially before the stale-lease test writes any file.
        assertEquals("device gate must target the separate debug APK", DEBUG_PACKAGE, context.packageName)
        val connected = CountDownLatch(1)
        var runtime: IDroidBridgeRuntime? = null
        val connection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName, binder: IBinder) {
                runtime = IDroidBridgeRuntime.Stub.asInterface(binder)
                connected.countDown()
            }

            override fun onServiceDisconnected(name: ComponentName) = Unit
        }
        val intent = Intent().setComponent(ComponentName(DEBUG_PACKAGE, RUNTIME_SERVICE))
        assertTrue(context.bindService(intent, connection, Context.BIND_AUTO_CREATE))
        try {
            assertTrue("debug Runtime did not bind", connected.await(10, TimeUnit.SECONDS))
            block(requireNotNull(runtime))
        } finally {
            context.unbindService(connection)
        }
    }

    private companion object {
        const val DEBUG_PACKAGE = "com.droidbridge.standalone.debug"
        const val RUNTIME_SERVICE = "com.droidbridge.standalone.runtimehost.DroidBridgeService"
        const val ORDINARY_CALLS = 20
        const val CALL_TIMEOUT_SECONDS = 120L
        const val RUNTIME_AVAILABLE_TIMEOUT_MS = 60_000L
        const val REPLACEMENT_TIMEOUT_MS = 75_000L
        const val POLL_MS = 500L
        const val MAX_DIAGNOSTIC_CHARS = 2_048
    }
}
