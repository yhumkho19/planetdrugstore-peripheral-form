import test from "node:test";
import assert from "node:assert/strict";
import worker, { shouldNotify, notificationText, notificationUrl, shouldSaveScanCursor } from "../src/index.js";

test("personal schedule notifications are sent only to the matching staff ID", () => {
  const subscription = { staffId: "staff-17" };
  assert.equal(shouldNotify(subscription, { type: "dateChanged", staffId: "STAFF-17" }), true);
  assert.equal(shouldNotify(subscription, { type: "dateChanged", staffId: "staff-18" }), false);
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
  const text = notificationText({ type: "slotAssigned", location: "SM North", list: "staff", date: "2026-10-10", time: "09:00 AM" });
  assert.match(text.title, /assigned/i);
  assert.match(text.body, /SM North|assigned/i);
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
    role: "PHARMACY ASSISTANT"
  });
  assert.match(relieverText.title, /Store Reliever/i);
  assert.match(relieverText.body, /cover MMMM/);
});

test("removal and move push messages describe the action", () => {
  const removed = notificationText({ type: "removed" });
  assert.match(removed.title, /removed/i);
  assert.match(removed.body, /choose another slot/i);

  const relieverRemoved = notificationText({ type: "removed", list: "relievers", location: "MMMM" });
  assert.match(relieverRemoved.title, /removed as Store Reliever/i);
  assert.match(relieverRemoved.body, /reliever for MMMM/i);

  const moved = notificationText({ type: "siteMoved", cardId: "new-card", oldCardId: "old-card", location: "SM North", date: "2026-10-10" });
  assert.match(moved.title, /another event bracket/i);
  assert.match(moved.body, /SM North/);
  assert.doesNotMatch(moved.body, /schedule has changed/i);
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

test("subscription CORS accepts both Firebase Hosting domains only", async () => {
  const env = { APP_ORIGIN: "https://planetdrugstore-peripher-d24c0.web.app" };
  for (const origin of [
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

  const blocked = await worker.fetch(new Request("https://worker.test/subscribe", {
    method: "OPTIONS",
    headers: { Origin: "https://untrusted.example" }
  }), env, {});
  assert.equal(blocked.status, 403);

  const reverseAlias = await worker.fetch(new Request("https://worker.test/subscribe", {
    method: "OPTIONS",
    headers: { Origin: "https://planetdrugstore-peripher-d24c0.web.app" }
  }), { APP_ORIGIN: "https://planetdrugstore-peripher-d24c0.firebaseapp.com" }, {});
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