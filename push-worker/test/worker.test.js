import test from "node:test";
import assert from "node:assert/strict";
import worker, { EmployeeLoginRateLimiter, ScheduledJobs, shouldNotify, isDirectlyDeliverableSwapNotification, notificationText, notificationUrl, notificationContactUrl, shouldSaveScanCursor, pushPlatformOptions, formatPushNotificationBody, stockCutoffAt, scheduleStockCutoff, eventCutoffAt, scheduleEventCutoff, registeredPharmacistAdminRole } from "../src/index.js";

function createScheduledJobs(env) {
  const jobs = new Map();
  let alarmAt = null;
  const storage = {
    async list({ prefix }) {
      return new Map([...jobs].filter(([key]) => key.startsWith(prefix)));
    },
    async put(key, value) { jobs.set(key, value); },
    async delete(key) { jobs.delete(key); },
    async setAlarm(timestamp) { alarmAt = timestamp; },
    async deleteAlarm() { alarmAt = null; }
  };
  const instance = new ScheduledJobs({ storage }, env);
  env.SCHEDULED_JOBS = {
    idFromName() { return "scheduled-jobs"; },
    get() {
      return { fetch: (url, init) => instance.fetch(new Request(url, init)) };
    }
  };
  return {
    instance,
    jobs,
    get alarmAt() { return alarmAt; },
    async runNow() {
      for (const [key, job] of jobs) jobs.set(key, { ...job, nextAttemptAt: Date.now() - 1 });
      await instance.alarm();
    }
  };
}

function createEmployeeLoginLimiterBinding() {
  let state;
  const storage = {
    async transaction(callback) {
      return callback({
        async get() { return state; },
        async put(_key, value) { state = value; }
      });
    },
    async setAlarm() {},
    async deleteAll() { state = undefined; }
  };
  const limiter = new EmployeeLoginRateLimiter({ storage });
  return {
    idFromName(name) { return name; },
    get() { return { fetch: (url, init) => limiter.fetch(new Request(url, init)) }; }
  };
}

test("push messages use high Android priority and high web urgency", () => {
  assert.deepEqual(pushPlatformOptions({ type: "dateChanged" }), {
    android: { priority: "HIGH", ttl: "3600s" },
    webpush: { headers: { Urgency: "high" } }
  });
});

test("event alarms are attempted immediately and are not delivered late", () => {
  assert.deepEqual(pushPlatformOptions({ type: "eventReminder" }), {
    android: { priority: "HIGH", ttl: "0s" },
    webpush: { headers: { Urgency: "high", TTL: "0" } }
  });
});

test("push banner bodies align event fields and retain relevant changes", () => {
  const body = formatPushNotificationBody({
    type: "eventUpdated",
    location: "SM North",
    eventType: "People's Day",
    date: "2026-11-20",
    time: "9:00 AM",
    timeChanged: true,
    locationChanged: true
  }, "The schedule was updated.");
  assert.equal(body, [
    "Site: SM North",
    "Event: People's Day",
    "Date: November 20, 2026",
    "Time: 9:00 AM",
    "Updated: Time and Site name"
  ].join("\n"));
});

test("push banner bodies preserve the cancellation and swap field layouts", () => {
  const cancelledBody = "Site: SM North\nEvent: Medical Mission\nDate: November 20, 2026\nReason: Severe weather";
  assert.equal(formatPushNotificationBody({ type: "eventCancelled" }, cancelledBody), cancelledBody);

  assert.equal(formatPushNotificationBody({
    type: "siteSwapRequest",
    requesterName: "JV MANES",
    requesterLocation: "South Hall",
    requesterDate: "2026-11-20",
    targetLocation: "North Hall",
    targetDate: "2026-11-21",
    requesterNote: "Please confirm."
  }, "JV MANES wants to swap event sites with you. Tap to review the request."), [
    "Requested by: JV MANES",
    "Your site: North Hall",
    "Their site: South Hall",
    "Your date: November 21, 2026",
    "Their date: November 20, 2026",
    "Note: Please confirm."
  ].join("\n"));
});

test("push banner bodies retain automatic deletion and reliever reminder details", () => {
  assert.equal(formatPushNotificationBody({
    type: "siteAutoDeleted",
    location: "SM North",
    date: "2026-11-20"
  }, "The site at SM North on 2026-11-20 was automatically deleted after its event date."), [
    "Site: SM North",
    "Date: November 20, 2026",
    "Status: Automatically deleted after the event date"
  ].join("\n"));

  assert.equal(formatPushNotificationBody({
    type: "eventReminder",
    recipientAssignment: {
      list: "relievers",
      location: "Center 09099",
      date: "2026-11-20",
      relieverTime: "20:00"
    }
  }, "You are relieving Center 09099 on 2026-11-20 from 8:00 PM onwards."), [
    "Site: Center 09099",
    "Date: November 20, 2026",
    "Starts: 8:00 PM"
  ].join("\n"));
});

test("push banner bodies keep stock notification details in labeled lines", () => {
  const body = formatPushNotificationBody({
    type: "stockDayActivated",
    requestType: "medicine",
    day: "WEDNESDAY",
    date: "2026-11-18"
  }, "Medicine SR# entry is now open! You are scheduled for WEDNESDAY (2026-11-18). Open Stock Request to submit it.");
  assert.equal(body, [
    "Request type: Medicine",
    "Date: November 18, 2026",
    "Day: WEDNESDAY",
    "Status: Open",
    "Next step: Open Stock Request to submit your SR#"
  ].join("\n"));
});

test("personal schedule notifications are sent only to the matching staff ID", () => {
  const subscription = { staffId: "staff-17" };
  assert.equal(shouldNotify(subscription, { type: "dateChanged", staffId: "STAFF-17" }), true);
  assert.equal(shouldNotify(subscription, { type: "dateChanged", staffId: "staff-18" }), false);
  for (const type of ["removed", "eventReinstated"]) {
    assert.equal(shouldNotify(subscription, { type, staffId: "STAFF-17" }), true);
    assert.equal(shouldNotify(subscription, { type, staffId: "staff-18" }), false);
  }
});

test("site swap notifications target only the intended employee and route to the right action", () => {
  const request = {
    id: "swap-request-42",
    type: "siteSwapRequest",
    status: "pending",
    targetStaffId: "STAFF-17",
    targetStaffIds: ["STAFF-17"],
    requesterName: "JV MANES",
    cardId: "event-site-9",
    date: "2026-10-14",
    region: "south",
    visibleToEmployees: true
  };
  assert.equal(shouldNotify({ staffId: "staff-17" }, request), true);
  assert.equal(shouldNotify({ staffId: "staff-18" }, request), false);
  assert.equal(shouldNotify({ headRole: "pharmacist" }, request), false);
  assert.equal(shouldNotify({ staffId: "staff-17" }, { ...request, visibleToEmployees: false }), false);
  assert.equal(isDirectlyDeliverableSwapNotification(request), true);
  assert.equal(isDirectlyDeliverableSwapNotification({ ...request, targetStaffId: "STAFF-18" }), false);
  assert.equal(isDirectlyDeliverableSwapNotification({ ...request, status: "approved" }), false);
  assert.equal(isDirectlyDeliverableSwapNotification({ ...request, visibleToEmployees: false }), false);
  assert.deepEqual(notificationText(request), {
    title: "Event site swap request",
    body: "JV MANES wants to swap event sites with you. Tap to review the request."
  });
  const requestUrl = new URL(notificationUrl("https://example.test/47fto0gim6", request));
  assert.equal(requestUrl.searchParams.get("swapRequest"), "swap-request-42");
  assert.equal(requestUrl.searchParams.get("viewSite"), "event-site-9");
  assert.equal(requestUrl.searchParams.get("date"), "2026-10-14");

  const approved = {
    type: "siteSwapApproved",
    status: "approved",
    targetStaffIds: ["STAFF-17"],
    swapPartnerName: "JV MANES",
    cardId: "event-site-10",
    date: "2026-10-15",
    region: "north"
  };
  assert.equal(shouldNotify({ staffId: "staff-17" }, approved), true);
  assert.equal(shouldNotify({ staffId: "staff-18" }, approved), false);
  assert.equal(isDirectlyDeliverableSwapNotification(approved), true);
  assert.equal(isDirectlyDeliverableSwapNotification({ ...approved, status: "declined" }), false);
  assert.match(notificationText(approved).body, /exchanged event sites/);
  const approvedUrl = new URL(notificationUrl("https://example.test/47fto0gim6", approved));
  assert.equal(approvedUrl.searchParams.get("viewSite"), "event-site-10");
  assert.equal(approvedUrl.searchParams.get("date"), "2026-10-15");

  assert.match(notificationText({
    type: "siteSwapDeclined",
    status: "declined",
    targetStaffIds: ["STAFF-17"],
    swapPartnerName: "JV MANES",
    responseReason: "The assignment changed."
  }).body, /The assignment changed\./);
  assert.equal(isDirectlyDeliverableSwapNotification({
    type: "siteSwapDeclined",
    status: "declined",
    targetStaffIds: ["STAFF-17"]
  }), true);
});

