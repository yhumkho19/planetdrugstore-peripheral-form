import { connectAuthEmulator } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOCAL_PROJECT_ID = "demo-peripherals-local";
const connectedAuthInstances = new WeakSet();
const connectedFirestoreInstances = new WeakSet();

function isLocalHost() {
  return LOCAL_HOSTS.has(window.location.hostname);
}

export function getFirebaseConfigForHost(config) {
  if (!isLocalHost()) return config;
  return {
    ...config,
    projectId: LOCAL_PROJECT_ID,
    authDomain: `${LOCAL_PROJECT_ID}.firebaseapp.com`
  };
}

export function connectLocalFirebaseEmulators({ db, auth, additionalAuth = [] } = {}) {
  if (!isLocalHost()) return;

  if (db && !connectedFirestoreInstances.has(db)) {
    connectFirestoreEmulator(db, "127.0.0.1", 8081);
    connectedFirestoreInstances.add(db);
  }

  [auth, ...additionalAuth].filter(Boolean).forEach(instance => {
    if (connectedAuthInstances.has(instance)) return;
    connectAuthEmulator(instance, "http://127.0.0.1:9099", { disableWarnings: true });
    connectedAuthInstances.add(instance);
  });

}