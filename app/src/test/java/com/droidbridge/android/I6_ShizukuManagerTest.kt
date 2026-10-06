package com.droidbridge.android

import com.droidbridge.android.execution.shizuku.ShizukuManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Shizuku+ (`af.shizuku.plus.api`) is a Shizuku manager like stock Shizuku, never a missing one. */
class I6_ShizukuManagerTest {
    private fun installed(vararg packages: String): (String) -> Boolean = { it in packages }

    @Test
    fun i6_shizukuPlusAloneIsAnInstalledManager() {
        assertEquals(ShizukuManager.ShizukuPlus, ShizukuManager.installed(installed("af.shizuku.plus.api")))
    }

    @Test
    fun i6_stockShizukuIsStillRecognized() {
        assertEquals(ShizukuManager.Shizuku, ShizukuManager.installed(installed("moe.shizuku.privileged.api")))
    }

    @Test
    fun i6_shizukuPlusWithItsCompatHubIsShownAsShizukuPlus() {
        // The Compat Hub registers the stock package name and forwards to Shizuku+.
        assertEquals(
            ShizukuManager.ShizukuPlus,
            ShizukuManager.installed(installed("moe.shizuku.privileged.api", "af.shizuku.plus.api")),
        )
    }

    @Test
    fun i6_noManagerIsNotInstalled() {
        assertNull(ShizukuManager.installed(installed("kerneldroid.nightzuku", "com.example")))
    }
}
