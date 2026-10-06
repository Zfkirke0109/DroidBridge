package com.droidbridge.android.ui.updates

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ListItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.droidbridge.android.R
import com.droidbridge.android.ui.common.RowIcon
import com.droidbridge.android.client.DroidBridgeClient
import com.droidbridge.android.product.update.MaintenanceRecordView
import com.droidbridge.android.product.update.MaintenanceReply
import com.droidbridge.android.product.release.ReleaseClassification
import com.droidbridge.android.product.update.UpdateCheck
import com.droidbridge.android.product.update.UpdateMaintenanceReplies
import com.droidbridge.android.product.update.UpdateMaintenanceView
import com.droidbridge.android.product.update.UpdateManager
import com.droidbridge.android.product.update.UpdateState
import com.droidbridge.android.ui.common.RefreshIndicator
import com.droidbridge.android.ui.common.RouteError
import com.droidbridge.android.ui.common.RouteLoading
import com.droidbridge.android.ui.settings.BackButton
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class UpdatesUiState(
    val maintenance: UpdateMaintenanceView? = null,
    val maintenanceFailed: Boolean = false,
    val busy: Boolean = false,
    val actionFailed: Boolean = false,
)

/** Presents UpdateManager (default process) and the Runtime-owned maintenance record together. */
class UpdatesViewModel(
    private val client: DroidBridgeClient,
    private val updates: UpdateManager,
    private val cacheRoot: File,
) : ViewModel() {
    private val mutableState = MutableStateFlow(UpdatesUiState())
    val state: StateFlow<UpdatesUiState> = mutableState.asStateFlow()
    val updateState: StateFlow<UpdateState> = updates.state

    fun refresh() {
        viewModelScope.launch {
            val view = runCatching { client.updateMaintenance() }.getOrNull()?.let(UpdateMaintenanceReplies::state)
            mutableState.update { it.copy(maintenance = view ?: it.maintenance, maintenanceFailed = view == null) }
            withContext(Dispatchers.IO) { updates.cleanup(referenced(view?.record)) }
        }
    }

    fun check() {
        viewModelScope.launch { updates.check() }
    }

    fun download() {
        viewModelScope.launch { updates.download() }
    }

    /** Enters product-update maintenance when needed, then makes one explicit PackageInstaller attempt. */
    fun installApk() = mutate {
        val record = mutableState.value.maintenance?.record ?: begin() ?: return@mutate FAILED
        client.installUpdateApk(record.updateId)
    }

    fun cancel(record: MaintenanceRecordView) = mutate { client.cancelUpdate(record.updateId) }

    private suspend fun begin(): MaintenanceRecordView? {
        val checked = updates.state.value.check as? UpdateCheck.Checked ?: return null
        val reply = client.beginProductUpdate(checked.manifest, checked.signature)
        return (UpdateMaintenanceReplies.mutation(reply) as? MaintenanceReply.Recorded)?.record
    }

    /** Runs one maintenance action; any refusal or local failure shows the common error state. */
    private fun mutate(action: suspend () -> String) {
        if (mutableState.value.busy) return
        mutableState.update { it.copy(busy = true, actionFailed = false) }
        viewModelScope.launch {
            val reply = runCatching { action() }.getOrElse { FAILED }
            val refused = UpdateMaintenanceReplies.mutation(reply) is MaintenanceReply.Refused
            mutableState.update { it.copy(busy = false, actionFailed = refused) }
            refresh()
        }
    }

    private fun referenced(record: MaintenanceRecordView?): Set<File> {
        record ?: return emptySet()
        return setOf(File(File(cacheRoot, record.targetVersion), "droidbridge-${record.targetVersion}-arm64-v8a.apk"))
    }

    private companion object {
        const val FAILED = """{"schema_version":1,"error":"IO_ERROR"}"""
    }
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun UpdatesRoute(viewModel: UpdatesViewModel, apkVersion: String, back: () -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val updates by viewModel.updateState.collectAsStateWithLifecycle()
    val context = LocalContext.current
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { viewModel.refresh() }
    val maintenance = state.maintenance
    val record = maintenance?.record
    val installApk = {
        if (context.packageManager.canRequestPackageInstalls()) {
            viewModel.installApk()
        } else {
            context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")))
        }
    }
    Scaffold(
        modifier = Modifier.testTag("route:Updates"),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.updates_title)) },
                navigationIcon = { BackButton("route:Updates", R.string.updates_title, back) },
                actions = { if (state.busy || updates.downloading) RefreshIndicator("updates") },
            )
        },
    ) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding)) {
            item {
                ListItem(
                    headlineContent = { Text(stringResource(R.string.updates_current_version)) },
                    leadingContent = { RowIcon(R.drawable.ic_info) },
                    supportingContent = { Text(apkVersion) },
                    modifier = Modifier.testTag("updates:current_version"),
                )
            }
            item {
                Button(
                    onClick = viewModel::check,
                    enabled = maintenance != null && updates.check != UpdateCheck.Checking && updates.check != UpdateCheck.Unconfigured,
                    modifier = Modifier.fillMaxWidth().padding(16.dp).heightIn(min = 56.dp).testTag("updates:check"),
                ) { Text(stringResource(R.string.action_check_for_updates)) }
            }
            if (state.actionFailed || updates.downloadFailed || state.maintenanceFailed) {
                item { RouteError("updates:action", retry = null) }
            }
            if (record != null) {
                maintenanceActions(record, state.busy, installApk, viewModel::cancel)
            } else {
                checkRegion(updates, state.busy, installApk, viewModel::download, viewModel::check)
            }
        }
    }
}

