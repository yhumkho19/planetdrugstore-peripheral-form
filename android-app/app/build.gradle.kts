import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.util.Properties

plugins {
    id("com.android.application")
    id("com.google.gms.google-services")
}

val localSigningPropertiesFile = File(
    System.getProperty("user.home"),
    ".android${File.separator}pds-release.properties"
)
val localSigningProperties = Properties().apply {
    if (localSigningPropertiesFile.isFile) {
        localSigningPropertiesFile.inputStream().use { load(it) }
    }
}
fun signingValue(name: String): String? =
    providers.environmentVariable(name).orNull?.takeIf { it.isNotBlank() }
        ?: localSigningProperties.getProperty(name)?.takeIf { it.isNotBlank() }

val releaseStoreFile = signingValue("PDS_RELEASE_STORE_FILE")
val releaseStorePassword = signingValue("PDS_RELEASE_STORE_PASSWORD")
val releaseKeyAlias = signingValue("PDS_RELEASE_KEY_ALIAS")
val releaseKeyPassword = signingValue("PDS_RELEASE_KEY_PASSWORD")
val hasReleaseSigning = listOf(releaseStoreFile, releaseStorePassword, releaseKeyAlias, releaseKeyPassword)
    .all { !it.isNullOrBlank() }
val expectedReleaseCertificateSha256 = "A1973EEC35B8E1CC474868B5004E39D09B3237035798C35673292717EEB0A06C"

android {
    namespace = "ph.planetdrugstore.schedule"
    compileSdk = 35

    defaultConfig {
        applicationId = "ph.planetdrugstore.schedule"
        minSdk = 23
        targetSdk = 35
        versionCode = 20
        versionName = "1.5.5"
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
    implementation("androidx.fragment:fragment:1.8.9")
    implementation("androidx.core:core:1.16.0")
}

val validateReleaseSigning = tasks.register("validateReleaseSigning") {
    doLast {
        check(hasReleaseSigning) {
            "Set the PDS_RELEASE_* environment variables or create ${localSigningPropertiesFile.path} before building a release APK."
        }
        val keyStoreFile = file(releaseStoreFile!!)
        check(keyStoreFile.isFile) { "Android release keystore was not found at ${keyStoreFile.path}." }
        val keyStore = KeyStore.getInstance("JKS")
        keyStoreFile.inputStream().use { keyStore.load(it, releaseStorePassword!!.toCharArray()) }
        val certificate = keyStore.getCertificate(releaseKeyAlias!!)
        check(certificate != null) { "The configured Android release key alias was not found in the keystore." }
        val actualFingerprint = MessageDigest.getInstance("SHA-256")
            .digest(certificate.encoded)
            .joinToString("") { "%02X".format(it.toInt() and 0xFF) }
        check(actualFingerprint == expectedReleaseCertificateSha256) {
            "The configured Android release certificate does not match the permanent Planet Drugstore signing key. Do not replace or rotate the release keystore."
        }
    }
}

tasks.configureEach {
    if (name != "validateReleaseSigning" && name.contains("Release", ignoreCase = true)) {
        dependsOn(validateReleaseSigning)
    }
}