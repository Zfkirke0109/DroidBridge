package com.droidbridge.android.ui.mcp

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.droidbridge.android.R
import com.droidbridge.android.client.ClientState
import com.droidbridge.android.client.DroidBridgeClient
import com.droidbridge.android.product.mcp.CLAUDE_CONNECTORS_URL
import com.droidbridge.android.product.mcp.ClaudePairing
import com.droidbridge.android.product.mcp.ClaudeRelaySettingsError
import com.droidbridge.android.product.mcp.ClaudeRelaySettingsReplies
import com.droidbridge.android.product.mcp.ClaudeRelaySettingsView
import com.droidbridge.android.product.mcp.TunnelRuntimeState
import com.droidbridge.android.product.mcp.isClaudeRelayInputValid
import com.droidbridge.android.ui.settings.BackButton
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ClaudeConnectorUiState(
    val settings: ClaudeRelaySettingsView? = null,
    val loading: Boolean = true,
    val failed: Boolean = false,
    val error: ClaudeRelaySettingsError? = null,
    /** Shown until it expires or this route's ViewModel ends; never stored. */
    val pairing: ClaudePairing? = null,
    val revoked: Boolean = false,
)

class ClaudeConnectorViewModel(private val client: DroidBridgeClient) : ViewModel() {
    private val mutableState = MutableStateFlow(ClaudeConnectorUiState())
    val state: StateFlow<ClaudeConnectorUiState> = mutableState.asStateFlow()

    init {
        viewModelScope.launch {
            client.state.collect { connection ->
                if (connection is ClientState.Available && mutableState.value.settings == null) refresh()
            }
        }
    }

    fun refresh(background: Boolean = false) {
        if (!background) mutableState.update { it.copy(loading = true, failed = false, error = null) }
        viewModelScope.launch {
            val reply = runCatching { client.claudeRelaySettings() }.getOrNull()
            val settings = reply?.let(ClaudeRelaySettingsReplies::settings)
            mutableState.update { current ->
                current.copy(
                    settings = settings ?: current.settings,
                    loading = if (background) current.loading else false,
                    failed = if (background) current.failed else settings == null,
                    error = if (settings == null && !background) reply?.let(ClaudeRelaySettingsReplies::error) else current.error,
                )
            }
        }
    }

    fun configureAndEnable(relayUrl: String, deviceKey: String, complete: (Boolean) -> Unit) {
        mutableState.update { it.copy(loading = true, failed = false, error = null) }
        viewModelScope.launch {
            val reply = runCatching { client.configureClaudeRelay(relayUrl.trim(), deviceKey.trim()) }.getOrNull()
            val configured = reply?.let(ClaudeRelaySettingsReplies::settings)
            val connected = when {
                configured == null -> null
                configured.enabled -> configured
                else -> runCatching { client.setClaudeRelayEnabled(true) }
                    .getOrNull()?.let(ClaudeRelaySettingsReplies::settings)
            }
            mutableState.update { current ->
                current.copy(
                    settings = connected ?: configured ?: current.settings,
                    loading = false,
                    failed = connected == null,
                    error = if (configured == null) reply?.let(ClaudeRelaySettingsReplies::error) else null,
                    pairing = null,
                )
            }
            complete(configured != null)
        }
    }

    fun setEnabled(enabled: Boolean) = mutate { client.setClaudeRelayEnabled(enabled) }

    fun pair() {
        mutableState.update { it.copy(loading = true, error = null, revoked = false) }
        viewModelScope.launch {
            val reply = runCatching { client.pairClaudeRelay() }.getOrNull()
            val pairing = reply?.let(ClaudeRelaySettingsReplies::pairing)
            mutableState.update { current ->
                current.copy(
                    loading = false,
                    pairing = pairing,
                    failed = pairing == null && reply == null,
                    error = if (pairing == null) reply?.let(ClaudeRelaySettingsReplies::error) else null,
                )
            }
        }
    }

    fun pairingExpired() = mutableState.update { it.copy(pairing = null) }

    fun revoke() {
        mutableState.update { it.copy(loading = true, error = null, revoked = false) }
        viewModelScope.launch {
            val reply = runCatching { client.revokeClaudeRelayClients() }.getOrNull()
            val settings = reply?.let(ClaudeRelaySettingsReplies::settings)
            mutableState.update { current ->
                current.copy(
                    settings = settings ?: current.settings,
                    loading = false,
                    failed = settings == null && reply == null,
                    error = if (settings == null) reply?.let(ClaudeRelaySettingsReplies::error) else null,
                    pairing = null,
                    revoked = settings != null,
                )
            }
        }
    }

    fun clear() = mutate { client.clearClaudeRelay() }

