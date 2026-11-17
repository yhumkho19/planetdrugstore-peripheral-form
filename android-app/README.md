# PDS Schedule Alarm

Native Android app for Planet Drugstore notifications, including schedule updates and event alarms.

## Build

Open this `android-app` folder in Android Studio and let Gradle sync. Build a debug APK with **Build > Build Bundle(s) / APK(s) > Build APK(s)**. Employees connect with their Staff ID and employee password. Department heads select their role and sign in with the matching Firebase Auth email/password for Pharmacist, Billing, or Information. Allow notifications after connecting.

The disconnected screen shows an X status circle; refreshing the connection shows a rotating broken-ring indicator. The connected screen shows the notification permission state and includes a **Test** action for event alarms. Test alarms return to the notification center after 60 seconds or when **Stop alarm** is tapped.

For Stock Request admin notifications, choose **Stock Request Meds Admin** or **Stock Request Supplies Admin** and use its matching Firebase Auth email. The selected role is checked against the verified email, which determines which category's alerts the device receives. Passwords are entered at sign-in and are not stored in the APK.

The **Open console** button securely hands the connected Firebase session to the common Planet Drugstore console landing page for every connected account, so the browser does not ask the user to sign in again. The one-time handoff expires quickly and cannot be reused.

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