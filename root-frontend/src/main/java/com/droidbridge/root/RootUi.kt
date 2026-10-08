package com.droidbridge.root

import androidx.activity.compose.BackHandler
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.NavEntryDecorator
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import com.droidbridge.ui.R
import com.droidbridge.ui.automation.AutomationDetailRoute
import com.droidbridge.ui.automation.AutomationDetailViewModel
import com.droidbridge.ui.automation.AutomationEditorRoute
import com.droidbridge.ui.automation.AutomationEditorViewModel
import com.droidbridge.ui.automation.AutomationListViewModel
import com.droidbridge.ui.automation.AutomationsRoute
import com.droidbridge.ui.client.CapabilityAction
import com.droidbridge.ui.client.CapabilityRow
import com.droidbridge.ui.client.CapabilityRowState
import com.droidbridge.ui.client.ClientState
import com.droidbridge.ui.client.RuntimeReadiness
import com.droidbridge.ui.client.settledCapabilityStates
import com.droidbridge.ui.common.CapabilityListItem
import com.droidbridge.ui.diagnostics.DiagnosticsRoute
import com.droidbridge.ui.diagnostics.DiagnosticsViewModel
import com.droidbridge.ui.home.HomeDestination
import com.droidbridge.ui.home.HomeRoute
import com.droidbridge.ui.home.HomeViewModel
import com.droidbridge.ui.home.agentSummary
import com.droidbridge.ui.maintenance.MaintenanceRecoveryRoute
import com.droidbridge.ui.maintenance.MaintenanceViewModel
import com.droidbridge.ui.mcp.AgentConnectionRoute
import com.droidbridge.ui.mcp.McpRoute
import com.droidbridge.ui.mcp.McpViewModel
import com.droidbridge.ui.mcp.TunnelRoute
import com.droidbridge.ui.mcp.TunnelViewModel
import com.droidbridge.ui.product.about.ProductInfo
import com.droidbridge.ui.product.settings.ThemePreference
import com.droidbridge.ui.settings.AboutRoute
import com.droidbridge.ui.settings.DataRoute
import com.droidbridge.ui.settings.DataViewModel
import com.droidbridge.ui.settings.LicensesRoute
import com.droidbridge.ui.settings.SettingsDestination
import com.droidbridge.ui.settings.SettingsRoute
import com.droidbridge.ui.settings.SettingsStatus
import com.droidbridge.ui.tasks.TaskDetailRoute
import com.droidbridge.ui.tasks.TaskDetailViewModel
import com.droidbridge.ui.theme.DroidBridgeTheme
import kotlinx.serialization.Serializable

@Serializable data object Main : NavKey
@Serializable data object Home : NavKey
@Serializable data object Capabilities : NavKey
@Serializable data class TaskDetail(val taskId: String) : NavKey
@Serializable data object Automations : NavKey
@Serializable data class AutomationDetail(val automationId: String) : NavKey
@Serializable data class AutomationEditor(val automationId: String? = null) : NavKey
@Serializable data object AgentConnections : NavKey
@Serializable data object MCP : NavKey
@Serializable data object TunnelSetup : NavKey
@Serializable data object Diagnostics : NavKey
@Serializable data object Settings : NavKey
@Serializable data object Data : NavKey
@Serializable data object About : NavKey
@Serializable data object Licenses : NavKey
@Serializable data object MaintenanceRecovery : NavKey

private data class PrimaryDestination(
    val key: NavKey,
    @StringRes val label: Int,
    @DrawableRes val icon: Int,
    val tag: String,
)

/**
 * The swipeable tabs in their spatial order, Home in the middle one swipe from each; the order also
 * fixes each tab switch's slide direction. Tasks live on Home, running work first.
 */
private val primaryDestinations = listOf(
    PrimaryDestination(Settings, R.string.nav_settings, R.drawable.ic_nav_settings, "nav:settings"),
    PrimaryDestination(Home, R.string.nav_home, R.drawable.ic_nav_home, "nav:home"),
    PrimaryDestination(Automations, R.string.nav_automations, R.drawable.ic_nav_automations, "nav:automations"),
)

private const val SETTINGS_TAB = 0
private const val HOME_TAB = 1
private const val AUTOMATIONS_TAB = 2

private const val PAGE_SLIDE_MILLIS = 300

/** Pages keep a readable line length on wide windows such as a landscape phone; the page ground fills the rest. */
private val READABLE_PAGE_WIDTH = 720.dp

/** The primary shell spans the window so its navigation rail stays at the edge; it bounds each tab page itself. */
private const val FULL_WIDTH_ENTRY = "droidbridge.full_width"

