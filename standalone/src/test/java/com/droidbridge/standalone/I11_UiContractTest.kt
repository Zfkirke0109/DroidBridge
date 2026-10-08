package com.droidbridge.standalone

import com.droidbridge.standalone.client.CapabilityRows
import com.droidbridge.ui.client.AvailabilityFact
import com.droidbridge.ui.client.AvailabilityState
import com.droidbridge.ui.client.CapabilityRowKey
import com.droidbridge.ui.client.RuntimeReadiness
import com.droidbridge.ui.client.RuntimeSnapshot
import org.junit.Assert.assertEquals
import org.junit.Test

class I11_UiContractTest {
    @Test
    fun I11_G04_everyMissingAccessRowAppearsAfterTheProviderRows() {
        val none = CapabilityRows.project(snapshot(grants = baseGrants(AvailabilityState.Unavailable)), notificationListenerGranted = true)
        assertEquals(
            listOf(
                CapabilityRowKey.Runtime,
                CapabilityRowKey.Shizuku,
                CapabilityRowKey.LocalNetwork,
                CapabilityRowKey.NotificationAccess,
                CapabilityRowKey.ExactAlarm,
                CapabilityRowKey.Accessibility,
                CapabilityRowKey.ScreenCapture,
            ),
            none.map { it.key },
        )
    }

    private fun baseGrants(state: AvailabilityState): Map<String, AvailabilityFact> = listOf(
        "android.local_network", "android.notifications", "android.notification_listener", "automation.exact_alarm",
        "visual.accessibility", "visual.media_projection_session", "shizuku.shell",
        "execution.app_guard", "execution.shell_guard",
    ).associateWith { AvailabilityFact(state, if (state == AvailabilityState.Available) null else "FIXTURE") }

    private fun snapshot(grants: Map<String, AvailabilityFact>) = RuntimeSnapshot(
        sdkInt = 37,
        host = "apk_runtime",
        hostGeneration = 1,
        readiness = RuntimeReadiness.Ready,
        runtimeReason = null,
        grants = grants,
        capabilities = mapOf(
            "automation.persistent_time" to AvailabilityFact(AvailabilityState.Unavailable, "FIXTURE"),
            "visual.image" to AvailabilityFact(AvailabilityState.Unavailable, "FIXTURE"),
        ),
    )
}
