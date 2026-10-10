# Mobile Push Notifications (No Firebase Blaze)

The employee schedule pages now have an opt-in push control. The free-tier path uses Firebase Cloud Messaging for delivery. Schedule pages wake the Cloudflare Worker immediately after writing notifications, with a once-per-minute poll as a fallback. It does not deploy Firebase Cloud Functions or require the Blaze plan. Actual delivery stays disabled until the setup below is completed.

## Prerequisites

- A Cloudflare account with Workers and KV enabled on its free plan.
- Access to the Firebase project and permission to create a service-account key.
- A Firebase Cloud Messaging Web Push certificate and the Cloudflare Worker URL.

Free plans have quotas and providers can change their limits. Check the current Cloudflare and Firebase quotas before production use. On iPhone, web push requires iOS 16.4 or newer and the site added to the Home Screen.

## Configure Firebase

1. In Firebase Console, open Project settings > Cloud Messaging and create a Web Push certificate key pair. Copy the public key; it is used by the website, not treated as a secret.
2. Enable the Firebase Cloud Messaging API for this project in Google Cloud. FCM delivery itself does not require Blaze.
3. Create a service account with Firebase Cloud Messaging send permission. Keep its JSON key private; never put it in `public/` or commit it.

## Deploy the Worker

From `push-worker/`, create a KV namespace and put the returned ID in `wrangler.toml` in place of `REPLACE_WITH_KV_NAMESPACE_ID`:

```powershell
npx wrangler login
npx wrangler kv namespace create PUSH_SUBSCRIPTIONS
```

Set the service account credentials as Worker secrets. Use the `client_email` and `private_key` values from the service-account JSON:

```powershell
npx wrangler secret put FIREBASE_CLIENT_EMAIL
npx wrangler secret put FIREBASE_PRIVATE_KEY
npx wrangler secret put FIREBASE_API_KEY
```

For each command, paste the requested value into the terminal prompt. Do not paste private credentials into chat or source files. Then deploy:

```powershell
npx wrangler deploy
```

Copy the Worker URL, normally `https://peripherals-push.<account>.workers.dev`.

## Enable the Website Control

Edit `public/push-config.json` after the Worker is deployed:

```json
{
  "enabled": true,
  "workerUrl": "https://peripherals-push.<account>.workers.dev",
  "vapidKey": "PUBLIC_WEB_PUSH_CERTIFICATE_KEY_FROM_FIREBASE"
}
```

Deploy the Firebase Hosting site. Employees can enable notifications from their schedule page or Stock Request page. The Stock Request admin can enable notifications from the Stock Request admin page. Each device/browser needs its own opt-in and must allow notifications.

On iPhone or iPad, open the site in Safari, add it to the Home Screen, launch it from the Home Screen icon, then tap **Enable phone notifications**. Web Push requires iOS/iPadOS 16.4 or newer; it is not available from a regular Safari tab.

## Scope and Data

The Worker sends generic schedule alerts for personal notifications addressed to the matching staff ID and for `eventsDeployed` broadcasts. It does not include employee names or schedule details in lock-screen text. The current Firestore rules already allow public reads of `emergencyNotifications`; the Worker uses that existing access and does not change Firestore rules. Review those rules separately before treating notification contents as private.

The Worker stores FCM device tokens and staff IDs in Cloudflare KV. Employees can turn off notifications for the current device from the same Notifications panel. Revoke a device centrally by removing its `sub:` KV entry. Disable push globally by setting `enabled` to `false` in `public/push-config.json` and redeploying Hosting.