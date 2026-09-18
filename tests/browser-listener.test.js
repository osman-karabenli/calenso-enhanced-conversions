"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const UUIDS = {
  one: "11111111-1111-4111-8111-111111111111",
  two: "22222222-2222-4222-8222-222222222222",
};

function loadListener(overrides = {}) {
  const listeners = {};
  const iframeWindow = {};
  const dataLayer = [];
  const fetchCalls = [];
  const timers = [];

  const context = {
    Blob,
    Date,
    Array,
    String,
    Boolean,
    Object,
    RegExp,
    module: { exports: {} },
    navigator: {
      sendBeacon: overrides.sendBeacon,
    },
    document: {
      querySelectorAll() {
        return overrides.frames || [
          {
            getAttribute(name) {
              return name === "src" ? "https://widget.calenso.com/widget/book" : "";
            },
            contentWindow: iframeWindow,
          },
        ];
      },
    },
    window: {
      dataLayer,
      setTimeout(fn, delay) {
        timers.push({ fn, delay });
      },
      addEventListener(name, fn) {
        listeners[name] = fn;
      },
    },
    fetch: overrides.fetch || ((url, options) => {
      fetchCalls.push({ url, options });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ action: "WAIT" }) });
    }),
  };

  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync("webador/browser-selected-appointment-listener.js", "utf8"), context);

  return {
    api: context.module.exports,
    context,
    dataLayer,
    fetchCalls,
    iframeWindow,
    listeners,
    timers,
  };
}

function doneMessage(iframeWindow, bookingData, overrides = {}) {
  return {
    origin: overrides.origin || "https://widget.calenso.com",
    source: overrides.source === undefined ? iframeWindow : overrides.source,
    data: {
      eventName: Object.prototype.hasOwnProperty.call(overrides, "eventName") ? overrides.eventName : "APPOINTMENT_BOOKING_DONE",
      bookingData,
    },
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function testDonePassesThroughAndNotifiesArrayBookingData() {
  const harness = loadListener();

  harness.listeners.message(doneMessage(harness.iframeWindow, [{ uuid: UUIDS.one }, { uuid: UUIDS.two }]));
  await flushPromises();

  assert.equal(JSON.stringify(harness.dataLayer), JSON.stringify([
    {
      event: "APPOINTMENT_BOOKING_DONE",
      appointment_uuid: UUIDS.one,
    },
  ]));
  assert.equal(harness.fetchCalls.length, 1);
  assert.match(harness.fetchCalls[0].options.body, new RegExp(UUIDS.one));
  assert.doesNotMatch(harness.fetchCalls[0].options.body, /customer|email|phone|secret/i);
}

async function testDonePassesThroughObjectBookingData() {
  const harness = loadListener();

  harness.listeners.message(doneMessage(harness.iframeWindow, { uuid: UUIDS.two }));
  await flushPromises();

  assert.equal(harness.dataLayer[0].appointment_uuid, UUIDS.two);
  assert.equal(harness.fetchCalls.length, 1);
}

async function testWrongOriginSourceAndInvalidUuid() {
  const harness = loadListener();

  harness.listeners.message(doneMessage(harness.iframeWindow, { uuid: UUIDS.one }, { origin: "https://example.test" }));
  harness.listeners.message(doneMessage(harness.iframeWindow, { uuid: UUIDS.one }, { source: {} }));
  harness.listeners.message(doneMessage(harness.iframeWindow, { uuid: "not-a-uuid" }));
  harness.listeners.message(doneMessage(harness.iframeWindow, { uuid: UUIDS.one }, { eventName: "" }));
  await flushPromises();

  assert.equal(harness.dataLayer.length, 1);
  assert.equal(harness.dataLayer[0].event, "APPOINTMENT_BOOKING_DONE");
  assert.equal(harness.dataLayer[0].appointment_uuid, undefined);
  assert.equal(harness.fetchCalls.length, 0);
}

async function testFetchFailureRetriesThenSuccess() {
  let calls = 0;
  const harness = loadListener({
    fetch() {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({ ok: false });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ action: "WAIT" }) });
    },
  });

  harness.listeners.message(doneMessage(harness.iframeWindow, { uuid: UUIDS.one }));
  await flushPromises();

  assert.equal(harness.timers.length, 1);
  assert.equal(harness.timers[0].delay, 1000);

  harness.timers[0].fn();
  await flushPromises();

  assert.equal(calls, 2);
}

async function testRepeatedDoneDedupesInFlightFetchAndRealStepSuccess() {
  let resolveFetch;
  let fetchCount = 0;
  const harness = loadListener({
    fetch() {
      fetchCount += 1;
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    },
  });

  harness.listeners.message(doneMessage(harness.iframeWindow, { uuid: UUIDS.one }));
  harness.listeners.message(doneMessage(harness.iframeWindow, { uuid: UUIDS.one }));

  assert.equal(harness.dataLayer.length, 2);
  assert.equal(harness.dataLayer[0].event, "APPOINTMENT_BOOKING_DONE");
  assert.equal(harness.dataLayer[1].event, "APPOINTMENT_BOOKING_DONE");
  assert.equal(fetchCount, 1);

  resolveFetch({ ok: true, json: () => Promise.resolve({ action: "WAIT" }) });
  await flushPromises();

  harness.listeners.message(doneMessage(harness.iframeWindow, {}, { eventName: "appointment_booking_step_success" }));
  harness.listeners.message(doneMessage(harness.iframeWindow, {}, { eventName: "appointment_booking_step_success" }));
  await flushPromises();

  const conversionEvents = harness.dataLayer.filter((item) => item.event === "appointment_booking_step_success");
  assert.equal(conversionEvents.length, 1);
  assert.equal(conversionEvents[0].appointment_uuid, UUIDS.one);
}

async function testEmptyTwoHundredResponseIsNotBrowserSuccess() {
  let calls = 0;
  const harness = loadListener({
    fetch() {
      calls += 1;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    },
  });

  harness.listeners.message(doneMessage(harness.iframeWindow, { uuid: UUIDS.one }));
  await flushPromises();

  assert.equal(calls, 1);
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.timers[0].delay, 1000);
}

const tests = [
  ["done passthrough and notify array bookingData", testDonePassesThroughAndNotifiesArrayBookingData],
  ["done passthrough object bookingData", testDonePassesThroughObjectBookingData],
  ["wrong origin/source and invalid uuid", testWrongOriginSourceAndInvalidUuid],
  ["fetch failure retries then success", testFetchFailureRetriesThenSuccess],
  ["repeated DONE dedupes in-flight fetch and real step_success", testRepeatedDoneDedupesInFlightFetchAndRealStepSuccess],
  ["empty 200 response retries", testEmptyTwoHundredResponseIsNotBrowserSuccess],
];

(async () => {
  for (const [name, fn] of tests) {
    await fn();
    console.log(`PASS ${name}`);
  }
})();
