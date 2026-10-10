plugins {
    id("com.android.application")
    id("com.google.gms.google-services")
}

val releaseStoreFile = providers.environmentVariable("PDS_RELEASE_STORE_FILE").orNull
val releaseStorePassword = providers.environmentVariable("PDS_RELEASE_STORE_PASSWORD").orNull
val releaseKeyAlias = providers.environmentVariable("PDS_RELEASE_KEY_ALIAS").orNull
val releaseKeyPassword = providers.environmentVariable("PDS_RELEASE_KEY_PASSWORD").orNull
val hasReleaseSigning = listOf(releaseStoreFile, releaseStorePassword, releaseKeyAlias, releaseKeyPassword)
    .all { !it.isNullOrBlank() }

android {
    namespace = "ph.planetdrugstore.schedule"
    compileSdk = 35

    defaultConfig {
        applicationId = "ph.planetdrugstore.schedule"
        minSdk = 23
        targetSdk = 35
            versionCode = 9
            versionName = "1.4.4"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseStoreFile!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("release")
        }
    }
}

dependencies {
    implementation(platform("com.google.firebase:firebase-bom:34.2.0"))
    implementation("com.google.firebase:firebase-messaging")
    implementation("com.google.firebase:firebase-firestore")
    implementation("com.google.firebase:firebase-auth")
    implementation("androidx.activity:activity:1.10.1")
    implementation("androidx.core:core:1.16.0")
}

val validateReleaseSigning = tasks.register("validateReleaseSigning") {
    doLast {
        check(hasReleaseSigning) {
            "Set PDS_RELEASE_STORE_FILE, PDS_RELEASE_STORE_PASSWORD, PDS_RELEASE_KEY_ALIAS, and PDS_RELEASE_KEY_PASSWORD before building a release APK."
        }
    }
}

tasks.configureEach {
    if (name != "validateReleaseSigning" && name.contains("Release", ignoreCase = true)) {
        dependsOn(validateReleaseSigning)
    }
}