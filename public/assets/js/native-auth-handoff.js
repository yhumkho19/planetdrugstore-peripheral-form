import { signInWithCustomToken } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const AUTH_HANDOFF_URL = "https://peripherals-push.pds-peripherals.workers.dev/auth-handoff/exchange";

export async function consumeNativeAuthHandoff(auth) {
  const url = new URL(window.location.href);
  const handoffCode = url.searchParams.get("authHandoff");
  if (!handoffCode) return;

  url.searchParams.delete("authHandoff");
  window.history.replaceState(null, "", url);

  try {
    let response;
    for (let attempt = 0; attempt < 5; attempt++) {
      response = await fetch(AUTH_HANDOFF_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handoffCode })
      });
      if (response.status !== 410 || attempt === 4) break;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
    if (!response.ok) throw new Error(`Authentication handoff failed (${response.status}).`);
    const result = await response.json();
    if (typeof result.customToken !== "string" || !result.customToken) {
      throw new Error("The authentication handoff did not return a Firebase token.");
    }
    await signInWithCustomToken(auth, result.customToken);
  } catch (error) {
    console.error("Could not sign in from the Android app:", error);
    window.alert("Could not sign in from the Android app. Please reopen this page from the app or sign in again.");
  }
}
