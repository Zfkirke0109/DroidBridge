import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.droidbridge.ui"
    compileSdk = 37
    buildToolsVersion = "36.0.0"

    defaultConfig {
        minSdk = 33
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    api(platform(libs.kotlin.bom))
    api(platform(libs.compose.bom))
    api(libs.compose.ui)
    api(libs.compose.foundation)
    api(libs.compose.material3)
    api(libs.compose.material3.adaptive.navigation.suite)
    api(libs.compose.ui.tooling.preview)
    api(libs.activity.compose)
    api(libs.lifecycle.runtime.compose)
    api(libs.lifecycle.viewmodel.compose)
    api(libs.androidx.core)
    api(libs.datastore.preferences)
    api(libs.kotlinx.coroutines.android)
    api(libs.kotlinx.serialization.json)

    testImplementation(libs.junit4)
}