private val ReadableWidthDecorator = NavEntryDecorator<NavKey> { entry ->
    if (entry.metadata[FULL_WIDTH_ENTRY] == true) entry.Content() else ReadableWidth { entry.Content() }
}

@Composable
private fun ReadableWidth(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.TopCenter) {
        Box(Modifier.widthIn(max = READABLE_PAGE_WIDTH).fillMaxHeight()) { content() }
    }
}

/** A child page slides in from the right over the page that stays beneath it. */
private val PushTransition = ContentTransform(
    targetContentEnter = slideInHorizontally(tween(PAGE_SLIDE_MILLIS)) { width -> width },
    // Fully opaque for the whole slide, so the parent stays visible beneath the incoming page.
    initialContentExit = fadeOut(tween(PAGE_SLIDE_MILLIS), targetAlpha = 1f),
    targetContentZIndex = 1f,
)

/** Going back slides the child page out to the right, uncovering the page beneath. */
private val PopTransition = ContentTransform(
    targetContentEnter = EnterTransition.None,
    initialContentExit = slideOutHorizontally(tween(PAGE_SLIDE_MILLIS)) { width -> width },
    targetContentZIndex = -1f,
)

/** A row in one of these states is still being determined; it asks for nothing yet and is not done. */
private val checkingCapabilityStates = setOf(CapabilityRowState.Starting, CapabilityRowState.Connecting)

@Composable
fun RootUi(viewModel: RootViewModel, graph: AppGraph) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val theme = state.theme
    val darkTheme = when (theme) {
        ThemePreference.Light -> false
        ThemePreference.Dark -> true
        else -> isSystemInDarkTheme()
    }
    DroidBridgeTheme(darkTheme) {
        if (theme == null) LoadingRoute() else NavigationRoot(state, viewModel, graph)
    }
}

@Composable
private fun LoadingRoute() {
    val loading = stringResource(R.string.state_loading)
    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(Modifier.semantics { contentDescription = loading })
    }
}

