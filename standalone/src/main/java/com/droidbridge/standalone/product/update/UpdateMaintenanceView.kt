package com.droidbridge.standalone.product.update

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull

/** The presentation subset of one Runtime `update-maintenance.json` record. */
data class MaintenanceRecordView(
    val updateId: String,
    val targetVersion: String,
    val phase: String,
)

/** One `getUpdateMaintenance` reply. */
data class UpdateMaintenanceView(
    val configured: Boolean,
    val installedVersionCode: Long,
    val record: MaintenanceRecordView?,
)

sealed interface MaintenanceReply {
    data class Recorded(val record: MaintenanceRecordView?) : MaintenanceReply
    data class Refused(val code: String) : MaintenanceReply
}

object UpdateMaintenanceReplies {
    fun state(reply: String): UpdateMaintenanceView? = runCatching {
        val value = Json.parseToJsonElement(reply).jsonObject
        require(value.keys == setOf("schema_version", "configured", "installed_version_code", "record"))
        UpdateMaintenanceView(
            configured = value.boolean("configured"),
            installedVersionCode = requireNotNull((value.getValue("installed_version_code") as JsonPrimitive).longOrNull),
            record = record(value.getValue("record")),
        )
    }.getOrNull()

    /** A begin/install/cancel reply: the resulting record, or the Runtime's refusal code. */
    fun mutation(reply: String): MaintenanceReply = runCatching {
        val value = Json.parseToJsonElement(reply).jsonObject
        value["error"]?.let { MaintenanceReply.Refused((it as JsonPrimitive).content) }
            ?: MaintenanceReply.Recorded(record(value.getValue("record")))
    }.getOrElse { MaintenanceReply.Refused("INTERNAL_ERROR") }

    private fun record(element: kotlinx.serialization.json.JsonElement): MaintenanceRecordView? {
        if (element == JsonNull) return null
        val value = element.jsonObject
        return MaintenanceRecordView(
            updateId = value.string("update_id"),
            targetVersion = value.string("target_version"),
            phase = value.string("phase"),
        )
    }

    private fun JsonObject.string(key: String): String = (getValue(key) as JsonPrimitive).also { require(it.isString) }.content

    private fun JsonObject.boolean(key: String): Boolean =
        requireNotNull((getValue(key) as JsonPrimitive).takeUnless { it.isString }?.booleanOrNull)
}
