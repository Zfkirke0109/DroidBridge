package com.droidbridge.root

import android.net.LocalServerSocket
import android.net.LocalSocket
import com.droidbridge.ui.client.ClientState
import com.droidbridge.ui.client.RuntimeConnection
import com.droidbridge.ui.client.resolveContextRefresh
import com.droidbridge.ui.product.diagnostics.DiagnosticsExport
import com.droidbridge.ui.product.diagnostics.FaultFileRead
import com.droidbridge.ui.product.diagnostics.FaultFileStatus
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/** What the daemon reports about itself on the `status` operation. */
data class DaemonStatus(
    val versionName: String,
    val versionCode: Long,
    val started: Boolean,
    /** The error code that keeps the Runtime from starting, while it is not started. */
    val startFailure: String?,
)

/**
 * The frontend link: this App listens on its abstract socket and the root daemon connects to it.
 * The App accepts only a root peer; the daemon in turn answers only this package's uid. Every
 * request is answered by the daemon, which is the only owner of the state the App shows.
 */
class DaemonConnection(
    private val packageName: String,
    private val socketName: String,
) : RuntimeConnection {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutableState = MutableStateFlow<ClientState>(ClientState.Connecting)
    private val mutableDaemon = MutableStateFlow<DaemonStatus?>(null)
    private val requestIds = AtomicLong(0)
    private val pending = ConcurrentHashMap<Long, CompletableDeferred<JsonObject>>()

    @Volatile
    private var link: Link? = null
    private var absenceTimer: Job? = null

    override val state: StateFlow<ClientState> = mutableState.asStateFlow()

    /** The daemon's own facts, or null while no daemon is connected. */
    val daemon: StateFlow<DaemonStatus?> = mutableDaemon.asStateFlow()

    private class Link(val socket: LocalSocket, val output: DataOutputStream)

    /** Opens the socket the daemon connects to; the link lives as long as this process. */
    fun start() {
        val server = LocalServerSocket(socketName)
        armAbsenceTimer()
        Thread({ acceptLoop(server) }, "droidbridge-daemon-link").start()
        scope.launch {
            while (true) {
                delay(REFRESH_MILLIS)
                if (link != null && mutableState.subscriptionCount.value > 0) refresh()
            }
        }
    }

    override fun recheck() {
        scope.launch { refresh() }
    }

    override suspend fun submit(envelope: ByteArray): ByteArray {
        val reply = request("submit", buildJsonObject { put("envelope", Json.parseToJsonElement(envelope.decodeToString())) })
        // A daemon that cannot run the request answers with its own error instead of an envelope.
        if (reply["outcome"] == null && reply["error"] != null) throw IOException("Runtime is not started")
        return reply.toString().encodeToByteArray()
    }

    override suspend fun mcpSettings(): String = request("mcp_settings").toString()

    override suspend fun setMcpEnabled(enabled: Boolean): String =
        request("mcp_set_enabled", buildJsonObject { put("enabled", enabled) }).toString()

    override suspend fun rotateMcpToken(): String = request("mcp_rotate_token").toString()

    override suspend fun revealMcpToken(): String = request("mcp_reveal_token").toString()

    override suspend fun tunnelSettings(): String = request("tunnel_settings").toString()

    override suspend fun configureTunnel(tunnelId: String, apiKey: String): String =
        request(
            "tunnel_configure",
            buildJsonObject {
                put("tunnel_id", tunnelId)
                put("api_key", apiKey)
            },
        ).toString()

    override suspend fun setTunnelEnabled(enabled: Boolean): String =
        request("tunnel_set_enabled", buildJsonObject { put("enabled", enabled) }).toString()

    override suspend fun clearTunnel(): String = request("tunnel_clear").toString()

    override suspend fun maintenanceState(): String = request("maintenance_state").toString()

    override suspend fun diagnosticsSnapshot(): String = request("diagnostics_snapshot").toString()

    override suspend fun resetRuntimeData(): String = maintenanceReply(request("reset_runtime_data"))

    override suspend fun strandedExecutions(): Int =
        (request("stranded_executions")["count"] as? JsonPrimitive)?.intOrNull
            ?: throw IOException("stranded execution count is missing")

    override suspend fun clearStrandedExecutions(): String = maintenanceReply(request("clear_stranded_executions"))

    /** The daemon's S-SEC-005 fault files, which only root can read. */
    suspend fun faultFiles(): Map<String, FaultFileRead> {
        val reply = request("fault_files")
        return DiagnosticsExport.ROLES.associateWith { role ->
            val file = reply[role] as? JsonObject
            val content = (file?.get("content") as? JsonPrimitive)?.contentOrNull
            val status = (file?.get("status") as? JsonPrimitive)?.contentOrNull
            when {
                content != null -> DiagnosticsExport.parseFaultFile(content.encodeToByteArray())
                else -> FaultFileRead(FaultFileStatus.entries.firstOrNull { it.wire == status } ?: FaultFileStatus.Unreadable)
            }
        }
    }

    /** A refused maintenance request carries `{code}` at the top, as the product parsers read it. */
    private fun maintenanceReply(reply: JsonObject): String {
        val error = reply["error"] as? JsonObject ?: return reply.toString()
        return buildJsonObject {
            put("code", (error["code"] as? JsonPrimitive)?.contentOrNull ?: "INTERNAL_ERROR")
        }.toString()
    }

    private suspend fun request(operation: String, payload: JsonObject = JsonObject(emptyMap())): JsonObject {
        val current = link ?: throw IOException("the root daemon is not connected")
        val id = requestIds.incrementAndGet()
        val answer = CompletableDeferred<JsonObject>()
        pending[id] = answer
        try {
            val frame = buildJsonObject {
                put("id", id)
                put("operation", operation)
                put("payload", payload)
            }.toString().encodeToByteArray()
            withContext(Dispatchers.IO) {
                synchronized(current.output) {
                    current.output.writeInt(frame.size)
                    current.output.write(frame)
                    current.output.flush()
                }
            }
            return answer.await()
        } finally {
            pending.remove(id)
        }
    }

    private fun acceptLoop(server: LocalServerSocket) {
        while (true) {
            val socket = runCatching { server.accept() }.getOrNull() ?: continue
            // Any process may connect to an abstract name; only root speaks for the module.
            if (runCatching { socket.peerCredentials.uid }.getOrNull() != 0) {
                runCatching { socket.close() }
                continue
            }
            val connected = runCatching { handshake(socket) }.getOrNull()
            if (connected == null) {
                runCatching { socket.close() }
                continue
            }
            link?.let { previous -> runCatching { previous.socket.close() } }
            link = connected
            absenceTimer?.cancel()
            scope.launch { refresh() }
            readLoop(connected)
        }
    }

    private fun handshake(socket: LocalSocket): Link {
        // A peer that never says hello must not hold the only accept loop.
        socket.soTimeout = HANDSHAKE_TIMEOUT_MILLIS
        val input = DataInputStream(socket.inputStream)
        val output = DataOutputStream(socket.outputStream)
        val hello = readFrame(input)
        require(
            (hello["protocol_version"] as? JsonPrimitive)?.intOrNull == PROTOCOL_VERSION &&
                (hello["role"] as? JsonPrimitive)?.contentOrNull == "droidbridged",
        )
        val reply = buildJsonObject {
            put("protocol_version", PROTOCOL_VERSION)
            put("role", "frontend")
            put("package", packageName)
        }.toString().encodeToByteArray()
        output.writeInt(reply.size)
        output.write(reply)
        output.flush()
        socket.soTimeout = 0
        return Link(socket, output)
    }

    /** Serves one connection until it ends; every request still waiting then fails. */
    private fun readLoop(current: Link) {
        val input = DataInputStream(current.socket.inputStream)
        try {
            while (true) {
                val response = readFrame(input)
                val id = (response["id"] as? JsonPrimitive)?.contentOrNull?.toLongOrNull() ?: break
                val payload = response["payload"] as? JsonObject ?: break
                pending.remove(id)?.complete(payload)
            }
        } catch (_: IOException) {
        } catch (_: IllegalArgumentException) {
        } finally {
            runCatching { current.socket.close() }
            if (link === current) {
                link = null
                pending.values.forEach { it.completeExceptionally(IOException("the root daemon disconnected")) }
                mutableDaemon.value = null
                mutableState.value = ClientState.Connecting
                armAbsenceTimer()
            }
        }
    }

    /** The daemon connects within a second of this socket opening; a longer silence means it is not running. */
    private fun armAbsenceTimer() {
        absenceTimer?.cancel()
        absenceTimer = scope.launch {
            delay(ABSENT_AFTER_MILLIS)
            if (link == null) mutableState.value = ClientState.Unavailable(BACKEND_NOT_CONNECTED)
        }
    }

    private suspend fun refresh() {
        val status = runCatching { request("status") }.getOrNull()
        mutableDaemon.value = status?.let(::daemonStatus)
        val reply = runCatching {
            submit(
                buildJsonObject {
                    put("protocol_version", 1)
                    put("request_id", UUID.randomUUID().toString())
                    put("payload", buildJsonObject {
                        put("tool", "context")
                        put("action", "status")
                        put("input", buildJsonObject { put("detail", "full") })
                    })
                }.toString().encodeToByteArray(),
            )
        }.getOrNull()
        if (link != null) mutableState.value = resolveContextRefresh(reply)
    }

    private fun daemonStatus(value: JsonObject): DaemonStatus? = runCatching {
        DaemonStatus(
            versionName = value.text("version_name")!!,
            versionCode = value.text("version_code")!!.toLong(),
            started = value.text("started") == "true",
            startFailure = (value["start_failure"] as? JsonObject)?.text("code"),
        )
    }.getOrNull()

    private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

    private fun readFrame(input: DataInputStream): JsonObject {
        val length = input.readInt()
        require(length in 1..MAX_FRAME_BYTES)
        val body = ByteArray(length)
        input.readFully(body)
        val element: JsonElement = Json.parseToJsonElement(body.decodeToString())
        return element.jsonObject
    }

    companion object {
        const val BACKEND_NOT_CONNECTED = "BACKEND_NOT_CONNECTED"
        private const val PROTOCOL_VERSION = 1
        private const val MAX_FRAME_BYTES = 4 * 1024 * 1024
        private const val ABSENT_AFTER_MILLIS = 5_000L
        private const val REFRESH_MILLIS = 5_000L
        private const val HANDSHAKE_TIMEOUT_MILLIS = 5_000
    }
}
