package com.droidbridge.android.ui.setup

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import com.droidbridge.android.client.BackgroundFacts
import com.droidbridge.android.execution.shizuku.ShizukuManager
import java.io.File

/**
 * Reads the device facts the setup guide needs and opens the settings pages it points to. Every
 * opener falls back to a page that exists on every device, so a button never does nothing.
 */
/** A root manager the App can name. KernelSU and APatch grant root from their own Superuser list, not a prompt. */
enum class RootManager(val label: String, val packages: List<String>, val grantsInManager: Boolean) {
    Magisk("Magisk", listOf("com.topjohnwu.magisk", "io.github.huskydg.magisk", "io.github.vvb2060.magisk"), false),
    KernelSu("KernelSU", listOf("me.weishu.kernelsu"), true),
    APatch("APatch", listOf("me.bmax.apatch"), true),
}

object DeviceSetup {
    /** The root module this APK carries, installed through the root manager from the App. */
    const val MODULE_ASSET = "droidbridge-module.zip"

    /** The installed root manager, when exactly one of them is installed. */
    fun rootManager(context: Context): RootManager? =
        RootManager.entries.filter { manager -> manager.packages.any { installed(context, it) } }.singleOrNull()

    fun openRootManager(context: Context, manager: RootManager) {
        manager.packages.firstNotNullOfOrNull { context.packageManager.getLaunchIntentForPackage(it) }
            ?.let { runCatching { context.startActivity(it) } }
    }

    /** The file name the exported module is offered under, the same as the published release asset. */
    fun moduleFileName(context: Context): String {
        val version = context.packageManager.getPackageInfo(context.packageName, 0).versionName.orEmpty()
        return if (context.packageName.endsWith(".debug")) {
            "droidbridge-debug-magisk-$version.zip"
        } else {
            "droidbridge-magisk-$version.zip"
        }
    }

    fun backgroundFacts(context: Context, autostartConfirmed: Boolean, recentsLockConfirmed: Boolean) = BackgroundFacts(
        batteryUnrestricted = context.getSystemService(PowerManager::class.java)
            .isIgnoringBatteryOptimizations(context.packageName),
        backgroundRestricted = context.getSystemService(ActivityManager::class.java).isBackgroundRestricted,
        vendorAutostart = vendorAutostartComponents().isNotEmpty(),
        autostartConfirmed = autostartConfirmed,
        recentsLockConfirmed = recentsLockConfirmed,
        recentSystemKill = recentSystemKill(context),
    )

    /** A root manager or an `su` file is present. `su` itself is never run: that would prompt the user. */
    fun rootDetected(context: Context): Boolean =
        ROOT_MANAGERS.any { installed(context, it) } || SU_PATHS.any { runCatching { File(it).exists() }.getOrDefault(false) }

    /** A Shizuku app is installed; whether it runs and authorizes this App is a Runtime fact. */
    fun shizukuInstalled(context: Context): Boolean = shizukuManager(context) != null

    /** The installed Shizuku manager (stock Shizuku or Shizuku+), or null. */
    internal fun shizukuManager(context: Context): ShizukuManager? =
        ShizukuManager.installed { packageName -> installed(context, packageName) }

    /** Installed from a file or browser rather than a store, so Android restricts its accessibility switch. */
    fun restrictedSettingsApply(context: Context): Boolean = Build.VERSION.SDK_INT >= 33 && runCatching {
        context.packageManager.getInstallSourceInfo(context.packageName).packageSource != PackageInstaller.PACKAGE_SOURCE_STORE
    }.getOrDefault(true)

