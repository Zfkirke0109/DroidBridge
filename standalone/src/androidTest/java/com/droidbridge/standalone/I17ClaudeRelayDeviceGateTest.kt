package com.droidbridge.standalone

import android.os.ParcelFileDescriptor
import android.os.Process
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.droidbridge.standalone.client.DroidBridgeClient
import com.droidbridge.ui.client.ClientState
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assume.assumeFalse
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The 0.5.1 standalone service exposes Claude connector state through its real Binder. Restart
 * only the debug app's separate Runtime process; no relay credentials or public endpoint are used.
 */
@RunWith(AndroidJUnit4::class)
class I17ClaudeRelayDeviceGateTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext

    @Test
    fun unconfiguredClaudeConnectorStaysStoppedAfterRuntimeProcessRecovery() = runBlocking {
        // A device gate must never restart the user's release DroidBridge process.
        assumeTrue("requires the standalone debug app", context.packageName.endsWith(".debug"))
        val client = DroidBridgeClient(context)
        try {
            client.bind()
            withTimeout(RUNTIME_AVAILABLE_TIMEOUT_MS) {
                client.state.filterIsInstance<ClientState.Available>().first()
            }
            val before = JSONObject(client.claudeRelaySettings())
            assertEquals(1, before.getInt("schema_version"))
            assumeFalse("requires an unconfigured debug connector", before.getBoolean("configured"))
            assertUnconfigured(before)

            val oldPid = runtimePid()
            assertNotEquals("must not kill the test process", Process.myPid(), oldPid)
            val disconnected = async(start = CoroutineStart.UNDISPATCHED) {
                withTimeout(DISCONNECT_TIMEOUT_MS) {
                    client.state.filterIsInstance<ClientState.Unavailable>().first()
                }
            }
            Process.killProcess(oldPid)
            assertEquals("RUNTIME_UNAVAILABLE", disconnected.await().reason)

            withTimeout(RUNTIME_AVAILABLE_TIMEOUT_MS) {
                client.state.filterIsInstance<ClientState.Available>().first()
            }
            assertNotEquals("the Runtime must be a new process", oldPid, runtimePid())
            assertUnconfigured(JSONObject(client.claudeRelaySettings()))
        } finally {
            client.unbind()
        }
    }

    private fun assertUnconfigured(settings: JSONObject) {
        assertEquals(settings.toString(), 1, settings.getInt("schema_version"))
        assertFalse(settings.toString(), settings.getBoolean("configured"))
        assertFalse(settings.toString(), settings.getBoolean("enabled"))
        assertEquals(settings.toString(), "stopped", settings.getString("state"))
        assertFalse(settings.toString(), settings.has("relay_url"))
        assertFalse(settings.toString(), settings.has("connector_url"))
        assertFalse(settings.toString(), settings.has("last_error"))
    }

    private fun runtimePid(): Int {
        val processName = "${context.packageName}:runtime"
        val descriptor = instrumentation.uiAutomation.executeShellCommand("pidof $processName")
        val output = ParcelFileDescriptor.AutoCloseInputStream(descriptor)
            .bufferedReader().use { it.readText().trim() }
        return output.toIntOrNull() ?: error("Expected one $processName process, got '$output'")
    }

    private companion object {
        const val RUNTIME_AVAILABLE_TIMEOUT_MS = 60_000L
        const val DISCONNECT_TIMEOUT_MS = 15_000L
    }
}
