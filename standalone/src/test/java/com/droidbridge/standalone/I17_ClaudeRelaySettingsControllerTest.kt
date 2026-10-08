package com.droidbridge.standalone

import com.droidbridge.standalone.runtimehost.ClaudeRelayRuntimePort
import com.droidbridge.standalone.runtimehost.ClaudeRelaySettingsController
import com.droidbridge.standalone.runtimehost.EncryptedTunnelCredential
import com.droidbridge.standalone.runtimehost.McpSettingsFileSystem
import com.droidbridge.standalone.runtimehost.RELAY_CALL_OK
import com.droidbridge.standalone.runtimehost.TUNNEL_RUNNING
import com.droidbridge.standalone.runtimehost.TUNNEL_STOPPED
import com.droidbridge.standalone.runtimehost.TunnelCredentialCipher
import com.droidbridge.standalone.runtimehost.TunnelNetworkMonitor
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Claude connector's settings: their own file, their own key, pairing that never sends the code. */
class I17_ClaudeRelaySettingsControllerTest {
    private val directory: File = Files.createTempDirectory("droidbridge-i17-relay").toFile()
    private val runtime = FakeRelay()
    private val network = FakeNetwork()
    private val cipher = FakeCipher()
    private val foreground = mutableListOf<Boolean>()

    private fun controller(runtime: FakeRelay = this.runtime, network: FakeNetwork = this.network) =
        ClaudeRelaySettingsController(
            directory, runtime, network, cipher, FakeFileSystem(),
            random = SecureRandom(), nowEpochMs = { NOW },
        )

    @Test
    fun i17_theRelayUrlIsNormalizedToAnHttpsOrigin() {
        assertEquals(ORIGIN, ClaudeRelaySettingsController.relayOrigin("https://Relay.Example.workers.dev/"))
        assertEquals(ORIGIN, ClaudeRelaySettingsController.relayOrigin("  https://relay.example.workers.dev:443  "))
        assertEquals("https://relay.example.com:8443", ClaudeRelaySettingsController.relayOrigin("https://relay.example.com:8443"))
        listOf(
            "",
            "http://relay.example.com",
            "https://relay.example.com/mcp",
            "https://relay.example.com/?q=1",
            "https://relay.example.com/#f",
            "https://user@relay.example.com",
            "relay.example.com",
            "https://${"a".repeat(260)}.com",
        ).forEach { assertNull(it, ClaudeRelaySettingsController.relayOrigin(it)) }
    }

    @Test
    fun i17_credentialsCommitToTheirOwnFileAndThePlaintextKeyNeverReachesDisk() {
        val controller = controller()
        val configured = controller.configure("https://relay.example.workers.dev/", DEVICE_KEY, foreground::add)
        assertTrue(boolean(configured, "configured"))
        assertFalse(boolean(configured, "enabled"))
        assertEquals(ORIGIN, string(configured, "relay_url"))
        assertEquals("$ORIGIN/mcp", string(configured, "connector_url"))
        assertEquals(ORIGIN to DEVICE_KEY, runtime.validated)
        val file = File(directory, "claude-relay.json")
        assertFalse(file.readText().contains(DEVICE_KEY))
        assertFalse("the OpenAI tunnel's file is untouched", File(directory, "tunnel.json").exists())
        assertTrue(foreground.isEmpty())

        controller.setEnabled(true, foreground::add)
        assertEquals(listOf(true), foreground)
        assertEquals(0, runtime.starts)
        network.emit(true)
        assertEquals(1, runtime.starts)
        assertEquals(ORIGIN to DEVICE_KEY, runtime.started)
        assertEquals(TUNNEL_RUNNING, string(controller.settings(), "state"))

        controller.setEnabled(false, foreground::add)
        assertEquals(TUNNEL_STOPPED, runtime.state())
        assertEquals(listOf(true, false), foreground)
    }

    @Test
    fun i17_malformedOrRefusedCredentialsAreNeverCommitted() {
        assertEquals("INVALID_CONFIG", error(controller().configure("http://relay.example.com", DEVICE_KEY, foreground::add)))
        assertEquals("INVALID_CONFIG", error(controller().configure(ORIGIN, "sk-openai-key", foreground::add)))
        assertNull("nothing reached the network", runtime.validated)
        for ((answer, expected) in listOf(
            "invalid_key" to "DEVICE_KEY_INVALID",
            "invalid_relay" to "RELAY_NOT_FOUND",
            "relay_not_configured" to "RELAY_NOT_CONFIGURED",
            "unavailable" to "RELAY_UNAVAILABLE",
            "unclassified" to "RELAY_UNAVAILABLE",
        )) {
            runtime.validation = answer
            assertEquals(answer, expected, error(controller().configure(ORIGIN, DEVICE_KEY, foreground::add)))
            assertFalse(File(directory, "claude-relay.json").exists())
        }
    }

