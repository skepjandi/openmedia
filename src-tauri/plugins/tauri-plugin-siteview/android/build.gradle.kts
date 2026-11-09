import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "surf.openmedia.siteview"
    compileSdk = 36

    defaultConfig {
        minSdk = 24

        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

// The Public Suffix rules every platform shares ship as a Java resource.
(extensions.getByName("android") as com.android.build.gradle.BaseExtension)
    .sourceSets.getByName("main").resources.srcDir(file("../../../../shared/public-suffix/resources"))

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.9.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("androidx.browser:browser:1.9.0")
    implementation(project(":tauri-android"))
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260814")
}
