const personalTypes = new Set([
  "removed",
  "stockRequestRemoved",
  "stockRequestCompleted",
  "stockRequestUnblocked",
  "branchChanged",
  "dateChanged",
  "eventUpdated",
  "missionChanged",
  "eventDeleted",
  "siteRemoved",
  "siteAutoDeleted",
  "eventCancelled",
  "eventReinstated",
  "slotAssigned",
  "slotRoleRemoved",
  "slotOpened",
  "siteMoved"
]);
const headRoles = new Set(["pharmacist", "billing", "information", "stock"]);
const stockRequestAdminTeamsUrl = "https://teams.microsoft.com/l/channel/19%3Ad306729cf93a4d0bb3970490db04752e%40thread.tacv2/CALOOCAN?groupId=64a1d61d-5681-4a79-ae96-a838a1a32560&tenantId=a5906354-ebe5-419d-b024-6c7db90917b0&ngc=true";
const eventScheduleAdminTeamsUrl = "https://teams.microsoft.com/l/channel/19%3A8c33af8e2f4c4d8dabb99a5a5337287f%40thread.tacv2/PEOPLES%20DAY%20x%20MEDICAL%20MISSION?groupId=64a1d61d-5681-4a79-ae96-a838a1a32560&tenantId=a5906354-ebe5-419d-b024-6c7db90917b0&ngc=true";
const headRolesByEmail = {
  "adminstockreqmeds@planetdrugstore.ph": "stock",
  "adminstockreqsup@planetdrugstore.ph": "stock",
  "pharmacistdepart@planetdrugstore.ph": "pharmacist",
  "billingdepart@planetdrugstore.ph": "billing",
  "informationdepart@planetdrugstore.ph": "information"
};

let cachedAccessToken;
let cachedFirebaseJwks;
let cachedFirebaseJwksExpiresAt = 0;
const SCHEDULED_JOB_MIGRATION_KEY = "scheduled-jobs-migrated-v1";
const SCHEDULED_ALARM_MIGRATION_KEY = "scheduled-jobs-alarm-migrated-v1";

async function updateScheduledAlarm(env, operation, name, task) {
  if (!env.SCHEDULED_JOBS) return;
  const id = env.SCHEDULED_JOBS.idFromName("scheduled-jobs");
  const stub = env.SCHEDULED_JOBS.get(id);
  await stub.fetch("https://scheduled-jobs.internal/task", {
    method: "POST",
    body: JSON.stringify({ operation, name, task })
  });
}

async function deleteScheduledTask(env, name) {
  await env.PUSH_SUBSCRIPTIONS.delete(name);
  await updateScheduledAlarm(env, "delete", name);
}

async function migrateScheduledJobsToAlarms(env) {
  if (!env.SCHEDULED_JOBS || await env.PUSH_SUBSCRIPTIONS.get(SCHEDULED_ALARM_MIGRATION_KEY)) return;
  await migrateLegacyScheduledJobs(env);
  let cursor;
  do {
    const page = await env.PUSH_SUBSCRIPTIONS.list({ prefix: "scheduled:", cursor });
    for (const item of page.keys) {
      const task = await env.PUSH_SUBSCRIPTIONS.get(item.name, "json");
      if (task && Number.isFinite(Number(task.dueAt))) {
        await updateScheduledAlarm(env, "upsert", item.name, task);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  await env.PUSH_SUBSCRIPTIONS.put(SCHEDULED_ALARM_MIGRATION_KEY, "1");
}

export function shouldNotify(subscription, notification) {
  const staffId = String(subscription.staffId || "").trim().toLowerCase();
  if (notification.type === "stockRequestSubmitted") {
    const headRole = String(subscription.headRole || "").trim().toLowerCase();
    const stockType = String(subscription.stockType || "").trim().toLowerCase();
    return headRole === "stock"
      && stockType === notification.requestType
      && ["medicine", "supplies"].includes(String(notification.requestType || "").trim().toLowerCase());
  }
  if (["siteSwapRequest", "siteSwapApproved", "siteSwapDeclined"].includes(notification.type)) {
    return !subscription.headRole
      && notification.visibleToEmployees !== false
      && Array.isArray(notification.targetStaffIds)
      && notification.targetStaffIds.map(id => String(id || "").trim().toLowerCase()).includes(staffId);
  }
  if (["siteInactive", "siteReactivated"].includes(notification.type)) {
    return !subscription.headRole
      && notification.visibleToEmployees !== false
      && Array.isArray(notification.targetStaffIds)
      && notification.targetStaffIds.map(id => String(id || "").trim().toLowerCase()).includes(staffId);
  }
  if (notification.type === "crossBranchSignup") {
    const headRole = String(subscription.headRole || "").trim().toLowerCase();
    if (headRole) {
      return Array.isArray(notification.targetRoles)
        && notification.targetRoles.includes(headRole)
        && notification.employeeOnly !== true;
    }
    const department = String(subscription.department || "").trim().toLowerCase().replace(/\s+(north|south)$/i, "");
    return notification.visibleToEmployees !== false
      && Array.isArray(notification.targetDepartments)
      && notification.targetDepartments.includes(department);
  }
  if (["eventCutoffChanged", "eventCutoffReached"].includes(notification.type)) {
    const headRole = String(subscription.headRole || "").trim().toLowerCase();
    if (headRole) return notification.employeeOnly !== true
      && Array.isArray(notification.targetRoles)
      && notification.targetRoles.includes(headRole);
    return notification.visibleToEmployees !== false && notification.broadcastToEmployees === true;
  }
  if (notification.type === "stockDayActivated") {
    return !subscription.headRole
      && Array.isArray(notification.targetStaffIds)
      && notification.targetStaffIds.map(id => String(id || "").trim().toLowerCase()).includes(staffId);
  }
  if (["stockDayScheduleChanged", "stockDayCutoffUpdated"].includes(notification.type)) {
    return !subscription.headRole
      && Array.isArray(notification.targetStaffIds)
      && notification.targetStaffIds.map(id => String(id || "").trim().toLowerCase()).includes(staffId);
  }
  if (["stockDayClosed", "stockDayClosedEarly"].includes(notification.type)) {
    if (subscription.headRole) {
      return String(subscription.headRole).trim().toLowerCase() === "stock"
        && (!notification.requestType || String(subscription.stockType || "").trim().toLowerCase() === notification.requestType);
    }
    return Array.isArray(notification.targetStaffIds)
      && notification.targetStaffIds.map(id => String(id || "").trim().toLowerCase()).includes(staffId);
  }
  if (notification.type === "eventReminder") {
    return !subscription.headRole
      && Array.isArray(notification.recipientStaffIds)
      && notification.recipientStaffIds.map(id => String(id || "").trim().toLowerCase()).includes(staffId);
  }
  if (notification.type === "pharmacistNote") {
    return !subscription.headRole
      && Array.isArray(notification.recipientStaffIds)
      && notification.recipientStaffIds.map(id => String(id || "").trim().toLowerCase()).includes(staffId);
  }

  const headRole = String(subscription.headRole || "").trim().toLowerCase();
  if (headRoles.has(headRole)) {
    return Array.isArray(notification.targetRoles)
      && notification.targetRoles.includes(headRole)
      && notification.employeeOnly !== true;
  }

  if (notification.visibleToEmployees === false) return false;

  if (["eventCancelled", "eventReinstated"].includes(notification.type) && notification.broadcastToEmployees === true) {
    return !subscription.headRole;
  }

  if (!staffId) return false;

  if (notification.type === "eventsDeployed") {
    const assigned = Array.isArray(notification.assignedStaffIds)
      ? notification.assignedStaffIds.map(id => String(id || "").trim().toLowerCase())
      : [];
    return !assigned.includes(staffId);
  }

  return personalTypes.has(notification.type)
    && String(notification.staffId || "").trim().toLowerCase() === staffId;
}

export function isDirectlyDeliverableSwapNotification(notification) {
  if (!notification || notification.visibleToEmployees === false || !Array.isArray(notification.targetStaffIds)) {
    return false;
  }
  const targetStaffIds = notification.targetStaffIds
    .map(id => String(id || "").trim().toLowerCase())
    .filter(Boolean);
  if (!targetStaffIds.length) return false;

  if (notification.type === "siteSwapRequest") {
    const targetStaffId = String(notification.targetStaffId || "").trim().toLowerCase();
    return notification.status === "pending" && Boolean(targetStaffId) && targetStaffIds.includes(targetStaffId);
  }
  if (notification.type === "siteSwapApproved") return notification.status === "approved";
  if (notification.type === "siteSwapDeclined") return ["declined", "expired"].includes(notification.status);
  return false;
}

export function firestoreValue(value) {
  if (!value || typeof value !== "object") return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(firestoreValue);
  if ("mapValue" in value) {
    return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, field]) => [key, firestoreValue(field)]));
  }
  if ("nullValue" in value) return null;
  return undefined;
}

function decodeDocument(document) {
  const fields = {};
  for (const [key, value] of Object.entries(document.fields || {})) {
    fields[key] = firestoreValue(value);
  }
  const path = String(document.name || "").split("/");
  return { id: path[path.length - 1], ...fields };
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function getFirebaseJwks() {
  if (cachedFirebaseJwks && cachedFirebaseJwksExpiresAt > Date.now()) return cachedFirebaseJwks;
  const response = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
  if (!response.ok) throw new Error(`Firebase signing-key lookup failed (${response.status})`);
  const jwks = await response.json();
  const maxAge = Number(response.headers.get("cache-control")?.match(/max-age=(\d+)/i)?.[1] || 3600);
  cachedFirebaseJwks = jwks.keys || [];
  cachedFirebaseJwksExpiresAt = Date.now() + maxAge * 1000;
  return cachedFirebaseJwks;
}

async function verifyFirebaseIdToken(token, projectId) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || token.length > 8192) return null;

  let header;
  let claims;
  try {
    header = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;

  let signingKeys = await getFirebaseJwks();
  let jwk = signingKeys.find(key => key.kid === header.kid);
  if (!jwk) {
    cachedFirebaseJwksExpiresAt = 0;
    signingKeys = await getFirebaseJwks();
    jwk = signingKeys.find(key => key.kid === header.kid);
  }
  if (!jwk) return null;

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) return null;

  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== projectId ||
      claims.iss !== `https://securetoken.google.com/${projectId}` ||
      Number(claims.exp) <= now ||
      Number(claims.iat) > now + 30 ||
      !claims.sub) return null;

  return claims;
}

export function registeredPharmacistAdminRole(profile, email) {
  return profile?.active === true
    && profile?.role === "pharmacist"
    && String(profile.email || "").trim().toLowerCase() === String(email || "").trim().toLowerCase()
    ? "pharmacist"
    : "";
}

async function headRoleForClaims(env, claims) {
  const email = String(claims?.email || "").trim().toLowerCase();
  const existingRole = headRolesByEmail[email];
  if (existingRole) return existingRole;
  if (email.endsWith("@staff.planetdrugstore.local")) return "";
  if (!claims?.sub) return "";

  const response = await fetch(firestoreDocumentsUrl(env, `/eventScheduleAdmins/${encodeURIComponent(claims.sub)}`), {
    headers: { authorization: `Bearer ${await getAccessToken(env)}` }
  });
  if (response.status === 404) return "";
  if (!response.ok) throw new Error(`Pharmacy admin profile lookup failed (${response.status})`);
  return registeredPharmacistAdminRole(decodeDocument(await response.json()), email);
}

async function verifyFirebaseHeadToken(token, env) {
  const claims = await verifyFirebaseIdToken(token, env.FIREBASE_PROJECT_ID);
  return claims ? headRoleForClaims(env, claims) : "";
}