test("direct swap push wake reports an unpaired recipient device", async () => {
  const originalFetch = globalThis.fetch;
  const storedNotification = {
    name: "projects/test/databases/(default)/documents/emergencyNotifications/swap-request-42",
    fields: {
      type: { stringValue: "siteSwapRequest" },
      status: { stringValue: "pending" },
      targetStaffId: { stringValue: "STAFF-17" },
      targetStaffIds: { arrayValue: { values: [{ stringValue: "STAFF-17" }] } },
      visibleToEmployees: { booleanValue: true }
    }
  };
  const env = {
    APP_ORIGIN: "https://planetdrugstoreconsole.web.app",
    FIREBASE_PROJECT_ID: "test-project",
    FIREBASE_API_KEY: "test-api-key",
    PUSH_SUBSCRIPTIONS: {
      async list() { return { keys: [], list_complete: true }; },
      async get() { return null; },
      async put() {}
    }
  };
  globalThis.fetch = async () => new Response(JSON.stringify(storedNotification), { status: 200 });
  try {
    const response = await worker.fetch(new Request("https://worker.test/wake", {
      method: "POST",
      headers: { Origin: env.APP_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ notificationId: "swap-request-42" })
    }), env, { waitUntil() {} });
    assert.equal(response.status, 409);
    assert.match(await response.text(), /No active notification subscription/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("event cutoff changes notify employees and targeted department heads", () => {
  const notification = {
    type: "eventCutoffChanged",
    location: "Barangay Hall",
    date: "2026-10-14",
    cutoffTime: "14:00",
    broadcastToEmployees: true,
    visibleToEmployees: true,
    targetRoles: ["pharmacist", "information", "billing"]
  };
  assert.equal(shouldNotify({ staffId: "staff-17" }, notification), true);
  assert.equal(shouldNotify({ staffId: "staff-17" }, { ...notification, broadcastToEmployees: false }), false);
  assert.equal(shouldNotify({ headRole: "billing" }, notification), true);
  assert.equal(shouldNotify({ headRole: "stock" }, notification), false);
  assert.deepEqual(notificationText(notification), {
    title: "Event cutoff changed",
    body: "Operations changed the cutoff time to 2:00 PM."
  });
  assert.deepEqual(notificationText(notification, { headRole: "billing" }), {
    title: "Event cutoff changed",
    body: "Operations changed the cutoff time to 2:00 PM. Site: Barangay Hall."
  });
});

test("event cutoff reached announces the final lineup for the named site", () => {
  const notification = {
    type: "eventCutoffReached",
    location: "Barangay Hall",
    cutoffTime: "17:00"
  };
  const expected = {
    title: "Event cutoff reached",
    body: "Here's the final lineup for Barangay Hall. The cutoff time (5:00 PM) has been reached."
  };
  assert.deepEqual(notificationText(notification), expected);
  assert.deepEqual(notificationText(notification, { headRole: "pharmacist" }), expected);
});

test("site deletion alerts describe next-day deletion rather than cutoff", () => {
  assert.deepEqual(notificationText({
    type: "siteAutoDeleted",
    location: "Barangay Hall",
    date: "2026-10-16",
    cutoffTime: "17:00"
  }), {
    title: "Your event site was removed",
    body: "The site at Barangay Hall on 2026-10-16 was automatically deleted after its event date."
  });
});

test("removed slot roles notify only the affected employee and name the department", () => {
  const notification = {
    type: "slotRoleRemoved",
    staffId: "STAFF-17",
    role: "Pharmacy Assistant",
    removedByDepartment: "Operations"
  };
  assert.equal(shouldNotify({ staffId: "staff-17" }, notification), true);
  assert.equal(shouldNotify({ staffId: "staff-18" }, notification), false);
  assert.deepEqual(notificationText(notification), {
    title: "Your slot role was removed",
    body: "Your Pharmacy Assistant slot has been removed by Operations. You can choose another slot."
  });
});

test("stock-day activation identifies the request type and notifies scheduled employees", () => {
  const notification = { type: "stockDayActivated", requestType: "medicine", targetStaffIds: ["260616", "staff-18"] };
  assert.equal(shouldNotify({ staffId: "260616" }, notification), true);
  assert.equal(shouldNotify({ staffId: "staff-18" }, notification), true);
  assert.equal(shouldNotify({ staffId: "staff-19" }, notification), false);
  assert.equal(shouldNotify({ headRole: "pharmacist" }, notification), false);
  assert.deepEqual(notificationText({ ...notification, day: "WEDNESDAY", date: "2026-10-14" }), {
    title: "Medicine stock requests are open",
    body: "Medicine SR# entry is now open! You are scheduled for WEDNESDAY (2026-10-14). Open Stock Request to submit it."
  });
  assert.deepEqual(notificationText({ ...notification, requestType: "supplies", day: "WEDNESDAY", date: "2026-10-14" }), {
    title: "Supplies stock requests are open",
    body: "Supplies SR# entry is now open! You are scheduled for WEDNESDAY (2026-10-14). Open Stock Request to submit it."
  });
  const target = new URL(notificationUrl("https://example.test/47fto0gim6", {
    type: "stockDayActivated",
    requestType: "medicine",
    day: "WEDNESDAY"
  }));
  assert.equal(target.pathname, "/w6n3d8ycrq");
  assert.equal(target.searchParams.get("day"), "WEDNESDAY");
  assert.equal(target.searchParams.get("requestType"), "medicine");
  const suppliesTarget = new URL(notificationUrl("https://example.test/47fto0gim6", {
    type: "stockDayActivated",
    requestType: "supplies",
    day: "WEDNESDAY"
  }));
  assert.equal(suppliesTarget.searchParams.get("requestType"), "supplies");
});

test("stock request removal notifies only the affected employee and links to that day", () => {
  const notification = {
    type: "stockRequestRemoved",
    staffId: "STAFF-17",
    day: "TUESDAY",
    date: "2026-10-20"
  };
  assert.equal(shouldNotify({ staffId: "staff-17" }, notification), true);
  assert.equal(shouldNotify({ staffId: "staff-18" }, notification), false);
  assert.equal(shouldNotify({ headRole: "stock" }, notification), false);
  assert.deepEqual(notificationText(notification), {
    title: "SR# removed",
    body: "Your SR# has been removed. Please contact your Stock Request Admin for more details."
  });
  const target = new URL(notificationUrl("https://example.test/47fto0gim6", notification));
  assert.equal(target.pathname, "/w6n3d8ycrq");
  assert.equal(target.searchParams.get("day"), "TUESDAY");
  const contact = new URL(notificationContactUrl(notification));
  assert.equal(contact.pathname, "/l/channel/19%3Ad306729cf93a4d0bb3970490db04752e%40thread.tacv2/CALOOCAN");
  assert.equal(contact.searchParams.get("groupId"), "64a1d61d-5681-4a79-ae96-a838a1a32560");
});

test("stock request completion notifies only the affected employee and links to that day", () => {
  const notification = {
    type: "stockRequestCompleted",
    requestType: "supplies",
    staffId: "STAFF-17",
    sr: "12345",
    day: "TUESDAY",
    date: "2026-10-20"
  };
  assert.equal(shouldNotify({ staffId: "staff-17" }, notification), true);
  assert.equal(shouldNotify({ staffId: "staff-18" }, notification), false);
  assert.equal(shouldNotify({ headRole: "stock" }, notification), false);
  assert.deepEqual(notificationText(notification), {
    title: "Supplies SR# completed",
    body: "Your supplies SR# 12345 has been marked completed by the admin. You can no longer edit this request."
  });
  const target = new URL(notificationUrl("https://example.test/47fto0gim6", notification));
  assert.equal(target.pathname, "/w6n3d8ycrq");
  assert.equal(target.searchParams.get("day"), "TUESDAY");
});

test("stock request unblock notifies only the affected employee and opens that request day", () => {
  const notification = {
    type: "stockRequestUnblocked",
    staffId: "STAFF-17",
    day: "TUESDAY",
    date: "2026-10-20"
  };
  assert.equal(shouldNotify({ staffId: "staff-17" }, notification), true);
  assert.equal(shouldNotify({ staffId: "staff-18" }, notification), false);
  assert.equal(shouldNotify({ headRole: "stock" }, notification), false);
  assert.deepEqual(notificationText(notification), {
    title: "You were unblocked",
    body: "You were unblocked by the Stock Request Admin. You can now edit your SR# or keep your current SR#."
  });
  const target = new URL(notificationUrl("https://example.test/47fto0gim6", notification));
  assert.equal(target.pathname, "/w6n3d8ycrq");
  assert.equal(target.searchParams.get("day"), "TUESDAY");
});

test("new stock request alerts only the matching stock admin category", () => {
  const medicineRequest = {
    type: "stockRequestSubmitted",
    requestType: "medicine",
    targetRoles: ["stock"],
    employeeName: "Employee Name",
    location: "SM North",
    branch: "north",
    sr: "12345",
    date: "2026-11-11",
    day: "WEDNESDAY"
  };
  const suppliesRequest = { ...medicineRequest, requestType: "supplies" };
  assert.equal(shouldNotify({ headRole: "stock", stockType: "medicine" }, medicineRequest), true);
  assert.equal(shouldNotify({ headRole: "stock", stockType: "supplies" }, medicineRequest), false);
  assert.equal(shouldNotify({ headRole: "stock", stockType: "supplies" }, suppliesRequest), true);
  assert.equal(shouldNotify({ headRole: "stock", stockType: "medicine" }, suppliesRequest), false);
  assert.equal(shouldNotify({ headRole: "stock", stockType: "medicine" }, { ...medicineRequest, updated: true }), true);
  assert.equal(shouldNotify({ headRole: "stock", stockType: "supplies" }, { ...medicineRequest, updated: true }), false);
  assert.equal(shouldNotify({ headRole: "stock", stockType: "supplies" }, { ...suppliesRequest, updated: true }), true);
  assert.equal(shouldNotify({ headRole: "stock", stockType: "medicine" }, { ...suppliesRequest, updated: true }), false);
  assert.equal(shouldNotify({ headRole: "stock" }, medicineRequest), false);
  assert.equal(shouldNotify({ headRole: "stock" }, suppliesRequest), false);
  assert.equal(shouldNotify({ headRole: "billing" }, medicineRequest), false);
  assert.deepEqual(notificationText(medicineRequest), {
    title: "New Medicine stock request",
    body: "Employee Name • SM North • NORTH • 2026-11-11 submitted SR# 12345."
  });
  assert.deepEqual(notificationText(suppliesRequest), {
    title: "New Supplies stock request",
    body: "Employee Name • SM North • NORTH • 2026-11-11 submitted SR# 12345."
  });
  assert.deepEqual(notificationText({ ...medicineRequest, updated: true, previousSr: "12344" }), {
    title: "Updated Medicine stock request",
    body: "Employee Name • SM North • NORTH • 2026-11-11 updated SR# 12344 → 12345."
  });
  assert.deepEqual(notificationText({ ...suppliesRequest, updated: true, previousSr: "12344" }), {
    title: "Updated Supplies stock request",
    body: "Employee Name • SM North • NORTH • 2026-11-11 updated SR# 12344 → 12345."
  });
  const target = new URL(notificationUrl("https://example.test/47fto0gim6", medicineRequest, "stock"));
  assert.equal(target.pathname, "/h9b4t2zvfe");
  assert.equal(target.searchParams.get("day"), "WEDNESDAY");
});

test("event assignment changes include the event-admin Teams contact action", () => {
  const notifications = [
    { type: "slotAssigned", list: "staff", staffId: "STAFF-17" },
    { type: "slotAssigned", list: "relievers", staffId: "STAFF-17" },
    { type: "removed", staffId: "STAFF-17" },
    { type: "siteMoved", list: "staff", staffId: "STAFF-17" },
    { type: "siteMoved", list: "relievers", staffId: "STAFF-17" },
    { type: "slotRoleRemoved", staffId: "STAFF-17" },
    { type: "dateChanged", staffId: "STAFF-17" },
    { type: "pharmacistNote", recipientStaffIds: ["STAFF-17"] },
    { type: "eventReminder", recipientStaffIds: ["STAFF-17"] },
    { type: "eventUpdated", staffId: "STAFF-17" }
  ];
  for (const notification of notifications) {
    assert.equal(shouldNotify({ staffId: "staff-17" }, notification), true);
    assert.equal(shouldNotify({ staffId: "staff-18" }, notification), false);
    const contact = new URL(notificationContactUrl(notification));
    assert.equal(contact.pathname, "/l/channel/19%3A8c33af8e2f4c4d8dabb99a5a5337287f%40thread.tacv2/PEOPLES%20DAY%20x%20MEDICAL%20MISSION");
    assert.equal(contact.searchParams.get("groupId"), "64a1d61d-5681-4a79-ae96-a838a1a32560");
    assert.equal(contact.searchParams.get("tenantId"), "a5906354-ebe5-419d-b024-6c7db90917b0");
  }
});

test("event Contact Admin opens the configured event schedule channel", () => {
  const contact = new URL(notificationContactUrl({
    type: "pharmacistNote",
    employeeName: "JV MANES",
    role: "IT Specialist",
    location: "Amparo Nature Park",
    date: "2026-10-17"
  }));
  assert.equal(contact.pathname, "/l/channel/19%3A8c33af8e2f4c4d8dabb99a5a5337287f%40thread.tacv2/PEOPLES%20DAY%20x%20MEDICAL%20MISSION");
  assert.equal(contact.searchParams.get("groupId"), "64a1d61d-5681-4a79-ae96-a838a1a32560");
  assert.equal(contact.searchParams.get("tenantId"), "a5906354-ebe5-419d-b024-6c7db90917b0");
});

test("all stock notifications link to Stock Request Admin while event notifications link to Event Admin", () => {
  const stockTypes = ["stockDayActivated", "stockDayClosed", "stockDayClosedEarly", "stockDayScheduleChanged", "stockDayCutoffUpdated", "stockRequestRemoved", "stockRequestCompleted", "stockRequestUnblocked"];
  for (const type of stockTypes) {
    const contact = new URL(notificationContactUrl({ type }));
    assert.equal(contact.pathname, "/l/channel/19%3Ad306729cf93a4d0bb3970490db04752e%40thread.tacv2/CALOOCAN");
  }
  const eventContact = new URL(notificationContactUrl({ type: "pharmacistNote" }));
  assert.equal(eventContact.pathname, "/l/channel/19%3A8c33af8e2f4c4d8dabb99a5a5337287f%40thread.tacv2/PEOPLES%20DAY%20x%20MEDICAL%20MISSION");
  assert.equal(notificationContactUrl({}), "");
});

test("stock cutoff time converts Philippine local time to UTC", () => {
  assert.equal(stockCutoffAt("2026-10-14", 480), Date.parse("2026-10-14T00:00:00Z"));
  assert.equal(stockCutoffAt("2026-10-14", 840), Date.parse("2026-10-14T06:00:00Z"));
  assert.equal(stockCutoffAt("invalid", 840), null);
});

test("event cutoff time converts Philippine local time to UTC", () => {
  assert.equal(eventCutoffAt("2026-10-14", "17:00"), Date.parse("2026-10-14T09:00:00Z"));
  assert.equal(eventCutoffAt("2026-10-14", "24:00"), null);
  assert.equal(eventCutoffAt("invalid", "17:00"), null);
});

test("event cutoff schedules replace prior times and cancel cleanly", async () => {
  const values = new Map([["scheduled-jobs-migrated-v1", "1"]]);
  let puts = 0;
  const kv = {
    async get(key, type) {
      const value = values.get(key);
      return type === "json" && value ? JSON.parse(value) : value || null;
    },
    async put(key, value) { puts++; values.set(key, value); },
    async delete(key) { values.delete(key); }
  };
  const env = { PUSH_SUBSCRIPTIONS: kv };
  const key = "scheduled:event-cutoff:event-site-2";
  await scheduleEventCutoff(env, { cardId: "event-site-2", date: "2026-10-14", cutoffTime: "17:00" });
  const original = await kv.get(key, "json");
  await scheduleEventCutoff(env, { cardId: "event-site-2", date: "2026-10-14", cutoffTime: "14:00" });
  const revised = await kv.get(key, "json");
  assert.notEqual(revised.id, original.id);
  assert.equal(revised.cutoffTime, "14:00");
  await scheduleEventCutoff(env, { cardId: "event-site-2", date: "2026-10-14", cutoffTime: "14:00" });
  assert.equal(puts, 2);
  await scheduleEventCutoff(env, { cardId: "event-site-2", cancelled: true });
  assert.equal(values.has(key), false);
});

test("worker wake backfills cutoff jobs from published employee events", async () => {
  const keyPair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
  }, true, ["sign", "verify"]);
  const privateKeyBytes = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const privateKeyBase64 = Buffer.from(privateKeyBytes).toString("base64").match(/.{1,64}/g).join("\n");
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${privateKeyBase64}\n-----END PRIVATE KEY-----`;
  const values = new Map([["scheduled-jobs-migrated-v1", "1"]]);
  let scheduleSyncReads = 0;
  const kv = {
    async get(key, type) {
      if (key === "event-cutoff-schedule-sync-at") scheduleSyncReads++;
      const value = values.get(key);
      return type === "json" && value ? JSON.parse(value) : value || null;
    },
    async put(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async list({ prefix }) {
      return { keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })), list_complete: true };
    }
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes("/documents/eventSchedule/current")) {
      assert.equal(new URL(url).searchParams.get("key"), "test-firestore-api-key");
      return new Response(JSON.stringify({
        name: "projects/test/databases/(default)/documents/eventSchedule/current",
        fields: {
          employeeCards: { arrayValue: { values: [{ mapValue: { fields: {
            id: { stringValue: "existing-event" },
            date: { stringValue: "2099-12-31" },
            cutoffTime: { stringValue: "17:00" },
            location: { stringValue: "Published Site" },
            cancelled: { booleanValue: false }
          } } }] } }
        }
      }), { headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("documents:runQuery")) {
      assert.equal(new URL(url).searchParams.get("key"), "test-firestore-api-key");
      return new Response("[]", { headers: { "content-type": "application/json" } });
    }
    if (String(url) === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: "cutoff-sync-test-token", expires_in: 3600 }), {
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected network request: ${String(url)}`);
  };

  try {
    const env = {
      APP_ORIGIN: "https://planetdrugstoreconsole.web.app",
      FIREBASE_PROJECT_ID: "planetdrugstore-peripher-d24c0",
      FIREBASE_API_KEY: "test-firestore-api-key",
      FIREBASE_CLIENT_EMAIL: "service@example.iam.gserviceaccount.com",
      FIREBASE_PRIVATE_KEY: privateKeyPem,
      PUSH_SUBSCRIPTIONS: kv
    };
    const alarmScheduler = createScheduledJobs(env);
    const pending = [];
    const response = await worker.fetch(new Request("https://worker.test/wake", {
      method: "POST",
      headers: { Origin: env.APP_ORIGIN, "content-type": "application/json" },
      body: "{}"
    }), env, { waitUntil(promise) { pending.push(promise); } });
    assert.equal(response.status, 202);
    await Promise.all(pending);

    const task = await kv.get("scheduled:event-cutoff:existing-event", "json");
    assert.equal(task.cutoffTime, "17:00");
    assert.equal(task.location, "Published Site");
    assert.ok(Number(values.get("event-cutoff-schedule-sync-at")) > 0);
    assert.equal(scheduleSyncReads, 1);
    assert.equal(alarmScheduler.jobs.has("job:scheduled:event-cutoff:existing-event"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scheduled event cutoff alerts employees and department heads once", async () => {
  const keyPair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
  }, true, ["sign", "verify"]);
  const privateKeyBytes = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const privateKeyBase64 = Buffer.from(privateKeyBytes).toString("base64").match(/.{1,64}/g).join("\n");
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${privateKeyBase64}\n-----END PRIVATE KEY-----`;
  const values = new Map([["scheduled-jobs-migrated-v1", "1"]]);
  const kv = {
    async get(key, type) {
      const value = values.get(key);
      return type === "json" && value ? JSON.parse(value) : value || null;
    },
    async put(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async list({ prefix }) {
      return { keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })), list_complete: true };
    }
  };
  const env = {
    APP_URL: "https://planetdrugstoreconsole.web.app/47fto0gim6",
    FIREBASE_PROJECT_ID: "planetdrugstore-peripher-d24c0",
    PUSH_SUBSCRIPTIONS: kv
  };
  const alarmScheduler = createScheduledJobs(env);
  await scheduleEventCutoff(env, {
    cardId: "event-site-1",
    date: "2000-01-01",
    cutoffTime: "17:00",
    location: "Barangay Hall"
  });
  values.set("sub:employee", JSON.stringify({ staffId: "staff-17", token: "employee-device-token" }));
  values.set("sub:billing", JSON.stringify({ headRole: "billing", token: "billing-device-token" }));
  values.set("sub:stock", JSON.stringify({ headRole: "stock", token: "stock-device-token" }));
  const sentMessages = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/documents/eventSchedule/current")) {
      return new Response(JSON.stringify({
        name: "projects/planetdrugstore-peripher-d24c0/databases/(default)/documents/eventSchedule/current",
        fields: {
          employeeCards: { arrayValue: { values: [{ mapValue: { fields: {
            id: { stringValue: "event-site-1" },
            date: { stringValue: "2000-01-01" },
            cutoffTime: { stringValue: "17:00" },
            location: { stringValue: "Barangay Hall" },
            cancelled: { booleanValue: false }
          } } }] } }
        }
      }), { headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("firestore.googleapis.com")) {
      return new Response("[]", { headers: { "content-type": "application/json" } });
    }
    if (String(url) === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: "event-cutoff-test-token", expires_in: 3600 }), {
        headers: { "content-type": "application/json" }
      });
    }
    if (String(url).includes("fcm.googleapis.com/v1/projects/")) {
      const message = JSON.parse(options.body).message;
      if (message.token === "employee-device-token") {
        return new Response(JSON.stringify({ error: { details: [{ errorCode: "SENDER_ID_MISMATCH" }] } }), { status: 403 });
      }
      sentMessages.push(message);
      return new Response(JSON.stringify({ name: "projects/test/messages/event-cutoff" }), {
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected network request: ${String(url)}`);
  };

  try {
    Object.assign(env, {
      FIREBASE_CLIENT_EMAIL: "service@example.iam.gserviceaccount.com",
      FIREBASE_PRIVATE_KEY: privateKeyPem
    });
    const runScheduled = () => alarmScheduler.runNow();
    await runScheduled();
    assert.equal(values.has("sub:employee"), false);
    assert.equal(values.has("scheduled:event-cutoff:event-site-1"), true);
    values.set("sub:employee-refreshed", JSON.stringify({ staffId: "staff-17", token: "employee-device-token-refreshed" }));
    await runScheduled();

    assert.deepEqual(sentMessages.map(message => message.token).sort(), ["billing-device-token", "employee-device-token-refreshed"]);
    assert.equal(sentMessages.every(message => message.data.notificationType === "eventCutoffReached"), true);
    assert.equal(sentMessages.every(message => message.data.body.includes("5:00 PM")), true);
    assert.equal(sentMessages.every(message => message.data.body.includes("final lineup for Barangay Hall")), true);
    assert.equal(values.has("scheduled:event-cutoff:event-site-1"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rescheduling a delivered stock cutoff creates a fresh employee-targeted notification", async () => {
  const values = new Map();
  const kv = {
    async get(key, type) {
      const value = values.get(key);
      return type === "json" && value ? JSON.parse(value) : value || null;
    },
    async put(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async list({ prefix }) {
      return {
        keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })),
        list_complete: true
      };
    }
  };
  const env = { PUSH_SUBSCRIPTIONS: kv };
  const activation = {
    id: "stock-day-2026-10-14-activation",
    type: "stockDayActivated",
    requestType: "medicine",
    date: "2026-10-14",
    day: "WEDNESDAY",
    cutoffMin: 840,
    targetStaffIds: ["260616"]
  };
  await scheduleStockCutoff(env, activation);
  const cutoffKey = "scheduled:stock-cutoff:medicine:2026-10-14";
  const firstTask = await kv.get(cutoffKey, "json");

  await kv.delete(cutoffKey);
  await scheduleStockCutoff(env, {
    id: "stock-day-cutoff-2026-10-14-update-2",
    type: "stockDayCutoffUpdated",
    requestType: "medicine",
    date: "2026-10-14",
    day: "WEDNESDAY",
    cutoffMin: 1020,
    targetStaffIds: ["260616"]
  });
  const revisedTask = await kv.get(cutoffKey, "json");

  assert.notEqual(revisedTask.id, firstTask.id);
  assert.equal(revisedTask.cutoffMin, 1020);
  assert.equal(revisedTask.requestType, "medicine");
  assert.deepEqual(revisedTask.targetStaffIds, ["260616"]);

  await scheduleStockCutoff(env, {
    id: "stock-day-supplies-2026-10-14",
    type: "stockDayActivated",
    requestType: "supplies",
    date: "2026-10-14",
    day: "WEDNESDAY",
    cutoffMin: 900,
    targetStaffIds: ["260616"]
  });
  assert.equal((await kv.get("scheduled:stock-cutoff:supplies:2026-10-14", "json")).requestType, "supplies");
  assert.equal((await kv.get(cutoffKey, "json")).cutoffMin, 1020);
});

