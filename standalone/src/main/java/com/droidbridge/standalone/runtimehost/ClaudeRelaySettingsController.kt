package com.droidbridge.standalone.runtimehost

import com.droidbridge.ui.product.mcp.MCP_PROTOCOL_VERSION
import java.io.File
import java.io.FileOutputStream
import java.net.URI
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.security.SecureRandom
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** The Claude relay's native side: the tunnel client at the user's relay, and its one-shot calls. */
internal interface ClaudeRelayRuntimePort {
    fun validate(relayUrl: String, deviceKey: String): String
    fun start(relayUrl: String, deviceKey: String): Boolean
    fun stop(): Boolean
    fun state(): String
    fun lastCallEpochMs(): Long
    fun lastError(): String? = null
    fun pair(relayUrl: String, deviceKey: String, codeSha256: String, ttlSeconds: Int): String
    fun revoke(relayUrl: String, deviceKey: String): String
}

internal class NativeClaudeRelayRuntime(
    private val port: Int,
    private val productVersion: String,
) : ClaudeRelayRuntimePort {
    override fun validate(relayUrl: String, deviceKey: String): String =
        NativeRuntime.nativeRelayValidate(relayUrl, deviceKey, productVersion) ?: RELAY_CALL_UNAVAILABLE

    override fun start(relayUrl: String, deviceKey: String): Boolean =
        NativeRuntime.nativeRelayStart(port, relayUrl, deviceKey, productVersion)

    override fun stop(): Boolean = NativeRuntime.nativeRelayStop()

    override fun state(): String = NativeRuntime.nativeRelayState() ?: TUNNEL_FAILED

    override fun lastCallEpochMs(): Long = NativeRuntime.nativeRelayLastCall()

    override fun lastError(): String? = NativeRuntime.nativeRelayLastError()

    override fun pair(relayUrl: String, deviceKey: String, codeSha256: String, ttlSeconds: Int): String =
        NativeRuntime.nativeRelayPair(relayUrl, deviceKey, codeSha256, ttlSeconds, productVersion)
            ?: RELAY_CALL_UNAVAILABLE

    override fun revoke(relayUrl: String, deviceKey: String): String =
        NativeRuntime.nativeRelayRevoke(relayUrl, deviceKey, productVersion) ?: RELAY_CALL_UNAVAILABLE
}

/**
 * The Claude connector (relay/DESIGN.md): the user's own relay URL and the relay's device key.
 * It is a credential domain of its own: its own settings file, its own Keystore alias, and no
 * shared state with the OpenAI tunnel or the Local MCP token. Lifecycle follows the tunnel: an
 * enabled relay holds the foreground and dials out only while a default network is available.
 */
