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
const headRoles = new Set(["pharmacist", "billing", "information", "stock"]);
const headRolesByEmail = {
  "adminstockreq@planetdrugstore.ph": "stock",
  "pharmacistdepart@planetdrugstore.ph": "pharmacist",
  "billingdepart@planetdrugstore.ph": "billing",
  "informationdepart@planetdrugstore.ph": "information"
};

let cachedAccessToken;
let cachedFirebaseJwks;
let cachedFirebaseJwksExpiresAt = 0;
const SCHEDULED_JOB_MIGRATION_KEY = "scheduled-jobs-migrated-v1";

export function shouldNotify(subscription, notification) {
  const staffId = String(subscription.staffId || "").trim().toLowerCase();
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
    if (subscription.headRole) return String(subscription.headRole).trim().toLowerCase() === "stock";
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

async function verifyFirebaseHeadToken(token, projectId) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || token.length > 8192) return "";

  let header;
  let claims;
  try {
    header = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
  } catch {
    return "";
  }
  if (header.alg !== "RS256" || !header.kid) return "";

  let signingKeys = await getFirebaseJwks();
  let jwk = signingKeys.find(key => key.kid === header.kid);
  if (!jwk) {
    cachedFirebaseJwksExpiresAt = 0;
    signingKeys = await getFirebaseJwks();
    jwk = signingKeys.find(key => key.kid === header.kid);
  }
  if (!jwk) return "";

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
  if (!valid) return "";

  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== projectId ||
      claims.iss !== `https://securetoken.google.com/${projectId}` ||
      Number(claims.exp) <= now ||
      Number(claims.iat) > now + 30 ||
      !claims.sub) return "";

  return headRolesByEmail[String(claims.email || "").trim().toLowerCase()] || "";
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
    case "stockDayActivated":
      return {
        title: "Stock request is open",
        body: `You need to enter your SR#! You are scheduled for ${notification.day || "this day"}${notification.date ? ` (${notification.date})` : ""}. Open Stock Request to submit it.`
      };
    case "stockDayClosed":
      return {
        title: "Stock request closed",
        body: `The stock request for today is now closed!${notification.day ? ` (${notification.day})` : ""}`
      };
    case "stockDayClosedEarly":
      return {
        title: "Stock request closed early",
        body: `The stock request${notification.day ? ` for ${notification.day}` : ""} was closed early by the admin. You can no longer submit, edit, or remove your SR# for this day.`
      };
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
      return {
        title: "Stock request cutoff changed",
        body: notification.unclosed === true
          ? `The admin reopened stock requests. You can now enter or edit your SR# until ${newCutoff}.`
          : notification.reopened === true
          ? `The cutoff passed, but the admin moved it from ${oldCutoff} to ${newCutoff}. You can edit or remove your SR# until ${newCutoff}.`
          : `The admin changed the stock request cutoff from ${oldCutoff} to ${newCutoff}. Submit, edit, or remove your SR# before ${newCutoff}.`
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
        body: `The pharmacist sent an event reminder for ${assignedLocation}${assignmentWhen ? ` on ${assignmentWhen}` : ""}.`
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

function notificationEventType(notification) {
  const direct = String(notification.newMissionLabel || notification.missionLabel || notification.eventType || "").trim();
  if (direct) return direct;
  const mission = String(notification.mission || "").trim().toLowerCase();
  if (mission === "medical") return "Medical Mission";
  if (mission === "peoples_day") return "People's Day";
  return String(notification.missionCustom || "").trim();
}

function headNotificationText(notification) {
  const context = [];
  if (notification.location && notification.type !== "siteAutoDeleted") context.push(`Site: ${notification.location}`);
  if (notification.type === "dateChanged" && notification.oldDate && notification.newDate) {
    context.push(`Date: ${notification.oldDate} → ${notification.newDate}`);
  } else if (notification.date) {
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
    siteFilled: "Event site is full",
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
    siteFilled: `The site ${notification.location || "this event site"} is full now${notification.filledCount ? ` (${notification.filledCount} Event Team slots filled)` : ""}`
  };
  return {
    title: titles[notification.type] || "Schedule update",
    body: `${summaries[notification.type] || "The schedule was updated"}${context.length ? `. ${context.join(" • ")}.` : "."}`
  };
}

export function notificationText(notification, subscription = {}) {
  if (notification?.type === "stockDayClosedEarly") {
    return {
      title: "Stock request closed early",
      body: `The stock request${notification.day ? ` for ${notification.day}` : ""} was closed early by the admin. You can no longer submit, edit, or remove your SR# for this day.`
    };
  }
  if (notification?.type === "stockDayClosed") {
    return {
      title: "Stock request closed",
      body: `The stock request for today is now closed!${notification.day ? ` (${notification.day})` : ""}`
    };
  }
  if (headRoles.has(String(subscription.headRole || "").trim().toLowerCase())) {
    return headNotificationText(notification);
  }
  const message = baseNotificationText(notification);
  if (!notification || typeof notification !== "object") return message;
  if (notification.type === "pharmacistNote") return message;
  const actorLabel = String(notification.actorLabel || "").trim();
  const appendActor = text => actorLabel
    ? { ...text, body: `${text.body} Action by: ${actorLabel}.` }
    : text;
  if (notification.type === "eventsDeployed") return appendActor(message);
  if (notification.type === "eventReminder" && notification.recipientAssignment?.list === "relievers") {
    return appendActor(message);
  }
  if (notification.list === "relievers" && notification.type !== "slotAssigned") return appendActor(message);

  const context = [];
  if (actorLabel && notification.type !== "slotAssigned") context.push(`Action by: ${actorLabel}`);
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
  if (["stockDayActivated", "stockDayClosed", "stockDayClosedEarly", "stockDayScheduleChanged", "stockDayCutoffUpdated"].includes(notification?.type)) {
    const path = headRole === "stock" ? "/h9b4t2zvfe" : "/w6n3d8ycrq";
    const stockTarget = new URL(path, appUrl);
    if (notification.day) stockTarget.searchParams.set("day", String(notification.day));
    return stockTarget.toString();
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

async function sendPush(env, subscription, notification) {
  const sentKey = `sent-device:${notification.id}:${(await subscriptionKey(subscription.token)).slice(4)}`;
  if (await env.PUSH_SUBSCRIPTIONS.get(sentKey)) return true;

  const accessToken = await getAccessToken(env);
  const text = notificationText(notification, subscription);
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
            body: text.body,
            url: notificationUrl(env.APP_URL, notification, subscription.headRole),
            notificationId: notification.id,
            notificationType: String(notification.type || ""),
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
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
  const accessToken = await getAccessToken(env);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
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

export async function scheduleStockCutoff(env, notification) {
  await migrateLegacyScheduledJobs(env);
  const date = String(notification.date || "");
  const cutoffMin = Number(notification.cutoffMin);
  const dueAt = stockCutoffAt(date, cutoffMin);
  if (dueAt === null) throw new Error("Invalid stock cutoff schedule.");
  const key = `scheduled:stock-cutoff:${date}`;
  const previous = notification.type === "stockDayCutoffUpdated"
    ? await env.PUSH_SUBSCRIPTIONS.get(key, "json")
    : null;
  const targetStaffIds = [...new Set((Array.isArray(notification.targetStaffIds) ? notification.targetStaffIds : previous?.targetStaffIds || [])
    .map(id => String(id || "").trim().toLowerCase())
    .filter(Boolean))];
  const task = {
    jobType: "stockCutoff",
    date,
    day: String(notification.day || previous?.day || ""),
    cutoffMin,
    targetStaffIds,
    dueAt,
    id: `stock-day-closed:${date}:${notification.id}`
  };
  const expirationTtl = Math.max(60, Math.ceil((dueAt - Date.now()) / 1000) + 86400);
  await env.PUSH_SUBSCRIPTIONS.put(key, JSON.stringify(task), { expirationTtl });
}

async function deliverStockCutoffNotifications(env, subscriptions, dueJobs) {
  for (const { name, task } of dueJobs.filter(job => job.task.jobType === "stockCutoff" || job.name.startsWith("scheduled:stock-cutoff:"))) {
    const notification = {
      id: task.id,
      type: "stockDayClosed",
      date: task.date,
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

async function loadDueScheduledJobs(env) {
  await migrateLegacyScheduledJobs(env);
  const dueJobs = [];
  let cursor;
  do {
    const page = await env.PUSH_SUBSCRIPTIONS.list({ prefix: "scheduled:", cursor });
    for (const item of page.keys) {
      const task = await env.PUSH_SUBSCRIPTIONS.get(item.name, "json");
      if (task && Number(task.dueAt) <= Date.now()) dueJobs.push({ name: item.name, task });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return dueJobs;
}

async function deliverScheduledJobs(env) {
  const dueJobs = await loadDueScheduledJobs(env);
  if (!dueJobs.length) return;
  const subscriptions = await loadSubscriptions(env);
  await Promise.all([
    deliverSnoozedReminders(env, subscriptions, dueJobs).catch(error => console.error("Snoozed reminder delivery failed:", error)),
    deliverStockCutoffNotifications(env, subscriptions, dueJobs).catch(error => console.error("Stock cutoff notification failed:", error))
  ]);
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
  const token = String(body.token || "").trim();
  if (Boolean(staffId) === Boolean(headRole) ||
      (headRole && !headRoles.has(headRole)) ||
      staffId.length > 100 || token.length < 20 || token.length > 8192) {
    return new Response("Invalid subscription", { status: 400, headers });
  }

  const key = await subscriptionKey(token, headRole ? `head:${headRole}` : "");
  if (request.method === "DELETE") {
    const existing = await env.PUSH_SUBSCRIPTIONS.get(key, "json");
    if (existing && existing.staffId === staffId && String(existing.headRole || "") === headRole) {
      await env.PUSH_SUBSCRIPTIONS.delete(key);
    }
  } else {
    const existing = await env.PUSH_SUBSCRIPTIONS.get(key, "json");
    if (!existing || existing.staffId !== staffId || String(existing.headRole || "") !== headRole || existing.token !== token) {
      await env.PUSH_SUBSCRIPTIONS.put(key, JSON.stringify({ staffId, ...(headRole ? { headRole } : {}), token }));
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

async function deliverDirectNotifications(env, notifications) {
  const subscriptions = await loadSubscriptions(env);
  for (const notification of notifications) {
    const id = String(notification.id || "");
    if (await env.PUSH_SUBSCRIPTIONS.get(`sent:${id}`)) continue;

    let complete = true;
    const targets = subscriptions.filter(subscription => shouldNotify(subscription, notification));
    for (const subscription of targets) {
      let delivery = notification;
      if (notification.type === "eventReminder") {
        const staffId = String(subscription.staffId || "").trim().toLowerCase();
        const assignments = Array.isArray(notification.recipientAssignments) ? notification.recipientAssignments : [];
        const assignment = assignments.find(item =>
          String(item.staffId || "").trim().toLowerCase() === staffId && item.list === "relievers"
        ) || assignments.find(item => String(item.staffId || "").trim().toLowerCase() === staffId);
        delivery = { ...notification, ...(assignment ? { recipientAssignment: assignment } : {}) };
      }
      if (!(await sendPush(env, subscription, delivery))) complete = false;
    }
    if (complete) await env.PUSH_SUBSCRIPTIONS.put(`sent:${id}`, "1", { expirationTtl: 604800 });
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
    headRole = await verifyFirebaseHeadToken(token, env.FIREBASE_PROJECT_ID);
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
  const stockScheduleTypes = new Set(["stockDayActivated", "stockDayCutoffUpdated", "stockDayDeactivated"]);
  const stockNoticeTypes = new Set(["stockDayScheduleChanged", "stockDayClosedEarly"]);
  const authorizedStockTypes = new Set([...stockScheduleTypes, ...stockNoticeTypes]);
  const hasStockScheduleChange = notifications.some(notification => authorizedStockTypes.has(notification.type));
  const stockScheduleOnly = notifications.every(notification => authorizedStockTypes.has(notification.type));
  if ((headRole === "stock" && !stockScheduleOnly) || (headRole !== "stock" && hasStockScheduleChange)) {
    return new Response("Notification type is not authorized for this account", { status: 403, headers });
  }

  if (headRole === "stock") {
    try {
      for (const notification of notifications) {
        if (!stockScheduleTypes.has(notification.type)) continue;
        const date = String(notification.date || "");
        if (notification.type === "stockDayDeactivated") {
          await Promise.all([
            env.PUSH_SUBSCRIPTIONS.delete(`scheduled:stock-cutoff:${date}`),
            env.PUSH_SUBSCRIPTIONS.delete(`stock-cutoff:${date}`)
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

  const immediateNotifications = notifications.filter(notification =>
    ["stockDayActivated", "stockDayScheduleChanged", "stockDayCutoffUpdated", "stockDayClosedEarly"].includes(notification.type)
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
  if (action === "snooze") {
    await env.PUSH_SUBSCRIPTIONS.put(`scheduled:event-reminder-snoozed:${reminderKey}`, JSON.stringify({
      jobType: "snoozedReminder",
      actionContext,
      sequence: Number(actionContext.sequence || 0) + 1,
      dueAt: Date.now() + 10 * 60 * 1000
    }), { expirationTtl: 259200 });
  }
  await env.PUSH_SUBSCRIPTIONS.delete(actionKey);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...headers, "content-type": "application/json" }
  });
}

async function deliverPendingPushes(env) {
  await Promise.all([
    deliverNewNotifications(env).catch(error => console.error("Schedule push delivery failed:", error)),
    deliverScheduledJobs(env).catch(error => console.error("Scheduled notification delivery failed:", error))
  ]);
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (url.pathname === "/subscribe") return handleSubscription(request, env);
    if (url.pathname === "/dispatch") return handleDispatch(request, env, context);
    if (url.pathname === "/wake") return handleWake(request, env, context);
    if (url.pathname === "/reminder-action") return handleReminderAction(request, env);
    return new Response("Not found", { status: 404 });
  },
  async scheduled(_event, env, context) {
    context.waitUntil(deliverPendingPushes(env));
  }
};
