import test from "node:test";
import assert from "node:assert/strict";
import { shouldNotify, notificationText } from "../src/index.js";

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

test("slot assignment push messages mention the actual employee assignment", () => {
  const text = notificationText({ type: "slotAssigned", location: "SM North", list: "staff", date: "2026-10-10", time: "09:00 AM" });
  assert.match(text.title, /assigned/i);
  assert.match(text.body, /SM North|assigned/i);
});

test("removal and move push messages describe the action", () => {
  const removed = notificationText({ type: "removed" });
  assert.match(removed.title, /removed/i);
  assert.match(removed.body, /free to pick another/i);

  const moved = notificationText({ type: "siteMoved", location: "SM North", date: "2026-10-10" });
  assert.match(moved.title, /moved to a new site/i);
  assert.match(moved.body, /SM North/);
  assert.doesNotMatch(moved.body, /schedule has changed/i);
});

test("unsupported notification types are ignored", () => {
  assert.equal(shouldNotify({ staffId: "staff-17" }, { type: "unknown", staffId: "staff-17" }), false);
});