function encodeJson(value) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function pemToBytes(pem) {
  const encoded = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(encoded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function getAccessToken(env) {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60000) {
    return cachedAccessToken.value;
  }

  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson({
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  })}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(env.FIREBASE_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${base64Url(new Uint8Array(signature))}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  if (!response.ok) throw new Error(`Google token request failed (${response.status})`);
  const token = await response.json();
  cachedAccessToken = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
  return cachedAccessToken.value;
}

function firestoreDocumentsUrl(env, path) {
  const projectId = String(env.FIREBASE_PROJECT_ID || "").trim();
  const apiKey = String(env.FIREBASE_API_KEY || "").trim();
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents${path}`;
  return apiKey ? `${baseUrl}?key=${encodeURIComponent(apiKey)}` : baseUrl;
}

async function firestoreReadHeaders(env) {
  const apiKey = String(env.FIREBASE_API_KEY || "").trim();
  return apiKey ? {} : { authorization: `Bearer ${await getAccessToken(env)}` };
}

function firestoreAdminUrl(env, path) {
  const projectId = String(env.FIREBASE_PROJECT_ID || "").trim();
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents${path}`;
}

async function patchFirestoreDocument(env, path, fields, updateMaskFields = [], mustNotExist = false) {
  const mask = updateMaskFields.length
    ? `?${updateMaskFields.map(field => `updateMask.fieldPaths=${encodeURIComponent(field)}`).join("&")}`
    : "";
  const precondition = mustNotExist
    ? `${mask ? "&" : "?"}currentDocument.exists=false`
    : "";
  const response = await fetch(`${firestoreAdminUrl(env, path)}${mask}${precondition}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${await getAccessToken(env)}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ fields })
  });
  if (!response.ok) {
    if (response.status === 409 || response.status === 412) {
      throw new Error(`Firestore precondition failed (${response.status})`);
    }
    throw new Error(`Firestore document update failed (${response.status})`);
  }
  return response.json();
}

async function deleteFirestoreDocument(env, path) {
  const response = await fetch(firestoreAdminUrl(env, path), {
    method: "DELETE",
    headers: { authorization: `Bearer ${await getAccessToken(env)}` }
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Firestore document delete failed (${response.status})`);
  }
}

