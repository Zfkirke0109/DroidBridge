package com.droidbridge.ui.product.mcp

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull

enum class ClaudeRelaySettingsError {
    RelayNotFound,
    RelayNotConfigured,
    DeviceKeyInvalid,
    RelayUnavailable,
    CredentialsUnavailable,
    InvalidConfig,
    IoError,
    NotConfigured,
}

/** The Claude connector as the Runtime reports it; it reuses the tunnel's connection states. */
data class ClaudeRelaySettingsView(
    val configured: Boolean,
    val enabled: Boolean,
    val state: TunnelRuntimeState,
    val relayUrl: String?,
    /** What the user pastes into Claude's "Add custom connector": the relay's `/mcp` URL. */
    val connectorUrl: String?,
    val reason: String?,
    val lastCallEpochMs: Long?,
    val lastError: String? = null,
    val protocolVersion: String,
)

data class ClaudePairing(val code: String, val expiresAtEpochMs: Long)

const val CLAUDE_CONNECTORS_URL = "https://claude.ai/settings/connectors"

/** The input shapes the Runtime accepts; the Runtime and the relay check them again. */
fun isClaudeRelayInputValid(relayUrl: String, deviceKey: String): Boolean =
    RELAY_URL.matches(relayUrl.trim()) && DEVICE_KEY.matches(deviceKey.trim())

object ClaudeRelaySettingsReplies {
    fun settings(reply: String): ClaudeRelaySettingsView? = runCatching {
        val value = Json.parseToJsonElement(reply).jsonObject
        val state = when (value.string("state")) {
            "stopped" -> TunnelRuntimeState.Stopped
            "connecting" -> TunnelRuntimeState.Connecting
            "running" -> TunnelRuntimeState.Running
            "failed" -> TunnelRuntimeState.Failed
            else -> kotlin.error("state")
        }
        val configured = value.boolean("configured")
        val enabled = value.boolean("enabled")
        val reason = value.optionalString("reason")
        val lastCallEpochMs = value.optionalLong("last_call_epoch_ms")
        val lastError = value.optionalString("last_error")
        val expected = buildSet {
            addAll(setOf("schema_version", "configured", "enabled", "state", "protocol_version"))
            if (configured) addAll(setOf("relay_url", "connector_url"))
            if (reason != null) add("reason")
            if (lastCallEpochMs != null) add("last_call_epoch_ms")
            if (lastError != null) add("last_error")
        }
        require(value.keys == expected && value.version())
        require(configured || (!enabled && state == TunnelRuntimeState.Stopped))
        require(enabled || state == TunnelRuntimeState.Stopped)
        require((state == TunnelRuntimeState.Failed) == (reason != null))
        ClaudeRelaySettingsView(
            configured = configured,
            enabled = enabled,
            state = state,
            relayUrl = if (configured) value.string("relay_url") else null,
            connectorUrl = if (configured) value.string("connector_url") else null,
            reason = reason,
            lastCallEpochMs = lastCallEpochMs,
            lastError = lastError,
            protocolVersion = value.string("protocol_version"),
        )
    }.getOrNull()

    fun pairing(reply: String): ClaudePairing? = runCatching {
        val value = Json.parseToJsonElement(reply).jsonObject
        require(value.keys == setOf("schema_version", "pairing_code", "expires_at_epoch_ms") && value.version())
        val code = value.string("pairing_code")
        require(PAIRING_CODE.matches(code))
        ClaudePairing(code, requireNotNull(value.optionalLong("expires_at_epoch_ms")))
    }.getOrNull()

    fun error(reply: String): ClaudeRelaySettingsError? = runCatching {
        val value = Json.parseToJsonElement(reply).jsonObject
        require(value.keys == setOf("schema_version", "error") && value.version())
        when (value.string("error")) {
            "RELAY_NOT_FOUND" -> ClaudeRelaySettingsError.RelayNotFound
            "RELAY_NOT_CONFIGURED" -> ClaudeRelaySettingsError.RelayNotConfigured
            "DEVICE_KEY_INVALID" -> ClaudeRelaySettingsError.DeviceKeyInvalid
            "RELAY_UNAVAILABLE" -> ClaudeRelaySettingsError.RelayUnavailable
            "CREDENTIALS_UNAVAILABLE" -> ClaudeRelaySettingsError.CredentialsUnavailable
            "INVALID_CONFIG" -> ClaudeRelaySettingsError.InvalidConfig
            "IO_ERROR" -> ClaudeRelaySettingsError.IoError
            "NOT_CONFIGURED" -> ClaudeRelaySettingsError.NotConfigured
            else -> error("unknown Claude relay settings error")
        }
    }.getOrNull()

    private fun JsonObject.version(): Boolean =
        (get("schema_version") as? JsonPrimitive)?.let { !it.isString && it.content == "1" } == true

    private fun JsonObject.boolean(name: String): Boolean =
        requireNotNull((getValue(name) as JsonPrimitive).takeUnless { it.isString }?.booleanOrNull)

    private fun JsonObject.string(name: String): String =
        (getValue(name) as JsonPrimitive).also { require(it.isString) }.content

    private fun JsonObject.optionalString(name: String): String? =
        get(name)?.let { (it as JsonPrimitive).also { value -> require(value.isString) }.content }

    private fun JsonObject.optionalLong(name: String): Long? =
        get(name)?.let { requireNotNull((it as JsonPrimitive).takeUnless(JsonPrimitive::isString)?.longOrNull) }
            ?.also { require(it > 0) }
}

private val RELAY_URL = Regex("(?i)https://[a-z0-9.-]+(:[0-9]{1,5})?/?")
private val DEVICE_KEY = Regex("dbrk_[A-Za-z0-9_-]{43}")
private val PAIRING_CODE = Regex("[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}")