test("stock cutoff alerts go to scheduled employees and the Stock Request admin only", () => {
  const notification = { type: "stockDayClosed", targetStaffIds: ["260616"] };
  assert.equal(shouldNotify({ staffId: "260616" }, notification), true);
  assert.equal(shouldNotify({ staffId: "other-staff" }, notification), false);
  assert.equal(shouldNotify({ headRole: "stock", stockType: "medicine" }, notification), true);
  assert.equal(shouldNotify({ headRole: "pharmacist" }, notification), false);
  assert.deepEqual(notificationText(notification, { headRole: "stock" }), {
    title: "Medicine stock requests closed",
    body: "Medicine stock requests for today are now closed!"
  });
});

test("early stock-day closure notifies scheduled employees and the Stock Request admin", () => {
  const notification = {
    type: "stockDayClosedEarly",
    requestType: "supplies",
    day: "THURSDAY",
    targetStaffIds: ["260616"]
  };
  assert.equal(shouldNotify({ staffId: "260616" }, notification), true);
  assert.equal(shouldNotify({ staffId: "other-staff" }, notification), false);
  assert.equal(shouldNotify({ headRole: "stock", stockType: "supplies" }, notification), true);
  assert.equal(shouldNotify({ headRole: "stock", stockType: "medicine" }, notification), false);
  assert.equal(shouldNotify({ headRole: "pharmacist" }, notification), false);
  assert.deepEqual(notificationText(notification), {
    title: "Supplies stock requests closed early",
    body: "Supplies stock requests for THURSDAY were closed early by the admin. You can no longer submit, edit, or remove your SR# for this day."
  });
  assert.equal(new URL(notificationUrl("https://example.test/47fto0gim6", notification)).pathname, "/w6n3d8ycrq");
});

