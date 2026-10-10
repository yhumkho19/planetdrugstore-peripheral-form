import test from "node:test";
import assert from "node:assert/strict";
import worker, { shouldNotify, notificationText, notificationUrl, shouldSaveScanCursor, pushPlatformOptions, stockCutoffAt, scheduleStockCutoff } from "../src/index.js";

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

test("personal schedule notifications are sent only to the matching staff ID", () => {
  const subscription = { staffId: "staff-17" };
  assert.equal(shouldNotify(subscription, { type: "dateChanged", staffId: "STAFF-17" }), true);
  assert.equal(shouldNotify(subscription, { type: "dateChanged", staffId: "staff-18" }), false);
  for (const type of ["removed", "eventReinstated"]) {
    assert.equal(shouldNotify(subscription, { type, staffId: "STAFF-17" }), true);
    assert.equal(shouldNotify(subscription, { type, staffId: "staff-18" }), false);
  }
});

test("stock-day activation notifies only employees scheduled for that day", () => {
  const notification = { type: "stockDayActivated", targetStaffIds: ["260616", "staff-18"] };
  assert.equal(shouldNotify({ staffId: "260616" }, notification), true);
  assert.equal(shouldNotify({ staffId: "staff-18" }, notification), true);
  assert.equal(shouldNotify({ staffId: "staff-19" }, notification), false);
  assert.equal(shouldNotify({ headRole: "pharmacist" }, notification), false);
  assert.deepEqual(notificationText({ ...notification, day: "WEDNESDAY", date: "2026-10-14" }), {
    title: "Stock request is open",
    body: "You need to enter your SR#! You are scheduled for WEDNESDAY (2026-10-14). Open Stock Request to submit it."
  });
  const target = new URL(notificationUrl("https://example.test/47fto0gim6", {
    type: "stockDayActivated",
    day: "WEDNESDAY"
  }));
  assert.equal(target.pathname, "/w6n3d8ycrq");
  assert.equal(target.searchParams.get("day"), "WEDNESDAY");
});

test("stock cutoff time converts Philippine local time to UTC", () => {
  assert.equal(stockCutoffAt("2026-10-14", 480), Date.parse("2026-10-14T00:00:00Z"));
  assert.equal(stockCutoffAt("2026-10-14", 840), Date.parse("2026-10-14T06:00:00Z"));
  assert.equal(stockCutoffAt("invalid", 840), null);
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
    date: "2026-10-14",
    day: "WEDNESDAY",
    cutoffMin: 840,
    targetStaffIds: ["260616"]
  };
  await scheduleStockCutoff(env, activation);
  const cutoffKey = "scheduled:stock-cutoff:2026-10-14";
  const firstTask = await kv.get(cutoffKey, "json");

  await kv.delete(cutoffKey);
  await scheduleStockCutoff(env, {
    id: "stock-day-cutoff-2026-10-14-update-2",
    type: "stockDayCutoffUpdated",
    date: "2026-10-14",
    day: "WEDNESDAY",
    cutoffMin: 1020,
    targetStaffIds: ["260616"]
  });
  const revisedTask = await kv.get(cutoffKey, "json");

  assert.notEqual(revisedTask.id, firstTask.id);
  assert.equal(revisedTask.cutoffMin, 1020);
  assert.deepEqual(revisedTask.targetStaffIds, ["260616"]);
});

test("stock cutoff alerts go to scheduled employees and the Stock Request admin only", () => {
  const notification = { type: "stockDayClosed", targetStaffIds: ["260616"] };
  assert.equal(shouldNotify({ staffId: "260616" }, notification), true);
  assert.equal(shouldNotify({ staffId: "other-staff" }, notification), false);
  assert.equal(shouldNotify({ headRole: "stock" }, notification), true);
  assert.equal(shouldNotify({ headRole: "pharmacist" }, notification), false);
  assert.deepEqual(notificationText(notification, { headRole: "stock" }), {
    title: "Stock request closed",
    body: "The stock request for today is now closed!"
  });
});