@Composable
private fun NavigationRoot(state: RootUiState, viewModel: RootViewModel, graph: AppGraph) {
    val backStack = rememberNavBackStack(Main)
    var selectedTab by rememberSaveable { mutableIntStateOf(HOME_TAB) }
    val navigate: (NavKey) -> Unit = { destination ->
        val tab = primaryDestinations.indexOfFirst { it.key == destination }
        if (tab < 0) {
            backStack.add(destination)
        } else {
            selectedTab = tab
            if (backStack.size != 1 || backStack.first() != Main) {
                backStack.clear()
                backStack.add(Main)
            }
        }
    }
    val rows = RootCapabilities.project(state.clientState, state.daemon, BuildConfig.VERSION_CODE.toLong())
    val capabilityAction: (CapabilityAction) -> Unit = { action ->
        when (action) {
            CapabilityAction.Diagnostics -> navigate(Diagnostics)
            else -> viewModel.recheck()
        }
    }
    // MaintenanceRecovery is the bootstrap root exactly while a maintenance blocker exists.
    LaunchedEffect(state.maintenance?.recoveryRequired) {
        if (state.maintenance?.recoveryRequired == true && backStack.lastOrNull() != MaintenanceRecovery) {
            backStack.clear()
            backStack.add(MaintenanceRecovery)
        }
    }
    NavDisplay(
        backStack = backStack,
        onBack = { backStack.removeLastOrNull() },
        // Each route entry owns its screen ViewModel, so a reopened editor requeries its owner.
        entryDecorators = listOf(
            rememberSaveableStateHolderNavEntryDecorator(),
            rememberViewModelStoreNavEntryDecorator(),
            ReadableWidthDecorator,
        ),
        transitionSpec = { PushTransition },
        popTransitionSpec = { PopTransition },
        predictivePopTransitionSpec = { PopTransition },
        entryProvider = entryProvider {
            entry<Main>(metadata = mapOf(FULL_WIDTH_ENTRY to true)) {
                val home = viewModel { HomeViewModel(graph.connection, graph.tasks) }
                val homeState by home.state.collectAsStateWithLifecycle()
                val available = state.clientState is ClientState.Available
                LaunchedEffect(selectedTab, available) { home.refresh() }
                LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { viewModel.recheck() }
                val attention = rows.filter { it.action != null && it.state !in settledCapabilityStates }
                // Without a snapshot nothing has been checked yet, which is not the same as all set.
                val checking = state.clientState !is ClientState.Available ||
                    rows.any { it.state in checkingCapabilityStates }
                PrimaryShell(
                    selected = selectedTab,
                    select = { selectedTab = it },
                    backToHome = backStack.size == 1,
                ) { page ->
                    when (page) {
                        HOME_TAB -> HomeRoute(
                            viewModel = home,
                            clientState = state.clientState,
                            attention = attention,
                            checking = checking,
                            onCapabilityAction = { row -> row.action?.let(capabilityAction) },
                            newerVersionAvailable = null,
                            openTask = { taskId -> backStack.add(TaskDetail(taskId)) },
                        ) { destination ->
                            when (destination) {
                                HomeDestination.Diagnostics -> backStack.add(Diagnostics)
                                HomeDestination.Capabilities -> backStack.add(Capabilities)
                                HomeDestination.AgentConnections -> backStack.add(AgentConnections)
                                // The root edition is updated through the root manager; it has no Updates page.
                                HomeDestination.Updates -> Unit
                            }
                        }
                        AUTOMATIONS_TAB -> AutomationsRoute(
                            viewModel = viewModel { AutomationListViewModel(graph.automations) },
                            openDetail = { id -> backStack.add(AutomationDetail(id)) },
                            openEditor = { backStack.add(AutomationEditor()) },
                        )
                        SETTINGS_TAB -> SettingsRoute(
                            theme = state.theme ?: ThemePreference.System,
                            setTheme = viewModel::setTheme,
                            status = SettingsStatus(
                                pendingSetup = attention.size,
                                checking = checking,
                                agent = homeState.agentSummary(),
                                versionName = graph.versionName,
                                newerVersionAvailable = null,
                                offersSetupGuide = false,
                            ),
                        ) { destination ->
                            when (destination) {
                                SettingsDestination.Capabilities -> backStack.add(Capabilities)
                                SettingsDestination.AgentConnections -> backStack.add(AgentConnections)
                                SettingsDestination.Diagnostics -> backStack.add(Diagnostics)
                                SettingsDestination.Data -> backStack.add(Data)
                                SettingsDestination.About -> backStack.add(About)
                                SettingsDestination.Updates, SettingsDestination.Welcome -> Unit
                            }
                        }
                    }
                }
            }
            entry<Capabilities> {
                CapabilitiesScreen(rows, state.clientState, viewModel::recheck, capabilityAction) {
                    backStack.removeLastOrNull()
                }
            }
            entry<TaskDetail> { key ->
                TaskDetailRoute(viewModel { TaskDetailViewModel(graph.tasks, key.taskId) }) { backStack.removeLastOrNull() }
            }
            entry<AutomationDetail> { key ->
                AutomationDetailRoute(
                    viewModel = viewModel { AutomationDetailViewModel(graph.automations, key.automationId) },
                    edit = { backStack.add(AutomationEditor(key.automationId)) },
                    openTask = { taskId -> backStack.add(TaskDetail(taskId)) },
                ) { backStack.removeLastOrNull() }
            }
            entry<AutomationEditor> { key ->
                AutomationEditorRoute(
                    viewModel = viewModel { AutomationEditorViewModel(graph.automations, key.automationId) },
                ) { backStack.removeLastOrNull() }
            }
            entry<AgentConnections> {
                AgentConnectionRoute(
                    viewModel = viewModel { McpViewModel(graph.connection) },
                    openMcp = { backStack.add(MCP) },
                    openTunnel = { backStack.add(TunnelSetup) },
                ) { backStack.removeLastOrNull() }
            }
            // The daemon serves MCP and the tunnel itself, so the frontend needs no notification
            // permission to keep them alive.
            entry<MCP> {
                McpRoute(
                    viewModel = viewModel { McpViewModel(graph.connection) },
                    notificationsUnavailable = false,
                    shouldRequestNotifications = { false },
                    finishSetup = null,
                ) { backStack.removeLastOrNull() }
            }
            entry<TunnelSetup> {
                TunnelRoute(
                    viewModel = viewModel { TunnelViewModel(graph.connection) },
                    runtimeReady = (state.clientState as? ClientState.Available)
                        ?.snapshot?.readiness == RuntimeReadiness.Ready,
                    notificationsUnavailable = false,
                    shouldRequestNotifications = { false },
                    done = {
                        backStack.clear()
                        backStack.add(Main)
                    },
                    finishSetup = null,
                ) { backStack.removeLastOrNull() }
            }
            entry<Diagnostics> {
                DiagnosticsRoute(
                    viewModel = viewModel { DiagnosticsViewModel(graph.diagnosticsExporter) },
                    apkVersion = graph.versionName,
                ) { backStack.removeLastOrNull() }
            }
            entry<Data> {
                DataRoute(viewModel { DataViewModel(graph.connection, updateCache = null) }) { backStack.removeLastOrNull() }
            }
            entry<About> {
                AboutRoute(
                    repositoryUrl = ProductInfo.repositoryUrl(BuildConfig.GITHUB_OWNER, BuildConfig.GITHUB_REPO),
                    openLicenses = { backStack.add(Licenses) },
                ) { backStack.removeLastOrNull() }
            }
            entry<Licenses> {
                LicensesRoute(graph.licenses, notices = { graph.thirdPartyNotices }) { backStack.removeLastOrNull() }
            }
            entry<MaintenanceRecovery> {
                MaintenanceRecoveryRoute(viewModel { MaintenanceViewModel(graph.connection, graph.diagnosticsExporter) }) {
                    // Successful recovery re-evaluates Main instead of creating a second stack.
                    viewModel.refreshMaintenance()
                    backStack.clear()
                    backStack.add(Main)
                }
            }
        },
    )
}