test("stock schedule and cutoff updates notify only their targeted employees", () => {
  const scheduleChange = {
    type: "stockDayScheduleChanged",
    targetStaffIds: ["260616"],
    requestDays: ["MONDAY", "WEDNESDAY"],
    addedDays: ["WEDNESDAY"],
    removedDays: []
  };
  assert.equal(shouldNotify({ staffId: "260616" }, scheduleChange), true);
  assert.equal(shouldNotify({ staffId: "other-staff" }, scheduleChange), false);
  assert.equal(shouldNotify({ headRole: "stock" }, scheduleChange), false);
  assert.deepEqual(notificationText(scheduleChange), {
    title: "Stock request schedule changed",
    body: "Your stock request days changed. Added: Wednesday. Current days: Monday, Wednesday."
  });

  const cutoffChange = {
    type: "stockDayCutoffUpdated",
    requestType: "medicine",
    targetStaffIds: ["260616"],
    previousCutoffMin: 1080,
    cutoffMin: 1200,
    reopened: true
  };
  assert.equal(shouldNotify({ staffId: "260616" }, cutoffChange), true);
  assert.equal(shouldNotify({ staffId: "other-staff" }, cutoffChange), false);
  assert.equal(notificationText(cutoffChange).body,
    "The medicine cutoff passed, but the admin moved it from 6:00 PM to 8:00 PM. You can edit or remove your SR# until 8:00 PM.");
  assert.equal(notificationText({ ...cutoffChange, requestType: "supplies", unclosed: true }).body,
    "The admin reopened supplies stock requests. You can now enter or edit your SR# until 8:00 PM.");
  assert.equal(new URL(notificationUrl("https://example.test/47fto0gim6", cutoffChange)).pathname, "/w6n3d8ycrq");
});

test("head push subscriptions receive only notifications for their department", () => {
  const pharmacist = { headRole: "pharmacist" };
  const billing = { headRole: "billing" };
  const departmentNotice = { type: "dateChanged", targetRoles: ["pharmacist", "billing"] };
  assert.equal(shouldNotify(pharmacist, departmentNotice), true);
  assert.equal(shouldNotify(billing, departmentNotice), true);
  assert.equal(shouldNotify(pharmacist, { type: "eventCreated", targetRoles: ["billing", "information"] }), false);
  for (const type of ["eventCancelled", "eventReinstated"]) {
    const eventNotice = { type, targetRoles: ["billing", "information"], broadcastToEmployees: true };
    assert.equal(shouldNotify(billing, eventNotice), true);
    assert.equal(shouldNotify({ headRole: "information" }, eventNotice), true);
    assert.equal(shouldNotify(pharmacist, eventNotice), false);
    assert.equal(shouldNotify({ staffId: "staff-17" }, eventNotice), true);
    assert.equal(shouldNotify({ staffId: "staff-17" }, { ...eventNotice, broadcastToEmployees: false }), false);
  }
  assert.equal(shouldNotify(pharmacist, { type: "siteFilled", targetRoles: ["pharmacist"] }), true);
  assert.equal(shouldNotify(billing, { type: "siteFilled", targetRoles: ["pharmacist"] }), false);
  assert.equal(shouldNotify({ staffId: "staff-17" }, { type: "eventReminder", recipientStaffIds: ["STAFF-17"] }), true);
  assert.equal(shouldNotify({ staffId: "staff-18" }, { type: "eventReminder", recipientStaffIds: ["STAFF-17"] }), false);
  assert.equal(shouldNotify({ headRole: "pharmacist" }, { type: "eventReminder", recipientStaffIds: ["STAFF-17"] }), false);
  assert.equal(shouldNotify(pharmacist, { type: "slotAssigned", staffId: "staff-17" }), false);
  assert.equal(shouldNotify(pharmacist, { type: "eventUpdated", targetRoles: ["pharmacist"], employeeOnly: true }), false);
  assert.equal(shouldNotify({ staffId: "staff-17" }, { type: "dateChanged", targetRoles: ["pharmacist"] }), false);
});

test("cross-branch signup alerts go to pharmacist, billing, IT, and pharmacy assistants", () => {
  const notification = {
    type: "crossBranchSignup",
    targetRoles: ["pharmacist", "billing", "information"],
    targetDepartments: ["pharmacy assistant"],
    employeeName: "Employee Name",
    employeeBranch: "north",
    eventBranch: "south",
    location: "Community Hall",
    date: "2026-10-17"
  };
  for (const headRole of notification.targetRoles) {
    assert.equal(shouldNotify({ headRole }, notification), true);
  }
  assert.equal(shouldNotify({ headRole: "stock" }, notification), false);
  assert.equal(shouldNotify({ staffId: "pa-17", department: "PHARMACY ASSISTANT SOUTH" }, notification), true);
  assert.equal(shouldNotify({ staffId: "billing-17", department: "BILLING SOUTH" }, notification), false);
  assert.equal(notificationText(notification).title, "Cross-branch signup");
  assert.match(notificationText(notification).body, /NORTH signed up in SOUTH at Community Hall/);
});

test("inactive site alerts target only assigned employees", () => {
  const notification = {
    type: "siteInactive",
    targetStaffIds: ["staff-17"],
    targetRoles: ["pharmacist", "billing", "information"],
    location: "North Health Center",
    date: "2026-10-20",
    visibleToEmployees: true
  };
  for (const type of ["siteInactive", "siteReactivated"]) {
    const siteStatusNotification = { ...notification, type };
    assert.equal(shouldNotify({ staffId: "STAFF-17" }, siteStatusNotification), true);
    assert.equal(shouldNotify({ staffId: "staff-18" }, siteStatusNotification), false);
    assert.equal(shouldNotify({ staffId: "staff-17", headRole: "billing" }, siteStatusNotification), false);
    assert.equal(shouldNotify({ headRole: "pharmacist" }, siteStatusNotification), false);
    assert.equal(shouldNotify({ headRole: "billing" }, siteStatusNotification), false);
    assert.equal(shouldNotify({ headRole: "stock" }, siteStatusNotification), false);
  }

  const employeeMessage = notificationText(notification);
  assert.equal(employeeMessage.title, "Your assigned site is inactive");
  assert.match(employeeMessage.body, /Operations will notify you when it becomes active again/);

  const reactivated = notificationText({ ...notification, type: "siteReactivated" });
  assert.equal(reactivated.title, "Your assigned site is active again");
  assert.match(reactivated.body, /assignment is still in place/);
});

test("department notes notify assigned employees with the correct head label", () => {
  const note = {
    id: "note-1",
    type: "pharmacistNote",
    recipientStaffIds: ["staff-17"],
    actorLabel: "IT Head",
    noteText: "Bring the blue forms.",
    location: "Health Center 12",
    cardId: "site-12",
    date: "2026-10-08"
  };
  assert.equal(shouldNotify({ staffId: "STAFF-17" }, note), true);
  assert.equal(shouldNotify({ staffId: "staff-18" }, note), false);
  assert.equal(shouldNotify({ headRole: "billing" }, note), false);
  assert.deepEqual(notificationText(note), {
    title: "Note from IT Head",
    body: "IT Head left a note for Health Center 12: Bring the blue forms."
  });
  assert.deepEqual(notificationText({ ...note, actorLabel: "Billing Head" }), {
    title: "Note from Billing Head",
    body: "Billing Head left a note for Health Center 12: Bring the blue forms."
  });
  const target = new URL(notificationUrl("https://example.test/47fto0gim6", note));
  assert.equal(target.searchParams.get("viewNotes"), "note-1");
  assert.equal(target.searchParams.get("viewSite"), "site-12");
});


