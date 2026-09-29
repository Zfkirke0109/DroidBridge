package com.droidbridge.android.client

import org.json.JSONObject

enum class ModuleInstallOutcome { Installed, NotGranted, Unsupported, Failed }

/** One answer of the embedded-module install: its outcome and the last lines the root manager printed. */
data class ModuleInstallResult(val outcome: ModuleInstallOutcome, val output: List<String>) {
    companion object {
        fun decode(reply: String): ModuleInstallResult = runCatching {
            val value = JSONObject(reply)
            require(value.getInt("schema_version") == 1)
            val outcome = when (value.getString("outcome")) {
                "installed" -> ModuleInstallOutcome.Installed
                "not_granted" -> ModuleInstallOutcome.NotGranted
                "unsupported" -> ModuleInstallOutcome.Unsupported
                else -> ModuleInstallOutcome.Failed
            }
            val lines = value.getJSONArray("output")
            ModuleInstallResult(outcome, List(lines.length()) { lines.getString(it) })
        }.getOrElse { ModuleInstallResult(ModuleInstallOutcome.Failed, emptyList()) }
    }
}