    fun requestBatteryExemption(context: Context) {
        open(
            context,
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, packageUri(context)),
            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
        )
    }

    fun openAppDetails(context: Context) {
        open(context, Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri(context)))
    }

    fun openVendorAutostart(context: Context) {
        val vendor = vendorAutostartComponents().map { Intent().setComponent(ComponentName.unflattenFromString(it)) }
        open(context, *vendor.toTypedArray(), Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri(context)))
    }

    /**
     * The accessibility list. The per-service details page needs the signature permission
     * OPEN_ACCESSIBILITY_DETAILS_SETTINGS, so an ordinary app is always refused it.
     */
    fun openAccessibility(context: Context) {
        open(context, Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
    }

    fun openNotificationAccess(context: Context, listener: ComponentName) {
        val component = listener.flattenToString()
        open(
            context,
            Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, component),
            Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS),
        )
    }

    /** The project's release page, where the Magisk/KernelSU-compatible module ZIP is published. */
    private fun open(context: Context, vararg candidates: Intent) {
        for (intent in candidates) {
            val started = runCatching {
                context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            if (started.isSuccess) return
            // A missing or non-exported vendor page moves on to the next candidate.
            if (started.exceptionOrNull() !is ActivityNotFoundException && started.exceptionOrNull() !is SecurityException) {
                throw requireNotNull(started.exceptionOrNull())
            }
        }
    }

    private fun packageUri(context: Context): Uri = Uri.parse("package:${context.packageName}")

    private fun installed(context: Context, packageName: String): Boolean = runCatching {
        context.packageManager.getPackageInfo(packageName, PackageManager.PackageInfoFlags.of(0))
    }.isSuccess

    private fun recentSystemKill(context: Context): Boolean {
        val since = System.currentTimeMillis() - SYSTEM_KILL_WINDOW_MILLIS
        return runCatching {
            context.getSystemService(ActivityManager::class.java)
                .getHistoricalProcessExitReasons(context.packageName, 0, EXIT_HISTORY_LIMIT)
                .any { exit ->
                    exit.processName == "${context.packageName}:runtime" && exit.timestamp >= since && exit.reason in SYSTEM_KILL_REASONS
                }
        }.getOrDefault(false)
    }

    private fun vendorAutostartComponents(): List<String> {
        val brand = "${Build.MANUFACTURER} ${Build.BRAND}".lowercase()
        return VENDOR_AUTOSTART.entries.firstOrNull { (names, _) -> names.any(brand::contains) }?.value.orEmpty()
    }

    private const val SYSTEM_KILL_WINDOW_MILLIS = 24L * 60 * 60 * 1000
    private const val EXIT_HISTORY_LIMIT = 20
    private const val REASON_FREEZER = 14

    private val SYSTEM_KILL_REASONS = setOf(
        ApplicationExitInfo.REASON_SIGNALED,
        ApplicationExitInfo.REASON_LOW_MEMORY,
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE,
        ApplicationExitInfo.REASON_OTHER,
        REASON_FREEZER,
    )

    private val ROOT_MANAGERS = listOf(
        "com.topjohnwu.magisk",
        "io.github.huskydg.magisk",
        "io.github.vvb2060.magisk",
        "me.weishu.kernelsu",
        "me.bmax.apatch",
    )

    private val SU_PATHS = listOf(
        "/system/bin/su",
        "/system/xbin/su",
        "/sbin/su",
        "/debug_ramdisk/su",
        "/system_ext/bin/su",
        "/vendor/bin/su",
    )

    /** Known autostart managers, after the list the AutoStarter project maintains; order is preference. */
    private val VENDOR_AUTOSTART: Map<List<String>, List<String>> = mapOf(
        listOf("oppo", "oneplus", "realme") to listOf(
            "com.coloros.safecenter/com.coloros.safecenter.startupapp.StartupAppListActivity",
            "com.coloros.safecenter/com.coloros.safecenter.permission.startup.StartupAppListActivity",
            "com.oplus.safecenter/com.oplus.safecenter.startupapp.view.StartupAppListActivity",
            "com.oppo.safe/com.oppo.safe.permission.startup.StartupAppListActivity",
            "com.oneplus.security/com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity",
        ),
        listOf("xiaomi", "redmi", "poco") to listOf(
            "com.miui.securitycenter/com.miui.permcenter.autostart.AutoStartManagementActivity",
        ),
        listOf("huawei", "honor") to listOf(
            "com.huawei.systemmanager/com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
            "com.huawei.systemmanager/com.huawei.systemmanager.optimize.process.ProtectActivity",
        ),
        listOf("vivo", "iqoo") to listOf(
            "com.vivo.permissionmanager/com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
            "com.iqoo.secure/com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity",
            "com.iqoo.secure/com.iqoo.secure.ui.phoneoptimize.BgStartUpManager",
        ),
        listOf("samsung") to listOf(
            "com.samsung.android.lool/com.samsung.android.sm.battery.ui.BatteryActivity",
            "com.samsung.android.lool/com.samsung.android.sm.ui.battery.BatteryActivity",
        ),
        listOf("asus") to listOf(
            "com.asus.mobilemanager/com.asus.mobilemanager.autostart.AutoStartActivity",
            "com.asus.mobilemanager/com.asus.mobilemanager.powersaver.PowerSaverSettings",
        ),
    )
}