    @Test
    fun i17_pairingPublishesOnlyTheCodeHashAndShowsTheCode() {
        val controller = controller()
        assertEquals("NOT_CONFIGURED", error(controller.pair()))
        controller.configure(ORIGIN, DEVICE_KEY, foreground::add)

        val reply = controller.pair()
        val shown = string(reply, "pairing_code")
        assertTrue(shown, Regex("[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}").matches(shown))
        assertEquals(NOW + 600_000L, string(reply, "expires_at_epoch_ms").toLong())
        val pairing = requireNotNull(runtime.paired)
        assertEquals(ORIGIN, pairing.relayUrl)
        assertEquals(DEVICE_KEY, pairing.deviceKey)
        assertEquals(600, pairing.ttlSeconds)
        assertEquals(sha256(shown.replace("-", "")), pairing.codeSha256)
        assertFalse(pairing.codeSha256.contains(shown.replace("-", "")))

        runtime.pairAnswer = "invalid_key"
        assertEquals("DEVICE_KEY_INVALID", error(controller.pair()))
        runtime.pairAnswer = "unavailable"
        assertEquals("RELAY_UNAVAILABLE", error(controller.pair()))
    }

    @Test
    fun i17_theKnownHashVectorMatchesTheRelay() {
        // relay/src normalizes "abcd-2345" to "ABCD2345" and hashes it the same way.
        assertEquals(sha256("ABCD2345"), ClaudeRelaySettingsController.pairingCodeSha256("ABCD2345"))
        assertEquals(64, ClaudeRelaySettingsController.pairingCodeSha256("ABCD2345").length)
    }

    @Test
    fun i17_revokingClaudeKeepsTheRelaySettings() {
        val controller = controller()
        assertEquals("NOT_CONFIGURED", error(controller.revokeClaude()))
        controller.configure(ORIGIN, DEVICE_KEY, foreground::add)
        assertTrue(boolean(controller.revokeClaude(), "configured"))
        assertEquals(ORIGIN to DEVICE_KEY, runtime.revoked)
        runtime.revokeAnswer = "invalid_relay"
        assertEquals("RELAY_NOT_FOUND", error(controller.revokeClaude()))
    }

    @Test
    fun i17_anEnabledRelayRestoresAfterProcessRecreationAndClearRemovesIt() {
        controller().run {
            configure(ORIGIN, DEVICE_KEY, foreground::add)
            setEnabled(true, foreground::add)
            suspendRuntime(foreground::add)
        }
        val restoredRuntime = FakeRelay()
        val restoredNetwork = FakeNetwork()
        val restored = controller(restoredRuntime, restoredNetwork)
        restored.restore(foreground::add)
        restoredNetwork.emit(true)
        assertEquals(ORIGIN to DEVICE_KEY, restoredRuntime.started)

        val cleared = restored.clear(foreground::add)
        assertFalse(boolean(cleared, "configured"))
        assertFalse(File(directory, "claude-relay.json").exists())
        assertTrue(cipher.deleted)
    }

    @Test
    fun i17_aTamperedSettingsFileIsRefusedNotTrusted() {
        controller().configure(ORIGIN, DEVICE_KEY, foreground::add)
        val file = File(directory, "claude-relay.json")
        file.writeText(file.readText().replace(ORIGIN, "http://attacker.example"))
        assertEquals("IO_ERROR", error(controller().settings()))
    }

    @Test
    fun i17_aSlowValidationCannotBlockServiceShutdownOrCommitAfterIt() {
        val controller = controller()
        val gate = CallGate()
        runtime.onValidate = { gate.block() }
        val reply = callWhileSuspending(controller, gate) {
            controller.configure(ORIGIN, DEVICE_KEY, foreground::add)
        }
        assertEquals("RELAY_UNAVAILABLE", error(reply))
        assertFalse(File(directory, "claude-relay.json").exists())
        assertEquals(TUNNEL_STOPPED, runtime.state())
    }

    @Test
    fun i17_slowPairAndRevokeCannotBlockServiceShutdownOrReportStaleSuccess() {
        val controller = controller()
        controller.configure(ORIGIN, DEVICE_KEY, foreground::add)
        val pairGate = CallGate()
        runtime.onPair = { pairGate.block() }
        val pairReply = callWhileSuspending(controller, pairGate, controller::pair)
        assertEquals("RELAY_UNAVAILABLE", error(pairReply))
        assertFalse(pairReply.contains("pairing_code"))

        controller.restore(foreground::add)
        val revokeGate = CallGate()
        runtime.onRevoke = { revokeGate.block() }
        val revokeReply = callWhileSuspending(controller, revokeGate, controller::revokeClaude)
        assertEquals("RELAY_UNAVAILABLE", error(revokeReply))
    }

    @Test
    fun i17_aSlowEarlierConfigurationCannotReplaceALaterConfiguration() {
        val controller = controller()
        val gate = CallGate()
        runtime.onValidate = { origin -> if (origin == ORIGIN) gate.block() }
        val earlierReply = AtomicReference<String?>()
        val earlier = Thread {
            earlierReply.set(controller.configure(ORIGIN, DEVICE_KEY, foreground::add))
        }
        earlier.start()
        try {
            assertTrue("earlier validation started", gate.entered.await(5, TimeUnit.SECONDS))
            assertTrue(boolean(controller.configure(OTHER_ORIGIN, DEVICE_KEY, foreground::add), "configured"))
        } finally {
            gate.release.countDown()
            earlier.join(5_000)
        }
        assertFalse("earlier validation ended", earlier.isAlive)
        assertEquals("RELAY_UNAVAILABLE", error(requireNotNull(earlierReply.get())))
        assertEquals(OTHER_ORIGIN, string(controller.settings(), "relay_url"))
    }