async function getAdminFirestoreDocument(env, path) {
  const response = await fetch(firestoreAdminUrl(env, path), {
    headers: { authorization: `Bearer ${await getAccessToken(env)}` }
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text();
    let detail = "";
    try { detail = JSON.parse(body)?.error?.message || ""; } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    throw new Error(`Firestore document lookup failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return decodeDocument(await response.json());
}

async function handleEmployeeRegistration(request, env) {
  const origin = request.headers.get("Origin") || "";
  const headers = corsHeaders(env, origin);
  if (!isAllowedOrigin(env, origin)) return new Response("Forbidden", { status: 403, headers });
  if (request.method === "OPTIONS") return new Response(null, { headers });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers });

  let body;
  try { body = await request.json(); } catch { return new Response("Invalid JSON", { status: 400, headers }); }
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const staffId = typeof body?.staffId === "string" ? body.staffId.trim() : "";
  const department = typeof body?.department === "string" ? body.department.trim() : "";
  const branch = typeof body?.branch === "string" ? body.branch.trim().toLowerCase() : "";
  const siteName = typeof body?.siteName === "string" ? body.siteName.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const allowedDepartments = new Set([
    "IT NORTH", "IT SOUTH",
    "BILLING NORTH", "BILLING SOUTH", "BILLING MANILA",
    "PHARMACIST NORTH", "PHARMACIST SOUTH",
    "Pharmacy Assistant NORTH", "Pharmacy Assistant SOUTH"
  ]);
  if (name.length < 2 || name.length > 120
      || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      || staffId.length < 1 || staffId.length > 40 || !/^[A-Za-z0-9._-]+$/.test(staffId)
      || !allowedDepartments.has(department)
      || siteName.length < 1 || siteName.length > 120
      || password.length < 8 || password.length > 256) {
    return new Response("Invalid registration data.", { status: 400, headers });
  }
  const expectedBranch = department.endsWith(" NORTH") ? "north"
    : department.endsWith(" SOUTH") ? "south"
    : department === "BILLING MANILA" ? "manila" : "";
  if (branch !== expectedBranch) return new Response("Invalid registration branch.", { status: 400, headers });

  try {
    if (!await employeeLoginRateLimit(env, request)) {
      return new Response("Too many registration attempts. Please try again later.", { status: 429, headers });
    }
    const registrationConfig = await getAdminFirestoreDocument(env, "/config/employeeRegistration");
    if (!registrationConfig?.registrationEnabled) {
      return new Response("Employee registration is closed.", { status: 403, headers });
    }
    const staffDocId = staffId.toLowerCase();
    if (await getAdminFirestoreDocument(env, `/employees/${encodeURIComponent(staffDocId)}`)) {
      return new Response("That Staff ID is already registered.", { status: 409, headers });
    }
    const passwordHash = await derivePasswordHash(password);
    try {
      await patchFirestoreDocument(env, `/employees/${encodeURIComponent(staffDocId)}`, {
        name: { stringValue: name },
        email: { stringValue: email },
        staffId: { stringValue: staffId },
        department: { stringValue: department },
        branch: { stringValue: branch },
        siteName: { stringValue: siteName },
        createdAt: { timestampValue: new Date().toISOString() },
        createdBy: { stringValue: "self-registration" }
      }, [], true);
    } catch (error) {
      if (/precondition failed \(409\)|precondition failed \(412\)/.test(error.message)) {
        return new Response("That Staff ID is already registered.", { status: 409, headers });
      }
      throw error;
    }
    try {
      await patchFirestoreDocument(env, `/employeeCredentials/${encodeURIComponent(staffDocId)}`, {
        passwordHash: { stringValue: passwordHash },
        updatedAt: { timestampValue: new Date().toISOString() }
      }, [], true);
    } catch (error) {
      await deleteFirestoreDocument(env, `/employees/${encodeURIComponent(staffDocId)}`);
      if (/precondition failed \(409\)|precondition failed \(412\)/.test(error.message)) {
        return new Response("That Staff ID is already registered.", { status: 409, headers });
      }
      throw error;
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...headers, "content-type": "application/json", "cache-control": "no-store" }
    });
  } catch (error) {
    console.error("Employee registration failed:", error);
    return new Response("Employee registration is temporarily unavailable.", { status: 503, headers });
  }
}

async function createFirebaseCustomToken(env, uid, claims = undefined) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson({
    iss: env.FIREBASE_CLIENT_EMAIL,
    sub: env.FIREBASE_CLIENT_EMAIL,
    aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
    iat: now,
    exp: now + 3600,
    uid,
    ...(claims ? { claims } : {})
  })}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(env.FIREBASE_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

async function employeeLoginRateLimit(env, request) {
  const ipAddress = request.headers.get("cf-connecting-ip") || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ipAddress));
  const limiterId = env.EMPLOYEE_LOGIN_LIMITER.idFromName(base64Url(new Uint8Array(digest)));
  const response = await env.EMPLOYEE_LOGIN_LIMITER.get(limiterId)
    .fetch("https://employee-login-limiter.internal/check", { method: "POST" });
  if (response.status === 429) return false;
  if (!response.ok) throw new Error(`Employee login rate limit check failed (${response.status})`);
  return true;
}

function constantTimeStringEqual(left, right) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }
  return difference === 0;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function derivePasswordHash(password) {
  const iterations = 100000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256
  );
  const hash = [...new Uint8Array(bits)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const saltBase64 = base64Url(salt);
  return `pbkdf2-sha256$${iterations}$${saltBase64}$${hash}`;
}

async function verifyPasswordHash(password, storedPasswordHash) {
  if (typeof storedPasswordHash !== "string") return { matches: false, needsUpgrade: false };
  if (/^pbkdf2-sha256\$/i.test(storedPasswordHash)) {
    const [algorithm, iterationsText, saltBase64, expectedHash] = storedPasswordHash.split("$");
    const iterations = Number(iterationsText);
    if (algorithm.toLowerCase() !== "pbkdf2-sha256"
        || !Number.isInteger(iterations) || iterations < 100000 || iterations > 100000
        || !saltBase64 || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
      return { matches: false, needsUpgrade: false };
    }
    let salt;
    try {
      salt = decodeBase64Url(saltBase64);
    } catch {
      return { matches: false, needsUpgrade: false };
    }
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      key,
      256
    );
    const actualHash = [...new Uint8Array(bits)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return {
      matches: constantTimeStringEqual(actualHash, expectedHash.toLowerCase()),
      needsUpgrade: false
    };
  }
  if (/^[a-f0-9]{64}$/i.test(storedPasswordHash)) {
    const suppliedHash = await sha256Hex(password);
    return {
      matches: constantTimeStringEqual(suppliedHash, storedPasswordHash.toLowerCase()),
      needsUpgrade: true
    };
  }
  return { matches: false, needsUpgrade: false };
}

function baseNotificationText(notification) {
  if (!notification || typeof notification !== "object") {
    return { title: "Schedule update", body: "Your schedule has changed. Open the app to review the details." };
  }

  const location = String(notification.location || "").trim();
  const date = String(notification.date || "").trim();
  const time = String(notification.time || "").trim();
  const role = String(notification.role || "").trim();
  const whenText = [date, time].filter(Boolean).join(" • ");
  const locationText = location ? ` at ${location}` : "";
  const roleText = role ? ` for ${role}` : "";
  const formatStockDays = days => (Array.isArray(days) ? days : [])
    .map(day => String(day || "").toLowerCase())
    .map(day => day.charAt(0).toUpperCase() + day.slice(1))
    .join(", ");
  const formatStockCutoff = minutes => Number.isInteger(minutes)
    ? new Date(Date.UTC(2000, 0, 1, Math.floor(minutes / 60), minutes % 60)).toLocaleTimeString("en-US", {
      timeZone: "UTC", hour: "numeric", minute: "2-digit"
    })
    : "the updated time";

  switch (notification.type) {
    case "siteSwapRequest":
      return {
        title: "Event site swap request",
        body: `${notification.requesterName || "Your teammate"} wants to swap event sites with you. Tap to review the request.`
      };
    case "siteSwapApproved":
      return {
        title: "Your site swap was approved",
        body: `You and ${notification.swapPartnerName || "your teammate"} exchanged event sites. Tap to view your new site.`
      };
    case "siteSwapDeclined":
      return {
        title: "Your site swap request was not approved",
        body: `${notification.swapPartnerName || "Your teammate"} declined the request.${notification.responseReason ? ` ${notification.responseReason}` : ""}`
      };
    case "siteInactive":
      return {
        title: "Your assigned site is inactive",
        body: `The site ${location || "you were assigned to"} is temporarily inactive. Operations will notify you when it becomes active again.`
      };
    case "siteReactivated":
      return {
        title: "Your assigned site is active again",
        body: `Operations reactivated ${location || "your assigned site"}. Your assignment is still in place.`
      };
    case "crossBranchSignup":
      return {
        title: "Cross-branch signup",
        body: `${notification.employeeName || "An employee"} from ${String(notification.employeeBranch || "").toUpperCase()} signed up in ${String(notification.eventBranch || "").toUpperCase()}${locationText}${whenText ? ` on ${whenText}` : ""}.`
      };
    case "eventCutoffChanged":
      return {
        title: "Event cutoff changed",
        body: `Operations changed the cutoff time to ${formatCutoffTime(notification.cutoffTime)}.`
      };
    case "eventCutoffReached":
      return {
        title: "Event cutoff reached",
        body: `Here's the final lineup for ${notification.location || "this event site"}. The cutoff time (${formatCutoffTime(notification.cutoffTime)}) has been reached.`
      };
    case "stockDayActivated":
      {
      const requestType = notification.requestType === "supplies" ? "Supplies" : "Medicine";
      return {
        title: `${requestType} stock requests are open`,
        body: `${requestType} SR# entry is now open! You are scheduled for ${notification.day || "this day"}${notification.date ? ` (${notification.date})` : ""}. Open Stock Request to submit it.`
      };
      }
    case "stockRequestRemoved":
      return {
        title: "SR# removed",
        body: "Your SR# has been removed. Please contact your Stock Request Admin for more details."
      };
    case "stockRequestCompleted": {
      const requestType = notification.requestType === "supplies" ? "Supplies" : "Medicine";
      const sr = String(notification.sr || "").trim();
      return {
        title: `${requestType} SR# completed`,
        body: `Your ${requestType.toLowerCase()} SR#${sr ? ` ${sr}` : ""} has been marked completed by the admin. You can no longer edit this request.`
      };
    }
    case "stockRequestSubmitted": {
      const requestType = notification.requestType === "supplies" ? "Supplies" : "Medicine";
      const details = [
        notification.employeeName || "An employee",
        notification.location,
        notification.branch ? String(notification.branch).toUpperCase() : "",
        notification.date
      ].filter(Boolean);
      if (notification.updated === true) {
        return {
          title: `Updated ${requestType} stock request`,
          body: `${details.join(" • ")} updated SR# ${notification.previousSr || ""} → ${notification.sr || ""}.`
        };
      }
      return {
        title: `New ${requestType} stock request`,
        body: `${details.join(" • ")} submitted SR# ${notification.sr || ""}.`
      };
    }
    case "stockRequestUnblocked":
      return {
        title: "You were unblocked",
        body: "You were unblocked by the Stock Request Admin. You can now edit your SR# or keep your current SR#."
      };
    case "stockDayClosed":
      {
      const requestType = notification.requestType === "supplies" ? "Supplies" : "Medicine";
      return {
        title: `${requestType} stock requests closed`,
        body: `${requestType} stock requests for today are now closed!${notification.day ? ` (${notification.day})` : ""}`
      };
      }
    case "stockDayClosedEarly":
      {
      const requestType = notification.requestType === "supplies" ? "Supplies" : "Medicine";
      return {
        title: `${requestType} stock requests closed early`,
        body: `${requestType} stock requests${notification.day ? ` for ${notification.day}` : ""} were closed early by the admin. You can no longer submit, edit, or remove your SR# for this day.`
      };
      }
    case "stockDayScheduleChanged": {
      const assignedDays = formatStockDays(notification.requestDays);
      if (notification.wasUnscheduled && assignedDays) {
        return {
          title: "Stock request schedule assigned",
          body: `You were assigned stock request days: ${assignedDays}.`
        };
      }
      if (!assignedDays) {
        return {
          title: "Stock request schedule changed",
          body: "Your stock request schedule was removed. You currently have no assigned request days."
        };
      }
      const changes = [];
      const addedDays = formatStockDays(notification.addedDays);
      const removedDays = formatStockDays(notification.removedDays);
      if (addedDays) changes.push(`Added: ${addedDays}`);
      if (removedDays) changes.push(`Removed: ${removedDays}`);
      return {
        title: "Stock request schedule changed",
        body: `Your stock request days changed. ${changes.join(". ")}${changes.length ? ". " : ""}Current days: ${assignedDays}.`
      };
    }
    case "stockDayCutoffUpdated": {
      const oldCutoff = formatStockCutoff(notification.previousCutoffMin);
      const newCutoff = formatStockCutoff(notification.cutoffMin);
      const requestType = notification.requestType === "supplies" ? "Supplies" : "Medicine";
      return {
        title: `${requestType} stock request cutoff changed`,
        body: notification.unclosed === true
          ? `The admin reopened ${requestType.toLowerCase()} stock requests. You can now enter or edit your SR# until ${newCutoff}.`
          : notification.reopened === true
          ? `The ${requestType.toLowerCase()} cutoff passed, but the admin moved it from ${oldCutoff} to ${newCutoff}. You can edit or remove your SR# until ${newCutoff}.`
          : `The admin changed the ${requestType.toLowerCase()} stock request cutoff from ${oldCutoff} to ${newCutoff}. Submit, edit, or remove your SR# before ${newCutoff}.`
      };
    }
    case "eventReminder": {
      const assignment = notification.recipientAssignment || {};
      const isReliever = assignment.list === "relievers";
      const assignedLocation = String(assignment.location || (isReliever ? "your assigned health center" : location || "your site")).trim();
      const assignmentDate = String(assignment.date || date).trim();
      const assignmentTime = isReliever
        ? formatRelieverTime(assignment.relieverTime || assignment.time || "20:00")
        : String(assignment.time || time).trim();
      const assignmentWhen = [assignmentDate, assignmentTime].filter(Boolean).join(" at ");
      if (isReliever) {
        return {
          title: "Store reliever reminder",
          body: `You are relieving ${assignedLocation}${assignmentDate ? ` on ${assignmentDate}` : ""} from ${assignmentTime} onwards.`
        };
      }
      return {
        title: "Event alarm from Pharmacy",
        body: `Operations sent an event reminder for ${assignedLocation}${assignmentWhen ? ` on ${assignmentWhen}` : ""}.`
      };
    }
    case "eventsDeployed":
      return {
        title: Number(notification.siteCount) === 1 ? "New site deployed" : "New sites deployed",
        body: notification.siteSummary
          ? `${Number(notification.siteCount) === 1 ? "The new site has been deployed" : "New sites have been deployed"}: ${notification.siteSummary}`
          : "New pharmacy events are available. Open the schedule to review."
      };
    case "pharmacistNote": {
      const note = String(notification.noteText || "").trim();
      const actor = String(notification.actorLabel || "your department head").trim();
      return {
        title: `Note from ${actor}`,
        body: `${actor} left a note for ${location || "your event"}: ${note}`
      };
    }
    case "slotAssigned":
      {
        const assignedBy = String(notification.actorLabel || notification.assignedBy || "your department head").trim();
      if (notification.list === "relievers") {
        return {
          title: "You were assigned as Store Reliever",
          body: `You're assigned to relieve ${location || "your assigned health center"}${date ? ` on ${date}` : ""} from ${formatRelieverTime(notification.relieverTime || "20:00")} onwards by ${assignedBy}.`
        };
      }
      return {
        title: "You were assigned to an event slot",
        body: `You were added to this event${roleText}${locationText}${whenText ? ` on ${whenText}` : ""} by ${assignedBy}. Open the schedule to review the details.`
      };
      }
    case "slotOpened":
      if (notification.list === "relievers") {
        return {
          title: "New Store Reliever slot available",
          body: `Store Reliever slot: ${location || "your assigned health center"}${date ? ` on ${date}` : ""} from ${formatRelieverTime(notification.relieverTime || "20:00")} onwards. Sign up now.`
        };
      }
      return {
        title: "New schedule slot available",
        body: `A new ${role || "schedule"} slot is available${locationText}${whenText ? ` on ${whenText}` : ""}. Sign up now.`
      };
    case "siteMoved":
      if (notification.list === "relievers") {
        return {
          title: "Your Store Reliever assignment moved",
          body: `You're now covering ${location || "your assigned health center"}${date ? ` on ${date}` : ""} from ${formatRelieverTime(notification.relieverTime || "20:00")} onwards.`
        };
      }
      if (notification.oldCardId && notification.oldCardId === notification.cardId) {
        return {
          title: "You were moved to another slot",
          body: `Your role changed${roleText}${locationText}${whenText ? ` on ${whenText}` : ""}.`
        };
      }
      return {
        title: "You were moved to another event bracket",
        body: `Your new assignment${roleText}${locationText}${whenText ? ` is on ${whenText}` : ""}.`
      };
    case "removed":
      if (notification.scheduleReset) {
        return {
          title: "Event schedule reset",
          body: `Operations reset the event schedule. Your previous assignment${roleText}${locationText}${whenText ? ` on ${whenText}` : ""} was cleared. You can sign up again if a slot is available.`
        };
      }
      if (notification.list === "relievers") {
        const replacedByName = String(notification.replacedByName || "").trim();
        return {
          title: "You were removed as Store Reliever",
          body: replacedByName
            ? `${replacedByName} replaced you at ${location || "that health center"}.`
            : `You are no longer assigned as reliever for ${location || "that health center"}${date ? ` on ${date}` : ""}.`
        };
      }
      if (notification.replacedByName) {
        return {
          title: "You were removed from the event slot",
          body: `${String(notification.replacedByName).trim()} replaced you at ${location || "the event site"}.`
        };
      }
      return {
        title: "You were removed from this slot",
        body: `Your assignment${roleText}${locationText}${whenText ? ` on ${whenText}` : ""} was removed. You can choose another slot.`
      };
    case "slotRoleRemoved":
      return {
        title: "Your slot role was removed",
        body: `Your ${role || "schedule"} slot has been removed by ${notification.removedByDepartment || "the department"}. You can choose another slot.`
      };
    case "branchChanged": {
      const oldBranch = String(notification.oldRegionCustom || notification.oldRegion || "").trim();
      const newBranch = String(notification.newRegionCustom || notification.newRegion || "").trim();
      return {
        title: "Your event branch changed",
        body: oldBranch && newBranch
          ? `Your event moved from ${oldBranch} to ${newBranch}. Your previous slot was cleared.`
          : "Your event moved to another branch. Your previous slot was cleared."
      };
    }
    case "dateChanged":
      {
        const changes = [];
        changes.push(notification.oldDate && notification.newDate
          ? `Date changed from ${notification.oldDate} to ${notification.newDate}`
          : "The event date changed");
        if (notification.timeChanged) changes.push(`time is now ${time || "updated"}`);
        if (notification.locationChanged) changes.push(`site name is now ${location || "updated"}`);
        return {
          title: "Your event date changed",
          body: `${changes.join("; ")}${location && !notification.locationChanged ? ` at ${location}` : ""}.`
        };
      }
    case "eventUpdated": {
      const changes = [];
      if (notification.timeChanged) changes.push(`Time is now ${time || "updated"}`);
      if (notification.locationChanged) changes.push(`Site name is now ${location || "updated"}`);
      return {
        title: changes.length === 1 && notification.timeChanged ? "Your event time changed"
          : changes.length === 1 ? "Your event site name changed" : "Your event details changed",
        body: changes.length
          ? `${changes.join(". ")}. ${whenText && !notification.timeChanged ? `Event date: ${whenText}. ` : ""}Open the schedule to review.`
          : `Your event details changed${locationText}${whenText ? ` on ${whenText}` : ""}. Open the schedule to review.`
      };
    }
    case "missionChanged":
      return {
        title: "Your event type changed",
        body: notification.oldMissionLabel && notification.newMissionLabel
          ? `Event type changed from ${notification.oldMissionLabel} to ${notification.newMissionLabel}${locationText}${whenText ? ` on ${whenText}` : ""}.`
          : `Your event type changed${locationText}${whenText ? ` on ${whenText}` : ""}.`
      };
    case "eventDeleted":
      return { title: "Your event was deleted", body: `The event${locationText}${whenText ? ` on ${whenText}` : ""} was deleted. You can choose another slot.` };
    case "siteRemoved":
      return { title: "Your event site was removed", body: `The site${locationText}${whenText ? ` on ${whenText}` : ""} was removed from the schedule.` };
    case "siteAutoDeleted":
      return { title: "Your event site was removed", body: `The site${locationText}${whenText ? ` on ${whenText}` : ""} was automatically deleted after its event date.` };
    case "eventCancelled":
      return { title: "Your event was cancelled", body: `The event${locationText}${whenText ? ` on ${whenText}` : ""} was cancelled.` };
    case "eventReinstated":
      return { title: "Your event is back on", body: `The event${locationText}${whenText ? ` on ${whenText}` : ""} was reinstated.` };
    default:
      return { title: "Schedule update", body: "Your schedule has changed. Open the app to review the details." };
  }
}

function formatRelieverTime(value) {
  const time = String(value || "20:00").trim();
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return time;
  const hour = Number(match[1]);
  const period = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 || 12}:${match[2]} ${period}`;
}

function formatNotificationBranch(value) {
  const raw = String(value || "").trim();
  const normalized = raw.toLowerCase();
  if (normalized === "north") return "North Caloocan";
  if (normalized === "south") return "South Caloocan";
  return raw && normalized !== "other" ? raw : "";
}

function notificationBranch(notification) {
  return formatNotificationBranch(
    notification.type === "branchChanged"
      ? notification.newRegionCustom || notification.newRegion || ""
      : notification.regionCustom || notification.region || ""
  );
}

function formatCutoffTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return "the updated time";
  return new Date(Date.UTC(2000, 0, 1, Number(match[1]), Number(match[2]))).toLocaleTimeString("en-US", {
    timeZone: "UTC", hour: "numeric", minute: "2-digit"
  });
}

function notificationEventType(notification) {
  const direct = String(notification.newMissionLabel || notification.missionLabel || notification.eventType || "").trim();
  if (direct) return direct;
  const mission = String(notification.mission || "").trim().toLowerCase();
  if (mission === "medical") return "Medical Mission";
  if (mission === "peoples_day") return "People's Day";
  return String(notification.missionCustom || "").trim();
}

function formatNotificationDate(value) {
  const raw = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return raw;
  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).toLocaleDateString("en-US", {
    timeZone: "UTC", month: "long", day: "numeric", year: "numeric"
  });
}

function eventCancelledNotificationText(notification) {
  const eventType = notificationEventType(notification) || "Event";
  const site = String(notification.location || "Unnamed site").trim();
  const date = formatNotificationDate(notification.date) || "Date not set";
  const reason = String(notification.cancelReason || "Not provided.").trim();
  return {
    title: "Event cancelled",
    body: `Site: ${site}\nEvent: ${eventType}\nDate: ${date}\nReason: ${reason}`
  };
}

function headNotificationText(notification) {
  const context = [];
  if (notification.location && !["siteAutoDeleted", "eventCutoffReached", "siteInactive", "siteReactivated"].includes(notification.type)) context.push(`Site: ${notification.location}`);
  if (notification.type === "dateChanged" && notification.oldDate && notification.newDate) {
    context.push(`Date: ${notification.oldDate} → ${notification.newDate}`);
  } else if (notification.date && !["eventCutoffChanged", "eventCutoffReached"].includes(notification.type)) {
    context.push(`Date: ${notification.date}`);
  }
  if (notification.time) context.push(`Time: ${notification.time}`);
  const branch = notificationBranch(notification);
  if (notification.type === "branchChanged") {
    const oldBranch = formatNotificationBranch(notification.oldRegionCustom || notification.oldRegion || "");
    context.push(`Branch: ${oldBranch ? `${oldBranch} → ` : ""}${branch || "updated"}`);
  } else if (branch) {
    context.push(`Branch: ${branch}`);
  }
  if (notification.type === "missionChanged" && notification.oldMissionLabel && notification.newMissionLabel) {
    context.push(`Event type: ${notification.oldMissionLabel} → ${notification.newMissionLabel}`);
  } else {
    const eventType = notificationEventType(notification);
    if (eventType) context.push(`Event type: ${eventType}`);
  }
  if (notification.role && notification.list !== "schedule") context.push(`Role: ${notification.role}`);
  if (notification.employeeName && notification.type !== "removed") context.push(`Employee: ${notification.employeeName}`);
  const titles = {
    siteInactive: "Site marked inactive",
    siteReactivated: "Site reactivated",
    crossBranchSignup: "Cross-branch signup",
    siteFilled: "Event site is full",
    eventCutoffChanged: "Event cutoff changed",
    eventCutoffReached: "Event cutoff reached",
    eventCreated: "New site deployed",
    deploymentConfirmed: "Site deployment confirmed",
    eventCancelled: "Event cancelled",
    eventReinstated: "Event reinstated",
    siteAutoDeleted: "Event site deleted",
    branchChanged: "Event branch changed",
    dateChanged: "Event date changed",
    eventUpdated: "Event schedule updated",
    missionChanged: "Event type changed",
    removed: "Employee removed from slot"
  };
  const summaries = {
    siteInactive: `Operations marked ${notification.location || "a site"} inactive. Assigned employees were notified and will be notified again when it is active`,
    siteReactivated: `Operations reactivated ${notification.location || "a site"}. Its existing assignments remain in place`,
    crossBranchSignup: `${notification.employeeName || "An employee"} from ${String(notification.employeeBranch || "").toUpperCase()} signed up in ${String(notification.eventBranch || "").toUpperCase()}`,
    eventCreated: "A new site was added to the schedule",
    deploymentConfirmed: "The site is now published to employees",
    eventCancelled: "An event was cancelled",
    eventReinstated: "An event was reinstated",
    siteAutoDeleted: `The event is now deleted: ${notification.location || "Unnamed site"}`,
    branchChanged: "An event was moved to another branch",
    dateChanged: "An event date was changed",
    eventUpdated: "An event schedule was updated",
    missionChanged: "An event type was changed",
    removed: `${notification.employeeName || "An employee"} was removed from ${notification.role || "a slot"}`,
    siteFilled: `The site ${notification.location || "this event site"} is full now${notification.filledCount ? ` (${notification.filledCount} Event Team slots filled)` : ""}`,
    eventCutoffChanged: `Operations changed the cutoff time to ${formatCutoffTime(notification.cutoffTime)}`,
    eventCutoffReached: `Here's the final lineup for ${notification.location || "this event site"}. The cutoff time (${formatCutoffTime(notification.cutoffTime)}) has been reached`
  };
  return {
    title: titles[notification.type] || "Schedule update",
    body: `${summaries[notification.type] || "The schedule was updated"}${context.length ? `. ${context.join(" • ")}.` : "."}`
  };
}

