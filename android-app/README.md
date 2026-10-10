# PDS Schedule Alarm

Native Android companion for background Pharmacy schedule notifications and event alarms.

## Build

Open this `android-app` folder in Android Studio and let Gradle sync. Build a debug APK with **Build > Build Bundle(s) / APK(s) > Build APK(s)**. Employees connect with their Staff ID and employee password. Department heads select their role and sign in with the matching Firebase Auth email/password for Pharmacist, Billing, or Information. Allow notifications after connecting.

## Company distribution

Do not distribute the debug APK. IT must create and securely back up the company's release keystore, then set these environment variables on the build machine (never commit the keystore or passwords):

- `PDS_RELEASE_STORE_FILE`
- `PDS_RELEASE_STORE_PASSWORD`
- `PDS_RELEASE_KEY_ALIAS`
- `PDS_RELEASE_KEY_PASSWORD`

Build the signed APK with `gradlew assembleRelease`. After signing/authentication review, distribute it through Firebase App Distribution using app ID `1:115454971026:android:d5de21244f5b4f7d6cea4b` and an IT-managed tester email list.

The app registers employee tokens by Staff ID and department-head tokens by the authenticated head role with the existing Cloudflare push worker. Event reminders use a high-importance notification plus the device's default alarm ringtone for up to 60 seconds, with a Stop alarm action.

## Infinix background behavior

After installation, allow notifications and sound for **PDS Schedule Alarm**. In XOS, also allow auto-start/background activity and set battery use to unrestricted if the device delays alarms. Android still honors Do Not Disturb, alarm volume, and per-channel notification settings.

Firebase configuration is in `app/google-services.json`; the Android app is registered as `ph.planetdrugstore.schedule` in the existing Firebase project.