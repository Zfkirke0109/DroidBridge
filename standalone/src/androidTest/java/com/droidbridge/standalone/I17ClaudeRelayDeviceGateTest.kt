package com.droidbridge.standalone

import android.os.ParcelFileDescriptor
import android.os.Process
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.droidbridge.standalone.client.DroidBridgeClient
import com.droidbridge.ui.client.ClientState
import java.io.File
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The 0.5.1 standalone service exposes Claude connector state through its real Binder. These
 * gates restart only the debug app's separate Runtime process and never provision relay secrets.
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
            awaitRuntime(client)
            val before = JSONObject(client.claudeRelaySettings())
            assertEquals(1, before.getInt("schema_version"))
            assumeFalse("requires an unconfigured debug connector", before.getBoolean("configured"))
            assertUnconfigured(before)

            restartRuntime(client)
            assertUnconfigured(JSONObject(client.claudeRelaySettings()))
        } finally {
            client.unbind()
        }
    }

    @Test
    fun configuredClaudeConnectorRestoresItsSettingsAfterRuntimeProcessRecovery() = runBlocking {
        assumeTrue("requires the standalone debug app", context.packageName.endsWith(".debug"))
        val client = DroidBridgeClient(context)
        try {
            client.bind()
            awaitRuntime(client)
            val before = JSONObject(client.claudeRelaySettings())
            assumeTrue("requires a configured debug connector", before.getBoolean("configured"))
            assertPublicStatus(before)
            assertEquals(1, before.getInt("schema_version"))
            val relayOrigin = before.getString("relay_url")
            val wasEnabled = before.getBoolean("enabled")
            val wasRunning = before.getString("state") == "running"
            assertTrue("relay origin must use HTTPS", relayOrigin.startsWith("https://"))
            assertTrue("connector URL must derive from the relay origin", before.getString("connector_url") == "$relayOrigin/mcp")

            // The fresh process must reload these values from the debug app's protected settings.
            val stored = JSONObject(File(
                context.createDeviceProtectedStorageContext().filesDir,
                "droidbridge/claude-relay.json",
            ).readText())
            assertEquals(1, stored.getInt("schema_version"))
            assertEquals(wasEnabled, stored.getBoolean("enabled"))
            assertTrue("stored relay origin changed", stored.getString("relay_url") == relayOrigin)
            assertTrue("stored credentials must be encrypted", stored.has("ciphertext") && stored.has("iv"))
            assertTrue("stored settings exposed an unexpected field", stored.keys().asSequence().all { it in STORED_SETTINGS_FIELDS })
            assertFalse("stored settings exposed a device key", DEVICE_KEY_PATTERN.containsMatchIn(stored.toString()))

            restartRuntime(client)
            val after = JSONObject(client.claudeRelaySettings())
            assertPublicStatus(after)
            assertEquals(1, after.getInt("schema_version"))
            assertTrue("configured relay was lost after Runtime recovery", after.getBoolean("configured"))
            assertEquals("enabled preference changed after Runtime recovery", wasEnabled, after.getBoolean("enabled"))
            assertTrue("relay origin changed after Runtime recovery", after.getString("relay_url") == relayOrigin)
            assertTrue("connector URL changed after Runtime recovery", after.getString("connector_url") == "$relayOrigin/mcp")
            if (wasEnabled) {
                assertNotEquals("enabled relay stayed stopped after Runtime recovery", "stopped", after.getString("state"))
                if (wasRunning) {
                    withTimeout(RELAY_RECONNECT_TIMEOUT_MS) {
                        while (JSONObject(client.claudeRelaySettings()).getString("state") != "running") delay(500)
                    }
                }
            } else {
                assertEquals("disabled relay restarted after Runtime recovery", "stopped", after.getString("state"))
            }
        } finally {
            client.unbind()
        }
    }

    private fun assertUnconfigured(settings: JSONObject) {
        assertPublicStatus(settings)
        assertEquals(1, settings.getInt("schema_version"))
        assertFalse(settings.getBoolean("configured"))
        assertFalse(settings.getBoolean("enabled"))
        assertEquals("stopped", settings.getString("state"))
        assertFalse(settings.has("relay_url"))
        assertFalse(settings.has("connector_url"))
        assertFalse(settings.has("last_error"))
    }

    private fun assertPublicStatus(settings: JSONObject) {
        assertTrue("relay status exposed a private field", settings.keys().asSequence().all { it in PUBLIC_STATUS_FIELDS })
        assertFalse("relay status exposed a device key", DEVICE_KEY_PATTERN.containsMatchIn(settings.toString()))
    }

    private suspend fun awaitRuntime(client: DroidBridgeClient) {
        withTimeout(RUNTIME_AVAILABLE_TIMEOUT_MS) {
            client.state.filterIsInstance<ClientState.Available>().first()
        }
    }

    private suspend fun restartRuntime(client: DroidBridgeClient) = coroutineScope {
        val oldPid = runtimePid()
        assertNotEquals("must not kill the test process", Process.myPid(), oldPid)
        val disconnected = async(start = CoroutineStart.UNDISPATCHED) {
            withTimeout(DISCONNECT_TIMEOUT_MS) {
                client.state.filterIsInstance<ClientState.Unavailable>().first()
            }
        }
        Process.killProcess(oldPid)
        assertEquals("RUNTIME_UNAVAILABLE", disconnected.await().reason)
        awaitRuntime(client)
        assertNotEquals("the Runtime must be a new process", oldPid, runtimePid())
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
        const val RELAY_RECONNECT_TIMEOUT_MS = 60_000L
        val DEVICE_KEY_PATTERN = Regex("dbrk_[A-Za-z0-9_-]{43}")
        val PUBLIC_STATUS_FIELDS = setOf(
            "schema_version", "configured", "enabled", "state", "relay_url", "connector_url",
            "reason", "last_call_epoch_ms", "last_error", "protocol_version",
        )
        val STORED_SETTINGS_FIELDS = setOf(
            "schema_version", "enabled", "relay_url", "ciphertext", "iv", "first_call_epoch_ms",
        )
    }
}
