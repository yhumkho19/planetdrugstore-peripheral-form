const personalTypes = new Set([
  "removed",
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
  "slotOpened",
  "siteMoved"
]);

let cachedAccessToken;

export function shouldNotify(subscription, notification) {
  if (notification.visibleToEmployees === false) return false;

  const staffId = String(subscription.staffId || "").trim().toLowerCase();
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

function firestoreValue(value) {
  if (!value || typeof value !== "object") return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(firestoreValue);
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
    scope: "https://www.googleapis.com/auth/firebase.messaging",
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

  switch (notification.type) {
    case "eventsDeployed":
      return {
        title: Number(notification.siteCount) === 1 ? "New site deployed" : "New sites deployed",
        body: notification.siteSummary
          ? `${Number(notification.siteCount) === 1 ? "The new site has been deployed" : "New sites have been deployed"}: ${notification.siteSummary}`
          : "New pharmacy events are available. Open the schedule to review."
      };
    case "slotAssigned":
      if (notification.list === "relievers") {
        return {
          title: "You were assigned as Store Reliever",
          body: `You'll be covering ${location || "the store"}${whenText ? ` on ${whenText}` : ""}.`
        };
      }
      return {
        title: "You were assigned to an event slot",
        body: `You were added to this event${roleText}${locationText}${whenText ? ` on ${whenText}` : ""}. Open the schedule to review the details.`
      };
    case "slotOpened":
      if (notification.list === "relievers") {
        return {
          title: "New Store Reliever slot available",
          body: `A Store Reliever slot is open to cover ${location || "the store"}${whenText ? ` on ${whenText}` : ""}. Sign up now.`
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
          body: `You're now covering ${location || "the store"}${whenText ? ` on ${whenText}` : ""}.`
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
      if (notification.list === "relievers") {
        return {
          title: "You were removed as Store Reliever",
          body: `You are no longer assigned as reliever for ${location || "that store"}${whenText ? ` on ${whenText}` : ""}.`
        };
      }
      return {
        title: "You were removed from this slot",
        body: `Your assignment${roleText}${locationText}${whenText ? ` on ${whenText}` : ""} was removed. You can choose another slot.`
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

function notificationBranch(notification) {
  const raw = String(
    notification.type === "branchChanged"
      ? notification.newRegionCustom || notification.newRegion || ""
      : notification.regionCustom || notification.region || ""
  ).trim();
  const normalized = raw.toLowerCase();
  if (normalized === "north") return "North Caloocan";
  if (normalized === "south") return "South Caloocan";
  return raw && normalized !== "other" ? raw : "";
}

function notificationEventType(notification) {
  const direct = String(notification.newMissionLabel || notification.missionLabel || notification.eventType || "").trim();
  if (direct) return direct;
  const mission = String(notification.mission || "").trim().toLowerCase();
  if (mission === "medical") return "Medical Mission";
  if (mission === "peoples_day") return "People's Day";
  return String(notification.missionCustom || "").trim();
}

export function notificationText(notification) {
  const message = baseNotificationText(notification);
  if (!notification || typeof notification !== "object" || notification.type === "eventsDeployed") return message;

  const context = [];
  const branch = notificationBranch(notification);
  const eventType = notificationEventType(notification);
  if (branch && notification.type !== "branchChanged") context.push(`Branch: ${branch}`);
  if (eventType && notification.type !== "missionChanged") context.push(`Event type: ${eventType}`);
  return context.length ? { ...message, body: `${message.body} ${context.join(" • ")}.` } : message;
}

export function notificationUrl(appUrl, notification) {
  const target = new URL(appUrl);
  if (notification?.cardId) target.searchParams.set("viewSite", String(notification.cardId));
  if (notification?.date) target.searchParams.set("date", String(notification.date));
  const region = notification?.region || notification?.newRegion;
  if (region) target.searchParams.set("region", String(region));
  return target.toString();
}

async function sendPush(env, subscription, notification) {
  const sentKey = `sent-device:${notification.id}:${(await subscriptionKey(subscription.token)).slice(4)}`;
  if (await env.PUSH_SUBSCRIPTIONS.get(sentKey)) return true;

  const accessToken = await getAccessToken(env);
  const text = notificationText(notification);
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
          data: {
            title: text.title,
            body: text.body,
            url: notificationUrl(env.APP_URL, notification),
            notificationId: notification.id,
            cardId: String(notification.cardId || ""),
            date: String(notification.date || ""),
            region: String(notification.region || "")
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

async function readNewNotifications(env, storedCursor) {
  let cursor = storedCursor;
  if (!cursor) cursor = new Date(Date.now() - 120000).toISOString();
  const overlap = new Date(Date.parse(cursor) - 1000).toISOString();
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery?key=${encodeURIComponent(env.FIREBASE_API_KEY)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
  if (!response.ok) throw new Error(`Firestore query failed (${response.status})`);
  const rows = await response.json();
  return rows.filter(row => row.document).map(row => decodeDocument(row.document));
}

export function shouldSaveScanCursor(storedCursor, newestTimestamp, allComplete) {
  return allComplete && Boolean(newestTimestamp) && newestTimestamp !== storedCursor;
}

async function deliverNewNotifications(env) {
  const subscriptions = await loadSubscriptions(env);
  const storedCursor = await env.PUSH_SUBSCRIPTIONS.get("scan-cursor");
  const notifications = await readNewNotifications(env, storedCursor);
  let newestTimestamp = storedCursor;
  let allComplete = true;

  for (const notification of notifications) {
    const createdAt = notification.createdAt;
    if (!createdAt) continue;
    if (await env.PUSH_SUBSCRIPTIONS.get(`sent:${notification.id}`)) continue;

    const targets = subscriptions.filter(subscription => shouldNotify(subscription, notification));
    let complete = true;
    for (const subscription of targets) {
      if (!(await sendPush(env, subscription, notification))) complete = false;
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

function isAllowedOrigin(env, origin) {
  if (origin === env.APP_ORIGIN) return true;
  try {
    const appUrl = new URL(env.APP_ORIGIN);
    const hostname = appUrl.hostname;
    const firebaseAlias = hostname.endsWith(".web.app")
      ? hostname.slice(0, -8) + ".firebaseapp.com"
      : hostname.endsWith(".firebaseapp.com")
        ? hostname.slice(0, -16) + ".web.app"
        : "";
    return Boolean(firebaseAlias) && origin === `${appUrl.protocol}//${firebaseAlias}`;
  } catch {
    return false;
  }
}

function corsHeaders(env, origin) {
  return {
    "access-control-allow-origin": isAllowedOrigin(env, origin) ? origin : "null",
    "access-control-allow-methods": "POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}

async function subscriptionKey(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
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
  const token = String(body.token || "").trim();
  if (!staffId || staffId.length > 100 || token.length < 20 || token.length > 8192) {
    return new Response("Invalid subscription", { status: 400, headers });
  }

  const key = await subscriptionKey(token);
  if (request.method === "DELETE") {
    const existing = await env.PUSH_SUBSCRIPTIONS.get(key, "json");
    if (existing && existing.staffId === staffId) await env.PUSH_SUBSCRIPTIONS.delete(key);
  } else {
    const existing = await env.PUSH_SUBSCRIPTIONS.get(key, "json");
    if (!existing || existing.staffId !== staffId || existing.token !== token) {
      await env.PUSH_SUBSCRIPTIONS.put(key, JSON.stringify({ staffId, token }));
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

  context.waitUntil(deliverNewNotifications(env).catch(error => {
    console.error("Immediate push delivery failed", error);
  }));
  return new Response(JSON.stringify({ ok: true }), {
    status: 202,
    headers: { ...headers, "content-type": "application/json" }
  });
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (url.pathname === "/subscribe") return handleSubscription(request, env);
    if (url.pathname === "/wake") return handleWake(request, env, context);
    return new Response("Not found", { status: 404 });
  },
  async scheduled(_event, env, context) {
    context.waitUntil(deliverNewNotifications(env));
  }
};