export function notificationText(notification, subscription = {}) {
  if (notification?.type === "eventCancelled") return eventCancelledNotificationText(notification);
  if (notification?.type === "stockDayClosedEarly") {
    const requestType = notification.requestType === "supplies" ? "Supplies" : "Medicine";
    return {
      title: `${requestType} stock requests closed early`,
      body: `${requestType} stock requests${notification.day ? ` for ${notification.day}` : ""} were closed early by the admin. You can no longer submit, edit, or remove your SR# for this day.`
    };
  }
  if (notification?.type === "stockDayClosed") {
    const requestType = notification.requestType === "supplies" ? "Supplies" : "Medicine";
    return {
      title: `${requestType} stock requests closed`,
      body: `${requestType} stock requests for today are now closed!${notification.day ? ` (${notification.day})` : ""}`
    };
  }
  if (headRoles.has(String(subscription.headRole || "").trim().toLowerCase())) {
    return headNotificationText(notification);
  }
  const message = baseNotificationText(notification);
  if (!notification || typeof notification !== "object") return message;
  if (["siteSwapRequest", "siteSwapApproved", "siteSwapDeclined"].includes(notification.type)) return message;
  if (notification.type === "pharmacistNote") return message;
  const actorLabel = String(notification.actorLabel || "").trim();
  const appendActor = text => actorLabel
    ? { ...text, body: `${text.body} Action by: ${actorLabel}.` }
    : text;
  if (notification.type === "eventsDeployed") return appendActor(message);
  if (notification.type === "eventReminder" && notification.recipientAssignment?.list === "relievers") {
    return appendActor(message);
  }
  if (notification.list === "relievers" && !["slotAssigned", "slotRoleRemoved"].includes(notification.type)) return appendActor(message);

  const context = [];
  if (actorLabel && !["slotAssigned", "slotRoleRemoved"].includes(notification.type)) context.push(`Action by: ${actorLabel}`);
  const branch = notificationBranch(notification);
  const eventType = notificationEventType(notification);
  if (branch && notification.type !== "branchChanged") context.push(`Branch: ${branch}`);
  if (eventType && notification.type !== "missionChanged") context.push(`Event type: ${eventType}`);
  return context.length ? { ...message, body: `${message.body} ${context.join(" • ")}.` } : message;
}

export function notificationUrl(appUrl, notification, headRole = "") {
  const headPaths = {
    pharmacist: "/tz8lc2ct4y",
    billing: "/jszdttqedv",
    information: "/51qx617jve"
  };
  const target = new URL(headPaths[headRole] || appUrl, appUrl);
  if (["stockDayActivated", "stockDayClosed", "stockDayClosedEarly", "stockDayScheduleChanged", "stockDayCutoffUpdated", "stockRequestRemoved", "stockRequestCompleted", "stockRequestUnblocked", "stockRequestSubmitted"].includes(notification?.type)) {
    const path = headRole === "stock" ? "/h9b4t2zvfe" : "/w6n3d8ycrq";
    const stockTarget = new URL(path, appUrl);
    if (notification.day) stockTarget.searchParams.set("day", String(notification.day));
    if (headRole !== "stock" && ["medicine", "supplies"].includes(notification.requestType)) {
      stockTarget.searchParams.set("requestType", notification.requestType);
    }
    return stockTarget.toString();
  }
  if (notification?.type === "siteSwapRequest" && notification?.id) {
    target.searchParams.set("swapRequest", String(notification.id));
  }
  if (notification?.cardId) target.searchParams.set("viewSite", String(notification.cardId));
  if (notification?.date) target.searchParams.set("date", String(notification.date));
  if (notification?.type === "pharmacistNote" && notification?.id) {
    target.searchParams.set("viewNotes", String(notification.id));
  }
  const region = notification?.region || notification?.newRegion;
  if (region) target.searchParams.set("region", String(region));
  return target.toString();
}

export function notificationContactUrl(notification) {
  const type = String(notification?.type || "");
  if (!type) return "";
  if (type.startsWith("stockDay") || type.startsWith("stockRequest")) return stockRequestAdminTeamsUrl;
  return eventScheduleAdminTeamsUrl;
}

export function pushPlatformOptions(notification = {}) {
  const isEventReminder = notification.type === "eventReminder";
  return {
    android: { priority: "HIGH", ttl: isEventReminder ? "0s" : "3600s" },
    webpush: {
      headers: {
        Urgency: "high",
        ...(isEventReminder ? { TTL: "0" } : {})
      }
    }
  };
}

