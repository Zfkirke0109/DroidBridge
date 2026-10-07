package com.droidbridge.root

import android.app.Application
import com.droidbridge.ui.diagnostics.DiagnosticsExporter
import com.droidbridge.ui.product.about.LicenseEntry
import com.droidbridge.ui.product.about.ProductInfo
import com.droidbridge.ui.product.automation.AutomationRepository
import com.droidbridge.ui.product.settings.AppSettings
import com.droidbridge.ui.product.tasks.TaskRepository
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class RootApplication : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
        graph.connection.start()
    }
}

/** The one process-wide object set of the frontend; the daemon behind [connection] owns all state. */
class AppGraph(application: Application) {
    val settings = AppSettings(application)
    val connection = DaemonConnection(
        packageName = application.packageName,
        socketName = "droidbridge.${application.packageName}.u0.v1",
    )
    val automations = AutomationRepository(submit = { envelope -> connection.submit(envelope) })
    val tasks = TaskRepository(submit = { envelope -> connection.submit(envelope) })

    val versionName: String =
        application.packageManager.getPackageInfo(application.packageName, 0).versionName.orEmpty()

    /** Packaged release provenance for Licenses, excluding build-only tools. */
    val licenses: List<LicenseEntry> by lazy {
        application.assets.open(ProductInfo.INVENTORY_ASSET).bufferedReader().use { reader ->
            ProductInfo.licenses(reader.readText())
        }
    }

    /** The exact packaged third-party notices text for the About dialog. */
    val thirdPartyNotices: String by lazy {
        application.assets.open(ProductInfo.NOTICES_ASSET).bufferedReader().use { it.readText() }
    }

    val diagnosticsExporter: DiagnosticsExporter by lazy {
        val packageInfo = application.packageManager.getPackageInfo(application.packageName, 0)
        DiagnosticsExporter(
            client = connection,
            readFaultFiles = { connection.faultFiles() },
            productVersions = buildJsonObject {
                put("frontend_version_name", packageInfo.versionName.orEmpty())
                put("frontend_version_code", packageInfo.longVersionCode)
            },
            releaseIdentifiers = buildJsonObject {
                put("application_id", application.packageName)
                put("build_type", BuildConfig.BUILD_TYPE)
            },
        )
    }
}