test("early stock-day closure notifies scheduled employees and the Stock Request admin", () => {
  const notification = {
    type: "stockDayClosedEarly",
    day: "THURSDAY",
    targetStaffIds: ["260616"]
  };
  assert.equal(shouldNotify({ staffId: "260616" }, notification), true);
  assert.equal(shouldNotify({ staffId: "other-staff" }, notification), false);
  assert.equal(shouldNotify({ headRole: "stock" }, notification), true);
  assert.equal(shouldNotify({ headRole: "pharmacist" }, notification), false);
  assert.deepEqual(notificationText(notification), {
    title: "Stock request closed early",
    body: "The stock request for THURSDAY was closed early by the admin. You can no longer submit, edit, or remove your SR# for this day."
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
    targetStaffIds: ["260616"],
    previousCutoffMin: 1080,
    cutoffMin: 1200,
    reopened: true
  };
  assert.equal(shouldNotify({ staffId: "260616" }, cutoffChange), true);
  assert.equal(shouldNotify({ staffId: "other-staff" }, cutoffChange), false);
  assert.equal(notificationText(cutoffChange).body,
    "The cutoff passed, but the admin moved it from 6:00 PM to 8:00 PM. You can edit or remove your SR# until 8:00 PM.");
  assert.equal(notificationText({ ...cutoffChange, unclosed: true }).body,
    "The admin reopened stock requests. You can now enter or edit your SR# until 8:00 PM.");
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

test("head and employee subscriptions coexist on the same browser token", async () => {
  const values = new Map();
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
  const context = { waitUntil() {} };
  const subscribe = body => worker.fetch(new Request("https://worker.test/subscribe", {
    method: "POST",
    headers: { Origin: env.APP_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body)
  }), env, context);

  assert.equal((await subscribe({ headRole: "billing", token: "same-browser-token-1234567890" })).status, 200);
  assert.equal((await subscribe({ staffId: "staff-17", token: "same-browser-token-1234567890" })).status, 200);
  assert.equal(values.size, 2);
  assert.deepEqual([...values.values()].map(value => JSON.parse(value).headRole || "").sort(), ["", "billing"]);

  const unsubscribeHead = await worker.fetch(new Request("https://worker.test/subscribe", {
    method: "DELETE",
    headers: { Origin: env.APP_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ headRole: "billing", token: "same-browser-token-1234567890" })
  }), env, context);
  assert.equal(unsubscribeHead.status, 200);
  assert.equal(values.size, 1);
  assert.equal(JSON.parse([...values.values()][0]).staffId, "staff-17");
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
  assert.match(attributedCancellation.body, /Action by: Billing Head/);

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

  const cancelled = notificationText({ type: "eventCancelled", location: "SM North" });
  assert.match(cancelled.title, /cancelled/i);
  assert.match(cancelled.body, /SM North/);

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
      }] })
    }), env, { waitUntil(promise) { pending.push(promise); } });

    assert.equal(response.status, 202);
    await Promise.all(pending);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].token, deviceToken);
    assert.equal(messages[0].data.notificationType, "slotAssigned");
    assert.equal(kvValues.get("sent:push-test-1"), "1");

    const stockUnsigned = `${encode({ alg: "RS256", kid: publicJwk.kid, typ: "JWT" })}.${encode({
      aud: projectId,
      iss: `https://securetoken.google.com/${projectId}`,
      sub: "stock-admin-auth-user",
      email: "adminstockreq@planetdrugstore.ph",
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
        day: "WEDNESDAY",
        date: "2026-10-14",
        cutoffMin: 840,
        targetStaffIds: ["staff-17"]
      }] })
    }), env, { waitUntil(promise) { stockPending.push(promise); } });
    assert.equal(stockResponse.status, 202);
    const cutoffTask = JSON.parse(kvValues.get("scheduled:stock-cutoff:2026-10-14"));
    assert.equal(cutoffTask.cutoffMin, 840);
    assert.deepEqual(cutoffTask.targetStaffIds, ["staff-17"]);
    await Promise.all(stockPending);
    assert.equal(messages.length, 2);
    assert.equal(messages[1].data.notificationType, "stockDayActivated");
    assert.match(messages[1].data.body, /WEDNESDAY/);
    assert.equal(new URL(messages[1].data.url).searchParams.get("day"), "WEDNESDAY");

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