internal class ClaudeRelaySettingsController(
    directory: File,
    private val runtime: ClaudeRelayRuntimePort,
    private val network: TunnelNetworkMonitor,
    private val cipher: TunnelCredentialCipher,
    private val fileSystem: McpSettingsFileSystem,
    private val random: SecureRandom = SecureRandom(),
    private val nowEpochMs: () -> Long = System::currentTimeMillis,
) {
    private val file = File(directory, FILE_NAME)
    private val lock = Any()
    private var committed: Committed? = null
    private var loaded = false
    private var generation = 0L
    private var watching = false
    private var failure: String? = null

    /** Told whether the committed preference keeps a connection enabled, whenever that may have changed. */
    @Volatile
    var enabledObserver: ((Boolean) -> Unit)? = null
        set(value) {
            field = value
            value?.invoke(synchronized(lock) { load().getOrNull()?.enabled == true })
        }

    private data class Committed(
        val enabled: Boolean,
        val relayUrl: String,
        val credential: EncryptedTunnelCredential,
        /** When Claude first called through this relay; first setup finishes on it after a restart too. */
        val firstCallEpochMs: Long? = null,
    )

    fun settings(): String = synchronized(lock) {
        load().fold({ status(it) }) { IO_ERROR }
    }

    fun configure(relayUrl: String, deviceKey: String, foreground: (Boolean) -> Unit): String = synchronized(lock) {
        val origin = relayOrigin(relayUrl) ?: return INVALID_CONFIG
        if (!isDeviceKey(deviceKey)) return INVALID_CONFIG
        when (runtime.validate(origin, deviceKey)) {
            RELAY_CALL_VALID -> Unit
            RELAY_CALL_INVALID_KEY -> return DEVICE_KEY_INVALID
            RELAY_CALL_INVALID_RELAY -> return RELAY_NOT_FOUND
            RELAY_CALL_NOT_CONFIGURED -> return RELAY_NOT_CONFIGURED
            else -> return RELAY_UNAVAILABLE
        }
        val current = load().getOrElse { return IO_ERROR }
        val credential = runCatching { cipher.encrypt(origin, deviceKey) }.getOrElse { return IO_ERROR }
        val next = commit(Committed(current?.enabled == true, origin, credential)).getOrElse { return IO_ERROR }
        if (next.enabled) restart(foreground)
        status(next)
    }

    fun setEnabled(enabled: Boolean, foreground: (Boolean) -> Unit): String = synchronized(lock) {
        val current = load().getOrElse { return IO_ERROR } ?: return NOT_CONFIGURED
        if (enabled) {
            val next = if (current.enabled) current else commit(current.copy(enabled = true)).getOrElse { return IO_ERROR }
            if (current.enabled) restart(foreground) else start(foreground)
            status(next)
        } else {
            stop(foreground)
            val next = if (!current.enabled) current else commit(current.copy(enabled = false)).getOrElse { return IO_ERROR }
            status(next)
        }
    }

    /**
     * Publishes a fresh pairing code's hash to the relay and returns the code for the user to type
     * into the relay's consent page. The code never leaves the phone except on screen.
     */
    fun pair(): String = synchronized(lock) {
        val current = load().getOrElse { return IO_ERROR } ?: return NOT_CONFIGURED
        val deviceKey = deviceKey(current) ?: return CREDENTIALS_UNAVAILABLE_ERROR
        val code = pairingCode(random)
        when (runtime.pair(current.relayUrl, deviceKey, pairingCodeSha256(code), PAIRING_TTL_SECONDS)) {
            RELAY_CALL_OK -> Unit
            RELAY_CALL_INVALID_KEY -> return DEVICE_KEY_INVALID
            RELAY_CALL_INVALID_RELAY -> return RELAY_NOT_FOUND
            RELAY_CALL_NOT_CONFIGURED -> return RELAY_NOT_CONFIGURED
            else -> return RELAY_UNAVAILABLE
        }
        buildJsonObject {
            put("schema_version", SCHEMA_VERSION)
            put("pairing_code", "${code.substring(0, 4)}-${code.substring(4)}")
            put("expires_at_epoch_ms", nowEpochMs() + PAIRING_TTL_SECONDS * 1_000L)
        }.toString()
    }

    /** Revokes every grant Claude holds at the relay; the relay settings themselves stay. */
    fun revokeClaude(): String = synchronized(lock) {
        val current = load().getOrElse { return IO_ERROR } ?: return NOT_CONFIGURED
        val deviceKey = deviceKey(current) ?: return CREDENTIALS_UNAVAILABLE_ERROR
        when (runtime.revoke(current.relayUrl, deviceKey)) {
            RELAY_CALL_OK -> status(current)
            RELAY_CALL_INVALID_KEY -> DEVICE_KEY_INVALID
            RELAY_CALL_INVALID_RELAY -> RELAY_NOT_FOUND
            RELAY_CALL_NOT_CONFIGURED -> RELAY_NOT_CONFIGURED
            else -> RELAY_UNAVAILABLE
        }
    }

    fun clear(foreground: (Boolean) -> Unit): String = synchronized(lock) {
        load().getOrElse { return IO_ERROR }
        stop(foreground)
        runCatching {
            if (file.exists()) {
                check(file.delete())
                fileSystem.syncDirectory(checkNotNull(file.parentFile))
            }
            cipher.deleteKey()
        }.getOrElse { return IO_ERROR }
        committed = null
        loaded = true
        enabledObserver?.invoke(false)
        status(null)
    }

    fun restore(foreground: (Boolean) -> Unit) {
        synchronized(lock) {
            val current = load().getOrNull() ?: return
            if (current.enabled) start(foreground)
        }
    }

    fun suspendRuntime(foreground: (Boolean) -> Unit) {
        synchronized(lock) { stop(foreground) }
    }

    private fun deviceKey(current: Committed): String? =
        runCatching { cipher.decrypt(current.relayUrl, current.credential) }.getOrNull()?.takeIf(::isDeviceKey)

    private fun start(foreground: (Boolean) -> Unit) {
        if (watching) return
        try {
            foreground(true)
        } catch (_: RuntimeException) {
            failure = FGS_START_REJECTED
            return
        }
        if (runtime.state() == TUNNEL_FAILED) runtime.stop()
        failure = null
        generation += 1
        val expected = generation
        if (!network.start { available -> networkChanged(expected, available) }) {
            failure = NETWORK_MONITOR_FAILED
            foreground(false)
            return
        }
        watching = true
    }

    private fun restart(foreground: (Boolean) -> Unit) {
        network.stop()
        watching = false
        runtime.stop()
        generation += 1
        start(foreground)
    }

    private fun stop(foreground: (Boolean) -> Unit) {
        generation += 1
        network.stop()
        watching = false
        runtime.stop()
        failure = null
        foreground(false)
    }

    private fun networkChanged(expected: Long, available: Boolean) {
        synchronized(lock) {
            if (expected != generation) return
            val current = committed?.takeIf { it.enabled } ?: return
            if (!available) {
                runtime.stop()
                return
            }
            val deviceKey = deviceKey(current) ?: run {
                failure = CREDENTIALS_UNAVAILABLE
                return
            }
            failure = if (runtime.start(current.relayUrl, deviceKey)) null else RELAY_RUNTIME_FAILED
        }
    }

    private fun status(current: Committed?): String {
        val observedCall = runtime.lastCallEpochMs().takeIf { it > 0 }
        val settings = if (current != null && current.firstCallEpochMs == null && observedCall != null) {
            commit(current.copy(firstCallEpochMs = observedCall)).getOrDefault(current)
        } else {
            current
        }
        val nativeState = runtime.state().takeIf { it in STATES } ?: TUNNEL_FAILED
        val state = when {
            settings?.enabled != true -> TUNNEL_STOPPED
            failure != null || nativeState == TUNNEL_FAILED -> TUNNEL_FAILED
            nativeState == TUNNEL_RUNNING -> TUNNEL_RUNNING
            else -> TUNNEL_CONNECTING
        }
        val reason = failure ?: RELAY_RUNTIME_FAILED.takeIf { state == TUNNEL_FAILED }
        return buildJsonObject {
            put("schema_version", SCHEMA_VERSION)
            put("configured", settings != null)
            put("enabled", settings?.enabled == true)
            put("state", state)
            if (settings != null) {
                put("relay_url", settings.relayUrl)
                put("connector_url", "${settings.relayUrl}/mcp")
            }
            if (reason != null) put("reason", reason)
            (observedCall ?: settings?.firstCallEpochMs)?.let { put("last_call_epoch_ms", it) }
            runtime.lastError()?.takeIf { state == TUNNEL_CONNECTING || state == TUNNEL_FAILED }
                ?.takeIf { LAST_ERROR.matches(it) }?.let { put("last_error", it) }
            put("protocol_version", MCP_PROTOCOL_VERSION)
        }.toString()
    }

    private fun load(): Result<Committed?> {
        if (loaded) return Result.success(committed)
        if (!file.exists()) {
            loaded = true
            return Result.success(null)
        }
        return runCatching {
            check(fileSystem.isOwnerOnly(file))
            decode(file.readText())
        }.onSuccess {
            committed = it
            loaded = true
        }
    }

    private fun commit(next: Committed): Result<Committed> = runCatching {
        val directory = checkNotNull(file.parentFile)
        check(directory.isDirectory || directory.mkdirs())
        val temporary = File(directory, "$FILE_NAME.tmp")
        try {
            FileOutputStream(temporary).use { output ->
                fileSystem.restrictToOwner(temporary)
                output.write(encode(next).encodeToByteArray())
                output.fd.sync()
            }
            Files.move(
                temporary.toPath(),
                file.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
            fileSystem.syncDirectory(directory)
            check(fileSystem.isOwnerOnly(file))
        } finally {
            if (temporary.exists()) check(temporary.delete())
        }
        committed = next
        loaded = true
        enabledObserver?.invoke(next.enabled)
        next
    }.onFailure {
        committed = null
        loaded = false
    }

    internal companion object {
        /** Read by the root module's keep-alive too: it reads only `schema_version` and `enabled`. */
        const val FILE_NAME = "claude-relay.json"
        const val SCHEMA_VERSION = 1
        const val PAIRING_TTL_SECONDS = 600
        private const val FGS_START_REJECTED = "FGS_START_REJECTED"
        private const val NETWORK_MONITOR_FAILED = "NETWORK_MONITOR_FAILED"
        private const val CREDENTIALS_UNAVAILABLE = "CREDENTIALS_UNAVAILABLE"
        private const val RELAY_RUNTIME_FAILED = "RELAY_RUNTIME_FAILED"
        private const val IO_ERROR = """{"schema_version":1,"error":"IO_ERROR"}"""
        private const val INVALID_CONFIG = """{"schema_version":1,"error":"INVALID_CONFIG"}"""
        private const val NOT_CONFIGURED = """{"schema_version":1,"error":"NOT_CONFIGURED"}"""
        private const val RELAY_NOT_FOUND = """{"schema_version":1,"error":"RELAY_NOT_FOUND"}"""
        private const val RELAY_NOT_CONFIGURED = """{"schema_version":1,"error":"RELAY_NOT_CONFIGURED"}"""
        private const val DEVICE_KEY_INVALID = """{"schema_version":1,"error":"DEVICE_KEY_INVALID"}"""
        private const val RELAY_UNAVAILABLE = """{"schema_version":1,"error":"RELAY_UNAVAILABLE"}"""
        private const val CREDENTIALS_UNAVAILABLE_ERROR = """{"schema_version":1,"error":"CREDENTIALS_UNAVAILABLE"}"""
        private val DEVICE_KEY = Regex("dbrk_[A-Za-z0-9_-]{43}")
        private val LAST_ERROR = Regex("[a-z0-9_]{1,40}")
        private const val MAX_RELAY_URL_LENGTH = 256
        private const val MAX_CIPHERTEXT_LENGTH = 1024
        private const val MAX_IV_LENGTH = 64

        /** Crockford base32: no I, L, O or U, so a code read aloud or retyped stays unambiguous. */
        private const val PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
        private const val PAIRING_LENGTH = 8

        fun isDeviceKey(value: String): Boolean = DEVICE_KEY.matches(value)

        /**
         * The relay's origin as `https://host[:port]`, or null: HTTPS with a host and nothing else,
         * so the device routes and the connector URL are always derived from it.
         */
        fun relayOrigin(value: String): String? {
            val trimmed = value.trim()
            if (trimmed.isEmpty() || trimmed.length > MAX_RELAY_URL_LENGTH) return null
            val uri = runCatching { URI(trimmed) }.getOrNull() ?: return null
            val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
            if (!uri.scheme.equals("https", ignoreCase = true) ||
                uri.rawUserInfo != null ||
                uri.rawQuery != null ||
                uri.rawFragment != null ||
                (uri.rawPath ?: "") !in setOf("", "/")
            ) {
                return null
            }
            return if (uri.port == -1 || uri.port == 443) "https://$host" else "https://$host:${uri.port}"
        }

        fun pairingCode(random: SecureRandom): String =
            String(CharArray(PAIRING_LENGTH) { PAIRING_ALPHABET[random.nextInt(PAIRING_ALPHABET.length)] })

        /** SHA-256 of the 8-character code without its dash, lowercase hex, as the relay computes it. */
        fun pairingCodeSha256(code: String): String =
            MessageDigest.getInstance("SHA-256").digest(code.encodeToByteArray())
                .joinToString("") { "%02x".format(it) }

        private fun encode(settings: Committed): String = buildJsonObject {
            put("schema_version", SCHEMA_VERSION)
            put("enabled", settings.enabled)
            put("relay_url", settings.relayUrl)
            put("ciphertext", settings.credential.ciphertext)
            put("iv", settings.credential.iv)
            settings.firstCallEpochMs?.let { put("first_call_epoch_ms", it) }
        }.toString()

        private fun decode(text: String): Committed {
            val value = Json.parseToJsonElement(text).jsonObject
            val firstCall = value["first_call_epoch_ms"]?.jsonPrimitive?.also { require(!it.isString) }
                ?.content?.toLong()?.also { require(it > 0) }
            require(
                value.keys == setOf("schema_version", "enabled", "relay_url", "ciphertext", "iv") +
                    if (firstCall != null) setOf("first_call_epoch_ms") else emptySet(),
            )
            val version = value.getValue("schema_version").jsonPrimitive
            require(!version.isString && version.content == SCHEMA_VERSION.toString())
            val enabled = value.getValue("enabled").jsonPrimitive
            require(!enabled.isString)
            val relayUrl = value.string("relay_url")
            val ciphertext = value.string("ciphertext")
            val iv = value.string("iv")
            require(
                relayOrigin(relayUrl) == relayUrl &&
                    ciphertext.isNotEmpty() && ciphertext.length <= MAX_CIPHERTEXT_LENGTH &&
                    iv.isNotEmpty() && iv.length <= MAX_IV_LENGTH,
            )
            return Committed(
                enabled = requireNotNull(enabled.booleanOrNull),
                relayUrl = relayUrl,
                credential = EncryptedTunnelCredential(ciphertext, iv),
                firstCallEpochMs = firstCall,
            )
        }

        private fun kotlinx.serialization.json.JsonObject.string(name: String): String =
            (getValue(name) as JsonPrimitive).also { require(it.isString) }.content
    }
}

internal const val RELAY_CALL_OK = "ok"
internal const val RELAY_CALL_VALID = "valid"
internal const val RELAY_CALL_INVALID_KEY = "invalid_key"
internal const val RELAY_CALL_INVALID_RELAY = "invalid_relay"
internal const val RELAY_CALL_NOT_CONFIGURED = "relay_not_configured"
internal const val RELAY_CALL_UNAVAILABLE = "unavailable"
private val STATES = setOf(TUNNEL_STOPPED, TUNNEL_CONNECTING, TUNNEL_RUNNING, TUNNEL_FAILED)