test("head push text and links use the subscribed department", () => {
  const notification = {
    type: "eventCreated",
    location: "SM North",
    date: "2026-10-10",
    time: "09:00 AM",
    region: "south",
    missionLabel: "Medical Mission"
  };
  const text = notificationText(notification, { headRole: "billing" });
  assert.equal(text.title, "New site deployed");
  assert.match(text.body, /SM North/);
  assert.match(text.body, /Date: 2026-10-10/);
  assert.match(text.body, /Time: 09:00 AM/);
  assert.match(text.body, /Branch: South Caloocan/);
  assert.match(text.body, /Event type: Medical Mission/);
  assert.equal(new URL(notificationUrl("https://example.test/47fto0gim6", notification, "billing")).pathname, "/jszdttqedv");

  const expiredSite = notificationText({
    type: "siteAutoDeleted",
    location: "BURAT EVENT",
    date: "2026-10-04",
    time: "09:00 AM",
    region: "south",
    missionLabel: "Medical Mission"
  }, { headRole: "pharmacist" });
  assert.equal(expiredSite.title, "Event site deleted");
  assert.match(expiredSite.body, /The event is now deleted: BURAT EVENT/);
  assert.match(expiredSite.body, /Branch: South Caloocan/);
  assert.match(expiredSite.body, /Event type: Medical Mission/);

  const fullSite = {
    type: "siteFilled",
    location: "BURAT EVENT",
    date: "2026-10-10",
    time: "09:00 AM",
    region: "south",
    missionLabel: "Medical Mission",
    filledCount: 4,
    cardId: "full-site"
  };
  const fullText = notificationText(fullSite, { headRole: "pharmacist" });
  assert.equal(fullText.title, "Event site is full");
  assert.match(fullText.body, /BURAT EVENT is full now/);
  assert.match(fullText.body, /4 Event Team slots filled/);
  assert.match(fullText.body, /Date: 2026-10-10/);
  assert.match(fullText.body, /Time: 09:00 AM/);
  assert.match(fullText.body, /Branch: South Caloocan/);
  assert.match(fullText.body, /Event type: Medical Mission/);
  const fullUrl = new URL(notificationUrl("https://example.test/47fto0gim6", fullSite, "pharmacist"));
  assert.equal(fullUrl.pathname, "/tz8lc2ct4y");
  assert.equal(fullUrl.searchParams.get("viewSite"), "full-site");

  const changed = notificationText({
    type: "dateChanged",
    oldDate: "2026-10-10",
    newDate: "2026-10-12",
    date: "2026-10-12",
    time: "10:00 AM",
    location: "SM North",
    region: "south",
    missionLabel: "Medical Mission"
  }, { headRole: "pharmacist" });
  assert.match(changed.body, /Date: 2026-10-10 → 2026-10-12/);
  assert.match(changed.body, /Time: 10:00 AM/);
  assert.match(changed.body, /Branch: South Caloocan/);
  assert.match(changed.body, /Event type: Medical Mission/);

  const branch = notificationText({
    type: "branchChanged",
    oldRegion: "north",
    newRegion: "south",
    region: "south",
    location: "SM North",
    missionLabel: "Medical Mission"
  }, { headRole: "billing" });
  assert.match(branch.body, /Branch: North Caloocan → South Caloocan/);
  assert.match(branch.body, /Event type: Medical Mission/);

  const mission = notificationText({
    type: "missionChanged",
    oldMissionLabel: "Medical Mission",
    newMissionLabel: "People's Day",
    region: "north",
    location: "SM North"
  }, { headRole: "information" });
  assert.match(mission.body, /Event type: Medical Mission → People's Day/);
  assert.match(mission.body, /Branch: North Caloocan/);
});

test("head, employee, and category-specific stock subscriptions coexist", async () => {
  const projectId = "planetdrugstore-peripher-d24c0";
  const keyPair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
  }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  publicJwk.kid = "test-subscription-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const createIdToken = async (email, sub) => {
    const unsigned = `${encode({ alg: "RS256", kid: publicJwk.kid, typ: "JWT" })}.${encode({
      aud: projectId,
      iss: `https://securetoken.google.com/${projectId}`,
      sub,
      email,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600
    })}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(unsigned));
    return `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
  };
  const idToken = await createIdToken("billingdepart@planetdrugstore.ph", "billing-head-uid");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes("service_accounts/v1/jwk/securetoken")) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        headers: { "cache-control": "public, max-age=3600", "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected network request: ${String(url)}`);
  };
  const values = new Map();
  const env = {
    APP_ORIGIN: "https://example.test",
    FIREBASE_PROJECT_ID: projectId,
    PUSH_SUBSCRIPTIONS: {
      async get(key, type) {
        const value = values.get(key);
        return type === "json" && typeof value === "string" ? JSON.parse(value) : value;
      },
      async put(key, value) { values.set(key, value); },
      async delete(key) { values.delete(key); }
    }
  };
  const context = { waitUntil() {} };
  const subscribe = body => worker.fetch(new Request("https://worker.test/subscribe", {
    method: "POST",
    headers: { Origin: env.APP_ORIGIN, authorization: `Bearer ${idToken}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  }), env, context);

  assert.equal((await subscribe({ headRole: "billing", token: "same-browser-token-1234567890" })).status, 200);
  assert.equal((await subscribe({ staffId: "staff-17", department: "PHARMACY ASSISTANT SOUTH", token: "same-browser-token-1234567890" })).status, 200);
  assert.equal(values.size, 2);
  assert.deepEqual([...values.values()].map(value => JSON.parse(value).headRole || "").sort(), ["", "billing"]);
  assert.equal([...values.values()].map(value => JSON.parse(value).department || "").sort()[1], "pharmacy assistant");

  const medicineToken = await createIdToken("adminstockreqmeds@planetdrugstore.ph", "stock-medicine-admin-uid");
  const medicineSubscribe = await worker.fetch(new Request("https://worker.test/subscribe", {
    method: "POST",
    headers: {
      Origin: env.APP_ORIGIN,
      authorization: `Bearer ${medicineToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ headRole: "stock", token: "stock-shared-device-token-1234567890" })
  }), env, context);
  assert.equal(medicineSubscribe.status, 200);
  const medicineSubscriptions = [...values.values()]
    .map(value => JSON.parse(value))
    .filter(value => value.token === "stock-shared-device-token-1234567890");
  assert.deepEqual(medicineSubscriptions.map(value => value.stockType).sort(), ["medicine"]);

  const suppliesToken = await createIdToken("adminstockreqsup@planetdrugstore.ph", "stock-supplies-admin-uid");
  const suppliesSubscribe = await worker.fetch(new Request("https://worker.test/subscribe", {
    method: "POST",
    headers: {
      Origin: env.APP_ORIGIN,
      authorization: `Bearer ${suppliesToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ headRole: "stock", token: "stock-shared-device-token-1234567890" })
  }), env, context);
  assert.equal(suppliesSubscribe.status, 200);
  const stockSubscriptions = [...values.values()]
    .map(value => JSON.parse(value))
    .filter(value => value.token === "stock-shared-device-token-1234567890");
  assert.deepEqual(stockSubscriptions.map(value => value.stockType).sort(), ["medicine", "supplies"]);

  const unsubscribeHead = await worker.fetch(new Request("https://worker.test/subscribe", {
    method: "DELETE",
    headers: { Origin: env.APP_ORIGIN, authorization: `Bearer ${idToken}`, "content-type": "application/json" },
    body: JSON.stringify({ headRole: "billing", token: "same-browser-token-1234567890" })
  }), env, context);
  assert.equal(unsubscribeHead.status, 200);
  assert.equal(values.size, 3);
  assert.equal([...values.values()].map(value => JSON.parse(value).stockType).filter(Boolean).sort().join(","), "medicine,supplies");
  assert.equal([...values.values()].map(value => JSON.parse(value).staffId).includes("staff-17"), true);
  globalThis.fetch = originalFetch;
});

test("registered pharmacist admin profiles authorize push only for their active email", () => {
  const profile = { active: true, email: "jv.manes@planetdrugstore.ph", role: "pharmacist" };
  assert.equal(registeredPharmacistAdminRole(profile, "JV.MANES@planetdrugstore.ph"), "pharmacist");
  assert.equal(registeredPharmacistAdminRole({ ...profile, active: false }, profile.email), "");
  assert.equal(registeredPharmacistAdminRole({ ...profile, role: "billing" }, profile.email), "");
  assert.equal(registeredPharmacistAdminRole(profile, "someone.else@planetdrugstore.ph"), "");
});

test("reminder actions persist snooze and dismissal for one recipient", async () => {
  const reminderKey = "r".repeat(43);
  const actionToken = "one-use-reminder-token";
  const reminderNotification = { id: "alarm-1", type: "eventReminder", cardId: "site-a" };
  const values = new Map([
    [`event-reminder-action:${reminderKey}`, JSON.stringify({ actionToken, staffId: "staff-17", sequence: 0, notification: reminderNotification })]
  ]);
  const env = {
    APP_ORIGIN: "https://example.test",
    PUSH_SUBSCRIPTIONS: {
      async get(key, type) {
        const value = values.get(key);
        return type === "json" && typeof value === "string" ? JSON.parse(value) : value;
      },
      async put(key, value) { values.set(key, value); },
      async delete(key) { values.delete(key); }
    }
  };
  const postAction = action => worker.fetch(new Request("https://worker.test/reminder-action", {
    method: "POST",
    headers: { Origin: env.APP_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ reminderKey, actionToken, action })
  }), env, { waitUntil() {} });

  assert.equal((await postAction("snooze")).status, 200);
  const snoozed = JSON.parse(values.get(`scheduled:event-reminder-snoozed:${reminderKey}`));
  assert.equal(snoozed.actionContext.staffId, "staff-17");
  assert.equal(snoozed.sequence, 1);
  assert.ok(snoozed.dueAt > Date.now());
  assert.equal(values.has(`event-reminder-action:${reminderKey}`), false);

  const dismissKey = "d".repeat(43);
  values.set(`event-reminder-action:${dismissKey}`, JSON.stringify({ actionToken, staffId: "staff-17", sequence: 0, notification: reminderNotification }));
  const response = await worker.fetch(new Request("https://worker.test/reminder-action", {
    method: "POST",
    headers: { Origin: env.APP_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ reminderKey: dismissKey, actionToken, action: "dismiss" })
  }), env, { waitUntil() {} });
  assert.equal(response.status, 200);
  assert.equal(values.has(`scheduled:event-reminder-snoozed:${dismissKey}`), false);
  assert.equal(values.has(`event-reminder-action:${dismissKey}`), false);
});

test("deployed schedule broadcasts skip assigned employees and hidden notices", () => {
  const subscription = { staffId: "staff-17" };
  assert.equal(shouldNotify(subscription, { type: "eventsDeployed", assignedStaffIds: [] }), true);
  assert.equal(shouldNotify(subscription, { type: "eventsDeployed", assignedStaffIds: ["STAFF-17"] }), false);
  assert.equal(shouldNotify(subscription, { type: "eventsDeployed", visibleToEmployees: false }), false);
});

test("newly deployed site broadcasts include the full site summary", () => {
  const text = notificationText({
    type: "eventsDeployed",
    siteCount: 1,
    siteSummary: "Site: MMMM • Date: 2026-10-10 • Time: 09:00 AM • Branch: South Caloocan • Event type: Medical Mission"
  });
  assert.equal(text.title, "New site deployed");
  assert.match(text.body, /MMMM/);
  assert.match(text.body, /2026-10-10/);
  assert.match(text.body, /09:00 AM/);
  assert.match(text.body, /South Caloocan/);
  assert.match(text.body, /Medical Mission/);
});

test("slot assignment push messages mention the actual employee assignment", () => {
  const text = notificationText({ type: "slotAssigned", location: "SM North", list: "staff", date: "2026-10-10", time: "09:00 AM", assignedBy: "IT Head" });
  assert.match(text.title, /assigned/i);
  assert.match(text.body, /SM North|assigned/i);
  assert.match(text.body, /IT Head/);

  const legacyText = notificationText({ type: "slotAssigned", location: "SM North", list: "staff" });
  assert.match(legacyText.body, /your department head/i);
});

test("new open-slot push messages invite eligible employees with event context", () => {
  const subscription = { staffId: "staff-17" };
  const notification = {
    type: "slotOpened",
    staffId: "STAFF-17",
    role: "PHARMACIST",
    location: "MMMM",
    date: "2026-10-10",
    time: "09:00 AM",
    region: "south",
    missionLabel: "Medical Mission"
  };
  assert.equal(shouldNotify(subscription, notification), true);
  const text = notificationText(notification);
  assert.match(text.title, /slot available/i);
  assert.match(text.body, /PHARMACIST/);
  assert.match(text.body, /MMMM/);
  assert.match(text.body, /Sign up now/);
  assert.match(text.body, /Branch: South Caloocan/);
  assert.match(text.body, /Event type: Medical Mission/);

  const relieverText = notificationText({
    ...notification,
    list: "relievers",
    role: "PHARMACY ASSISTANT",
    relieverTime: "08:00"
  });
  assert.match(relieverText.title, /Store Reliever/i);
  assert.match(relieverText.body, /slot: MMMM/);
  assert.match(relieverText.body, /8:00 AM onwards/);
  assert.doesNotMatch(relieverText.body, /09:00 AM|Branch:|Event type:/);
});

test("removal and move push messages describe the action", () => {
  const removed = notificationText({ type: "removed" });
  assert.match(removed.title, /removed/i);
  assert.match(removed.body, /choose another slot/i);

  const reset = notificationText({
    type: "removed",
    scheduleReset: true,
    list: "relievers",
    location: "SM North"
  });
  assert.equal(reset.title, "Event schedule reset");
  assert.match(reset.body, /Operations reset the event schedule/i);
  assert.match(reset.body, /SM North/);
  assert.doesNotMatch(reset.body, /removed from|removed as/i);

  assert.deepEqual(notificationText({
    type: "removed",
    location: "122123",
    replacedByName: "JV Manes",
    role: "IT SPECIALIST",
    date: "2026-10-07",
    time: "7:00PM - ONWARDS"
  }), {
    title: "You were removed from the event slot",
    body: "JV Manes replaced you at 122123."
  });

  const attributedRemoval = notificationText({
    type: "removed",
    location: "SM North",
    actorLabel: "IT Head"
  });
  assert.match(attributedRemoval.body, /Action by: IT Head/);

  const attributedCancellation = notificationText({
    type: "eventCancelled",
    actorLabel: "Billing Head"
  });
  assert.match(attributedCancellation.body, /Reason: Not provided\./);
  assert.doesNotMatch(attributedCancellation.body, /Action by: Billing Head/);

  const relieverRemoved = notificationText({ type: "removed", list: "relievers", location: "MMMM" });
  assert.match(relieverRemoved.title, /removed as Store Reliever/i);
  assert.match(relieverRemoved.body, /reliever for MMMM/i);

  const moved = notificationText({ type: "siteMoved", cardId: "new-card", oldCardId: "old-card", location: "SM North", date: "2026-10-10" });
  assert.match(moved.title, /another event bracket/i);
  assert.match(moved.body, /SM North/);
  assert.doesNotMatch(moved.body, /schedule has changed/i);

  const movedReliever = notificationText({
    type: "siteMoved",
    cardId: "new-card",
    oldCardId: "old-card",
    list: "relievers",
    location: "TANGINANG HEALTH CENTER",
    date: "2026-10-07",
    time: "11:23AM - ONWARDS",
    relieverTime: "08:00",
    region: "north",
    missionLabel: "People's Day"
  });
  assert.equal(movedReliever.body, "You're now covering TANGINANG HEALTH CENTER on 2026-10-07 from 8:00 AM onwards.");
  assert.doesNotMatch(movedReliever.body, /11:23AM|Branch:|People's Day/);
});

test("schedule change messages identify the changed field and old/new values", () => {
  const date = notificationText({
    type: "dateChanged",
    oldDate: "2026-10-10",
    newDate: "2026-10-12",
    timeChanged: true,
    time: "10:00 AM",
    locationChanged: true,
    location: "SM North"
  });
  assert.match(date.title, /date changed/i);
  assert.match(date.body, /2026-10-10 to 2026-10-12/);
  assert.match(date.body, /time is now 10:00 AM/);
  assert.match(date.body, /site name is now SM North/);

  const site = notificationText({ type: "eventUpdated", locationChanged: true, location: "SM North" });
  assert.match(site.title, /site name changed/i);
  assert.match(site.body, /SM North/);

  const branch = notificationText({ type: "branchChanged", oldRegion: "north", newRegion: "south" });
  assert.match(branch.body, /from north to south/i);

  const eventType = notificationText({ type: "missionChanged", oldMissionLabel: "Medical Mission", newMissionLabel: "People's Day" });
  assert.match(eventType.body, /Medical Mission to People's Day/);

  const cancelled = notificationText({
    type: "eventCancelled",
    location: "SM North",
    missionLabel: "Medical Mission",
    date: "2026-11-20",
    time: "10:00 AM",
    cancelReason: "Severe weather"
  });
  assert.match(cancelled.title, /cancelled/i);
  assert.match(cancelled.body, /Event: Medical Mission/);
  assert.match(cancelled.body, /SM North/);
  assert.match(cancelled.body, /November 20, 2026/);
  assert.match(cancelled.body, /Reason: Severe weather/);
  assert.doesNotMatch(cancelled.body, /10:00 AM/);

  const deleted = notificationText({ type: "eventDeleted", location: "SM North" });
  assert.match(deleted.title, /deleted/i);
  assert.match(deleted.body, /SM North/);
});

test("personal notification messages include branch and event type context", () => {
  const text = notificationText({
    type: "slotAssigned",
    location: "MMMM",
    region: "south",
    missionLabel: "Medical Mission"
  });
  assert.match(text.body, /Branch: South Caloocan/);
  assert.match(text.body, /Event type: Medical Mission/);

  const custom = notificationText({
    type: "eventDeleted",
    location: "MMMM",
    region: "other",
    regionCustom: "Warehouse District",
    missionLabel: "People's Day"
  });
  assert.match(custom.body, /Branch: Warehouse District/);
  assert.match(custom.body, /Event type: People's Day/);
});

test("push View site links target the assigned bracket and region", () => {
  const target = new URL(notificationUrl("https://example.test/47fto0gim6", {
    cardId: "card-17",
    date: "2026-10-10",
    region: "south"
  }));
  assert.equal(target.pathname, "/47fto0gim6");
  assert.equal(target.searchParams.get("viewSite"), "card-17");
  assert.equal(target.searchParams.get("date"), "2026-10-10");
  assert.equal(target.searchParams.get("region"), "south");
});

test("branch-change push links use the destination branch", () => {
  const target = new URL(notificationUrl("https://example.test/47fto0gim6", {
    type: "branchChanged",
    cardId: "card-17",
    date: "2026-10-10",
    oldRegion: "north",
    newRegion: "south"
  }));
  assert.equal(target.searchParams.get("region"), "south");
});

test("unsupported notification types are ignored", () => {
  assert.equal(shouldNotify({ staffId: "staff-17" }, { type: "unknown", staffId: "staff-17" }), false);
});

test("subscription CORS accepts the vanity site and legacy Firebase domains only", async () => {
  const env = {
    APP_ORIGIN: "https://planetdrugstoreconsole.web.app",
    FIREBASE_PROJECT_ID: "planetdrugstore-peripher-d24c0"
  };
  for (const origin of [
    "https://planetdrugstoreconsole.web.app",
    "https://planetdrugstore-peripher-d24c0.web.app",
    "https://planetdrugstore-peripher-d24c0.firebaseapp.com"
  ]) {
    const response = await worker.fetch(new Request("https://worker.test/subscribe", {
      method: "OPTIONS",
      headers: { Origin: origin }
    }), env, {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
  }

  const dispatchPreflight = await worker.fetch(new Request("https://worker.test/dispatch", {
    method: "OPTIONS",
    headers: { Origin: env.APP_ORIGIN, "access-control-request-headers": "authorization,content-type" }
  }), env, {});
  assert.equal(dispatchPreflight.status, 200);
  assert.match(dispatchPreflight.headers.get("access-control-allow-headers"), /authorization/i);

  const blocked = await worker.fetch(new Request("https://worker.test/subscribe", {
    method: "OPTIONS",
    headers: { Origin: "https://untrusted.example" }
  }), env, {});
  assert.equal(blocked.status, 403);

  const reverseAlias = await worker.fetch(new Request("https://worker.test/subscribe", {
    method: "OPTIONS",
    headers: { Origin: "https://planetdrugstore-peripher-d24c0.web.app" }
  }), {
    APP_ORIGIN: "https://planetdrugstore-peripher-d24c0.firebaseapp.com",
    FIREBASE_PROJECT_ID: "planetdrugstore-peripher-d24c0"
  }, {});
  assert.equal(reverseAlias.status, 200);
  assert.equal(reverseAlias.headers.get("access-control-allow-origin"), "https://planetdrugstore-peripher-d24c0.web.app");
});

test("scan cursor is written only when it advances after complete delivery", () => {
  assert.equal(shouldSaveScanCursor("2026-10-04T00:00:00Z", "2026-10-04T00:00:00Z", true), false);
  assert.equal(shouldSaveScanCursor("2026-10-04T00:00:00Z", "2026-10-04T00:01:00Z", true), true);
  assert.equal(shouldSaveScanCursor("2026-10-04T00:00:00Z", "2026-10-04T00:01:00Z", false), false);
});

test("repeating the same device subscription does not write KV twice", async () => {
  const values = new Map();
  let writes = 0;
  const kv = {
    async get(key, type) {
      const value = values.get(key);
      return type === "json" && value ? JSON.parse(value) : value || null;
    },
    async put(key, value) {
      writes++;
      values.set(key, value);
    },
    async delete(key) { values.delete(key); }
  };
  const env = {
    APP_ORIGIN: "https://planetdrugstore-peripher-d24c0.web.app",
    PUSH_SUBSCRIPTIONS: kv
  };
  const createRequest = () => new Request("https://worker.test/subscribe", {
    method: "POST",
    headers: {
      Origin: env.APP_ORIGIN,
      "content-type": "application/json"
    },
    body: JSON.stringify({ staffId: "staff-17", token: "device-token-long-enough" })
  });

  assert.equal((await worker.fetch(createRequest(), env, {})).status, 200);
  assert.equal((await worker.fetch(createRequest(), env, {})).status, 200);
  assert.equal(writes, 1);
});

test("event alarm copy includes schedule details", () => {
  const reminder = notificationText({
    type: "eventReminder",
    location: "SM North",
    date: "2026-10-04",
    time: "09:00 AM",
    role: "PICKER",
    region: "south",
    missionLabel: "Medical Mission"
  });
  assert.equal(reminder.title, "Event alarm from Pharmacy");
  assert.match(reminder.body, /SM North/);
  assert.match(reminder.body, /on 2026-10-04/);
  assert.match(reminder.body, /09:00 AM/);
  assert.match(reminder.body, /Branch: South Caloocan/);
  assert.match(reminder.body, /Event type: Medical Mission/);
});

test("Store Reliever reminders show only their center, date, and onwards time", () => {
  const reminder = notificationText({
    type: "eventReminder",
    location: "Pharmacy event site",
    date: "2026-10-06",
    time: "7:55 PM",
    region: "south",
    missionLabel: "Medical Mission",
    recipientAssignment: { list: "relievers", location: "Center 09099", relieverTime: "20:00" }
  });
  assert.equal(reminder.title, "Store reliever reminder");
  assert.equal(reminder.body, "You are relieving Center 09099 on 2026-10-06 from 8:00 PM onwards.");
  assert.doesNotMatch(reminder.body, /Pharmacy event site|7:55 PM|South Caloocan|Medical Mission/);

  const unnamedCenterReminder = notificationText({
    type: "eventReminder",
    location: "Pharmacy event site",
    recipientAssignment: { list: "relievers", relieverTime: "08:00" }
  });
  assert.doesNotMatch(unnamedCenterReminder.body, /Pharmacy event site/);
  assert.match(unnamedCenterReminder.body, /your assigned health center/);
});

test("authenticated head dispatch sends directly through FCM without a Firestore query", async () => {
  const projectId = "planetdrugstore-peripher-d24c0";
  const clientEmail = "pharmacistdepart@planetdrugstore.ph";
  const keyPair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
  }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  publicJwk.kid = "test-firebase-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  const privateKeyBytes = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const privateKeyBase64 = Buffer.from(privateKeyBytes).toString("base64").match(/.{1,64}/g).join("\n");
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${privateKeyBase64}\n-----END PRIVATE KEY-----`;
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", kid: publicJwk.kid, typ: "JWT" })}.${encode({
    aud: projectId,
    iss: `https://securetoken.google.com/${projectId}`,
    sub: "head-auth-user",
    email: clientEmail,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600
  })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(unsigned));
  const idToken = `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
  const deviceToken = "fcm-test-device-token-1234567890";
  const kvValues = new Map([[
    "sub:test-device",
    JSON.stringify({ staffId: "staff-17", token: deviceToken })
  ]]);
  const kv = {
    async get(key, type) {
      const value = kvValues.get(key);
      return type === "json" && value ? JSON.parse(value) : value || null;
    },
    async put(key, value) { kvValues.set(key, value); },
    async delete(key) { kvValues.delete(key); },
    async list({ prefix }) {
      return {
        keys: [...kvValues.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })),
        list_complete: true
      };
    }
  };
  const messages = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("service_accounts/v1/jwk/securetoken")) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        headers: { "cache-control": "public, max-age=3600", "content-type": "application/json" }
      });
    }
    if (target === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: "test-access-token", expires_in: 3600 }), {
        headers: { "content-type": "application/json" }
      });
    }
    if (target.includes("fcm.googleapis.com/v1/projects/")) {
      messages.push(JSON.parse(options.body).message);
      return new Response(JSON.stringify({ name: "projects/test/messages/1" }), {
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected network request: ${target}`);
  };

  try {
    const env = {
      APP_ORIGIN: "https://planetdrugstoreconsole.web.app",
      APP_URL: "https://planetdrugstoreconsole.web.app/47fto0gim6",
      FIREBASE_PROJECT_ID: projectId,
      FIREBASE_CLIENT_EMAIL: clientEmail,
      FIREBASE_PRIVATE_KEY: privateKeyPem,
      PUSH_SUBSCRIPTIONS: kv
    };
    const pending = [];
    const response = await worker.fetch(new Request("https://worker.test/dispatch", {
      method: "POST",
      headers: {
        Origin: env.APP_ORIGIN,
        Authorization: `Bearer ${idToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ notifications: [{
        id: "push-test-1",
        type: "slotAssigned",
        staffId: "staff-17",
        location: "Test site",
        date: "2026-10-07"
      }, {
        id: "push-reset-test",
        type: "removed",
        scheduleReset: true,
        staffId: "staff-17",
        location: "SM North"
      }] })
    }), env, { waitUntil(promise) { pending.push(promise); } });

    assert.equal(response.status, 202);
    await Promise.all(pending);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].token, deviceToken);
    assert.equal(messages[0].data.notificationType, "slotAssigned");
    assert.equal(messages[0].data.scheduleReset, "0");
    assert.equal(messages[1].data.notificationType, "removed");
    assert.equal(messages[1].data.scheduleReset, "1");
    assert.equal(messages[1].data.scheduleLocation, "SM North");
    assert.equal(messages[1].data.title, "Event schedule reset");
    assert.match(messages[1].data.body, /Operations reset the event schedule/);
    assert.equal(kvValues.get("sent:push-test-1"), "1");
    assert.equal(kvValues.get("sent:push-reset-test"), "1");

    const stockUnsigned = `${encode({ alg: "RS256", kid: publicJwk.kid, typ: "JWT" })}.${encode({
      aud: projectId,
      iss: `https://securetoken.google.com/${projectId}`,
      sub: "stock-admin-auth-user",
      email: "adminstockreqmeds@planetdrugstore.ph",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600
    })}`;
    const stockSignature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(stockUnsigned));
    const stockIdToken = `${stockUnsigned}.${Buffer.from(stockSignature).toString("base64url")}`;
    const stockPending = [];
    const stockResponse = await worker.fetch(new Request("https://worker.test/dispatch", {
      method: "POST",
      headers: {
        Origin: env.APP_ORIGIN,
        Authorization: `Bearer ${stockIdToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ notifications: [{
        id: "stock-day-test-1",
        type: "stockDayActivated",
        requestType: "medicine",
        day: "WEDNESDAY",
        date: "2026-10-14",
        cutoffMin: 840,
        targetStaffIds: ["staff-17"]
      }] })
    }), env, { waitUntil(promise) { stockPending.push(promise); } });
    assert.equal(stockResponse.status, 202);
    const cutoffTask = JSON.parse(kvValues.get("scheduled:stock-cutoff:medicine:2026-10-14"));
    assert.equal(cutoffTask.cutoffMin, 840);
    assert.deepEqual(cutoffTask.targetStaffIds, ["staff-17"]);
    await Promise.all(stockPending);
    assert.equal(messages.length, 3);
    assert.equal(messages[2].data.notificationType, "stockDayActivated");
    assert.match(messages[2].data.body, /WEDNESDAY/);
    assert.equal(new URL(messages[2].data.url).searchParams.get("day"), "WEDNESDAY");

    const deniedStock = await worker.fetch(new Request("https://worker.test/dispatch", {
      method: "POST",
      headers: {
        Origin: env.APP_ORIGIN,
        Authorization: `Bearer ${idToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ notifications: [{
        id: "stock-day-forbidden",
        type: "stockDayActivated",
        day: "WEDNESDAY",
        targetStaffIds: ["staff-17"]
      }] })
    }), env, {});
    assert.equal(deniedStock.status, 403);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("direct dispatch rejects requests without a Firebase ID token", async () => {
  const response = await worker.fetch(new Request("https://worker.test/dispatch", {
    method: "POST",
    headers: {
      Origin: "https://planetdrugstoreconsole.web.app",
      "content-type": "application/json"
    },
    body: JSON.stringify({ notifications: [{ id: "push-test", type: "slotAssigned" }] })
  }), {
    APP_ORIGIN: "https://planetdrugstoreconsole.web.app",
    FIREBASE_PROJECT_ID: "planetdrugstore-peripher-d24c0"
  }, {});
  assert.equal(response.status, 401);
});

test("native head sign-in handoffs are verified, one-use, and preserve the Firebase UID", async () => {
  const projectId = "planetdrugstore-peripher-d24c0";
  const keyPair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
  }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  publicJwk.kid = "test-handoff-firebase-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  const privateKeyBytes = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const privateKeyBase64 = Buffer.from(privateKeyBytes).toString("base64").match(/.{1,64}/g).join("\n");
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${privateKeyBase64}\n-----END PRIVATE KEY-----`;
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const makeIdToken = (email, sub = "firebase-head-uid", customClaims = {}) => {
    const unsigned = `${encode({ alg: "RS256", kid: publicJwk.kid, typ: "JWT" })}.${encode({
      aud: projectId,
      iss: `https://securetoken.google.com/${projectId}`,
      sub,
      email,
      ...customClaims,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600
    })}`;
    return crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(unsigned))
      .then(signature => `${unsigned}.${Buffer.from(signature).toString("base64url")}`);
  };
  const values = new Map();
  const kv = {
    async get(key) { return values.get(key) || null; },
    async put(key, value, options) {
      values.set(key, value);
      assert.equal(options.expirationTtl, 60);
    },
    async delete(key) { values.delete(key); }
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes("service_accounts/v1/jwk/securetoken")) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        headers: { "cache-control": "public, max-age=3600", "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected network request: ${String(url)}`);
  };

  try {
    const env = {
      APP_ORIGIN: "https://planetdrugstoreconsole.web.app",
      FIREBASE_PROJECT_ID: projectId,
      FIREBASE_CLIENT_EMAIL: "service@example.iam.gserviceaccount.com",
      FIREBASE_PRIVATE_KEY: privateKeyPem,
      PUSH_SUBSCRIPTIONS: kv
    };
    const createResponse = await worker.fetch(new Request("https://worker.test/auth-handoff", {
      method: "POST",
      headers: {
        Origin: env.APP_ORIGIN,
        Authorization: `Bearer ${await makeIdToken("pharmacistdepart@planetdrugstore.ph")}`,
        "content-type": "application/json"
      },
      body: "{}"
    }), env, {});
    assert.equal(createResponse.status, 200);
    const { handoffCode } = await createResponse.json();
    assert.match(handoffCode, /^[A-Fa-f0-9]{32}$/);

    const exchangeRequest = () => new Request("https://worker.test/auth-handoff/exchange", {
      method: "POST",
      headers: { Origin: env.APP_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ handoffCode })
    });
    const exchangeResponse = await worker.fetch(exchangeRequest(), env, {});
    assert.equal(exchangeResponse.status, 200);
    const { customToken } = await exchangeResponse.json();
    const [header, payload, signature] = customToken.split(".");
    assert.equal(JSON.parse(Buffer.from(header, "base64url").toString()).alg, "RS256");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    assert.equal(claims.uid, "firebase-head-uid");
    assert.equal(claims.aud, "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit");
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    assert.equal(await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      Buffer.from(signature, "base64url"),
      new TextEncoder().encode(`${header}.${payload}`)
    ), true);
    assert.equal((await worker.fetch(exchangeRequest(), env, {})).status, 410);

    const wrongRoleToken = await makeIdToken("pharmacistdepart@planetdrugstore.ph");
    const wrongRoleResponse = await worker.fetch(new Request("https://worker.test/auth-handoff", {
      method: "POST",
      headers: {
        Origin: env.APP_ORIGIN,
        authorization: `Bearer ${wrongRoleToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ headRole: "billing" })
    }), env, {});
    assert.equal(wrongRoleResponse.status, 403);

    const employeeStaffId = "employee-17";
    const employeeHash = Buffer.from(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(employeeStaffId)
    )).toString("hex");
    const employeeToken = await makeIdToken("", `employee-${employeeHash.slice(0, 40)}`, {
      employee: true,
      staffId: employeeStaffId,
      employeeDepartment: "pharmacy assistant"
    });
    const validEmployeeHandoff = await worker.fetch(new Request("https://worker.test/auth-handoff", {
      method: "POST",
      headers: {
        Origin: env.APP_ORIGIN,
        authorization: `Bearer ${employeeToken}`,
        "content-type": "application/json"
      },
      body: "{}"
    }), env, {});
    assert.equal(validEmployeeHandoff.status, 200);
    const employeeCode = (await validEmployeeHandoff.json()).handoffCode;
    const employeeExchange = await worker.fetch(new Request("https://worker.test/auth-handoff/exchange", {
      method: "POST",
      headers: { Origin: env.APP_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ handoffCode: employeeCode })
    }), env, {});
    assert.equal(employeeExchange.status, 200);
    const employeeCustomToken = JSON.parse(await employeeExchange.text()).customToken;
    const employeePayload = JSON.parse(Buffer.from(employeeCustomToken.split(".")[1], "base64url").toString());
    assert.equal(employeePayload.uid, `employee-${employeeHash.slice(0, 40)}`);
    assert.deepEqual(employeePayload.claims, {
      employee: true,
      staffId: employeeStaffId,
      employeeDepartment: "pharmacy assistant"
    });
    const wrongEmployeePairing = await worker.fetch(new Request("https://worker.test/auth-handoff", {
      method: "POST",
      headers: {
        Origin: env.APP_ORIGIN,
        authorization: `Bearer ${employeeToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ staffId: "different-employee" })
    }), env, {});
    assert.equal(wrongEmployeePairing.status, 403);
    const forgedEmployeeToken = await makeIdToken("attacker@staff.planetdrugstore.local", "unrelated-uid", {
      employee: true,
      staffId: employeeStaffId
    });
    const forgedEmployeeHandoff = await worker.fetch(new Request("https://worker.test/auth-handoff", {
      method: "POST",
      headers: {
        Origin: env.APP_ORIGIN,
        authorization: `Bearer ${forgedEmployeeToken}`,
        "content-type": "application/json"
      },
      body: "{}"
    }), env, {});
    assert.equal(forgedEmployeeHandoff.status, 403);

    const employeeResponse = await worker.fetch(new Request("https://worker.test/auth-handoff", {
      method: "POST",
      headers: {
        Origin: env.APP_ORIGIN,
        Authorization: `Bearer ${await makeIdToken("employee@staff.planetdrugstore.local")}`,
        "content-type": "application/json"
      },
      body: "{}"
    }), env, {});
    assert.equal(employeeResponse.status, 403);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("employee site-filled wake directly delivers the persisted alert to pharmacists", async () => {
  const projectId = "planetdrugstore-peripher-d24c0";
  const keyPair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
  }, true, ["sign", "verify"]);
  const privateKeyBytes = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const privateKeyBase64 = Buffer.from(privateKeyBytes).toString("base64").match(/.{1,64}/g).join("\n");
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${privateKeyBase64}\n-----END PRIVATE KEY-----`;
  const notificationId = "employee-site-filled-test";
  const kvValues = new Map([
    ["sub:pharmacist", JSON.stringify({ headRole: "pharmacist", token: "pharmacist-device-token" })],
    ["sub:billing", JSON.stringify({ headRole: "billing", token: "billing-device-token" })]
  ]);
  const kv = {
    async get(key, type) {
      const value = kvValues.get(key);
      return type === "json" && value ? JSON.parse(value) : value || null;
    },
    async put(key, value) { kvValues.set(key, value); },
    async delete(key) { kvValues.delete(key); },
    async list({ prefix }) {
      return {
        keys: [...kvValues.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })),
        list_complete: true
      };
    }
  };
  const sentMessages = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes(`/documents/emergencyNotifications/${notificationId}`)) {
      assert.equal(new URL(target).searchParams.get("key"), "test-firebase-api-key");
      assert.equal(options.headers, undefined);
      return new Response(JSON.stringify({
        name: `projects/${projectId}/databases/(default)/documents/emergencyNotifications/${notificationId}`,
        fields: {
          type: { stringValue: "siteFilled" },
          targetRoles: { arrayValue: { values: [{ stringValue: "pharmacist" }] } },
          cardId: { stringValue: "site-1" },
          location: { stringValue: "Test event site" },
          date: { stringValue: "2026-10-12" },
          createdAt: { timestampValue: new Date().toISOString() }
        }
      }), { headers: { "content-type": "application/json" } });
    }
    if (target.includes("fcm.googleapis.com/v1/projects/")) {
      sentMessages.push(JSON.parse(options.body).message);
      return new Response(JSON.stringify({ name: "projects/test/messages/site-filled" }), {
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected network request: ${target}`);
  };

  try {
    const env = {
      APP_ORIGIN: "https://planetdrugstoreconsole.web.app",
      APP_URL: "https://planetdrugstoreconsole.web.app/47fto0gim6",
      FIREBASE_PROJECT_ID: projectId,
      FIREBASE_API_KEY: "test-firebase-api-key",
      FIREBASE_CLIENT_EMAIL: "service@example.iam.gserviceaccount.com",
      FIREBASE_PRIVATE_KEY: privateKeyPem,
      PUSH_SUBSCRIPTIONS: kv
    };
    const pending = [];
    const response = await worker.fetch(new Request("https://worker.test/wake", {
      method: "POST",
      headers: {
        Origin: env.APP_ORIGIN,
        "content-type": "application/json"
      },
      body: JSON.stringify({ notificationId })
    }), env, { waitUntil(promise) { pending.push(promise); } });

    assert.equal(response.status, 202);
    await Promise.all(pending);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].token, "pharmacist-device-token");
    assert.equal(sentMessages[0].data.notificationType, "siteFilled");
    assert.match(sentMessages[0].data.title, /Event site is full/);
    assert.equal(kvValues.get(`sent:${notificationId}`), "1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker does not run a periodic KV polling handler while idle", () => {
  assert.equal(worker.scheduled, undefined);
});

