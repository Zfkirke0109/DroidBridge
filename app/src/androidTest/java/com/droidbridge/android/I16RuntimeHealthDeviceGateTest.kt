package com.droidbridge.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.droidbridge.android.client.ClientState
import com.droidbridge.android.client.DroidBridgeClient
import com.droidbridge.android.product.mcp.McpListenerState
import com.droidbridge.android.product.mcp.McpSettingsReplies
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.util.UUID
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Issue #2 on a real device, against the debug package's own store only: ordinary traffic never
 * withdraws a healthy APK Runtime, and an instance whose lifetime lease went stale is refused,
 * recorded and replaced by the next request instead of staying ready.
 */
@RunWith(AndroidJUnit4::class)
class I16RuntimeHealthDeviceGateTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val canonicalBase =
        File(context.createDeviceProtectedStorageContext().filesDir, "droidbridge")

    @Test
    fun ordinaryTrafficNeverWithdrawsAHealthyApkRuntime() = runBlocking {
        withApkListener { endpoint, token ->
            val before = healthFaults()
            repeat(ORDINARY_CALLS) { index ->
                served(call(endpoint, token, 100 + index, "context", "status", JSONObject()))
                served(
                    call(
                        endpoint, token, 200 + index, "command", "run",
                        JSONObject().put("command", "printf health-$index").put("run_as", "app"),
                    ),
                )
            }
            assertEquals("health faults during ordinary traffic", before, healthFaults())
        }
    }

    @Test
    fun aStaleLeaseIsRefusedRecordedAndReplacedByTheNextRequest() = runBlocking {
        withApkListener { endpoint, token ->
            served(call(endpoint, token, 300, "context", "status", JSONObject()))
            val faultsBefore = healthFaults()
            // Another identity now claims the lifetime: the live instance's lease is stale.
            val live = File(canonicalBase, "runtime-live.json")
            val record = JSONObject(live.readText())
            val staleGeneration = record.getLong("host_generation")
            record.put("runtime_instance_id", UUID.randomUUID().toString())
            val replacement = File(canonicalBase, "runtime-live.json.i16")
            replacement.writeText(record.toString())
            assertTrue(replacement.renameTo(live))

            val refused = call(
                endpoint, token, 301, "command", "run",
                JSONObject().put("command", "printf must-not-run").put("run_as", "app"),
            )
            val refusal = structured(refused)
            assertTrue(refused.toString(), refused.getJSONObject("result").getBoolean("isError"))
            assertEquals(refused.toString(), "CAPABILITY_UNAVAILABLE", refusal.getString("code"))
            assertTrue(refused.toString(), refusal.optString("message").contains("lease_stale"))

            val recorded = healthFaults() - faultsBefore.toSet()
            assertTrue(
                recorded.toString(),
                recorded.any { it == "health_admission:lease_stale@g$staleGeneration" },
            )

            // Only a later request establishes the next instance, which then executes.
            val deadline = System.currentTimeMillis() + REPLACEMENT_TIMEOUT_MS
            var status: JSONObject
            while (true) {
                status = call(endpoint, token, 302, "context", "status", JSONObject())
                if (!status.getJSONObject("result").getBoolean("isError")) break
                assertTrue("no replacement instance: $status", System.currentTimeMillis() < deadline)
                delay(POLL_MS)
            }
            val command = served(
                call(
                    endpoint, token, 303, "command", "run",
                    JSONObject().put("command", "printf replaced").put("run_as", "app"),
                ),
            )
            assertEquals(command.toString(), "completed", command.getString("state"))
            assertEquals(command.toString(), "replaced", command.getString("stdout"))
            val replacedLive = JSONObject(live.readText())
            assertFalse(
                replacedLive.toString(),
                replacedLive.getString("runtime_instance_id") == record.getString("runtime_instance_id"),
            )
        }
    }

    /** Phases of the Runtime health records in the host fault file, oldest first. */
    private fun healthFaults(): List<String> {
        val file = File(canonicalBase, "diagnostics/host.json")
        if (!file.exists()) return emptyList()
        val records = JSONObject(file.readText()).getJSONArray("records")
        return (0 until records.length())
            .map { records.getJSONObject(it) }
            .filter { it.getString("component") == "apk_runtime_health" }
            .map { it.getString("phase") }
    }

    private suspend fun withApkListener(block: suspend (String, String) -> Unit) {
        val client = DroidBridgeClient(context)
        var enabled = false
        try {
            client.bind()
            withTimeout(RUNTIME_AVAILABLE_TIMEOUT_MS) {
                client.state.filterIsInstance<ClientState.Available>().first()
            }
            val settings = McpSettingsReplies.settings(client.setMcpEnabled(true))
            assertEquals(McpListenerState.Running, settings?.listener)
            enabled = true
            val token = requireNotNull(McpSettingsReplies.token(client.revealMcpToken()))
            val endpoint = requireNotNull(settings).endpoint
            val status = served(call(endpoint, token, 1, "context", "status", JSONObject()))
            assumeTrue(
                "the APK Runtime is not the host on this device",
                status.getJSONObject("runtime").getString("host") == APK_RUNTIME,
            )
            block(endpoint, token)
        } finally {
            if (enabled) client.setMcpEnabled(false)
            client.unbind()
        }
    }

    private fun served(response: JSONObject): JSONObject {
        assertFalse("refused: $response", response.getJSONObject("result").getBoolean("isError"))
        return structured(response)
    }

    private fun structured(response: JSONObject): JSONObject {
        assertFalse("JSON-RPC error: $response", response.has("error"))
        val result = response.getJSONObject("result")
        assertEquals("complete", result.getString("resultType"))
        return result.getJSONObject("structuredContent")
    }

    private fun call(
        endpoint: String,
        token: String,
        id: Int,
        tool: String,
        action: String,
        input: JSONObject,
    ): JSONObject {
        val meta = JSONObject()
            .put("io.modelcontextprotocol/protocolVersion", PROTOCOL_VERSION)
            .put("io.modelcontextprotocol/clientCapabilities", JSONObject())
        val body = JSONObject()
            .put("jsonrpc", "2.0")
            .put("id", id)
            .put("method", "tools/call")
            .put(
                "params",
                JSONObject()
                    .put("name", tool)
                    .put("arguments", JSONObject().put("action", action).put("input", input))
                    .put("_meta", meta),
            )
            .toString()
            .toByteArray(Charsets.UTF_8)
        val target = URI(endpoint)
        val head = buildString {
            append("POST ${target.rawPath} HTTP/1.1\r\n")
            append("Host: ${target.host}:${target.port}\r\n")
            append("Authorization: Bearer $token\r\n")
            append("Content-Type: application/json\r\n")
            append("Accept: application/json, text/event-stream\r\n")
            append("MCP-Protocol-Version: $PROTOCOL_VERSION\r\n")
            append("Mcp-Method: tools/call\r\n")
            append("Mcp-Name: $tool\r\n")
            append("Content-Length: ${body.size}\r\n")
            append("Connection: close\r\n\r\n")
        }.toByteArray(Charsets.UTF_8)
        val answered = Socket().use { socket ->
            socket.connect(InetSocketAddress(target.host, target.port), CONNECT_TIMEOUT_MS)
            socket.soTimeout = CALL_TIMEOUT_MS
            socket.getOutputStream().apply {
                write(head)
                write(body)
                flush()
            }
            socket.getInputStream().readBytes().decodeToString()
        }
        val boundary = answered.indexOf("\r\n\r\n")
        assertTrue("no header terminator: $answered", boundary >= 0)
        val status = answered.substring(0, boundary).substringBefore("\r\n")
        assertTrue("HTTP $status", status.startsWith("HTTP/1.1 200 "))
        return JSONObject(answered.substring(boundary + 4)).also { assertNotNull(it) }
    }

    private companion object {
        const val APK_RUNTIME = "apk_runtime"
        const val PROTOCOL_VERSION = "2026-07-28"
        const val ORDINARY_CALLS = 20
        const val RUNTIME_AVAILABLE_TIMEOUT_MS = 60_000L
        const val REPLACEMENT_TIMEOUT_MS = 30_000L
        const val POLL_MS = 500L
        const val CONNECT_TIMEOUT_MS = 15_000
        const val CALL_TIMEOUT_MS = 120_000
    }
}