private fun LazyListScope.checkRegion(
    updates: UpdateState,
    busy: Boolean,
    installApk: () -> Unit,
    download: () -> Unit,
    retry: () -> Unit,
) {
    when (val check = updates.check) {
        UpdateCheck.Unconfigured -> item { Status(R.string.updates_configuration_unavailable, null, "configuration_unavailable", R.drawable.ic_status_unknown) }
        UpdateCheck.Idle -> Unit
        UpdateCheck.Checking -> item { RouteLoading("updates") }
        UpdateCheck.Failed -> item { RouteError("updates", retry) }
        is UpdateCheck.Checked -> when (val classification = check.classification) {
            ReleaseClassification.UpToDate -> item { Status(R.string.updates_up_to_date, null, "up_to_date", R.drawable.ic_status_success) }
            is ReleaseClassification.ProductUpdate -> {
                item { Status(R.string.updates_available, classification.manifest.version, "available", R.drawable.ic_system_update) }
                val apk = updates.downloads?.apk
                item {
                    if (apk == null) {
                        Action(R.string.action_download_update, "download_update", !updates.downloading, download)
                    } else {
                        Action(R.string.updates_install_apk, "install_apk", !busy, installApk)
                    }
                }
            }
        }
    }
}

private fun LazyListScope.maintenanceActions(
    record: MaintenanceRecordView,
    busy: Boolean,
    installApk: () -> Unit,
    cancel: (MaintenanceRecordView) -> Unit,
) {
    item { Status(R.string.updates_available, record.targetVersion, "maintenance", R.drawable.ic_system_update) }
    // Every later phase, including a module step an earlier release recorded, is Runtime recovery.
    if (record.phase == "prepared") {
        item { Action(R.string.updates_install_apk, "install_apk", !busy, installApk) }
    } else {
        item { RouteLoading("updates:installing") }
    }
    val cancellable = !record.nativeAttemptActive && (record.phase == "prepared" || record.phase == "apk_installing")
    if (cancellable) {
        item {
            TextButton(
                onClick = { cancel(record) },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).heightIn(min = 48.dp).testTag("updates:cancel"),
            ) { Text(stringResource(R.string.action_cancel)) }
        }
    }
}

@Composable
private fun Status(@StringRes text: Int, version: String?, tag: String, @DrawableRes icon: Int) {
    ListItem(
        headlineContent = { Text(stringResource(text)) },
        leadingContent = { RowIcon(icon) },
        supportingContent = version?.let { { Text(it) } },
        modifier = Modifier.testTag("updates:$tag"),
    )
}

@Composable
private fun Action(@StringRes text: Int, tag: String, enabled: Boolean, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).heightIn(min = 56.dp).testTag("updates:$tag"),
    ) { Text(stringResource(text)) }
}
