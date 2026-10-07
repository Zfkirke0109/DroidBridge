package com.droidbridge.standalone.ui.state

import android.content.Intent
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.droidbridge.standalone.client.DroidBridgeClient
import com.droidbridge.ui.client.ClientState
import com.droidbridge.ui.client.SetupRoute
import com.droidbridge.ui.product.maintenance.MaintenanceReplies
import com.droidbridge.ui.product.maintenance.MaintenanceState
import com.droidbridge.ui.product.settings.AgentType
import com.droidbridge.ui.product.settings.AppSettings
import com.droidbridge.ui.product.settings.BackgroundConfirmations
import com.droidbridge.ui.product.settings.ThemePreference
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class AppUiState(
    val onboardingCompleted: Boolean? = null,
    val theme: ThemePreference = ThemePreference.System,
    val clientState: ClientState = ClientState.Disconnected,
    /** The S-UI-017 maintenance facts; MaintenanceRecovery is the root while a blocker exists. */
    val maintenance: MaintenanceState? = null,
    val agentType: AgentType = AgentType.ChatGpt,
    val backgroundConfirmations: BackgroundConfirmations = BackgroundConfirmations(),
    /** How the user chose to run DroidBridge on this phone; null until first setup commits one. */
    val setupRoute: SetupRoute? = null,
)

class AppViewModel(
    private val settings: AppSettings,
    private val client: DroidBridgeClient,
) : ViewModel() {
    private val maintenance = MutableStateFlow<MaintenanceState?>(null)

    val state: StateFlow<AppUiState> = combine(
        settings.onboardingCompleted,
        settings.theme,
        client.state,
        maintenance,
        settings.agentType,
    ) { onboarding, theme, client, maintenance, agentType ->
        AppUiState(onboarding, theme, client, maintenance, agentType)
    }
        .combine(settings.backgroundConfirmations) { state, confirmations -> state.copy(backgroundConfirmations = confirmations) }
        .combine(settings.setupRoute) { state, route -> state.copy(setupRoute = route) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), AppUiState())

    init {
        viewModelScope.launch {
            client.state.collect { connection ->
                if (connection is ClientState.Available || connection is ClientState.Unavailable) refreshMaintenance()
            }
        }
    }

    fun startRuntime() = client.bind()
    fun recheckRuntime() = client.recheck()
    fun requestShizukuAuthorization() = client.requestShizukuAuthorization()
    fun deliverMediaProjectionConsent(resultCode: Int, resultData: Intent) =
        client.deliverMediaProjectionConsent(resultCode, resultData)
    fun stopMediaProjection() = client.stopMediaProjection()
    fun completeOnboarding() = edit { settings.completeOnboarding() }
    fun setTheme(theme: ThemePreference) = edit { settings.setTheme(theme) }
    fun setAgentType(agentType: AgentType) = edit { settings.setAgentType(agentType) }
    fun setSetupRoute(route: SetupRoute) = edit { settings.setSetupRoute(route) }
    fun confirmAutostart() = edit { settings.confirmAutostart() }
    fun confirmRecentsLock() = edit { settings.confirmRecentsLock() }

    /** A preference the device cannot store stays as it was; it never ends the App. */
    private fun edit(write: suspend () -> Unit) {
        viewModelScope.launch { runCatching { write() } }
    }

    /** Requeries the owner; an unbound Service leaves the previous maintenance facts in place. */
    fun refreshMaintenance() {
        viewModelScope.launch {
            runCatching { client.maintenanceState() }.getOrNull()
                ?.let(MaintenanceReplies::state)
                ?.let { maintenance.value = it }
        }
    }

    // The client belongs to the process graph and outlives this screen's ViewModel; a later
    // Activity in the same process binds it again.
    override fun onCleared() = client.unbind()
}
