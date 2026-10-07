package com.droidbridge.root

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.droidbridge.ui.client.ClientState
import com.droidbridge.ui.product.maintenance.MaintenanceReplies
import com.droidbridge.ui.product.maintenance.MaintenanceState
import com.droidbridge.ui.product.settings.AppSettings
import com.droidbridge.ui.product.settings.ThemePreference
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class RootUiState(
    /** Null until the stored preference is read, so the first frame never flashes a theme. */
    val theme: ThemePreference? = null,
    val clientState: ClientState = ClientState.Connecting,
    /** The S-UI-017 maintenance facts; MaintenanceRecovery is the root while a blocker exists. */
    val maintenance: MaintenanceState? = null,
    val daemon: DaemonStatus? = null,
)

class RootViewModel(
    private val settings: AppSettings,
    private val connection: DaemonConnection,
) : ViewModel() {
    private val maintenance = MutableStateFlow<MaintenanceState?>(null)

    val state: StateFlow<RootUiState> = combine(
        settings.theme,
        connection.state,
        maintenance,
        connection.daemon,
    ) { theme, client, maintenance, daemon -> RootUiState(theme, client, maintenance, daemon) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), RootUiState())

    init {
        viewModelScope.launch {
            connection.state.collect { client ->
                if (client is ClientState.Available || client is ClientState.Unavailable) refreshMaintenance()
            }
        }
    }

    fun recheck() = connection.recheck()

    fun setTheme(theme: ThemePreference) {
        // A preference the device cannot store stays as it was; it never ends the App.
        viewModelScope.launch { runCatching { settings.setTheme(theme) } }
    }

    /** Requeries the daemon; without one the previous maintenance facts stay in place. */
    fun refreshMaintenance() {
        viewModelScope.launch {
            runCatching { connection.maintenanceState() }.getOrNull()
                ?.let(MaintenanceReplies::state)
                ?.let { maintenance.value = it }
        }
    }
}
