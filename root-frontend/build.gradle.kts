import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.gradle.api.tasks.Copy
import org.gradle.api.tasks.Exec
import org.gradle.api.tasks.Sync
import org.gradle.api.tasks.bundling.Jar
import org.gradle.api.tasks.bundling.Zip
import org.gradle.api.tasks.compile.JavaCompile
import org.gradle.jvm.toolchain.JavaLanguageVersion
import org.gradle.jvm.toolchain.JavaToolchainService

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

val releaseConfig = Properties().apply {
    rootProject.file("release-config.properties").inputStream().use(::load)
}

/** The root edition's version; the frontend APK, module.prop and the daemon carry it. */
val productVersionName = providers.gradleProperty("droidbridgeVersionName").get()
val productVersionCode = providers.gradleProperty("droidbridgeVersionCode").get().toInt()
val rustWorkspaceVersion = Regex("""(?m)^version = "([^"]+)"""")
    .find(rootProject.file("rust/Cargo.toml").readText())
    ?.groupValues
    ?.get(1)
check(rustWorkspaceVersion == productVersionName) {
    "rust/Cargo.toml version $rustWorkspaceVersion does not carry the product version $productVersionName"
}

fun quoted(value: String): String = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

android {
    namespace = "com.droidbridge.root"
    compileSdk = 37
    buildToolsVersion = "36.0.0"
    // The module's daemon is built with this NDK.
    ndkVersion = "29.0.14206865"

    defaultConfig {
        applicationId = "com.droidbridge.root"
        minSdk = 33
        targetSdk = 37
        versionCode = productVersionCode
        versionName = productVersionName
        buildConfigField("String", "GITHUB_OWNER", quoted(releaseConfig.getProperty("github_owner")))
        buildConfigField("String", "GITHUB_REPO", quoted(releaseConfig.getProperty("github_repo")))
        // The module that installs this App is arm64-only.
        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
        }
        release {
            isMinifyEnabled = false
            isShrinkResources = false
        }
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    androidResources {
        generateLocaleConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets.named("main") {
        assets.srcDir(layout.buildDirectory.dir("generated/productInfoAssets").get().asFile)
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(project(":ui-common"))
    implementation(libs.navigation3.runtime)
    implementation(libs.navigation3.ui)
    implementation(libs.lifecycle.viewmodel.navigation3)

    debugImplementation(libs.compose.ui.tooling)

    testImplementation(libs.junit4)
}

// Licenses and third-party notices ship from the same provenance the release checks use.
val copyProductInfoAssets by tasks.registering(Copy::class) {
    from(rootProject.file("tools/third-party-direct.tsv"))
    from(rootProject.file("THIRD_PARTY_NOTICES.txt"))
    into(layout.buildDirectory.dir("generated/productInfoAssets"))
}

tasks.named("preBuild").configure { dependsOn(copyProductInfoAssets) }

val sdkPath = androidComponents.sdkComponents.sdkDirectory.get().asFile
val ndkPath = androidComponents.sdkComponents.ndkDirectory.get().asFile.absolutePath

val helperCommonSources = rootProject.file("magisk/framework-src/common")
val java17Compiler = extensions.getByType(JavaToolchainService::class.java).compilerFor {
    languageVersion.set(JavaLanguageVersion.of(17))
}
val helperJars = (33..37).associateWith { api ->
    val classesDirectory = layout.buildDirectory.dir("generated/magiskFramework/api$api/classes")
    val compileHelper = tasks.register<JavaCompile>("compileMagiskFrameworkApi$api") {
        val stubs = rootProject.file("magisk/framework-stubs/api$api")
        source(
            fileTree(helperCommonSources) { include("**/*.java") },
            fileTree(rootProject.file("magisk/framework-src/api$api")) { include("**/*.java") },
        )
        inputs.dir(stubs)
        classpath = files(sdkPath.resolve("platforms/android-$api/android.jar"))
        options.sourcepath = files(stubs)
        options.compilerArgs.add("-implicit:none")
        destinationDirectory.set(classesDirectory)
        javaCompiler.set(java17Compiler)
        sourceCompatibility = "17"
        targetCompatibility = "17"
        options.encoding = "UTF-8"
    }
    val classesJarDirectory = layout.buildDirectory.dir("generated/magiskFramework/api$api")
    val classesJar = classesJarDirectory.map { it.file("classes.jar") }
    val jarHelper = tasks.register<Jar>("jarMagiskFrameworkApi$api") {
        dependsOn(compileHelper)
        from(classesDirectory)
        archiveFileName.set("classes.jar")
        destinationDirectory.set(classesJarDirectory)
    }
    val dexDirectory = layout.buildDirectory.dir("generated/magiskFramework/api$api/dex")
    val dexHelper = tasks.register<Exec>("dexMagiskFrameworkApi$api") {
        dependsOn(jarHelper)
        inputs.file(classesJar)
        outputs.dir(dexDirectory)
        commandLine(
            sdkPath.resolve("build-tools/36.0.0/d8.bat").absolutePath,
            "--min-api", "33",
            "--output", dexDirectory.get().asFile.absolutePath,
            classesJar.get().asFile.absolutePath,
        )
    }
    tasks.register<Zip>("packageMagiskFrameworkApi$api") {
        dependsOn(dexHelper)
        from(dexDirectory.map { it.file("classes.dex") })
        archiveFileName.set("droidbridge-framework-api$api.jar")
        destinationDirectory.set(layout.buildDirectory.dir("generated/magiskFramework/jars"))
    }
}

/**
 * The module of one build identity. The debug module carries this build's debug frontend; the
 * stable module is staged without it, because the release tooling adds the frontend only once
 * it is signed.
 */
fun registerMagiskModule(variant: String, debugModule: Boolean) {
    val capitalized = variant.replaceFirstChar(Char::uppercase)
    val rustTarget = layout.buildDirectory.dir("generated/magiskRust/$variant")
    val rustTargetPath = rustTarget.get().asFile.absolutePath
    val buildRust = tasks.register<Exec>("build${capitalized}MagiskRust") {
        workingDir(rootProject.file("rust"))
        inputs.files(rootProject.fileTree("rust/crates") { include("**/*.rs", "**/Cargo.toml") })
        inputs.files(rootProject.file("rust/Cargo.toml"), rootProject.file("rust/Cargo.lock"))
        outputs.dir(rustTarget)
        val features = if (debugModule) listOf("--features", "daemon/debug-module") else emptyList()
        commandLine(
            listOf(
                "cargo", "ndk", "-t", "arm64-v8a", "--platform", "33", "build", "--locked", "--release",
                "-p", "daemon", "-p", "supervisor", "-p", "app_native", "--bins",
            ) + features,
        )
        environment("ANDROID_NDK_HOME", ndkPath)
        environment("ANDROID_NDK_ROOT", ndkPath)
        environment("CARGO_TARGET_DIR", rustTargetPath)
    }
    val staging = layout.buildDirectory.dir("generated/magiskModule/$variant")
    val stampedVersionName = productVersionName
    val stampedVersionCode = productVersionCode
    val frontendPackage = if (debugModule) "com.droidbridge.root.debug" else "com.droidbridge.root"
    val stageModule = tasks.register<Sync>("stage${capitalized}MagiskModule") {
        dependsOn(buildRust)
        dependsOn(helperJars.values)
        from(rootProject.file("magisk")) {
            exclude("framework-src/**")
            exclude("framework-stubs/**")
            if (debugModule) exclude("module.prop")
        }
        from(rootProject.file("THIRD_PARTY_NOTICES.txt"))
        from(rustTarget.map { it.file("aarch64-linux-android/release/droidbridge-supervisor") }) {
            into("bin")
        }
        from(rustTarget.map { it.file("aarch64-linux-android/release/droidbridged") }) {
            into("bin")
        }
        from(rustTarget.map { it.file("aarch64-linux-android/release/droidbridge_exec_guard") }) {
            into("bin")
            rename { "droidbridge-exec-guard" }
        }
        helperJars.forEach { (api, task) ->
            from(task.flatMap { it.archiveFile }) {
                into("framework")
                rename { "droidbridge-framework-api$api.jar" }
            }
        }
        if (debugModule) {
            dependsOn("assembleDebug")
            from(layout.buildDirectory.file("outputs/apk/debug/root-frontend-debug.apk")) {
                rename { "frontend.apk" }
            }
        }
        into(staging)
        val template = rootProject.file("magisk/module.prop")
        doLast {
            // The staged module.prop carries the one product version, written with LF endings
            // because the module ZIP is byte-checked and its scripts are LF-only.
            val lines = if (debugModule) {
                listOf(
                    "id=droidbridge_debug",
                    "name=DroidBridge Debug",
                    "version=",
                    "versionCode=",
                    "author=DroidBridge",
                    "description=DroidBridge debug root backend",
                )
            } else {
                template.readLines()
            }
            val stamped = lines.map { line ->
                when {
                    line.startsWith("version=") -> "version=$stampedVersionName"
                    line.startsWith("versionCode=") -> "versionCode=$stampedVersionCode"
                    else -> line
                }
            }
            staging.get().file("module.prop").asFile
                .writeText(stamped.joinToString("\n", postfix = "\n"))
            staging.get().file("frontend.package").asFile.writeText("$frontendPackage\n")
        }
    }
    tasks.register<Zip>("assemble${capitalized}MagiskModule") {
        dependsOn(stageModule)
        from(staging)
        archiveFileName.set("droidbridge-$variant-magisk.zip")
        destinationDirectory.set(layout.buildDirectory.dir("outputs/magisk"))
    }
}

registerMagiskModule("stable", false)
registerMagiskModule("debug", true)
