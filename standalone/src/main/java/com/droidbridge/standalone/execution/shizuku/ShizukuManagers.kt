package com.droidbridge.standalone.execution.shizuku

/** Manager apps that provide the Shizuku API to DroidBridge. */
internal enum class ShizukuManager(val packageName: String) {
    // Shizuku+ may install a compatibility app under the stock package name too.
    ShizukuPlus("af.shizuku.plus.api"),
    Shizuku("moe.shizuku.privileged.api"),
    ;

    companion object {
        fun installed(isInstalled: (String) -> Boolean): ShizukuManager? =
            entries.firstOrNull { isInstalled(it.packageName) }
    }
}