export function formatPushNotificationBody(notification, body) {
  const type = String(notification?.type || "");
  const originalBody = String(body || "").trim();
  if (type === "eventCancelled" && originalBody.startsWith("Site:")) return originalBody;

  const rows = [];
  const add = (label, value) => {
    const text = String(value || "").trim();
    if (text) rows.push(`${label}: ${text}`);
  };
  const date = value => formatNotificationDate(value);
  const site = notification?.location || notification?.siteName;
  const eventType = notificationEventType(notification || {});

  if (type === "siteSwapRequest") {
    add("Requested by", notification.requesterName);
    add("Your site", notification.targetLocation);
    add("Their site", notification.requesterLocation);
    add("Your date", date(notification.targetDate));
    add("Their date", date(notification.requesterDate));
    add("Note", notification.requesterNote);
    return rows.join("\n") || `Details: ${originalBody}`;
  }
  if (["siteSwapApproved", "siteSwapDeclined"].includes(type)) {
    add("Teammate", notification.swapPartnerName);
    add("Status", type === "siteSwapApproved" ? "Approved" : "Disapproved");
    add("Site", site);
    add("Event", eventType);
    add("Date", date(notification.date));
    add("Reason", notification.responseReason);
    return rows.join("\n") || `Details: ${originalBody}`;
  }
  if (type === "pharmacistNote") {
    add("From", notification.actorLabel || notification.assignedBy);
    add("Site", site);
    add("Event", eventType);
    add("Date", date(notification.date));
    add("Note", notification.noteText);
    return rows.join("\n") || `Details: ${originalBody}`;
  }
  if (type === "eventReminder") {
    const assignment = notification.recipientAssignment || {};
    const isReliever = assignment.list === "relievers";
    add("Site", assignment.location || site);
    add("Date", date(assignment.date || notification.date));
    if (isReliever) {
      add("Starts", formatRelieverTime(assignment.relieverTime || assignment.time || "20:00"));
    } else {
      add("Time", assignment.time || notification.time);
    }
    return rows.join("\n") || `Details: ${originalBody}`;
  }

  if (type.startsWith("stock")) {
    const requestType = notification.requestType === "supplies" ? "Supplies"
      : notification.requestType === "medicine" ? "Medicine" : "";
    const formatDays = values => (Array.isArray(values) ? values : [])
      .map(value => String(value || "").trim())
      .filter(Boolean)
      .map(value => value.charAt(0).toUpperCase() + value.slice(1).toLowerCase())
      .join(", ");
    const formatMinutes = value => Number.isInteger(value)
      ? formatCutoffTime(`${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`)
      : "";

    add("Request type", requestType);
    add("Site", site);
    add("Branch", formatNotificationBranch(notification.branch || ""));
    add("Date", date(notification.date));
    add("Day", notification.day);
    add("SR#", notification.sr);

    switch (type) {
      case "stockDayActivated":
        add("Status", "Open");
        add("Next step", "Open Stock Request to submit your SR#");
        break;
      case "stockDayClosed":
        add("Status", "Closed");
        break;
      case "stockDayClosedEarly":
        add("Status", "Closed early by the admin");
        break;
      case "stockDayScheduleChanged": {
        const assignedDays = formatDays(notification.requestDays);
        if (notification.wasUnscheduled && assignedDays) {
          add("Assigned days", assignedDays);
        } else if (!assignedDays) {
          add("Status", "No assigned request days");
        } else {
          add("Added days", formatDays(notification.addedDays));
          add("Removed days", formatDays(notification.removedDays));
          add("Current days", assignedDays);
        }
        break;
      }
      case "stockDayCutoffUpdated": {
        const previousCutoff = formatMinutes(notification.previousCutoffMin);
        const newCutoff = formatMinutes(notification.cutoffMin);
        add("Previous cutoff", previousCutoff);
        add("New cutoff", newCutoff);
        add("Status", notification.unclosed === true || notification.reopened === true ? "Reopened" : "Updated");
        if (newCutoff) add("Next step", `Submit, edit, or remove your SR# before ${newCutoff}`);
        break;
      }
      case "stockRequestRemoved":
        add("Status", "SR# removed");
        add("Next step", "Contact your Stock Request Admin for details");
        break;
      case "stockRequestCompleted":
        add("Status", "Completed by the admin");
        break;
      case "stockRequestUnblocked":
        add("Status", "Unblocked");
        add("Next step", "Edit your SR# or keep your current SR#");
        break;
      case "stockRequestSubmitted":
        add("Employee", notification.employeeName);
        add("Status", notification.updated === true ? "Updated stock request" : "New stock request");
        if (notification.updated === true) add("Previous SR#", notification.previousSr);
        break;
      default:
        add("Details", originalBody);
    }
    return rows.join("\n") || `Details: ${originalBody}`;
  }

  if (notification?.actorLabel && type !== "slotAssigned" && !type.startsWith("stock")) {
    add("Action by", notification.actorLabel);
  }
  add("Site", site);
  if (type === "missionChanged") {
    add("Previous event", notification.oldMissionLabel);
    add("Event", notification.newMissionLabel || eventType);
  } else {
    add("Event", eventType);
  }
  if (type === "dateChanged") {
    add("Previous date", date(notification.oldDate));
    add("Date", date(notification.newDate || notification.date));
  } else {
    add("Date", date(notification.date));
  }
  if (notification.day) add("Day", notification.day);
  if (notification.role) add("Role", notification.role);
  if (notification.time) add("Time", notification.time);
  if (["slotAssigned", "slotOpened"].includes(type) && notification.list === "relievers") {
    add("Starts", formatRelieverTime(notification.relieverTime || "20:00"));
  }
  if (type === "slotAssigned") add("Assigned by", notification.actorLabel || notification.assignedBy);

  if (type === "eventCancelled") {
    add("Reason", notification.cancelReason || "Not provided.");
  } else if (type === "dateChanged") {
    if (notification.timeChanged) add("Time update", notification.time || "Updated");
    if (notification.locationChanged) add("Site update", notification.location || "Updated");
  } else if (type === "eventUpdated") {
    const changes = [
      notification.timeChanged && "Time",
      notification.locationChanged && "Site name"
    ].filter(Boolean);
    add("Updated", changes.join(" and "));
  } else if (type === "crossBranchSignup") {
    add("Employee", notification.employeeName);
    add("Employee branch", notification.employeeBranch);
    add("Event branch", notification.eventBranch);
  } else if (type === "eventsDeployed") {
    add("Sites deployed", notification.siteCount);
    add("Sites", notification.siteSummary);
  } else if (type === "siteFilled" && notification.filledCount) {
    add("Filled roles", notification.filledCount);
  }

  if (type === "branchChanged") {
    add("Previous branch", formatNotificationBranch(notification.oldRegionCustom || notification.oldRegion || ""));
    add("Branch", formatNotificationBranch(notification.newRegionCustom || notification.newRegion || ""));
    add("Status", "Previous slot cleared");
  }
  if (type === "removed") {
    add("Status", notification.scheduleReset ? "Previous assignment cleared" : "Removed from assignment");
    if (notification.replacedByName) add("Replaced by", notification.replacedByName);
    else add("Next step", notification.scheduleReset ? "Sign up again if a slot is available" : "Choose another slot");
  }
  if (type === "slotRoleRemoved") {
    add("Removed by", notification.removedByDepartment);
    add("Next step", "Choose another slot");
  }
  if (type === "slotOpened") add("Next step", "Sign up now");
  if (type === "slotAssigned") add("Status", "Assigned");
  if (type === "siteMoved") add("Status", "Assignment moved");
  if (type === "eventDeleted") {
    add("Status", "Event deleted");
    add("Next step", "Choose another slot");
  }
  if (type === "siteRemoved") add("Status", "Site removed from the schedule");
  if (type === "siteAutoDeleted") add("Status", "Automatically deleted after the event date");
  if (type === "eventReinstated") add("Status", "Reinstated");
  if (type === "siteInactive") add("Status", "Temporarily inactive");
  if (type === "siteReactivated") add("Status", "Active again");
  if (type === "eventCreated") add("Status", "Available in the schedule");
  if (type === "deploymentConfirmed") add("Status", "Published to employees");
  if (type === "eventCutoffChanged" && notification.cutoffTime) {
    add("New cutoff", formatCutoffTime(notification.cutoffTime));
  }
  if (type === "eventCutoffReached" && notification.cutoffTime) {
    add("Cutoff", formatCutoffTime(notification.cutoffTime));
  }

  const actionInTitle = new Set([
    "eventCancelled", "eventReinstated", "eventDeleted", "siteRemoved", "siteAutoDeleted",
    "siteInactive", "siteReactivated", "slotAssigned", "slotOpened", "slotRoleRemoved",
    "siteMoved", "removed", "deploymentConfirmed", "eventCreated", "dateChanged",
    "eventUpdated", "missionChanged", "branchChanged", "crossBranchSignup",
    "eventCutoffChanged", "eventsDeployed", "siteFilled", "eventReminder"
  ]);
  if ((!actionInTitle.has(type) || notification.scheduleReset === true) && originalBody) {
    add("Details", originalBody);
  }
  return rows.join("\n") || (originalBody ? `Details: ${originalBody}` : "Details: Open the app to review the update.");
}

async function sendPush(env, subscription, notification) {
  const sentKey = `sent-device:${notification.id}:${(await subscriptionKey(subscription.token)).slice(4)}`;
  if (await env.PUSH_SUBSCRIPTIONS.get(sentKey)) return true;

  const accessToken = await getAccessToken(env);
  const text = notificationText(notification, subscription);
  const body = formatPushNotificationBody(notification, text.body);
  const type = String(notification.type || "");
  const contactAdminUrl = notificationContactUrl(notification);
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/messages:send`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        message: {
          token: subscription.token,
          ...pushPlatformOptions(notification),
          data: {
            title: text.title,
            body,
            url: notificationUrl(env.APP_URL, notification, subscription.headRole),
            ...(contactAdminUrl ? { contactAdminUrl } : {}),
            notificationId: notification.id,
            notificationType: String(notification.type || ""),
            scheduleReset: notification.scheduleReset === true ? "1" : "0",
            scheduleLocation: String(notification.location || ""),
            cardId: String(notification.cardId || ""),
            date: String(notification.date || ""),
            region: String(notification.region || ""),
            eventReminder: notification.type === "eventReminder" ? "1" : "",
            reminderKey: String(notification.reminderKey || ""),
            reminderActionToken: String(notification.reminderActionToken || ""),
            reminderRole: String(notification.role || ""),
            reminderList: String(notification.recipientAssignment?.list || notification.list || "")
          }
        }
      })
    }
  );

  if (response.ok) {
    await env.PUSH_SUBSCRIPTIONS.put(sentKey, "1", { expirationTtl: 604800 });
    return true;
  }
  const error = await response.text();
  if (error.includes("UNREGISTERED")) {
    await env.PUSH_SUBSCRIPTIONS.delete(subscription.key);
    await env.PUSH_SUBSCRIPTIONS.put(sentKey, "1", { expirationTtl: 604800 });
    return true;
  }
  if (error.includes("SENDER_ID_MISMATCH")) {
    await env.PUSH_SUBSCRIPTIONS.delete(subscription.key);
    console.error("FCM subscription belongs to a different sender; removed stale subscription.");
    return false;
  }
  console.error("FCM send failed", response.status, error);
  return false;
}

async function loadSubscriptions(env) {
  const subscriptions = [];
  let cursor;
  do {
    const page = await env.PUSH_SUBSCRIPTIONS.list({ prefix: "sub:", cursor });
    for (const item of page.keys) {
      const value = await env.PUSH_SUBSCRIPTIONS.get(item.name, "json");
      if (value) subscriptions.push({ ...value, key: item.name });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return subscriptions;
}

async function migrateLegacyScheduledJobs(env) {
  if (await env.PUSH_SUBSCRIPTIONS.get(SCHEDULED_JOB_MIGRATION_KEY)) return;

  const legacyPrefixes = [
    { oldPrefix: "stock-cutoff:", newPrefix: "scheduled:stock-cutoff:", jobType: "stockCutoff" },
    { oldPrefix: "event-reminder-snoozed:", newPrefix: "scheduled:event-reminder-snoozed:", jobType: "snoozedReminder" }
  ];
  for (const { oldPrefix, newPrefix, jobType } of legacyPrefixes) {
    let cursor;
    do {
      const page = await env.PUSH_SUBSCRIPTIONS.list({ prefix: oldPrefix, cursor });
      for (const item of page.keys) {
        const legacyTask = await env.PUSH_SUBSCRIPTIONS.get(item.name, "json");
        if (legacyTask) {
          const destinationKey = newPrefix + item.name.slice(oldPrefix.length);
          const destinationTask = await env.PUSH_SUBSCRIPTIONS.get(destinationKey, "json");
          if (!destinationTask) {
            await env.PUSH_SUBSCRIPTIONS.put(destinationKey, JSON.stringify({ ...legacyTask, jobType }));
          }
        }
        await env.PUSH_SUBSCRIPTIONS.delete(item.name);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
  await env.PUSH_SUBSCRIPTIONS.put(SCHEDULED_JOB_MIGRATION_KEY, "1");
}

async function readNewNotifications(env, storedCursor) {
  let cursor = storedCursor;
  if (!cursor) cursor = new Date(Date.now() - 120000).toISOString();
  const overlap = new Date(Date.parse(cursor) - 1000).toISOString();
  const url = firestoreDocumentsUrl(env, ":runQuery");
  const authHeaders = await firestoreReadHeaders(env);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...authHeaders,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "emergencyNotifications" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "createdAt" },
            op: "GREATER_THAN_OR_EQUAL",
            value: { timestampValue: overlap }
          }
        },
        orderBy: [{ field: { fieldPath: "createdAt" }, direction: "ASCENDING" }],
        limit: 500
      }
    })
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Firestore query failed (${response.status}): ${detail}`);
  }
  const rows = await response.json();
  return rows.filter(row => row.document).map(row => decodeDocument(row.document));
}

export function shouldSaveScanCursor(storedCursor, newestTimestamp, allComplete) {
  return allComplete && Boolean(newestTimestamp) && newestTimestamp !== storedCursor;
}

async function deliverNewNotifications(env, loadedSubscriptions) {
  const storedCursor = await env.PUSH_SUBSCRIPTIONS.get("scan-cursor");
  const notifications = await readNewNotifications(env, storedCursor);
  if (!notifications.length) return;
  await syncEventCutoffSchedules(env, notifications);
  const subscriptions = loadedSubscriptions || await loadSubscriptions(env);
  let newestTimestamp = storedCursor;
  let allComplete = true;

  for (const notification of notifications) {
    const createdAt = notification.createdAt;
    if (!createdAt) continue;
    if (await env.PUSH_SUBSCRIPTIONS.get(`sent:${notification.id}`)) continue;
    const createdAtMillis = Date.parse(createdAt);
    const maxAge = notification.type === "eventReminder" ? 5 * 60 * 1000 : 60 * 60 * 1000;
    if (createdAtMillis < Date.now() - maxAge) {
      await env.PUSH_SUBSCRIPTIONS.put(`sent:${notification.id}`, "1", { expirationTtl: 604800 });
      if (!newestTimestamp || createdAtMillis > Date.parse(newestTimestamp)) newestTimestamp = createdAt;
      continue;
    }

    const targets = subscriptions.filter(subscription => shouldNotify(subscription, notification));
    let complete = true;
    for (const subscription of targets) {
      let delivery = notification;
      if (notification.type === "eventReminder") {
        const staffId = String(subscription.staffId || "").trim().toLowerCase();
        const assignments = Array.isArray(notification.recipientAssignments) ? notification.recipientAssignments : [];
        const assignment = assignments.find(item =>
          String(item.staffId || "").trim().toLowerCase() === staffId && item.list === "relievers"
        ) || assignments.find(item => String(item.staffId || "").trim().toLowerCase() === staffId);
        const reminderHash = await subscriptionKey(notification.id, `event-reminder:${staffId}`);
        const reminderKey = reminderHash.slice(4);
        const actionKey = `event-reminder-action:${reminderKey}`;
        let actionContext = await env.PUSH_SUBSCRIPTIONS.get(actionKey, "json");
        if (!actionContext) {
          actionContext = {
            actionToken: crypto.randomUUID(),
            staffId,
            sequence: 0,
            notification
          };
          await env.PUSH_SUBSCRIPTIONS.put(actionKey, JSON.stringify(actionContext), { expirationTtl: 259200 });
        }
        delivery = {
          ...notification,
          ...(assignment ? { recipientAssignment: assignment } : {}),
          reminderKey,
          reminderActionToken: actionContext.actionToken
        };
      }
      if (!(await sendPush(env, subscription, delivery))) complete = false;
    }
    if (!complete) {
      allComplete = false;
      continue;
    }

    await env.PUSH_SUBSCRIPTIONS.put(`sent:${notification.id}`, "1", { expirationTtl: 604800 });
    if (!newestTimestamp || Date.parse(createdAt) > Date.parse(newestTimestamp)) newestTimestamp = createdAt;
  }

  if (shouldSaveScanCursor(storedCursor, newestTimestamp, allComplete)) {
    await env.PUSH_SUBSCRIPTIONS.put("scan-cursor", newestTimestamp);
  }
}