/**
 * The tab bar and the horizontal pager are two views of one selection: a tap slides the pager to the
 * tab in its spatial direction, and a settled swipe selects its tab. Back from another tab returns to
 * Home first.
 */
@Composable
private fun PrimaryShell(
    selected: Int,
    select: (Int) -> Unit,
    backToHome: Boolean,
    page: @Composable (Int) -> Unit,
) {
    val pager = rememberPagerState(initialPage = selected) { primaryDestinations.size }
    LaunchedEffect(selected) { if (pager.currentPage != selected) pager.animateScrollToPage(selected) }
    // A settle between a cancelled tab animation and its replacement must not overwrite the new target.
    LaunchedEffect(pager) { snapshotFlow { pager.settledPage }.collect { if (!pager.isScrollInProgress) select(it) } }
    BackHandler(enabled = backToHome && selected != HOME_TAB) { select(HOME_TAB) }
    NavigationSuiteScaffold(
        navigationSuiteItems = {
            primaryDestinations.forEachIndexed { index, destination ->
                item(
                    selected = pager.currentPage == index,
                    onClick = { select(index) },
                    icon = {
                        Icon(
                            painterResource(destination.icon),
                            contentDescription = stringResource(destination.label),
                            modifier = Modifier.testTag(destination.tag),
                        )
                    },
                    label = { Text(stringResource(destination.label)) },
                )
            }
        },
    ) {
        HorizontalPager(
            state = pager,
            key = { primaryDestinations[it].tag },
            modifier = Modifier.fillMaxSize(),
        ) { index -> ReadableWidth { page(index) } }
    }
}

/** Every capability fact of this device, each with the step it still needs, if any. */
@Composable
@OptIn(ExperimentalMaterial3Api::class)
private fun CapabilitiesScreen(
    rows: List<CapabilityRow>,
    clientState: ClientState,
    recheck: () -> Unit,
    onAction: (CapabilityAction) -> Unit,
    onBack: () -> Unit,
) {
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { recheck() }
    val refreshing = (clientState as? ClientState.Available)?.refreshing == true
    Scaffold(
        modifier = Modifier.testTag("route:Capabilities"),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.capabilities_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack, modifier = Modifier.testTag("route:Capabilities:back")) {
                        Icon(
                            painterResource(R.drawable.ic_arrow_back),
                            contentDescription = stringResource(R.string.capabilities_title),
                        )
                    }
                },
            )
        },
    ) { padding ->
        val pending = rows.filter { it.action != null && it.state !in settledCapabilityStates }
        LazyColumn(modifier = Modifier.fillMaxSize().padding(padding)) {
            item(key = "capabilities:summary") {
                val waiting = rows.any { it.state in checkingCapabilityStates }
                Text(
                    when {
                        pending.isNotEmpty() ->
                            pluralStringResource(R.plurals.capabilities_remaining, pending.size, pending.size)
                        waiting -> stringResource(R.string.capabilities_checking)
                        else -> stringResource(R.string.capabilities_all_set)
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("capabilities:summary"),
                )
            }
            itemsIndexed(rows, key = { _, row -> row.key }) { index, row ->
                CapabilityListItem(
                    row = row,
                    refreshing = index == 0 && refreshing,
                    emphasized = row.key == pending.firstOrNull()?.key,
                ) { row.action?.let(onAction) }
                if (index != rows.lastIndex) HorizontalDivider()
            }
        }
    }
}