test("stock cutoff alarm alerts the employee and Stock Request admin", async () => {
  const dueAt = Date.now() - 1000;
  const values = new Map([
    ["scheduled:stock-cutoff:medicine:2026-10-14", JSON.stringify({
      jobType: "stockCutoff",
      requestType: "medicine",
      id: "stock-day-closed:2026-10-14",
      date: "2026-10-14",
      day: "WEDNESDAY",
      cutoffMin: 840,
      targetStaffIds: ["260616"],
      dueAt
    })]
  ]);
  const kv = {
    async get(key, type) {
      const value = values.get(key);
      return type === "json" && value ? JSON.parse(value) : value || null;
    },
    async put(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async list({ prefix }) {
      return {
        keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })),
        list_complete: true
      };
    }
  };
  const env = {
    APP_URL: "https://planetdrugstoreconsole.web.app/47fto0gim6",
    FIREBASE_PROJECT_ID: "planetdrugstore-peripher-d24c0",
    FIREBASE_CLIENT_EMAIL: "service@example.iam.gserviceaccount.com",
    FIREBASE_PRIVATE_KEY: "unused-when-token-is-cached",
    PUSH_SUBSCRIPTIONS: kv
  };
  const alarmScheduler = createScheduledJobs(env);
  await alarmScheduler.instance.fetch(new Request("https://scheduler.test/task", {
    method: "POST",
    body: JSON.stringify({
      operation: "upsert",
      name: "scheduled:stock-cutoff:medicine:2026-10-14",
      task: JSON.parse(values.get("scheduled:stock-cutoff:medicine:2026-10-14"))
    })
  }));
  const sentMessages = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: "cutoff-test-access-token", expires_in: 3600 }), {
        headers: { "content-type": "application/json" }
      });
    }
    if (target.includes("fcm.googleapis.com/v1/projects/")) {
      sentMessages.push(JSON.parse(options.body).message);
      return new Response(JSON.stringify({ name: "projects/test/messages/cutoff" }), {
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected network request: ${target}`);
  };

  try {
    const runScheduled = () => alarmScheduler.runNow();
    await runScheduled();

    assert.equal(sentMessages.length, 0);
    assert.equal(values.has("scheduled:stock-cutoff:medicine:2026-10-14"), true);
    assert.equal([...values.keys()].some(key => key.startsWith("stock-cutoff-logged:")), false);

    values.set("sub:employee", JSON.stringify({ staffId: "260616", token: "employee-device-token-260616" }));
    values.set("sub:stock-admin", JSON.stringify({ headRole: "stock", stockType: "medicine", token: "stock-admin-device-token" }));
    values.set("sub:pharmacist", JSON.stringify({ headRole: "pharmacist", token: "pharmacist-device-token" }));
    await runScheduled();

    assert.deepEqual(sentMessages.map(message => message.token).sort(), [
      "employee-device-token-260616",
      "stock-admin-device-token"
    ]);
    assert.equal(sentMessages.every(message => message.data.notificationType === "stockDayClosed"), true);
    assert.equal(sentMessages.every(message =>
      message.data.body.includes("Request type: Medicine") &&
      message.data.body.includes("Date: October 14, 2026") &&
      message.data.body.includes("Day: WEDNESDAY") &&
      message.data.body.includes("Status: Closed")
    ), true);
    assert.equal(values.has("scheduled:stock-cutoff:medicine:2026-10-14"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("employee sign-in verifies credentials and issues a Firebase custom token with employee identity", async () => {
  const projectId = "planetdrugstore-peripher-d24c0";
  const clientEmail = "firebase-admin@example.iam.gserviceaccount.com";
  const keyPair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
  }, true, ["sign", "verify"]);
  const privateKeyBytes = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const privateKeyBase64 = Buffer.from(privateKeyBytes).toString("base64").match(/.{1,64}/g).join("\n");
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${privateKeyBase64}\n-----END PRIVATE KEY-----`;
  const passwordHash = Buffer.from(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("test-password")
  )).toString("hex");
  const pbkdf2Salt = new TextEncoder().encode("test-salt-123456");
  const pbkdf2Key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("stored-password"),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const pbkdf2Bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: pbkdf2Salt, iterations: 100000, hash: "SHA-256" },
    pbkdf2Key,
    256
  );
  const storedPasswordHash = [
    "pbkdf2-sha256",
    "100000",
    Buffer.from(pbkdf2Salt).toString("base64url"),
    Buffer.from(pbkdf2Bits).toString("hex")
  ].join("$");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: "test-access-token", expires_in: 3600 }));
    }
    if (target.includes(`/documents/employeeCredentials/bill-18`)) {
      return new Response(JSON.stringify({
        fields: { passwordHash: { stringValue: storedPasswordHash } }
      }));
    }
    if (target.includes(`/documents/employeeCredentials/bill-17`)) {
      if (options.method === "PATCH") return new Response(JSON.stringify({ fields: {} }));
      return new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
    }
    if (target.includes(`/documents/employees/bill-18`)) {
      assert.match(options.headers.authorization, /^Bearer .+/);
      return new Response(JSON.stringify({
        fields: {
          staffId: { stringValue: "BILL-18" },
          name: { stringValue: "Existing PBKDF2 Employee" }
        }
      }));
    }
    if (target.includes(`/documents/employees/bill-17`)) {
      assert.match(options.headers.authorization, /^Bearer .+/);
      if (options.method === "PATCH") return new Response(JSON.stringify({ fields: {} }));
      return new Response(JSON.stringify({
        fields: {
          staffId: { stringValue: "BILL-17" },
          passwordHash: { stringValue: passwordHash },
          name: { stringValue: "Billing Employee" },
          email: { stringValue: "billing.employee@example.com" },
          department: { stringValue: "Billing South" },
          branch: { stringValue: "South" }
        }
      }));
    }
    throw new Error(`Unexpected network request: ${target}`);
  };

  try {
    const env = {
      APP_ORIGIN: "https://planetdrugstoreconsole.web.app",
      FIREBASE_PROJECT_ID: projectId,
      FIREBASE_CLIENT_EMAIL: clientEmail,
      FIREBASE_PRIVATE_KEY: privateKeyPem,
      EMPLOYEE_LOGIN_LIMITER: createEmployeeLoginLimiterBinding()
    };
    const makeRequest = (staffId, password) => new Request("https://worker.test/employee-authenticate", {
      method: "POST",
      headers: {
        Origin: env.APP_ORIGIN,
        "cf-connecting-ip": "203.0.113.17",
        "content-type": "application/json"
      },
      body: JSON.stringify({ staffId, password })
    });

    const response = await worker.fetch(makeRequest("bill-17", "test-password"), env, {});
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.employee, {
      staffId: "BILL-17",
      name: "Billing Employee",
      email: "billing.employee@example.com",
      department: "Billing South",
      branch: "South"
    });
    const [, encodedPayload] = result.customToken.split(".");
    const tokenPayload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString());
    const staffIdHash = Buffer.from(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("bill-17")
    )).toString("hex");
    assert.equal(tokenPayload.uid, `employee-${staffIdHash.slice(0, 40)}`);
    assert.deepEqual(tokenPayload.claims, {
      employee: true,
      staffId: "bill-17",
      employeeDepartment: "billing south"
    });
    assert.equal(Object.hasOwn(result.employee, "passwordHash"), false);

    const incorrectPassword = await worker.fetch(makeRequest("bill-17", "wrong-password"), env, {});
    assert.equal(incorrectPassword.status, 401);

    const existingPbkdf2Hash = await worker.fetch(makeRequest("bill-18", "stored-password"), env, {});
    assert.equal(existingPbkdf2Hash.status, 200);
    const incorrectPbkdf2Password = await worker.fetch(makeRequest("bill-18", "wrong-password"), env, {});
    assert.equal(incorrectPbkdf2Password.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("employee login rate limiter blocks attempts after the configured threshold", async () => {
  const state = new Map();
  let alarmAt = null;
  const storage = {
    async transaction(callback) {
      return callback({
        async get(key) { return state.get(key); },
        async put(key, value) { state.set(key, value); }
      });
    },
    async setAlarm(timestamp) { alarmAt = timestamp; },
    async deleteAll() { state.clear(); }
  };
  const limiter = new EmployeeLoginRateLimiter({ storage });
  const makeRequest = () => new Request("https://limiter.internal/check", { method: "POST" });
  for (let attempt = 0; attempt < 30; attempt++) {
    assert.equal((await limiter.fetch(makeRequest())).status, 200);
  }
  assert.equal((await limiter.fetch(makeRequest())).status, 429);
  assert.ok(alarmAt > Date.now());
  await limiter.alarm();
  assert.equal(state.size, 0);
});