export function stockCutoffAt(date, cutoffMin) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!match || !Number.isInteger(cutoffMin) || cutoffMin < 0 || cutoffMin > 1439) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - 8 * 60 * 60 * 1000 + cutoffMin * 60 * 1000;
}

export function eventCutoffAt(date, cutoffTime) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(cutoffTime || ""));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return stockCutoffAt(date, hour * 60 + minute);
}

export async function scheduleEventCutoff(env, event) {
  const cardId = String(event.cardId || event.id || "").trim();
  if (!cardId) return;
  const key = `scheduled:event-cutoff:${cardId}`;
  if (event.cancelled === true) {
    await deleteScheduledTask(env, key);
    return;
  }
  const date = String(event.date || "");
  const cutoffTime = String(event.cutoffTime || "");
  const dueAt = eventCutoffAt(date, cutoffTime);
  if (dueAt === null) {
    await deleteScheduledTask(env, key);
    return;
  }
  const notificationId = `event-cutoff-reached:${cardId}:${date}:${cutoffTime}`;
  if (dueAt <= Date.now() && await env.PUSH_SUBSCRIPTIONS.get(`sent:${notificationId}`)) {
    await deleteScheduledTask(env, key);
    return;
  }
  const task = {
    jobType: "eventCutoff",
    cardId,
    date,
    cutoffTime,
    location: String(event.location || "Unnamed site"),
    dueAt,
    id: notificationId
  };
  const existingTask = await env.PUSH_SUBSCRIPTIONS.get(key, "json");
  if (existingTask &&
      existingTask.jobType === task.jobType &&
      existingTask.cardId === task.cardId &&
      existingTask.date === task.date &&
      existingTask.cutoffTime === task.cutoffTime &&
      existingTask.location === task.location &&
      existingTask.dueAt === task.dueAt &&
      existingTask.id === task.id) {
    await updateScheduledAlarm(env, "upsert", key, task);
    return;
  }
  const secondsUntilDue = Math.max(0, Math.ceil((dueAt - Date.now()) / 1000));
  const expirationTtl = secondsUntilDue + 7 * 86400;
  await env.PUSH_SUBSCRIPTIONS.put(key, JSON.stringify(task), { expirationTtl });
  await updateScheduledAlarm(env, "upsert", key, task);
}

async function syncPublishedEventCutoffJobs(env) {
  const syncKey = "event-cutoff-schedule-sync-at";
  const lastSyncAt = Number(await env.PUSH_SUBSCRIPTIONS.get(syncKey) || 0);
  if (Date.now() - lastSyncAt < 5 * 60 * 1000) return;

  const response = await fetch(firestoreDocumentsUrl(env, "/eventSchedule/current"), {
    headers: await firestoreReadHeaders(env)
  });
  if (!response.ok && response.status !== 404) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Event schedule sync failed (${response.status}): ${detail}`);
  }
  const schedule = response.status === 404 ? {} : decodeDocument(await response.json());
  const cards = Array.isArray(schedule.employeeCards) ? schedule.employeeCards : [];
  const activeIds = new Set();
  for (const card of cards) {
    const cardId = String(card.id || "").trim();
    if (!cardId) continue;
    if (!card.cancelled && card.date && card.cutoffTime) activeIds.add(cardId);
    await scheduleEventCutoff(env, { ...card, cardId });
  }

  let cursor;
  do {
    const page = await env.PUSH_SUBSCRIPTIONS.list({ prefix: "scheduled:event-cutoff:", cursor });
    for (const item of page.keys) {
      const cardId = item.name.slice("scheduled:event-cutoff:".length);
        if (!activeIds.has(cardId)) await deleteScheduledTask(env, item.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  await env.PUSH_SUBSCRIPTIONS.put(syncKey, String(Date.now()), { expirationTtl: 600 });
}

export async function scheduleStockCutoff(env, notification) {
  await migrateLegacyScheduledJobs(env);
  const date = String(notification.date || "");
  const requestType = notification.requestType === "supplies" ? "supplies" : "medicine";
  const cutoffMin = Number(notification.cutoffMin);
  const dueAt = stockCutoffAt(date, cutoffMin);
  if (dueAt === null) throw new Error("Invalid stock cutoff schedule.");
  const key = `scheduled:stock-cutoff:${requestType}:${date}`;
  const previous = notification.type === "stockDayCutoffUpdated"
    ? await env.PUSH_SUBSCRIPTIONS.get(key, "json")
    : null;
  const targetStaffIds = [...new Set((Array.isArray(notification.targetStaffIds) ? notification.targetStaffIds : previous?.targetStaffIds || [])
    .map(id => String(id || "").trim().toLowerCase())
    .filter(Boolean))];
  const task = {
    jobType: "stockCutoff",
    date,
    requestType,
    day: String(notification.day || previous?.day || ""),
    cutoffMin,
    targetStaffIds,
    dueAt,
    id: `stock-day-closed:${date}:${notification.id}`
  };
  const expirationTtl = Math.max(60, Math.ceil((dueAt - Date.now()) / 1000) + 86400);
  await env.PUSH_SUBSCRIPTIONS.put(key, JSON.stringify(task), { expirationTtl });
  await updateScheduledAlarm(env, "upsert", key, task);
}

async function deliverStockCutoffNotifications(env, subscriptions, dueJobs) {
  for (const { name, task } of dueJobs.filter(job => job.task.jobType === "stockCutoff" || job.name.startsWith("scheduled:stock-cutoff:"))) {
    const notification = {
      id: task.id,
      type: "stockDayClosed",
      date: task.date,
      requestType: task.requestType || "medicine",
      day: task.day,
      targetStaffIds: task.targetStaffIds || [],
      targetRoles: ["stock"],
      employeeOnly: false,
      createdAt: new Date(Number(task.dueAt)).toISOString()
    };
    let complete = true;
    let matchedSubscriptions = 0;
    for (const subscription of subscriptions) {
      if (!shouldNotify(subscription, notification)) continue;
      matchedSubscriptions++;
      if (!(await sendPush(env, subscription, notification))) complete = false;
    }
    if (complete && matchedSubscriptions > 0) await env.PUSH_SUBSCRIPTIONS.delete(name);
  }
}

async function deliverEventCutoffNotifications(env, subscriptions, dueJobs) {
  const eventJobs = dueJobs.filter(job => job.task.jobType === "eventCutoff");
  if (!eventJobs.length) return;
  const response = await fetch(firestoreDocumentsUrl(env, "/eventSchedule/current"), {
    headers: await firestoreReadHeaders(env)
  });
  if (response.status === 404) {
    await Promise.all(eventJobs.map(({ name }) => env.PUSH_SUBSCRIPTIONS.delete(name)));
    return;
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Event schedule lookup failed (${response.status}): ${detail}`);
  }
  const schedule = decodeDocument(await response.json());
  const publishedCards = Array.isArray(schedule.employeeCards) ? schedule.employeeCards : [];
  const publishedById = new Map(publishedCards.map(card => [String(card.id || ""), card]));
  for (const { name, task } of eventJobs) {
    const card = publishedById.get(String(task.cardId || ""));
    if (!card || card.cancelled === true) {
      await env.PUSH_SUBSCRIPTIONS.delete(name);
      continue;
    }
    if (card.date !== task.date || card.cutoffTime !== task.cutoffTime) {
      await scheduleEventCutoff(env, { ...card, cardId: task.cardId });
      continue;
    }
    const notification = {
      id: task.id,
      type: "eventCutoffReached",
      cardId: task.cardId,
      date: task.date,
      cutoffTime: task.cutoffTime,
      location: task.location,
      targetRoles: ["pharmacist", "information", "billing"],
      broadcastToEmployees: true,
      visibleToEmployees: true
    };
    let complete = true;
    let matchedSubscriptions = 0;
    for (const subscription of subscriptions) {
      if (!shouldNotify(subscription, notification)) continue;
      matchedSubscriptions++;
      if (!(await sendPush(env, subscription, notification))) complete = false;
    }
    if (complete && matchedSubscriptions > 0) await env.PUSH_SUBSCRIPTIONS.delete(name);
  }
}

async function deliverSnoozedReminders(env, subscriptions, dueJobs) {
  for (const { name, task: queued } of dueJobs.filter(job => job.task.jobType === "snoozedReminder" || job.name.startsWith("scheduled:event-reminder-snoozed:"))) {
    const staffId = String(queued.actionContext && queued.actionContext.staffId || "").trim().toLowerCase();
    const targets = subscriptions.filter(subscription =>
      !subscription.headRole && String(subscription.staffId || "").trim().toLowerCase() === staffId
    );
    if (!targets.length) continue;

    const baseNotification = queued.actionContext.notification;
    const sequence = Number(queued.sequence || 1);
    const notificationId = `${baseNotification.id}:snooze:${sequence}`;
    const reminderHash = await subscriptionKey(notificationId, `event-reminder:${staffId}`);
    const reminderKey = reminderHash.slice(4);
    const actionKey = `event-reminder-action:${reminderKey}`;
    let actionContext = await env.PUSH_SUBSCRIPTIONS.get(actionKey, "json");
    if (!actionContext) {
      actionContext = {
        actionToken: crypto.randomUUID(),
        staffId,
        sequence,
        notification: baseNotification
      };
      await env.PUSH_SUBSCRIPTIONS.put(actionKey, JSON.stringify(actionContext), { expirationTtl: 259200 });
    }
    const notification = {
      ...baseNotification,
      id: notificationId,
      reminderKey,
      reminderActionToken: actionContext.actionToken
    };
    let complete = true;
    for (const subscription of targets) {
      if (!(await sendPush(env, subscription, notification))) complete = false;
    }
    if (complete) await env.PUSH_SUBSCRIPTIONS.delete(name);
  }
}

async function deliverScheduledJobs(env, dueJobs) {
  if (!dueJobs.length) return;
  const subscriptions = await loadSubscriptions(env);
  await Promise.all([
    deliverSnoozedReminders(env, subscriptions, dueJobs).catch(error => console.error("Snoozed reminder delivery failed:", error)),
    deliverStockCutoffNotifications(env, subscriptions, dueJobs).catch(error => console.error("Stock cutoff notification failed:", error)),
    deliverEventCutoffNotifications(env, subscriptions, dueJobs).catch(error => console.error("Event cutoff notification failed:", error))
  ]);
}

export class ScheduledJobs {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    let body;
    try { body = await request.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
    const name = String(body.name || "");
    if (!name.startsWith("scheduled:")) return new Response("Invalid scheduled job", { status: 400 });

    const storageKey = `job:${name}`;
    if (body.operation === "delete") {
      await this.ctx.storage.delete(storageKey);
    } else if (body.operation === "upsert" && body.task && Number.isFinite(Number(body.task.dueAt))) {
      await this.ctx.storage.put(storageKey, {
        name,
        task: body.task,
        nextAttemptAt: Number(body.task.dueAt)
      });
    } else {
      return new Response("Invalid scheduled job operation", { status: 400 });
    }

    await this.armNextJob();
    return new Response("OK");
  }

  async armNextJob() {
    const jobs = await this.ctx.storage.list({ prefix: "job:" });
    const nextAttemptAt = [...jobs.values()]
      .map(job => Number(job.nextAttemptAt || job.task?.dueAt))
      .filter(Number.isFinite)
      .reduce((next, value) => Math.min(next, value), Infinity);
    if (nextAttemptAt === Infinity) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, nextAttemptAt));
  }

  async alarm() {
    const now = Date.now();
    const jobs = [...(await this.ctx.storage.list({ prefix: "job:" })).values()];
    const dueJobs = jobs
      .filter(job => Number(job.nextAttemptAt || job.task?.dueAt) <= now)
      .map(({ name, task }) => ({ name, task }));

    if (dueJobs.length) {
      const deliveryEnv = { ...this.env, SCHEDULED_JOBS: undefined };
      await deliverScheduledJobs(deliveryEnv, dueJobs);
      for (const job of dueJobs) {
        const currentTask = await this.env.PUSH_SUBSCRIPTIONS.get(job.name, "json");
        const storageKey = `job:${job.name}`;
        if (!currentTask) {
          await this.ctx.storage.delete(storageKey);
          continue;
        }
        const changed = JSON.stringify(currentTask) !== JSON.stringify(job.task);
        const dueAt = Number(currentTask.dueAt);
        const nextAttemptAt = changed && dueAt > Date.now()
          ? dueAt
          : Date.now() + 5 * 60 * 1000;
        await this.ctx.storage.put(storageKey, { name: job.name, task: currentTask, nextAttemptAt });
      }
    }

    await this.armNextJob();
  }
}