    private fun mutate(call: suspend () -> String) {
        mutableState.update { it.copy(loading = true, failed = false, error = null) }
        viewModelScope.launch {
            val reply = runCatching { call() }.getOrNull()
            val settings = reply?.let(ClaudeRelaySettingsReplies::settings)
            mutableState.update { current ->
                current.copy(
                    settings = settings ?: current.settings,
                    loading = false,
                    failed = settings == null,
                    error = if (settings == null) reply?.let(ClaudeRelaySettingsReplies::error) else null,
                    pairing = if (settings?.configured == false) null else current.pairing,
                    revoked = false,
                )
            }
        }
    }
}

/**
 * The Claude connector: the user's own relay (relay/README.md), the connector URL to paste into
 * Claude, and the pairing code the relay's consent page asks for.
 */
@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun ClaudeConnectorRoute(viewModel: ClaudeConnectorViewModel, back: () -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val settings = state.settings
    val context = LocalContext.current
    var editing by rememberSaveable { mutableStateOf(false) }
    var confirmRevoke by remember { mutableStateOf(false) }
    var confirmRemove by remember { mutableStateOf(false) }
    val showForm = settings != null && (!settings.configured || editing)

    Scaffold(
        modifier = Modifier.testTag("route:ClaudeConnector"),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.claude_title)) },
                navigationIcon = { BackButton("route:ClaudeConnector", R.string.claude_title, back) },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            item { Paragraph(R.string.claude_intro) }
            state.error?.let { error ->
                item {
                    Text(
                        stringResource(claudeErrorText(error)),
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("claude:error"),
                    )
                }
            }
            if (state.failed && state.error == null) {
                item {
                    ListItem(
                        headlineContent = { Text(stringResource(R.string.state_error)) },
                        trailingContent = {
                            Button(onClick = { viewModel.refresh() }, modifier = Modifier.testTag("claude:retry")) {
                                Text(stringResource(R.string.action_retry))
                            }
                        },
                    )
                }
            }
            if (showForm) {
                item {
                    RelayForm(
                        loading = state.loading,
                        initialUrl = settings.relayUrl.orEmpty(),
                        cancel = if (settings.configured) ({ editing = false }) else null,
                    ) { url, key -> viewModel.configureAndEnable(url, key) { saved -> if (saved) editing = false } }
                }
            } else if (settings != null && settings.configured) {
                item {
                    ListItem(
                        headlineContent = { Text(stringResource(R.string.claude_enabled)) },
                        supportingContent = {
                            Column {
                                Text(stringResource(claudeStatusLabel(settings)))
                                settings.lastError?.let { Text(stringResource(R.string.claude_last_error, it)) }
                            }
                        },
                        trailingContent = {
                            Switch(
                                checked = settings.enabled,
                                enabled = !state.loading,
                                onCheckedChange = viewModel::setEnabled,
                                modifier = Modifier.testTag("claude:enabled"),
                            )
                        },
                    )
                }
                item {
                    ListItem(
                        headlineContent = { Text(stringResource(R.string.claude_connector_url)) },
                        supportingContent = {
                            Column {
                                Text(settings.connectorUrl.orEmpty(), modifier = Modifier.testTag("claude:connector_url"))
                                Text(stringResource(R.string.claude_connector_url_help))
                            }
                        },
                        trailingContent = {
                            TextButton(
                                onClick = {
                                    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(
                                        ClipData.newPlainText("Claude connector URL", settings.connectorUrl.orEmpty()),
                                    )
                                },
                                modifier = Modifier.testTag("claude:copy_url"),
                            ) { Text(stringResource(R.string.action_copy)) }
                        },
                    )
                }
                item {
                    OutlinedButton(
                        onClick = {
                            runCatching {
                                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(CLAUDE_CONNECTORS_URL)))
                            }
                        },
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("claude:open_claude"),
                    ) { Text(stringResource(R.string.claude_open_connectors)) }
                }
                item {
                    Button(
                        onClick = viewModel::pair,
                        enabled = !state.loading,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("claude:pair"),
                    ) { Text(stringResource(R.string.claude_pair)) }
                }
                state.pairing?.let { pairing ->
                    item { PairingCard(pairing, viewModel::pairingExpired) }
                }
                if (state.revoked) item { Paragraph(R.string.claude_revoked) }
                settings.lastCallEpochMs?.let { lastCall ->
                    item {
                        Text(
                            stringResource(
                                R.string.claude_last_call,
                                DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(lastCall)),
                            ),
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                        )
                    }
                }
                item { Paragraph(R.string.claude_offline_note) }
                item {
                    OutlinedButton(
                        onClick = { confirmRevoke = true },
                        enabled = !state.loading,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("claude:revoke"),
                    ) { Text(stringResource(R.string.claude_revoke)) }
                }
                item {
                    TextButton(
                        onClick = { editing = true },
                        modifier = Modifier.padding(horizontal = 8.dp).testTag("claude:edit"),
                    ) { Text(stringResource(R.string.claude_change_relay)) }
                }
                item {
                    TextButton(
                        onClick = { confirmRemove = true },
                        enabled = !state.loading,
                        modifier = Modifier.padding(horizontal = 8.dp).testTag("claude:remove"),
                    ) { Text(stringResource(R.string.claude_remove)) }
                }
            } else if (state.loading) {
                item { Paragraph(R.string.state_loading) }
            }
        }
    }

    if (confirmRevoke) {
        AlertDialog(
            onDismissRequest = { confirmRevoke = false },
            title = { Text(stringResource(R.string.claude_revoke_confirm_title)) },
            text = { Text(stringResource(R.string.claude_revoke_confirm_text)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmRevoke = false
                    viewModel.revoke()
                }) { Text(stringResource(R.string.claude_revoke)) }
            },
            dismissButton = { TextButton(onClick = { confirmRevoke = false }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
    if (confirmRemove) {
        AlertDialog(
            onDismissRequest = { confirmRemove = false },
            title = { Text(stringResource(R.string.claude_remove)) },
            text = { Text(stringResource(R.string.claude_remove_confirm_text)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmRemove = false
                    viewModel.clear()
                }) { Text(stringResource(R.string.claude_remove)) }
            },
            dismissButton = { TextButton(onClick = { confirmRemove = false }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }

    LaunchedEffect(Unit) { viewModel.refresh() }
    // A relay that is enabled but not yet running is read again until it settles.
    LaunchedEffect(settings?.enabled, settings?.state) {
        while (settings?.enabled == true && settings.state != TunnelRuntimeState.Running) {
            delay(REFRESH_MS)
            viewModel.refresh(background = true)
        }
    }
}

@Composable
private fun RelayForm(
    loading: Boolean,
    initialUrl: String,
    cancel: (() -> Unit)?,
    save: (String, String) -> Unit,
) {
    var relayUrl by rememberSaveable { mutableStateOf(initialUrl) }
    // The device key is never saved in instance state.
    var deviceKey by remember { mutableStateOf("") }
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(stringResource(R.string.claude_setup_steps))
        OutlinedTextField(
            value = relayUrl,
            onValueChange = { relayUrl = it },
            label = { Text(stringResource(R.string.claude_relay_url)) },
            placeholder = { Text(stringResource(R.string.claude_relay_url_hint)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth().testTag("claude:relay_url"),
        )
        OutlinedTextField(
            value = deviceKey,
            onValueChange = { deviceKey = it },
            label = { Text(stringResource(R.string.claude_device_key)) },
            supportingText = { Text(stringResource(R.string.claude_device_key_hint)) },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth().testTag("claude:device_key"),
        )
        Button(
            onClick = { save(relayUrl, deviceKey) },
            enabled = !loading && isClaudeRelayInputValid(relayUrl, deviceKey),
            modifier = Modifier.fillMaxWidth().testTag("claude:save"),
        ) { Text(stringResource(R.string.claude_save)) }
        if (cancel != null) {
            TextButton(onClick = cancel, modifier = Modifier.testTag("claude:cancel_edit")) {
                Text(stringResource(R.string.action_cancel))
            }
        }
    }
}

@Composable
private fun PairingCard(pairing: ClaudePairing, expired: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("claude:pairing")) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.claude_pair_code_label))
            Text(pairing.code, style = MaterialTheme.typography.displaySmall, modifier = Modifier.testTag("claude:pairing_code"))
            Text(stringResource(R.string.claude_pair_expires))
        }
    }
    LaunchedEffect(pairing) {
        delay((pairing.expiresAtEpochMs - System.currentTimeMillis()).coerceAtLeast(0))
        expired()
    }
}

