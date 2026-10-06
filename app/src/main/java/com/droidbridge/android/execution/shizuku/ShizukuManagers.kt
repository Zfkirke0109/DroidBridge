package com.droidbridge.android.execution.shizuku

/**
 * The Shizuku server apps DroidBridge recognizes. Both serve the same `rikka.shizuku` API and
 * permission to this App; Shizuku+ installs under its own package, next to or instead of stock
 * Shizuku, so an installed manager is either one. Neither changes the identity the shell user
 * service must run as.
 */
internal enum class ShizukuManager(val packageName: String) {
    /** Shizuku+ (`thejaustin/ShizukuPlus`). Listed first: its Compat Hub also installs as stock. */
    ShizukuPlus("af.shizuku.plus.api"),
    Shizuku("moe.shizuku.privileged.api"),
    ;

    companion object {
        /** The manager to show and open, or null when none is installed. */
        fun installed(isInstalled: (String) -> Boolean): ShizukuManager? =
            entries.firstOrNull { isInstalled(it.packageName) }
    }
}
