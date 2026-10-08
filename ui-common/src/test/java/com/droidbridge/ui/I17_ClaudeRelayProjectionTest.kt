package com.droidbridge.ui

import com.droidbridge.ui.product.home.AgentConnectionSummary
import com.droidbridge.ui.product.home.ConnectedAgent
import com.droidbridge.ui.product.home.HomeMcpRow
import com.droidbridge.ui.product.home.HomeProjection
import com.droidbridge.ui.product.mcp.ClaudeRelaySettingsError
import com.droidbridge.ui.product.mcp.ClaudeRelaySettingsReplies
import com.droidbridge.ui.product.mcp.TunnelRuntimeState
import com.droidbridge.ui.product.mcp.isClaudeRelayInputValid
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What the UI reads from the Claude connector's replies, and how Home counts it. */
class I17_ClaudeRelayProjectionTest {
    @Test
    fun i17_aRunningRelayReplyIsReadWithItsConnectorUrl() {
        val view = requireNotNull(
            ClaudeRelaySettingsReplies.settings(
                """{"schema_version":1,"configured":true,"enabled":true,"state":"running",""" +
                    """"relay_url":"https://r.example.workers.dev","connector_url":"https://r.example.workers.dev/mcp",""" +
                    """"last_call_epoch_ms":1791300000000,"protocol_version":"2026-07-28"}""",
            ),
        )
        assertEquals(TunnelRuntimeState.Running, view.state)
        assertEquals("https://r.example.workers.dev/mcp", view.connectorUrl)
        assertEquals(1_791_300_000_000L, view.lastCallEpochMs)
    }

    @Test
    fun i17_inconsistentRepliesAreRefused() {
        // Unconfigured but enabled, failed without a reason, and an unknown key.
        listOf(
            """{"schema_version":1,"configured":false,"enabled":true,"state":"stopped","protocol_version":"2026-07-28"}""",
            """{"schema_version":1,"configured":true,"enabled":true,"state":"failed","relay_url":"https://r","connector_url":"https://r/mcp","protocol_version":"2026-07-28"}""",
            """{"schema_version":1,"configured":false,"enabled":false,"state":"stopped","protocol_version":"2026-07-28","device_key":"x"}""",
        ).forEach { assertNull(it, ClaudeRelaySettingsReplies.settings(it)) }
    }

    @Test
    fun i17_pairingAndErrorRepliesAreRead() {
        val pairing = requireNotNull(
            ClaudeRelaySettingsReplies.pairing(
                """{"schema_version":1,"pairing_code":"AB12-CD34","expires_at_epoch_ms":1791300600000}""",
            ),
        )
        assertEquals("AB12-CD34", pairing.code)
        assertNull(ClaudeRelaySettingsReplies.pairing("""{"schema_version":1,"pairing_code":"OIL0-0000","expires_at_epoch_ms":1}"""))
        assertEquals(
            ClaudeRelaySettingsError.RelayNotConfigured,
            ClaudeRelaySettingsReplies.error("""{"schema_version":1,"error":"RELAY_NOT_CONFIGURED"}"""),
        )
    }

    @Test
    fun i17_theFormAcceptsOnlyAnHttpsOriginAndADeviceKey() {
        val key = "dbrk_" + "A".repeat(43)
        assertTrue(isClaudeRelayInputValid("https://r.example.workers.dev/", key))
        assertFalse(isClaudeRelayInputValid("http://r.example.workers.dev", key))
        assertFalse(isClaudeRelayInputValid("https://r.example.workers.dev/mcp", key))
        assertFalse(isClaudeRelayInputValid("https://r.example.workers.dev", "sk-" + "A".repeat(45)))
    }

    @Test
    fun i17_homeNamesAConnectedClaudeRelay() {
        assertEquals(
            AgentConnectionSummary(listOf(ConnectedAgent.ChatGpt, ConnectedAgent.Claude), unreadable = false),
            HomeProjection.agentConnections(
                HomeMcpRow.Off,
                tunnelRunning = true,
                readFailed = false,
                claudeRelayRunning = true,
            ),
        )
    }
}
