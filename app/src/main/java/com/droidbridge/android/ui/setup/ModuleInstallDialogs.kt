package com.droidbridge.android.ui.setup

import android.content.Context
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.droidbridge.android.R
import com.droidbridge.android.client.ModuleInstallOutcome
import com.droidbridge.android.client.ModuleInstallResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Where the in-App install of the root module this APK carries currently stands. */
sealed interface ModuleDialog {
    data class Explain(val update: Boolean) : ModuleDialog
    data object Installing : ModuleDialog
    data object Installed : ModuleDialog
    data class NotGranted(val update: Boolean) : ModuleDialog
    data object NoRoot : ModuleDialog
    data class Failed(val update: Boolean, val unsupported: Boolean, val output: List<String>) : ModuleDialog
}

@Composable
fun ModuleInstallDialogs(
    dialog: ModuleDialog?,
    setDialog: (ModuleDialog?) -> Unit,
    install: suspend () -> ModuleInstallResult,
    reboot: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val manager = remember(dialog) { DeviceSetup.rootManager(context) }
    val export = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/zip")) { uri ->
        if (uri != null) scope.launch { exportModule(context, uri) }
    }
    val start: (Boolean) -> Unit = { update ->
        setDialog(ModuleDialog.Installing)
        scope.launch {
            val result = install()
            setDialog(
                when (result.outcome) {
                    ModuleInstallOutcome.Installed -> ModuleDialog.Installed
                    // Without a manager on the phone, a refusal only means there is no root at all.
                    ModuleInstallOutcome.NotGranted ->
                        if (manager != null || DeviceSetup.rootDetected(context)) ModuleDialog.NotGranted(update) else ModuleDialog.NoRoot
                    ModuleInstallOutcome.Unsupported -> ModuleDialog.Failed(update, unsupported = true, result.output)
                    ModuleInstallOutcome.Failed -> ModuleDialog.Failed(update, unsupported = false, result.output)
                },
            )
        }
    }
    val managerName = manager?.label ?: stringResource(R.string.module_root_manager)
    when (dialog) {
        is ModuleDialog.Explain -> AlertDialog(
            onDismissRequest = { setDialog(null) },
            title = { Text(stringResource(if (dialog.update) R.string.module_update_title else R.string.module_install_title)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (dialog.update) Text(stringResource(R.string.module_update_mismatch))
                    Text(stringResource(R.string.module_install_body))
                    manager?.let { Text(stringResource(R.string.module_install_detected, it.label)) }
                    if (manager?.grantsInManager == true) {
                        Text(stringResource(R.string.module_install_grant_first, manager.label))
                        TextButton(
                            onClick = { DeviceSetup.openRootManager(context, manager) },
                            modifier = Modifier.testTag("module:open_manager"),
                        ) { Text(stringResource(R.string.action_open_named, manager.label)) }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { start(dialog.update) }, modifier = Modifier.testTag("module:install")) {
                    Text(stringResource(if (dialog.update) R.string.action_update_module else R.string.action_install_module))
                }
            },
            dismissButton = { TextButton(onClick = { setDialog(null) }) { Text(stringResource(R.string.action_cancel)) } },
        )
        ModuleDialog.Installing -> AlertDialog(
            // The root manager is deciding; leaving now would hide the answer, not stop the install.
            onDismissRequest = {},
            title = { Text(stringResource(R.string.module_installing_title)) },
            text = {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    CircularProgressIndicator()
                    Text(stringResource(R.string.module_installing_body))
                }
            },
            confirmButton = {},
            modifier = Modifier.testTag("module:installing"),
        )
        ModuleDialog.Installed -> AlertDialog(
            onDismissRequest = { setDialog(null) },
            title = { Text(stringResource(R.string.module_installed_title)) },
            text = { Text(stringResource(R.string.module_installed_body)) },
            confirmButton = {
                TextButton(onClick = { setDialog(null); reboot() }, modifier = Modifier.testTag("module:reboot")) {
                    Text(stringResource(R.string.action_reboot))
                }
            },
            dismissButton = { TextButton(onClick = { setDialog(null) }) { Text(stringResource(R.string.action_later)) } },
        )
        is ModuleDialog.NotGranted -> AlertDialog(
            onDismissRequest = { setDialog(null) },
            title = { Text(stringResource(R.string.module_not_granted_title)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.module_not_granted_body, managerName))
                    if (manager != null) {
                        TextButton(onClick = { DeviceSetup.openRootManager(context, manager) }) {
                            Text(stringResource(R.string.action_open_named, manager.label))
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { start(dialog.update) }, modifier = Modifier.testTag("module:retry")) {
                    Text(stringResource(R.string.action_retry))
                }
            },
            dismissButton = { TextButton(onClick = { setDialog(null) }) { Text(stringResource(R.string.action_cancel)) } },
        )
        ModuleDialog.NoRoot -> AlertDialog(
            onDismissRequest = { setDialog(null) },
            title = { Text(stringResource(R.string.module_no_root_title)) },
            text = { Text(stringResource(R.string.module_no_root_body)) },
            confirmButton = { TextButton(onClick = { setDialog(null) }) { Text(stringResource(R.string.action_close)) } },
        )
        is ModuleDialog.Failed -> AlertDialog(
            onDismissRequest = { setDialog(null) },
            title = { Text(stringResource(R.string.module_failed_title)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(if (dialog.unsupported) R.string.module_unsupported_body else R.string.module_failed_body))
                    if (dialog.output.isNotEmpty()) {
                        Text(
                            dialog.output.joinToString("\n"),
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                            modifier = Modifier.fillMaxWidth().heightIn(max = 200.dp)
                                .verticalScroll(rememberScrollState()).testTag("module:output"),
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { start(dialog.update) }, modifier = Modifier.testTag("module:retry")) {
                    Text(stringResource(R.string.action_retry))
                }
            },
            dismissButton = {
                Row {
                    TextButton(
                        onClick = { export.launch(DeviceSetup.moduleFileName(context)) },
                        modifier = Modifier.testTag("module:export"),
                    ) { Text(stringResource(R.string.action_export_module)) }
                    TextButton(onClick = { setDialog(null) }) { Text(stringResource(R.string.action_close)) }
                }
            },
        )
        null -> Unit
    }
}

/** Copies the module this APK carries to a file the user chose, for a manual install in the manager. */
private suspend fun exportModule(context: Context, uri: Uri) {
    val written = withContext(Dispatchers.IO) {
        runCatching {
            context.assets.open(DeviceSetup.MODULE_ASSET).use { input ->
                checkNotNull(context.contentResolver.openOutputStream(uri, "w")).use { output -> input.copyTo(output) }
            }
        }.isSuccess
    }
    Toast.makeText(
        context,
        if (written) R.string.module_exported else R.string.module_export_failed,
        Toast.LENGTH_SHORT,
    ).show()
}
