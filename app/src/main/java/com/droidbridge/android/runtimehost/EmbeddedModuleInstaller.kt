package com.droidbridge.android.runtimehost

import android.content.Context
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.Collections
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import org.json.JSONArray
import org.json.JSONObject

/**
 * Installs the root module this APK carries through the device's own root manager. It is the only
 * root shell the App opens itself, and only on a visible user action: the script is fixed, takes
 * the module bytes on stdin and no argument from anywhere, and ends by reading the staged
 * module.prop, so an install counts only when the manager holds this module at this version.
 */
internal class EmbeddedModuleInstaller(private val context: Context) {
    private val moduleId = if (context.packageName.endsWith(".debug")) "droidbridge_debug" else "droidbridge"
    private val versionCode = context.packageManager.getPackageInfo(context.packageName, 0).longVersionCode
    private val pendingFile = File(context.filesDir, PENDING_FILE)
    private val running = AtomicBoolean(false)

    /** `{schema_version,outcome,output}`; outcome is installed, not_granted, unsupported or failed. */
    fun install(): String {
        if (!running.compareAndSet(false, true)) return reply(FAILED, listOf("an install is already running"))
        try {
            val run = context.assets.open(MODULE_ASSET).use { module ->
                runRoot(installScript(), module, INSTALL_TIMEOUT_SECONDS)
            }
            val outcome = when {
                !run.started || run.exitCode == EXIT_NOT_ROOT -> NOT_GRANTED
                run.exitCode == EXIT_UNSUPPORTED -> UNSUPPORTED
                run.exitCode == 0 && INSTALLED_MARKER in run.output -> INSTALLED
                else -> FAILED
            }
            if (outcome == INSTALLED) recordPendingReboot()
            return reply(outcome, run.output.filterNot { it == ROOT_MARKER || it == INSTALLED_MARKER })
        } catch (failure: IOException) {
            return reply(FAILED, listOf(failure.toString()))
        } finally {
            running.set(false)
        }
    }

    /** Whether this module version was installed during the current boot and so waits for a reboot. */
    fun rebootPending(): Boolean = runCatching {
        val record = JSONObject(pendingFile.readText())
        record.getString("boot_id") == bootId() && record.getLong("version_code") == versionCode
    }.getOrDefault(false)

    /** Reboots through the same root grant; the phone restarts, so a return means it did not. */
    fun reboot(): Boolean = runRoot(REBOOT_SCRIPT, null, REBOOT_TIMEOUT_SECONDS).started

    private fun installScript(): String = """
        [ "${'$'}(id -u)" = 0 ] || exit $EXIT_NOT_ROOT
        umask 077
        z=$STAGED_ZIP
        cat > "${'$'}z" || { rm -f "${'$'}z"; exit $EXIT_STAGE; }
        a=0; k=0; m=0
        [ -x $APATCH ] && a=1
        [ -x $KERNELSU ] && k=1
        [ -x $MAGISK ] && m=1
        case "${'$'}a${'$'}k${'$'}m" in
          100) $APATCH module install "${'$'}z" ;;
          010) $KERNELSU module install "${'$'}z" ;;
          001) $MAGISK --install-module "${'$'}z" ;;
          *) rm -f "${'$'}z"; exit $EXIT_UNSUPPORTED ;;
        esac
        r=${'$'}?
        rm -f "${'$'}z"
        [ "${'$'}r" = 0 ] || exit "${'$'}r"
        p=/data/adb/modules_update/$moduleId/module.prop
        [ -f "${'$'}p" ] || p=/data/adb/modules/$moduleId/module.prop
        grep -qx 'versionCode=$versionCode' "${'$'}p" || exit $EXIT_NOT_STAGED
        echo $INSTALLED_MARKER
    """.trimIndent()

    private fun recordPendingReboot() {
        val temporary = File(context.filesDir, "$PENDING_FILE.tmp")
        temporary.writeText(JSONObject().put("boot_id", bootId()).put("version_code", versionCode).toString())
        Files.move(temporary.toPath(), pendingFile.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }

    private class RootRun(val started: Boolean, val exitCode: Int?, val output: List<String>)

    /**
     * Runs [script] as root. The shell first prints [ROOT_MARKER], so a missing marker means the
     * manager refused or no root is available, whatever `su` itself printed.
     */
    private fun runRoot(script: String, stdin: InputStream?, timeoutSeconds: Long): RootRun {
        val process = try {
            ProcessBuilder("su", "-c", "echo $ROOT_MARKER\n$script").redirectErrorStream(true).start()
        } catch (_: IOException) {
            return RootRun(false, null, emptyList())
        }
        val lines = Collections.synchronizedList(ArrayList<String>())
        val reader = thread(name = "droidbridge-module-output") {
            runCatching {
                process.inputStream.bufferedReader().forEachLine { line ->
                    lines += line
                    if (lines.size > MAX_OUTPUT_LINES) lines.removeAt(1)
                }
            }
        }
        // A refused request ends `su` before it reads, which fails this write; the outcome is read below.
        val writer = thread(name = "droidbridge-module-input") {
            runCatching { process.outputStream.use { output -> stdin?.copyTo(output) } }
        }
        val finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS)
        if (!finished) {
            process.destroyForcibly()
            process.waitFor(KILL_WAIT_SECONDS, TimeUnit.SECONDS)
        }
        writer.join(JOIN_MILLIS)
        reader.join(JOIN_MILLIS)
        val output = synchronized(lines) { lines.toList() }
        return RootRun(output.firstOrNull() == ROOT_MARKER, if (finished) process.exitValue() else null, output)
    }

    private fun reply(outcome: String, output: List<String>): String = JSONObject()
        .put("schema_version", 1)
        .put("outcome", outcome)
        .put("output", JSONArray(output.takeLast(REPLY_OUTPUT_LINES)))
        .toString()

    private fun bootId(): String = File(BOOT_ID).readText().trim()

    private companion object {
        const val MODULE_ASSET = "droidbridge-module.zip"
        const val PENDING_FILE = "module-install-pending.json"
        const val STAGED_ZIP = "/data/local/tmp/droidbridge-module-install.zip"
        const val MAGISK = "/system/bin/magisk"
        const val KERNELSU = "/data/adb/ksud"
        const val APATCH = "/data/adb/ap/bin/apd"
        const val REBOOT_SCRIPT = "/system/bin/svc power reboot"
        const val BOOT_ID = "/proc/sys/kernel/random/boot_id"
        const val ROOT_MARKER = "DROIDBRIDGE_ROOT_SHELL"
        const val INSTALLED_MARKER = "DROIDBRIDGE_MODULE_STAGED"
        const val EXIT_NOT_ROOT = 90
        const val EXIT_STAGE = 91
        const val EXIT_UNSUPPORTED = 92
        const val EXIT_NOT_STAGED = 93
        const val INSTALLED = "installed"
        const val NOT_GRANTED = "not_granted"
        const val UNSUPPORTED = "unsupported"
        const val FAILED = "failed"
        const val INSTALL_TIMEOUT_SECONDS = 180L
        const val REBOOT_TIMEOUT_SECONDS = 60L
        const val KILL_WAIT_SECONDS = 5L
        const val JOIN_MILLIS = 2_000L
        const val MAX_OUTPUT_LINES = 200
        const val REPLY_OUTPUT_LINES = 20
    }
}
