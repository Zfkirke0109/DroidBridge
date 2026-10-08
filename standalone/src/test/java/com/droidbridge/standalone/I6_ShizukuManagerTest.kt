package com.droidbridge.standalone

import com.droidbridge.standalone.execution.shizuku.ShizukuManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class I6_ShizukuManagerTest {
    private fun installed(vararg packages: String): (String) -> Boolean = { it in packages }

    @Test
    fun shizukuPlusAloneIsAnInstalledManager() {
        assertEquals(ShizukuManager.ShizukuPlus, ShizukuManager.installed(installed("af.shizuku.plus.api")))
    }

    @Test
    fun stockShizukuIsStillRecognized() {
        assertEquals(ShizukuManager.Shizuku, ShizukuManager.installed(installed("moe.shizuku.privileged.api")))
    }

    @Test
    fun shizukuPlusIsPreferredWhenBothManagerPackagesAreInstalled() {
        assertEquals(
            ShizukuManager.ShizukuPlus,
            ShizukuManager.installed(installed("moe.shizuku.privileged.api", "af.shizuku.plus.api")),
        )
    }

    @Test
    fun unrelatedPackagesDoNotCountAsShizukuManagers() {
        assertNull(ShizukuManager.installed(installed("kerneldroid.nightzuku", "com.example")))
    }
}