test("idle cron performs one KV list and does not scan push subscriptions", async () => {
  const listPrefixes = [];
  const values = new Map([["scheduled-jobs-migrated-v1", "1"]]);
  const kv = {
    async get(key, type) {
      const value = values.get(key);
      return type === "json" && value ? JSON.parse(value) : value || null;
    },
    async put(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async list({ prefix }) {
      listPrefixes.push(prefix);
      return { keys: [], list_complete: true };
    }
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes("firestore.googleapis.com")) {
      return new Response("[]", { headers: { "content-type": "application/json" } });
    }
    if (String(url) === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: "idle-test-token", expires_in: 3600 }), {
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected network request: ${String(url)}`);
  };

  try {
    const env = {
      FIREBASE_PROJECT_ID: "planetdrugstore-peripher-d24c0",
      FIREBASE_CLIENT_EMAIL: "service@example.iam.gserviceaccount.com",
      FIREBASE_PRIVATE_KEY: "unused-when-token-is-cached",
      PUSH_SUBSCRIPTIONS: kv
    };
    const pending = [];
    await worker.scheduled({}, env, { waitUntil(promise) { pending.push(promise); } });
    await Promise.all(pending);
    assert.deepEqual(listPrefixes, ["scheduled:"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scheduled stock cutoff alerts the employee and Stock Request admin", async () => {
  const dueAt = Date.now() - 1000;
  const values = new Map([
    ["stock-cutoff:2026-10-14", JSON.stringify({
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
  const sentMessages = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("firestore.googleapis.com")) {
      return new Response("[]", { headers: { "content-type": "application/json" } });
    }
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
    const env = {
      APP_URL: "https://planetdrugstoreconsole.web.app/47fto0gim6",
      FIREBASE_PROJECT_ID: "planetdrugstore-peripher-d24c0",
      FIREBASE_CLIENT_EMAIL: "service@example.iam.gserviceaccount.com",
      FIREBASE_PRIVATE_KEY: "unused-when-token-is-cached",
      PUSH_SUBSCRIPTIONS: kv
    };
    const runScheduled = async () => {
      const pending = [];
      await worker.scheduled({}, env, { waitUntil(promise) { pending.push(promise); } });
      await Promise.all(pending);
    };
    await runScheduled();

    assert.equal(sentMessages.length, 0);
    assert.equal(values.has("stock-cutoff:2026-10-14"), false);
    assert.equal(values.has("scheduled:stock-cutoff:2026-10-14"), true);

    values.set("sub:employee", JSON.stringify({ staffId: "260616", token: "employee-device-token-260616" }));
    values.set("sub:stock-admin", JSON.stringify({ headRole: "stock", token: "stock-admin-device-token" }));
    values.set("sub:pharmacist", JSON.stringify({ headRole: "pharmacist", token: "pharmacist-device-token" }));
    await runScheduled();

    assert.deepEqual(sentMessages.map(message => message.token).sort(), [
      "employee-device-token-260616",
      "stock-admin-device-token"
    ]);
    assert.equal(sentMessages.every(message => message.data.notificationType === "stockDayClosed"), true);
    assert.equal(sentMessages.every(message => message.data.body.includes("The stock request for today is now closed!")), true);
    assert.equal(values.has("scheduled:stock-cutoff:2026-10-14"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
