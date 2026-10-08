package com.droidbridge.root

import com.droidbridge.ui.client.AvailabilityFact
import com.droidbridge.ui.client.AvailabilityState
import com.droidbridge.ui.client.CapabilityAction
import com.droidbridge.ui.client.CapabilityRow
import com.droidbridge.ui.client.CapabilityRowKey
import com.droidbridge.ui.client.CapabilityRowState
import com.droidbridge.ui.client.ClientState
import com.droidbridge.ui.client.RuntimeReadiness
import com.droidbridge.ui.client.RuntimeSnapshot

/**
 * The capability facts of the root edition. Root provides every capability, so a row appears
 * only for what is not available yet; the frontend itself grants nothing.
 */
object RootCapabilities {
    fun project(client: ClientState, daemon: DaemonStatus?, frontendVersionCode: Long): List<CapabilityRow> {
        val snapshot = (client as? ClientState.Available)?.snapshot
        return buildList {
            add(runtime(client, snapshot))
            add(backend(snapshot, daemon, frontendVersionCode))
            if (snapshot == null) return@buildList
            val notifications = snapshot.grant("magisk.notifications")
            if (notifications.state != AvailabilityState.Available) {
                add(pending(CapabilityRowKey.NotificationAccess, notifications))
            }
            val persistentTime = snapshot.capability("automation.persistent_time")
            if (persistentTime.state != AvailabilityState.Available) {
                add(pending(CapabilityRowKey.ExactAlarm, persistentTime))
            }
            add(CapabilityRow(CapabilityRowKey.BackgroundKeeper, CapabilityRowState.KeptByModule))
        }
    }

    private fun runtime(client: ClientState, snapshot: RuntimeSnapshot?): CapabilityRow = when {
        snapshot != null -> when (snapshot.readiness) {
            RuntimeReadiness.Ready -> CapabilityRow(CapabilityRowKey.Runtime, CapabilityRowState.Ready)
            RuntimeReadiness.Initializing -> CapabilityRow(CapabilityRowKey.Runtime, CapabilityRowState.Starting)
            RuntimeReadiness.Unavailable -> unavailableRuntime(snapshot.runtimeReason)
        }
        client is ClientState.Unavailable -> unavailableRuntime(client.reason)
        else -> CapabilityRow(CapabilityRowKey.Runtime, CapabilityRowState.Starting)
    }

    private fun unavailableRuntime(reason: String?) = CapabilityRow(
        CapabilityRowKey.Runtime,
        CapabilityRowState.Unavailable,
        if (reason in DIAGNOSTIC_REASONS) CapabilityAction.Diagnostics else CapabilityAction.Retry,
        reason,
    )

    private fun backend(snapshot: RuntimeSnapshot?, daemon: DaemonStatus?, frontendVersionCode: Long): CapabilityRow {
        // The module installs the frontend it carries; any other pairing is an incomplete update.
        if (daemon != null && daemon.versionCode != frontendVersionCode) {
            return CapabilityRow(CapabilityRowKey.RootBackend, CapabilityRowState.UpdateRequired)
        }
        val root = snapshot?.grant("magisk.root")
        return when (root?.state) {
            AvailabilityState.Available -> CapabilityRow(CapabilityRowKey.RootBackend, CapabilityRowState.Ready)
            AvailabilityState.Unavailable ->
                CapabilityRow(CapabilityRowKey.RootBackend, CapabilityRowState.Unavailable, CapabilityAction.Recheck, root.reason)
            else -> CapabilityRow(CapabilityRowKey.RootBackend, CapabilityRowState.Starting)
        }
    }

    private fun pending(key: CapabilityRowKey, fact: AvailabilityFact): CapabilityRow = when (fact.state) {
        AvailabilityState.Unknown -> CapabilityRow(key, CapabilityRowState.Unknown, CapabilityAction.Recheck, fact.reason)
        else -> CapabilityRow(key, CapabilityRowState.Unavailable, CapabilityAction.Recheck, fact.reason)
    }

    private fun RuntimeSnapshot.grant(key: String): AvailabilityFact =
        grants[key] ?: AvailabilityFact(AvailabilityState.Unknown, "MISSING_FACT")

    private fun RuntimeSnapshot.capability(key: String): AvailabilityFact =
        capabilities[key] ?: AvailabilityFact(AvailabilityState.Unknown, "MISSING_FACT")

    private val DIAGNOSTIC_REASONS = setOf("CLEANUP_UNVERIFIED", "PROTOCOL_MISMATCH")
}
