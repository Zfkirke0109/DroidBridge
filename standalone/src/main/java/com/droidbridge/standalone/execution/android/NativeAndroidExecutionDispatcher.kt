package com.droidbridge.standalone.execution.android

import android.os.ParcelFileDescriptor
import com.droidbridge.standalone.runtimehost.RuntimeFence
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.runBlocking

internal object NativeAndroidExecutionDispatcher {
    private val registry = AtomicReference<AndroidExecutionRegistry?>(null)
    private var taskActivitySink: ((Long) -> Unit)? = null
    private var taskActivityFence: RuntimeFence? = null
    private var taskActivityRevision = -1L
    private var activeTaskCount = 0L
    private val withdrawnTaskSources = HashSet<RuntimeFence>()

    fun install(value: AndroidExecutionRegistry) {
        check(registry.compareAndSet(null, value) || registry.get() === value)
    }

    fun uninstall(value: AndroidExecutionRegistry) {
        registry.compareAndSet(value, null)
    }

    /** Reads the framework executor registry through JNI without invoking an executor. */
    @JvmStatic
    fun probeExecutor(key: String, generation: Long): Boolean =
        key == "android.framework" && generation > 0 && registry.get()?.executor(key, generation) != null

    @Synchronized
    fun installTaskActivitySink(value: ((Long) -> Unit)?) {
        taskActivitySink = value
        if (value != null && taskActivityRevision >= 0) value(activeTaskCount)
    }

    @JvmStatic
    @Synchronized
    fun taskActivityChanged(
        runtimeEpoch: String,
        hostGeneration: Long,
        runtimeInstanceId: String,
        activeTasks: Long,
        canonicalRevision: Long,
    ) {
        if (runtimeEpoch.isEmpty() || hostGeneration <= 0 || runtimeInstanceId.isEmpty() ||
            activeTasks < 0 || canonicalRevision < 0
        ) return
        val source = RuntimeFence(runtimeEpoch, hostGeneration, runtimeInstanceId)
        if (source in withdrawnTaskSources) return
        val sourceChanged = source != taskActivityFence
        if (sourceChanged) {
            taskActivityFence = source
            taskActivityRevision = -1L
        }
        if (canonicalRevision <= taskActivityRevision) return
        taskActivityRevision = canonicalRevision
        if (!sourceChanged && activeTasks == activeTaskCount) return
        activeTaskCount = activeTasks
        taskActivitySink?.invoke(activeTasks)
    }

    /** Retire the exact JNI source before clearing its foreground hold. */
    @Synchronized
    fun forgetRuntimeTaskActivity(fence: RuntimeFence) {
        withdrawnTaskSources += fence
        taskActivityFence = null
        taskActivityRevision = -1L
        if (activeTaskCount == 0L) return
        activeTaskCount = 0L
        taskActivitySink?.invoke(0L)
    }

    @JvmStatic
    fun execute(
        key: String,
        generation: Long,
        primitive: String,
        payload: ByteArray,
        executionId: String,
        runtimeEpoch: String,
        hostGeneration: Long,
        runtimeInstanceId: String,
    ): AndroidExecutionResult? = executeInternal(
        key,
        generation,
        primitive,
        payload,
        executionId,
        runtimeEpoch,
        hostGeneration,
        runtimeInstanceId,
        emptyList(),
    )

    @JvmStatic
    fun executeWithDescriptor(
        key: String,
        generation: Long,
        primitive: String,
        payload: ByteArray,
        executionId: String,
        runtimeEpoch: String,
        hostGeneration: Long,
        runtimeInstanceId: String,
        descriptorRole: String,
        descriptorFd: Int,
    ): AndroidExecutionResult? {
        val descriptor = ParcelFileDescriptor.fromFd(descriptorFd)
        return try {
            executeInternal(
                key,
                generation,
                primitive,
                payload,
                executionId,
                runtimeEpoch,
                hostGeneration,
                runtimeInstanceId,
                listOf(RoleDescriptor(descriptorRole, descriptor)),
            )
        } finally {
            runCatching { descriptor.close() }
        }
    }

    /**
     * Runs one companion-issued primitive. A canonical companion call carries no
     * capability key, so the primitive and its generation select the executor.
     */
    fun executePrimitive(
        primitive: AndroidPrimitive,
        generation: Long,
        payload: ByteArray,
        executionId: String,
        runtimeEpoch: String,
        hostGeneration: Long,
        runtimeInstanceId: String,
        descriptors: List<RoleDescriptor> = emptyList(),
    ): AndroidExecutionResult {
        val executor = registry.get()?.executor(primitive, generation)
            ?: return AndroidExecutionResult(byteArrayOf(), errorCode = "CAPABILITY_UNAVAILABLE")
        return dispatch(
            executor,
            AndroidExecutionRequest(
                primitive = primitive,
                payload = payload,
                executionId = executionId,
                runtimeEpoch = runtimeEpoch,
                hostGeneration = hostGeneration,
                runtimeInstanceId = runtimeInstanceId,
                descriptors = descriptors,
            ),
        )
    }

    private fun executeInternal(
        key: String,
        generation: Long,
        primitive: String,
        payload: ByteArray,
        executionId: String,
        runtimeEpoch: String,
        hostGeneration: Long,
        runtimeInstanceId: String,
        descriptors: List<RoleDescriptor>,
    ): AndroidExecutionResult? {
        val executor = registry.get()?.executor(key, generation) ?: return null
        return dispatch(
            executor,
            AndroidExecutionRequest(
                primitive = AndroidPrimitive.valueOf(primitive),
                payload = payload,
                executionId = executionId,
                runtimeEpoch = runtimeEpoch,
                hostGeneration = hostGeneration,
                runtimeInstanceId = runtimeInstanceId,
                descriptors = descriptors,
            ),
        )
    }

    private fun dispatch(
        executor: AndroidExecutionBridge,
        request: AndroidExecutionRequest,
    ): AndroidExecutionResult = try {
        runBlocking { executor.execute(request) }
    } catch (error: AndroidExecutionException) {
        AndroidExecutionResult(
            byteArrayOf(),
            errorCode = error.code,
            errorReason = error.reason,
            errorOsError = error.osError,
        )
    } catch (_: TimeoutCancellationException) {
        AndroidExecutionResult(byteArrayOf(), errorCode = "TIMEOUT")
    } catch (_: CancellationException) {
        AndroidExecutionResult(byteArrayOf(), errorCode = "CANCELLED")
    } catch (_: Exception) {
        // An executor's own exception is an operation failure, not a failure of the shared JNI
        // bridge that every Android primitive uses.
        AndroidExecutionResult(byteArrayOf(), errorCode = "INTERNAL_ERROR")
    }
}