    private fun callWhileSuspending(
        controller: ClaudeRelaySettingsController,
        gate: CallGate,
        call: () -> String,
    ): String {
        val reply = AtomicReference<String?>()
        val operation = Thread { reply.set(call()) }
        var shutdown: Thread? = null
        operation.start()
        try {
            assertTrue("network call started", gate.entered.await(5, TimeUnit.SECONDS))
            val stopping = Thread { controller.suspendRuntime(foreground::add) }
            shutdown = stopping
            stopping.start()
            stopping.join(2_000)
            assertFalse("shutdown must not wait for the network", stopping.isAlive)
        } finally {
            gate.release.countDown()
            operation.join(5_000)
            shutdown?.join(5_000)
        }
        assertFalse("network call ended", operation.isAlive)
        return requireNotNull(reply.get())
    }

    private class CallGate {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)

        fun block() {
            entered.countDown()
            check(release.await(10, TimeUnit.SECONDS))
        }
    }

    private fun sha256(value: String): String =
        MessageDigest.getInstance("SHA-256").digest(value.encodeToByteArray()).joinToString("") { "%02x".format(it) }

    private fun boolean(reply: String, name: String): Boolean = string(reply, name).toBooleanStrict()

    private fun string(reply: String, name: String): String =
        Json.parseToJsonElement(reply).jsonObject.getValue(name).jsonPrimitive.content

    private fun error(reply: String): String = string(reply, "error")

    private data class Pairing(val relayUrl: String, val deviceKey: String, val codeSha256: String, val ttlSeconds: Int)

    private class FakeRelay : ClaudeRelayRuntimePort {
        var validation = "valid"
        var pairAnswer = RELAY_CALL_OK
        var revokeAnswer = RELAY_CALL_OK
        var validated: Pair<String, String>? = null
        var started: Pair<String, String>? = null
        var revoked: Pair<String, String>? = null
        var paired: Pairing? = null
        var starts = 0
        var onValidate: ((String) -> Unit)? = null
        var onPair: (() -> Unit)? = null
        var onRevoke: (() -> Unit)? = null
        private var current = TUNNEL_STOPPED

        override fun validate(relayUrl: String, deviceKey: String): String {
            validated = relayUrl to deviceKey
            onValidate?.invoke(relayUrl)
            return validation
        }

        override fun start(relayUrl: String, deviceKey: String): Boolean {
            starts += 1
            started = relayUrl to deviceKey
            current = TUNNEL_RUNNING
            return true
        }

        override fun stop(): Boolean {
            current = TUNNEL_STOPPED
            return true
        }

        override fun state(): String = current

        override fun lastCallEpochMs(): Long = 0

        override fun pair(relayUrl: String, deviceKey: String, codeSha256: String, ttlSeconds: Int): String {
            paired = Pairing(relayUrl, deviceKey, codeSha256, ttlSeconds)
            onPair?.invoke()
            return pairAnswer
        }

        override fun revoke(relayUrl: String, deviceKey: String): String {
            revoked = relayUrl to deviceKey
            onRevoke?.invoke()
            return revokeAnswer
        }
    }

    private class FakeNetwork : TunnelNetworkMonitor {
        var callback: ((Boolean) -> Unit)? = null

        override fun start(changed: (Boolean) -> Unit): Boolean {
            callback = changed
            return true
        }

        override fun stop() = Unit

        fun emit(available: Boolean) {
            callback?.invoke(available)
        }
    }

    private class FakeCipher : TunnelCredentialCipher {
        private val values = mutableMapOf<String, Pair<String, String>>()
        var deleted = false

        override fun encrypt(tunnelId: String, apiKey: String): EncryptedTunnelCredential {
            val id = UUID.randomUUID().toString()
            values[id] = tunnelId to apiKey
            return EncryptedTunnelCredential(id, "test-iv")
        }

        // Bound to the relay URL like the Keystore cipher's AAD: another URL cannot decrypt it.
        override fun decrypt(tunnelId: String, credential: EncryptedTunnelCredential): String {
            val (boundTo, value) = checkNotNull(values[credential.ciphertext])
            check(boundTo == tunnelId)
            return value
        }

        override fun deleteKey() {
            deleted = true
            values.clear()
        }
    }

    private class FakeFileSystem : McpSettingsFileSystem {
        override fun restrictToOwner(file: File) = Unit
        override fun isOwnerOnly(file: File): Boolean = true
        override fun syncDirectory(directory: File) = Unit
    }

    private companion object {
        const val ORIGIN = "https://relay.example.workers.dev"
        const val OTHER_ORIGIN = "https://replacement.example.workers.dev"
        const val DEVICE_KEY = "dbrk_TESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTES"
        const val NOW = 1_791_300_000_000L
    }
}
