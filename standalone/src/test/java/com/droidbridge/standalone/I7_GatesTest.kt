package com.droidbridge.standalone

import com.droidbridge.standalone.execution.android.AndroidExecutionBridge
import com.droidbridge.standalone.execution.android.AndroidExecutionRegistry
import com.droidbridge.standalone.execution.android.AndroidExecutionResult
import com.droidbridge.standalone.execution.android.AndroidPrimitive
import com.droidbridge.standalone.execution.android.CapabilityRegistration
import com.droidbridge.standalone.execution.android.RegisteredCapabilityState
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class I7_GatesTest {
    @Test
    fun i7_g10_executionResolvesItsExecutorByPrimitiveAndGeneration() {
        val framework = AndroidExecutionBridge { AndroidExecutionResult(byteArrayOf()) }
        val replacement = AndroidExecutionBridge { AndroidExecutionResult(byteArrayOf()) }
        val registry = AndroidExecutionRegistry { _, _, _, _, _ -> true }
        assertTrue(
            registry.register(
                CapabilityRegistration(
                    key = "android.framework",
                    state = RegisteredCapabilityState.Available,
                    reason = null,
                    sourceGeneration = 7,
                    executor = framework,
                    primitives = setOf(
                        AndroidPrimitive.ContentInspect,
                        AndroidPrimitive.ContentOpenRead,
                    ),
                ),
            ),
        )
        assertSame(framework, registry.executor(AndroidPrimitive.ContentInspect, 7))
        assertSame(framework, registry.executor(AndroidPrimitive.ContentOpenRead, 7))
        assertSame(framework, registry.executor("android.framework", 7))
        assertNull(registry.executor(AndroidPrimitive.ContentInspect, 6))
        assertNull(registry.executor(AndroidPrimitive.PackageInspect, 7))

        assertTrue(
            registry.register(
                CapabilityRegistration(
                    key = "android.framework",
                    state = RegisteredCapabilityState.Available,
                    reason = null,
                    sourceGeneration = 8,
                    executor = replacement,
                    primitives = setOf(AndroidPrimitive.ContentInspect),
                ),
            ),
        )
        assertSame(replacement, registry.executor(AndroidPrimitive.ContentInspect, 8))
        assertSame(replacement, registry.executor("android.framework", 8))
        assertNull(registry.executor(AndroidPrimitive.ContentOpenRead, 8))
        assertTrue(
            runCatching {
                registry.register(
                    CapabilityRegistration(
                        key = "android.framework",
                        state = RegisteredCapabilityState.Unavailable,
                        reason = "BINDER_UNAVAILABLE",
                        sourceGeneration = 9,
                        primitives = setOf(AndroidPrimitive.ContentInspect),
                    ),
                )
            }.isFailure,
        )
    }
}