export class EmployeeLoginRateLimiter {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const now = Date.now();
    let resetAt = 0;
    const allowed = await this.ctx.storage.transaction(async transaction => {
      const current = await transaction.get("rateLimit");
      if (!current || now >= current.resetAt) {
        resetAt = now + 15 * 60 * 1000;
        await transaction.put("rateLimit", { attempts: 1, resetAt });
        return true;
      }
      resetAt = current.resetAt;
      if (current.attempts >= 30) return false;
      await transaction.put("rateLimit", { attempts: current.attempts + 1, resetAt });
      return true;
    });
    await this.ctx.storage.setAlarm(resetAt);
    return new Response(allowed ? "Allowed" : "Rate limit exceeded", { status: allowed ? 200 : 429 });
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

function isAllowedOrigin(env, origin) {
  const projectId = String(env.FIREBASE_PROJECT_ID || "").trim();
  const allowedOrigins = new Set([env.APP_ORIGIN]);
  if (projectId) {
    allowedOrigins.add(`https://${projectId}.web.app`);
    allowedOrigins.add(`https://${projectId}.firebaseapp.com`);
  }
  return allowedOrigins.has(origin);
}

function corsHeaders(env, origin) {
  return {
    "access-control-allow-origin": isAllowedOrigin(env, origin) ? origin : "null",
    "access-control-allow-methods": "POST, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}

async function handleEmployeeAuthentication(request, env) {
  const origin = request.headers.get("Origin") || "";
  const headers = corsHeaders(env, origin);
  if (!isAllowedOrigin(env, origin)) return new Response("Forbidden", { status: 403, headers });
  if (request.method === "OPTIONS") return new Response(null, { headers });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers });

  let body;
  try { body = await request.json(); } catch { return new Response("Invalid JSON", { status: 400, headers }); }
  const staffIdInput = typeof body?.staffId === "string" ? body.staffId.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!staffIdInput || staffIdInput.length > 120 || !password || password.length > 256) {
    return new Response("Invalid credentials", { status: 400, headers });
  }

  try {
    if (!await employeeLoginRateLimit(env, request)) {
      return new Response("Too many sign-in attempts. Please try again later.", { status: 429, headers });
    }

    const staffId = staffIdInput.toLowerCase();
    const employee = await getAdminFirestoreDocument(env, `/employees/${encodeURIComponent(staffId)}`);
    if (!employee) {
      return new Response("Incorrect Staff ID or password.", { status: 401, headers });
    }
    const credential = await getAdminFirestoreDocument(env, `/employeeCredentials/${encodeURIComponent(staffId)}`);
    const storedPasswordHash = credential?.passwordHash || employee.passwordHash;
    if (credential?.passwordHash && employee.passwordHash) {
      await patchFirestoreDocument(env, `/employees/${encodeURIComponent(staffId)}`, {}, ["passwordHash"]);
    }
    const passwordVerification = await verifyPasswordHash(password, storedPasswordHash);
    const passwordMatches = passwordVerification.matches;
    if (!passwordMatches
        || typeof employee.staffId !== "string"
        || employee.staffId.trim().toLowerCase() !== staffId) {
      return new Response("Incorrect Staff ID or password.", { status: 401, headers });
    }
    if (passwordVerification.needsUpgrade) {
      const upgradedHash = await derivePasswordHash(password);
      await patchFirestoreDocument(env, `/employeeCredentials/${encodeURIComponent(staffId)}`, {
        passwordHash: { stringValue: upgradedHash },
        updatedAt: { timestampValue: new Date().toISOString() }
      });
      await patchFirestoreDocument(env, `/employees/${encodeURIComponent(staffId)}`, {
      }, ["passwordHash"]);
    }

    const tokenStaffId = employee.staffId.trim().toLowerCase();
    const uid = `employee-${(await sha256Hex(tokenStaffId)).slice(0, 40)}`;
    const customToken = await createFirebaseCustomToken(env, uid, {
      employee: true,
      staffId: tokenStaffId,
      employeeDepartment: typeof employee.department === "string"
        ? employee.department.trim().toLowerCase()
        : ""
    });
    return new Response(JSON.stringify({
      customToken,
      employee: {
        staffId: employee.staffId,
        name: typeof employee.name === "string" ? employee.name : "",
        email: typeof employee.email === "string" ? employee.email : "",
        department: typeof employee.department === "string" ? employee.department : "",
        branch: typeof employee.branch === "string" ? employee.branch : ""
      }
    }), {
      headers: { ...headers, "content-type": "application/json", "cache-control": "no-store" }
    });
  } catch (error) {
    console.error("Employee authentication failed:", error);
    return new Response("Employee sign-in is temporarily unavailable.", { status: 503, headers });
  }
}

async function handleAuthHandoff(request, env) {
  const origin = request.headers.get("Origin") || "";
  const headers = corsHeaders(env, origin);
  if (!isAllowedOrigin(env, origin)) return new Response("Forbidden", { status: 403, headers });
  if (request.method === "OPTIONS") return new Response(null, { headers });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers });

  const authorization = request.headers.get("authorization") || "";
  const idToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  if (!idToken) return new Response("Firebase ID token required", { status: 401, headers });
  let body;
  try { body = await request.json(); } catch { return new Response("Invalid JSON", { status: 400, headers }); }

  let claims;
  try {
    claims = await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);
  } catch (error) {
    console.error("Firebase ID token verification failed for auth handoff:", error);
    return new Response("Could not verify Firebase ID token", { status: 503, headers });
  }
  let customClaims;
  if (claims?.employee === true && typeof claims.staffId === "string") {
    const staffId = claims.staffId.trim().toLowerCase();
    const expectedUid = `employee-${(await sha256Hex(staffId)).slice(0, 40)}`;
    const requestedStaffId = String(body?.staffId || "").trim().toLowerCase();
    if (!staffId || !constantTimeStringEqual(claims.sub, expectedUid)
        || (requestedStaffId && requestedStaffId !== staffId)
        || body?.headRole) {
      return new Response("Authorized employee account required", { status: 403, headers });
    }
    customClaims = {
      employee: true,
      staffId,
      employeeDepartment: typeof claims.employeeDepartment === "string" ? claims.employeeDepartment : ""
    };
  } else {
    const headRole = claims ? await headRoleForClaims(env, claims) : "";
    const requestedHeadRole = String(body?.headRole || "");
    if (!headRole || (requestedHeadRole && requestedHeadRole !== headRole) || body?.staffId) {
      return new Response("Authorized department-head account required", { status: 403, headers });
    }
  }

  try {
    const customToken = await createFirebaseCustomToken(env, claims.sub, customClaims);
    const handoffCode = crypto.randomUUID().replace(/-/g, "");
    await env.PUSH_SUBSCRIPTIONS.put(`auth-handoff:${handoffCode}`, customToken, { expirationTtl: 60 });
    return new Response(JSON.stringify({ handoffCode }), {
      headers: { ...headers, "content-type": "application/json", "cache-control": "no-store" }
    });
  } catch (error) {
    console.error("Could not create Firebase auth handoff:", error);
    return new Response("Could not create authentication handoff", { status: 500, headers });
  }
}

async function handleAuthHandoffExchange(request, env) {
  const origin = request.headers.get("Origin") || "";
  const headers = corsHeaders(env, origin);
  if (!isAllowedOrigin(env, origin)) return new Response("Forbidden", { status: 403, headers });
  if (request.method === "OPTIONS") return new Response(null, { headers });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers });

  let body;
  try { body = await request.json(); } catch { return new Response("Invalid JSON", { status: 400, headers }); }
  const handoffCode = String(body?.handoffCode || "");
  if (!/^[A-Fa-f0-9]{32}$/.test(handoffCode)) return new Response("Invalid handoff code", { status: 400, headers });

  const key = `auth-handoff:${handoffCode}`;
  const customToken = await env.PUSH_SUBSCRIPTIONS.get(key);
  if (!customToken) return new Response("Authentication handoff expired or already used", { status: 410, headers });
  await env.PUSH_SUBSCRIPTIONS.delete(key);
  return new Response(JSON.stringify({ customToken }), {
    headers: { ...headers, "content-type": "application/json", "cache-control": "no-store" }
  });
}

async function subscriptionKey(token, recipient = "") {
  const material = recipient ? `${token}:${recipient}` : token;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return `sub:${base64Url(new Uint8Array(digest))}`;
}

async function handleSubscription(request, env) {
  const origin = request.headers.get("Origin") || "";
  const headers = corsHeaders(env, origin);
  if (!isAllowedOrigin(env, origin)) return new Response("Forbidden", { status: 403, headers });
  if (request.method === "OPTIONS") return new Response(null, { headers });
  if (request.method !== "POST" && request.method !== "DELETE") {
    return new Response("Method not allowed", { status: 405, headers });
  }

  let body;
  try { body = await request.json(); } catch { return new Response("Invalid JSON", { status: 400, headers }); }
  const staffId = String(body.staffId || "").trim().toLowerCase();
  const headRole = String(body.headRole || "").trim().toLowerCase();
    const rawDepartment = String(body.department || "").trim().toLowerCase().replace(/\s+(north|south)$/i, "");
    const department = rawDepartment === "pharmacy assistant" ? rawDepartment : "";
  const token = String(body.token || "").trim();
    let stockType = "";
  if (Boolean(staffId) === Boolean(headRole) ||
      (headRole && !headRoles.has(headRole)) ||
      (headRole && body.department) ||
      staffId.length > 100 || token.length < 20 || token.length > 8192) {
    return new Response("Invalid subscription", { status: 400, headers });
  }

  if (headRole) {
    const authorization = request.headers.get("authorization") || "";
    const idToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
    if (!idToken) return new Response("Firebase ID token required", { status: 401, headers });
    let verifiedRole;
    try {
      verifiedRole = await verifyFirebaseHeadToken(idToken, env);
      if (verifiedRole === "stock") {
        const claims = await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);
        const email = String(claims?.email || "").trim().toLowerCase();
        stockType = email === "adminstockreqsup@planetdrugstore.ph" ? "supplies" : "medicine";
      }
    } catch (error) {
      console.error("Firebase ID token verification failed for push subscription:", error);
      return new Response("Could not verify Firebase ID token", { status: 503, headers });
    }
    if (verifiedRole !== headRole) return new Response("Authorized department-head account required", { status: 403, headers });
  }

  const keyRecipient = headRole
    ? `head:${headRole}${stockType ? `:${stockType}` : ""}`
    : "";
  const key = await subscriptionKey(token, keyRecipient);
  if (headRole === "stock") {
    const legacyKey = await subscriptionKey(token, "head:stock");
    const legacy = await env.PUSH_SUBSCRIPTIONS.get(legacyKey, "json");
    if (legacy && legacyKey !== key) {
      if (["medicine", "supplies"].includes(String(legacy.stockType || ""))) {
        const migratedKey = await subscriptionKey(token, `head:stock:${legacy.stockType}`);
        if (!(await env.PUSH_SUBSCRIPTIONS.get(migratedKey))) {
          await env.PUSH_SUBSCRIPTIONS.put(migratedKey, JSON.stringify(legacy));
        }
      }
      await env.PUSH_SUBSCRIPTIONS.delete(legacyKey);
    }
  }
  if (request.method === "DELETE") {
    const existing = await env.PUSH_SUBSCRIPTIONS.get(key, "json");
    if (existing && existing.staffId === staffId && String(existing.headRole || "") === headRole) {
      await env.PUSH_SUBSCRIPTIONS.delete(key);
    }
  } else {
    const existing = await env.PUSH_SUBSCRIPTIONS.get(key, "json");
    if (!existing || existing.staffId !== staffId || String(existing.headRole || "") !== headRole ||
        String(existing.department || "") !== department || String(existing.stockType || "") !== stockType || existing.token !== token) {
      await env.PUSH_SUBSCRIPTIONS.put(key, JSON.stringify({ staffId, ...(headRole ? { headRole } : {}), ...(department ? { department } : {}), ...(stockType ? { stockType } : {}), token }));
    }
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...headers, "content-type": "application/json" }
  });
}