@Composable
private fun Paragraph(@StringRes text: Int) {
    Text(stringResource(text), modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
}

@StringRes
internal fun claudeStatusLabel(settings: ClaudeRelaySettingsView?): Int = when {
    settings == null || !settings.configured -> R.string.tunnel_state_not_configured
    settings.state == TunnelRuntimeState.Running -> R.string.mcp_state_running
    settings.state == TunnelRuntimeState.Connecting -> R.string.tunnel_state_connecting
    settings.state == TunnelRuntimeState.Failed -> R.string.task_state_failed
    else -> R.string.mcp_state_off
}

@StringRes
private fun claudeErrorText(error: ClaudeRelaySettingsError): Int = when (error) {
    ClaudeRelaySettingsError.RelayNotFound -> R.string.claude_error_relay_not_found
    ClaudeRelaySettingsError.RelayNotConfigured -> R.string.claude_error_relay_not_configured
    ClaudeRelaySettingsError.DeviceKeyInvalid -> R.string.claude_error_device_key
    ClaudeRelaySettingsError.RelayUnavailable -> R.string.claude_error_unavailable
    ClaudeRelaySettingsError.CredentialsUnavailable -> R.string.claude_error_credentials
    ClaudeRelaySettingsError.InvalidConfig -> R.string.claude_error_invalid
    ClaudeRelaySettingsError.IoError -> R.string.claude_error_io
    ClaudeRelaySettingsError.NotConfigured -> R.string.tunnel_state_not_configured
}

private const val REFRESH_MS = 2_000L
