package com.droidbridge.ui.client

import kotlinx.coroutines.flow.StateFlow

/**
 * The one way the UI reaches the Runtime host of its edition. Every reply is the host's own JSON
 * text in the shape the product parsers read; a transport failure throws.
 */
interface RuntimeConnection {
    val state: StateFlow<ClientState>
    val supportsClaudeRelay: Boolean get() = false

    /** Rereads the Runtime status now. */
    fun recheck()

    suspend fun submit(envelope: ByteArray): ByteArray

    /** The S-MCP-003 settings reply `{schema_version,enabled,listener,...}` or `{error}`. */
    suspend fun mcpSettings(): String

    /** Returns only after the listener is live or has failed (S-MCP-004). */
    suspend fun setMcpEnabled(enabled: Boolean): String

    suspend fun rotateMcpToken(): String

    suspend fun revealMcpToken(): String

    suspend fun tunnelSettings(): String

    suspend fun configureTunnel(tunnelId: String, apiKey: String): String

    suspend fun setTunnelEnabled(enabled: Boolean): String

    suspend fun clearTunnel(): String

    suspend fun claudeRelaySettings(): String = error("Claude relay is unavailable in this edition")
    suspend fun configureClaudeRelay(relayUrl: String, deviceKey: String): String =
        error("Claude relay is unavailable in this edition")
    suspend fun setClaudeRelayEnabled(enabled: Boolean): String = error("Claude relay is unavailable in this edition")
    suspend fun clearClaudeRelay(): String = error("Claude relay is unavailable in this edition")
    suspend fun pairClaudeRelay(): String = error("Claude relay is unavailable in this edition")
    suspend fun revokeClaudeRelayClients(): String = error("Claude relay is unavailable in this edition")

    /** The S-UI-017 `{schema_version,blocker,cleanup}` reply or `{error}`. */
    suspend fun maintenanceState(): String

    /** The S-UI-017 live diagnostics snapshot. */
    suspend fun diagnosticsSnapshot(): String

    /** Returns only after a fresh Runtime instance is active or the reset failed. */
    suspend fun resetRuntimeData(): String

    suspend fun strandedExecutions(): Int

    suspend fun clearStrandedExecutions(): String
}