async function handleWake(request, env, context) {
  const origin = request.headers.get("Origin") || "";
  const headers = corsHeaders(env, origin);
  if (!isAllowedOrigin(env, origin)) return new Response("Forbidden", { status: 403, headers });
  if (request.method === "OPTIONS") return new Response(null, { headers });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers });

  let body;
  try { body = await request.json(); } catch { return new Response("Invalid JSON", { status: 400, headers }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return new Response("Invalid request body", { status: 400, headers });
  }
  if (body.notificationId !== undefined) {
    const notificationId = String(body.notificationId || "").trim();
    if (!/^[A-Za-z0-9_-]{1,1500}$/.test(notificationId)) {
      return new Response("Invalid notification ID", { status: 400, headers });
    }

    try {
      const apiKey = String(env.FIREBASE_API_KEY || "").trim();
      if (!apiKey) throw new Error("FIREBASE_API_KEY is not configured");
      const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/emergencyNotifications/${encodeURIComponent(notificationId)}?key=${encodeURIComponent(apiKey)}`;
      const response = await fetch(url);
      if (response.status === 404) return new Response("Notification not found", { status: 404, headers });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(`Firestore notification lookup failed (${response.status}): ${detail}`);
      }
      const notification = decodeDocument(await response.json());
      const isSiteFilled = notification.type === "siteFilled" &&
        Array.isArray(notification.targetRoles) &&
        notification.targetRoles.includes("pharmacist") &&
        notification.employeeOnly !== true;
      const isSwapNotification = isDirectlyDeliverableSwapNotification(notification);
      if (!isSiteFilled && !isSwapNotification) {
        return new Response("Notification is not eligible for direct delivery", { status: 404, headers });
      }

      if (isSwapNotification) {
        const result = await deliverDirectNotifications(env, [notification], { bypassSentMarker: true });
        if (!result.targetCount) {
          return new Response("No active notification subscription for the swap recipient.", { status: 409, headers });
        }
        if (result.failedCount) {
          return new Response("Push delivery failed for one or more recipient devices.", { status: 502, headers });
        }
        return new Response(JSON.stringify({ ok: true, delivered: result.deliveredCount }), {
          status: 202,
          headers: { ...headers, "content-type": "application/json" }
        });
      }

      context.waitUntil(deliverDirectNotifications(env, [notification]).catch(error => {
        console.error("Direct site-filled push delivery failed:", error);
      }));
      return new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { ...headers, "content-type": "application/json" }
      });
    } catch (error) {
      console.error("Could not load site-filled notification for push delivery:", error);
      return new Response("Could not load notification", { status: 502, headers });
    }
  }

  context.waitUntil(deliverPendingPushes(env).catch(error => {
    console.error("Immediate push wake failed", error);
  }));
  return new Response(JSON.stringify({ ok: true }), {
    status: 202,
    headers: { ...headers, "content-type": "application/json" }
  });
}

async function deliverDirectNotifications(env, notifications, { bypassSentMarker = false } = {}) {
  const subscriptions = await loadSubscriptions(env);
  let targetCount = 0;
  let deliveredCount = 0;
  let failedCount = 0;
  for (const notification of notifications) {
    const id = String(notification.id || "");
    if (!bypassSentMarker && await env.PUSH_SUBSCRIPTIONS.get(`sent:${id}`)) continue;

    let complete = true;
    const targets = subscriptions.filter(subscription => shouldNotify(subscription, notification));
    for (const subscription of targets) {
      targetCount++;
      let delivery = notification;
      if (notification.type === "eventReminder") {
        const staffId = String(subscription.staffId || "").trim().toLowerCase();
        const assignments = Array.isArray(notification.recipientAssignments) ? notification.recipientAssignments : [];
        const assignment = assignments.find(item =>
          String(item.staffId || "").trim().toLowerCase() === staffId && item.list === "relievers"
        ) || assignments.find(item => String(item.staffId || "").trim().toLowerCase() === staffId);
        delivery = { ...notification, ...(assignment ? { recipientAssignment: assignment } : {}) };
      }
      if (await sendPush(env, subscription, delivery)) deliveredCount++;
      else {
        complete = false;
        failedCount++;
      }
    }
    if (complete && !bypassSentMarker) {
      await env.PUSH_SUBSCRIPTIONS.put(`sent:${id}`, "1", { expirationTtl: 604800 });
    }
  }
  return { targetCount, deliveredCount, failedCount };
}

async function syncEventCutoffSchedules(env, notifications) {
  const cancelTypes = new Set(["eventCancelled", "eventDeleted", "siteRemoved"]);
  const updateTypes = new Set(["eventCutoffChanged", "dateChanged", "eventUpdated", "eventReinstated"]);
  for (const notification of notifications) {
    for (const event of Array.isArray(notification.cutoffSchedules) ? notification.cutoffSchedules : []) {
      await scheduleEventCutoff(env, event);
    }
    if (updateTypes.has(notification.type)) await scheduleEventCutoff(env, notification);
    if (cancelTypes.has(notification.type) && notification.cardId) {
      await deleteScheduledTask(env, `scheduled:event-cutoff:${notification.cardId}`);
    }
  }
}

async function handleDispatch(request, env, context) {
  const origin = request.headers.get("Origin") || "";
  const headers = corsHeaders(env, origin);
  if (!isAllowedOrigin(env, origin)) return new Response("Forbidden", { status: 403, headers });
  if (request.method === "OPTIONS") return new Response(null, { headers });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers });

  let body;
  try { body = await request.json(); } catch { return new Response("Invalid JSON", { status: 400, headers }); }
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  if (!token) return new Response("Firebase ID token required", { status: 401, headers });

  let headRole;
  try {
    headRole = await verifyFirebaseHeadToken(token, env);
  } catch (error) {
    console.error("Firebase ID token verification failed", error);
    return new Response("Could not verify Firebase ID token", { status: 503, headers });
  }
  if (!headRole) return new Response("Authorized department-head account required", { status: 403, headers });

  const notifications = body.notifications;
  if (!Array.isArray(notifications) || notifications.length === 0 || notifications.length > 100 ||
      notifications.some(notification => !notification || !notification.id || !notification.type)) {
    return new Response("Invalid notification batch", { status: 400, headers });
  }
  try {
    await migrateScheduledJobsToAlarms(env);
  } catch (error) {
    console.error("Could not migrate scheduled notifications to alarms", error);
    return new Response("Could not initialize scheduled notifications", { status: 500, headers });
  }
  const stockScheduleTypes = new Set(["stockDayActivated", "stockDayCutoffUpdated", "stockDayDeactivated"]);
  const stockNoticeTypes = new Set(["stockDayScheduleChanged", "stockDayClosedEarly", "stockRequestRemoved", "stockRequestCompleted", "stockRequestUnblocked"]);
  const authorizedStockTypes = new Set([...stockScheduleTypes, ...stockNoticeTypes]);
  const hasStockScheduleChange = notifications.some(notification => authorizedStockTypes.has(notification.type));
  const stockScheduleOnly = notifications.every(notification => authorizedStockTypes.has(notification.type));
  if ((headRole === "stock" && !stockScheduleOnly) || (headRole !== "stock" && hasStockScheduleChange)) {
    return new Response("Notification type is not authorized for this account", { status: 403, headers });
  }

  if (headRole === "stock") {
    try {
      const claims = await verifyFirebaseIdToken(token, env.FIREBASE_PROJECT_ID);
      const email = String(claims?.email || "").trim().toLowerCase();
      const stockType = email === "adminstockreqsup@planetdrugstore.ph" ? "supplies" : "medicine";
      const typeSpecificNotifications = new Set([
        "stockDayActivated", "stockDayCutoffUpdated", "stockDayDeactivated", "stockDayClosedEarly", "stockRequestCompleted"
      ]);
      if (notifications.some(notification => typeSpecificNotifications.has(notification.type)
          && notification.requestType !== stockType)) {
        return new Response("Stock request category does not match the signed-in account", { status: 403, headers });
      }
      for (const notification of notifications) {
        if (!stockScheduleTypes.has(notification.type)) continue;
        const date = String(notification.date || "");
        const requestType = notification.requestType === "supplies" ? "supplies" : "medicine";
        const cutoffKey = `scheduled:stock-cutoff:${requestType}:${date}`;
        if (notification.type === "stockDayDeactivated") {
          await Promise.all([
            deleteScheduledTask(env, cutoffKey),
            env.PUSH_SUBSCRIPTIONS.delete(cutoffKey),
            ...(requestType === "medicine"
              ? [
                  deleteScheduledTask(env, `scheduled:stock-cutoff:${date}`),
                  env.PUSH_SUBSCRIPTIONS.delete(`scheduled:stock-cutoff:${date}`),
                  deleteScheduledTask(env, `stock-cutoff:${date}`),
                  env.PUSH_SUBSCRIPTIONS.delete(`stock-cutoff:${date}`)
                ]
              : [])
          ]);
        } else {
          await scheduleStockCutoff(env, notification);
        }
      }
    } catch (error) {
      console.error("Could not schedule stock cutoff notification", error);
      return new Response("Could not schedule stock cutoff notification", { status: 500, headers });
    }
  }

  if (headRole !== "stock") {
    try {
      await syncEventCutoffSchedules(env, notifications);
    } catch (error) {
      console.error("Could not schedule event cutoff notification", error);
      return new Response("Could not schedule event cutoff notification", { status: 500, headers });
    }
  }

  const immediateNotifications = notifications.filter(notification =>
    ["stockDayActivated", "stockDayScheduleChanged", "stockDayCutoffUpdated", "stockDayClosedEarly", "stockRequestRemoved", "stockRequestCompleted", "stockRequestUnblocked"].includes(notification.type)
  );
  if (headRole !== "stock" || immediateNotifications.length) {
    const dispatchBatch = headRole === "stock" ? immediateNotifications : notifications;
    context.waitUntil(deliverDirectNotifications(env, dispatchBatch).catch(error => {
      console.error(`Direct push delivery failed for ${headRole}`, error);
    }));
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 202,
    headers: { ...headers, "content-type": "application/json" }
  });
}

async function handleReminderAction(request, env) {
  const origin = request.headers.get("Origin") || "";
  const headers = corsHeaders(env, origin);
  if (!isAllowedOrigin(env, origin)) return new Response("Forbidden", { status: 403, headers });
  if (request.method === "OPTIONS") return new Response(null, { headers });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers });

  let body;
  try { body = await request.json(); } catch { return new Response("Invalid JSON", { status: 400, headers }); }
  const reminderKey = String(body.reminderKey || "");
  const actionToken = String(body.actionToken || "");
  const action = String(body.action || "");
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(reminderKey) || !actionToken || actionToken.length > 100 || !["snooze", "dismiss"].includes(action)) {
    return new Response("Invalid reminder action", { status: 400, headers });
  }

  const actionKey = `event-reminder-action:${reminderKey}`;
  const actionContext = await env.PUSH_SUBSCRIPTIONS.get(actionKey, "json");
  if (!actionContext || actionContext.actionToken !== actionToken) return new Response("Reminder action expired", { status: 403, headers });
  await migrateScheduledJobsToAlarms(env);
  if (action === "snooze") {
    const name = `scheduled:event-reminder-snoozed:${reminderKey}`;
    const task = {
      jobType: "snoozedReminder",
      actionContext,
      sequence: Number(actionContext.sequence || 0) + 1,
      dueAt: Date.now() + 10 * 60 * 1000
    };
    await env.PUSH_SUBSCRIPTIONS.put(name, JSON.stringify(task), { expirationTtl: 259200 });
    await updateScheduledAlarm(env, "upsert", name, task);
  }
  await env.PUSH_SUBSCRIPTIONS.delete(actionKey);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...headers, "content-type": "application/json" }
  });
}

async function deliverPendingPushes(env) {
  await migrateScheduledJobsToAlarms(env);
  await syncPublishedEventCutoffJobs(env).catch(error => {
    console.error("Published event cutoff sync failed:", error);
  });
  await deliverNewNotifications(env).catch(error => console.error("Schedule push delivery failed:", error));
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (url.pathname === "/employee-authenticate") return handleEmployeeAuthentication(request, env);
    if (url.pathname === "/employee-register") return handleEmployeeRegistration(request, env);
    if (url.pathname === "/subscribe") return handleSubscription(request, env);
    if (url.pathname === "/dispatch") return handleDispatch(request, env, context);
    if (url.pathname === "/wake") return handleWake(request, env, context);
    if (url.pathname === "/auth-handoff") return handleAuthHandoff(request, env);
    if (url.pathname === "/auth-handoff/exchange") return handleAuthHandoffExchange(request, env);
    if (url.pathname === "/reminder-action") return handleReminderAction(request, env);
    return new Response("Not found", { status: 404 });
  }
};
