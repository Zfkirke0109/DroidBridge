package com.droidbridge.ui.product

import android.content.Context
import android.os.Build
import android.provider.Settings

/** The status contract's bound on `context.status.device.name`, in UTF-8 bytes. */
private const val DEVICE_NAME_MAX_BYTES = 256

/**
 * The name the owner gave this phone in Settings, else its model, bounded to the status contract.
 * The Runtime reports it in status and the ChatGPT plugin is suggested under it, so several phones
 * stay apart in one client.
 */
fun deviceName(context: Context): String {
    val named = Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)?.trim()
    val name = if (named.isNullOrEmpty() || named == "null") Build.MODEL else named
    var end = name.length
    while (name.substring(0, end).toByteArray(Charsets.UTF_8).size > DEVICE_NAME_MAX_BYTES) {
        end = name.offsetByCodePoints(end, -1)
    }
    return name.substring(0, end)
}
