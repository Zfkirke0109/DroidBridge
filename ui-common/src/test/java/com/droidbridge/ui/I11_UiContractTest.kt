package com.droidbridge.ui

import com.droidbridge.ui.common.ReasonText
import com.droidbridge.ui.common.RouteContent
import com.droidbridge.ui.common.routeContent
import com.droidbridge.ui.common.showsRefresh
import com.droidbridge.ui.maintenance.reason
import com.droidbridge.ui.product.maintenance.MaintenanceBlocker
import com.droidbridge.ui.product.maintenance.MaintenanceState
import com.droidbridge.ui.settings.DataAction
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class I11_UiContractTest {
    @Test
    fun data_actions_keep_local_mcp_and_chatgpt_credentials_separate() {
        assertTrue(DataAction.entries.contains(DataAction.ResetMcp))
        assertTrue(DataAction.entries.contains(DataAction.ClearChatGpt))
        assertFalse(DataAction.ResetMcp.tag == DataAction.ClearChatGpt.tag)
    }

    @Test
    fun I11_G01_everyAsyncRouteSharesTheCommonInitialRefreshAndErrorContract() {
        // Initial: no projection loads, and a failed first read becomes the error item.
        assertEquals(RouteContent.Loading, routeContent(hasProjection = false, loadFailed = false))
        assertEquals(RouteContent.Error, routeContent(hasProjection = false, loadFailed = true))
        assertEquals(RouteContent.Error, routeContent(hasProjection = false, loadFailed = true, empty = true))
        // Refresh and later failures keep the last immutable projection visible.
        assertEquals(RouteContent.Content, routeContent(hasProjection = true, loadFailed = true))
        assertEquals(RouteContent.Content, routeContent(hasProjection = true, loadFailed = false))
        // Only a list projection can be empty; Home and details pass no empty flag.
        assertEquals(RouteContent.Empty, routeContent(hasProjection = true, loadFailed = false, empty = true))
        assertTrue(showsRefresh(hasProjection = true, refreshing = true))
        assertFalse(showsRefresh(hasProjection = false, refreshing = true))
        assertFalse(showsRefresh(hasProjection = true, refreshing = false))
    }

    @Test
    fun I11_G03_knownReasonsUseOnlyCatalogStringsAndOthersRenderStateError() {
        val known = mapOf(
            "RUNTIME_UNAVAILABLE" to R.string.reason_runtime_unavailable,
            "MCP_LISTENER_FAILED" to R.string.reason_mcp_listener_failed,
            "PROTOCOL_MISMATCH" to R.string.reason_protocol_mismatch,
            "STORE_UNAVAILABLE" to R.string.reason_store_unavailable,
            "COMPANION_UNAVAILABLE" to R.string.reason_companion_unavailable,
            "FGS_START_REJECTED" to R.string.reason_fgs_start_rejected,
            "USER_CONSENT_REQUIRED" to R.string.reason_user_consent_required,
            "CLEANUP_UNVERIFIED" to R.string.reason_cleanup_unverified,
            "BACKEND_NOT_CONNECTED" to R.string.reason_backend_not_connected,
        )
        known.forEach { (token, resource) -> assertEquals(token, resource, ReasonText.resource(token)) }
        for (token in listOf(null, "", "HOST_TRANSITION_PENDING", "MODULE_CONFLICT", "SHIZUKU_NOT_RUNNING", "reason_runtime_unavailable")) {
            assertEquals(token.toString(), R.string.state_error, ReasonText.resource(token))
        }

        // MaintenanceRecovery never shows its blocker token, only the S-UI-017 reason resources.
        assertEquals(R.string.reason_cleanup_unverified, reason(MaintenanceState(MaintenanceBlocker.StoreCorrupt, cleanupVerified = false)))
        assertEquals(R.string.reason_store_unavailable, reason(MaintenanceState(MaintenanceBlocker.StoreCorrupt, cleanupVerified = true)))
        assertEquals(R.string.reason_runtime_unavailable, reason(MaintenanceState(MaintenanceBlocker.OwnerCorrupt, cleanupVerified = true)))
    }
}
