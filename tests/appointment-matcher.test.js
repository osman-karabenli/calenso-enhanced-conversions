"use strict";

const assert = require("node:assert/strict");
const {
  claimNextRetry,
  createInitialState,
  googleAdsUploadAccepted,
  handleAuthenticatedCalensoWebhook,
  handleBrowserSelection,
  pruneState,
  recordGoogleAdsUploadResult,
} = require("../lib/appointment-matcher");

const OPTIONS = {
  pendingTtlMs: 10 * 60 * 1000,
  claimTtlMs: 2 * 60 * 1000,
  sentRetentionMs: 24 * 60 * 60 * 1000,
  maxPendingRecords: 20,
  maxAcceptedRecords: 20,
  maxUploadAttempts: 3,
  retryBackoffMs: [60_000, 120_000],
};

const UUIDS = {
  one: "11111111-1111-4111-8111-111111111111",
  two: "22222222-2222-4222-8222-222222222222",
  three: "33333333-3333-4333-8333-333333333333",
  four: "44444444-4444-4444-8444-444444444444",
  five: "55555555-5555-4555-8555-555555555555",
};

function calensoEvent(appointmentUuid, overrides = {}) {
  return {
    appointmentUuid,
    conversionData: {
      event_type: "appointment.booking.created",
      event_created: "2026-09-15T10:00:00",
      appointment_uuid: appointmentUuid,
      appointment_start_utc: "2026-09-20T09:00:00Z",
      customer_uuid: overrides.customer_uuid || "customer-a",
      email: overrides.email || "customer@example.test",
      phone: overrides.phone || "+4917612345678",
    },
    nowMs: overrides.nowMs || 1_000_000,
  };
}

function browserEvent(appointmentUuid, nowMs = 1_000_000) {
  return {
    appointmentUuid,
    nowMs,
  };
}

function assertSend(decision, appointmentUuid) {
  assert.equal(decision.action, "SEND_ENHANCEMENT");
  assert.equal(decision.appointmentUuid, appointmentUuid);
  assert.equal(decision.conversionData.appointment_uuid, appointmentUuid);
  assert.equal(decision.conversionData.order_id, appointmentUuid);
  assert.ok(decision.deliveryClaimId);
  assert.equal(decision.conversionData.delivery_claim_id, decision.deliveryClaimId);
  return decision;
}

function acceptedResult(appointmentUuid) {
  return {
    statusCode: 200,
    body: {
      results: [{ orderId: appointmentUuid }],
    },
  };
}

function markAccepted(state, sendDecision, nowMs = 1_001_000) {
  const result = recordGoogleAdsUploadResult(
    state,
    {
      appointmentUuid: sendDecision.appointmentUuid,
      deliveryClaimId: sendDecision.deliveryClaimId,
      googleAdsResult: acceptedResult(sendDecision.appointmentUuid),
      nowMs,
    },
    OPTIONS,
  );
  assert.equal(result.action, "MARK_SENT");
}

function testSingleAppointment() {
  const state = createInitialState();

  assert.equal(handleBrowserSelection(state, browserEvent(UUIDS.one), OPTIONS).action, "WAIT");
  const send = assertSend(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.one), OPTIONS), UUIDS.one);
  markAccepted(state, send);

  assert.equal(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.one), OPTIONS).action, "SKIP");
}

function testMultipleAppointmentsInOneBooking() {
  const state = createInitialState();

  assert.equal(handleBrowserSelection(state, browserEvent(UUIDS.one), OPTIONS).action, "WAIT");
  const send = assertSend(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.one), OPTIONS), UUIDS.one);
  markAccepted(state, send);

  assert.equal(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.two), OPTIONS).action, "WAIT");
  assert.equal(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.three), OPTIONS).action, "WAIT");

  assert.deepEqual(Object.keys(state.acceptedOrderIds), [UUIDS.one]);
}

function testSameCustomerSeparateBookings() {
  const state = createInitialState();

  assert.equal(handleBrowserSelection(state, browserEvent(UUIDS.one), OPTIONS).action, "WAIT");
  const sendOne = assertSend(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.one), OPTIONS), UUIDS.one);
  markAccepted(state, sendOne);

  assert.equal(handleBrowserSelection(state, browserEvent(UUIDS.four, 1_030_000), OPTIONS).action, "WAIT");
  const sendFour = assertSend(
    handleAuthenticatedCalensoWebhook(
      state,
      calensoEvent(UUIDS.four, {
        customer_uuid: "customer-a",
        email: "customer@example.test",
        nowMs: 1_031_000,
      }),
      OPTIONS,
    ),
    UUIDS.four,
  );
  markAccepted(state, sendFour, 1_032_000);

  assert.deepEqual(Object.keys(state.acceptedOrderIds).sort(), [UUIDS.four, UUIDS.one].sort());
}

function testReverseOrderAndDuplicates() {
  const state = createInitialState();

  assert.equal(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.one), OPTIONS).action, "WAIT");
  assert.equal(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.one), OPTIONS).action, "WAIT");
  const send = assertSend(handleBrowserSelection(state, browserEvent(UUIDS.one, 1_002_000), OPTIONS), UUIDS.one);

  assert.equal(handleBrowserSelection(state, browserEvent(UUIDS.one, 1_003_000), OPTIONS).reason, "ENHANCEMENT_DELIVERY_ALREADY_IN_FLIGHT");
  assert.equal(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.one, { nowMs: 1_004_000 }), OPTIONS).reason, "ENHANCEMENT_DELIVERY_ALREADY_IN_FLIGHT");
  markAccepted(state, send, 1_005_000);
  assert.equal(handleBrowserSelection(state, browserEvent(UUIDS.one, 1_006_000), OPTIONS).reason, "ORDER_ID_ALREADY_ACCEPTED_BY_GOOGLE_ADS");
}

function testUnmatchedOrInvalidNotification() {
  const state = createInitialState();

  assert.equal(handleBrowserSelection(state, browserEvent("not-a-uuid"), OPTIONS).action, "REJECT");
  assert.equal(handleBrowserSelection(state, browserEvent(UUIDS.five), OPTIONS).action, "WAIT");

  pruneState(state, 1_000_000 + OPTIONS.pendingTtlMs + 1, OPTIONS);

  assert.equal(Object.keys(state.browserSelections).length, 0);
  assert.equal(Object.keys(state.pendingCalenso).length, 0);
}

function testLateDuplicatesAfterPendingTtlDoNotResendAcceptedOrder() {
  const state = createInitialState();
  const nowMs = 1_000_000;

  assert.equal(handleBrowserSelection(state, browserEvent(UUIDS.one, nowMs), OPTIONS).action, "WAIT");
  const send = assertSend(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.one, { nowMs: nowMs + 1_000 }), OPTIONS), UUIDS.one);
  markAccepted(state, send, nowMs + 2_000);

  pruneState(state, nowMs + OPTIONS.pendingTtlMs + 60_000, OPTIONS);

  assert.equal(handleBrowserSelection(state, browserEvent(UUIDS.one, nowMs + OPTIONS.pendingTtlMs + 61_000), OPTIONS).reason, "ORDER_ID_ALREADY_ACCEPTED_BY_GOOGLE_ADS");
  assert.equal(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.one, { nowMs: nowMs + OPTIONS.pendingTtlMs + 62_000 }), OPTIONS).reason, "ORDER_ID_ALREADY_ACCEPTED_BY_GOOGLE_ADS");
}

function testRetryableFailuresAndPartialFailuresAreNotMarkedSent() {
  const state = createInitialState();

  assert.equal(handleBrowserSelection(state, browserEvent(UUIDS.one), OPTIONS).action, "WAIT");
  const send = assertSend(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.one), OPTIONS), UUIDS.one);

  const partial = recordGoogleAdsUploadResult(
    state,
    {
      appointmentUuid: UUIDS.one,
      deliveryClaimId: send.deliveryClaimId,
      googleAdsResult: {
        statusCode: 200,
        body: { partialFailureError: { message: "bad user identifier" } },
      },
      nowMs: 1_010_000,
    },
    OPTIONS,
  );
  assert.equal(partial.action, "GIVE_UP");
  assert.equal(state.acceptedOrderIds[UUIDS.one], undefined);

  const state2 = createInitialState();
  assert.equal(handleBrowserSelection(state2, browserEvent(UUIDS.one), OPTIONS).action, "WAIT");
  const timeoutSend = assertSend(handleAuthenticatedCalensoWebhook(state2, calensoEvent(UUIDS.one), OPTIONS), UUIDS.one);
  const timeout = recordGoogleAdsUploadResult(
    state2,
    { appointmentUuid: UUIDS.one, deliveryClaimId: timeoutSend.deliveryClaimId, googleAdsResult: { timeout: true }, nowMs: 1_201_000 },
    OPTIONS,
  );
  assert.equal(timeout.action, "RETRYABLE_FAILURE");
  assert.equal(state2.acceptedOrderIds[UUIDS.one], undefined);
}

function testRestartPersistenceShape() {
  const state = createInitialState();

  assert.equal(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.one), OPTIONS).action, "WAIT");
  const restoredState = JSON.parse(JSON.stringify(state));

  const send = assertSend(handleBrowserSelection(restoredState, browserEvent(UUIDS.one, 1_001_000), OPTIONS), UUIDS.one);
  markAccepted(restoredState, send, 1_002_000);
  assert.equal(restoredState.pendingCalenso[UUIDS.one], undefined);
}

function testGoogleAdsAcceptanceRules() {
  assert.equal(googleAdsUploadAccepted(acceptedResult(UUIDS.one), UUIDS.one), true);
  assert.equal(googleAdsUploadAccepted({ statusCode: 200, body: {} }, UUIDS.one), false);
  assert.equal(googleAdsUploadAccepted({ statusCode: 500, body: {} }, UUIDS.one), false);
  assert.equal(googleAdsUploadAccepted({ statusCode: 200, body: { partialFailureError: { message: "nope" } } }, UUIDS.one), false);
  assert.equal(googleAdsUploadAccepted({ timeout: true }, UUIDS.one), false);
}

function recordForFreshClaim(googleAdsResult) {
  const state = createInitialState();
  assert.equal(handleBrowserSelection(state, browserEvent(UUIDS.one), OPTIONS).action, "WAIT");
  const send = assertSend(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.one), OPTIONS), UUIDS.one);
  const result = recordGoogleAdsUploadResult(
    state,
    { appointmentUuid: UUIDS.one, deliveryClaimId: send.deliveryClaimId, googleAdsResult, nowMs: 1_010_000 },
    OPTIONS,
  );
  return { state, result };
}

function testTransientResponsesRetryAndValidationIsPermanent() {
  const retryableResults = [
    { statusCode: 200, body: {} },
    { error: "ECONNRESET" },
    { error: { code: "ECONNRESET", message: "socket reset" } },
    { error: "network connection failed" },
    { timeout: true },
    { statusCode: 429, body: {} },
    { statusCode: 503, body: {} },
    { statusCode: 200, body: { results: [{ orderId: UUIDS.two }] } },
  ];

  for (const googleAdsResult of retryableResults) {
    const { state, result } = recordForFreshClaim(googleAdsResult);
    assert.equal(result.action, "RETRYABLE_FAILURE", JSON.stringify(googleAdsResult));
    assert.equal(state.acceptedOrderIds[UUIDS.one], undefined);
  }

  const partial = recordForFreshClaim({ statusCode: 200, body: { partialFailureError: { message: "invalid identifier" } } });
  assert.equal(partial.result.action, "GIVE_UP");

  const validation = recordForFreshClaim({ statusCode: 400, body: { error: "invalid field: orderId is required" } });
  assert.equal(validation.result.action, "GIVE_UP");
}

function testUuidlessErrorResponseUsesPreservedClaimContext() {
  const state = createInitialState();

  assert.equal(handleBrowserSelection(state, browserEvent(UUIDS.one), OPTIONS).action, "WAIT");
  const send = assertSend(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.one), OPTIONS), UUIDS.one);
  const result = recordGoogleAdsUploadResult(
    state,
    {
      appointmentUuid: send.orderId,
      deliveryClaimId: send.deliveryClaimId,
      googleAdsResult: { statusCode: 200, body: { partialFailureError: { code: 3, message: "synthetic" }, results: [{}] } },
      nowMs: 1_010_000,
    },
    OPTIONS,
  );

  assert.equal(result.action, "GIVE_UP");
  assert.equal(state.failedDeliveries[UUIDS.one].attempts, 1);
  assert.equal(state.deliveryClaims[UUIDS.one], undefined);
}

function testScheduledRetryWithoutNewWebhook() {
  const state = createInitialState();

  assert.equal(handleBrowserSelection(state, browserEvent(UUIDS.one), OPTIONS).action, "WAIT");
  const send = assertSend(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.one), OPTIONS), UUIDS.one);
  const failure = recordGoogleAdsUploadResult(
    state,
    { appointmentUuid: UUIDS.one, deliveryClaimId: send.deliveryClaimId, googleAdsResult: { error: "synthetic timeout" }, nowMs: 1_010_000 },
    OPTIONS,
  );

  assert.equal(failure.action, "RETRYABLE_FAILURE");
  assert.equal(claimNextRetry(state, { nowMs: failure.nextRetryAtMs - 1 }, OPTIONS).action, "WAIT");
  const retry = assertSend(claimNextRetry(state, { nowMs: failure.nextRetryAtMs }, OPTIONS), UUIDS.one);
  assert.equal(retry.deliveryAttempt, 2);
  assert.notEqual(retry.deliveryClaimId, send.deliveryClaimId);
}

function testExpiredInFlightClaimIsReclaimedByScheduledRetry() {
  const state = createInitialState();

  assert.equal(handleBrowserSelection(state, browserEvent(UUIDS.one), OPTIONS).action, "WAIT");
  const first = assertSend(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.one), OPTIONS), UUIDS.one);
  const retry = assertSend(claimNextRetry(state, { nowMs: 1_000_000 + OPTIONS.claimTtlMs + 1 }, OPTIONS), UUIDS.one);

  assert.equal(retry.deliveryAttempt, 2);
  assert.notEqual(retry.deliveryClaimId, first.deliveryClaimId);
  assert.equal(state.failedDeliveries[UUIDS.one].status, "IN_FLIGHT");
}

function testActiveInFlightClaimIsNotReclaimedByScheduledRetry() {
  const state = createInitialState();

  assert.equal(handleBrowserSelection(state, browserEvent(UUIDS.one), OPTIONS).action, "WAIT");
  const first = assertSend(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.one), OPTIONS), UUIDS.one);
  const retry = claimNextRetry(state, { nowMs: 1_000_000 + OPTIONS.claimTtlMs - 1 }, OPTIONS);

  assert.equal(retry.action, "WAIT");
  assert.equal(state.deliveryClaims[UUIDS.one].claimId, first.deliveryClaimId);
  assert.equal(state.failedDeliveries[UUIDS.one].status, "IN_FLIGHT");
}

function testConcurrentClaimOnlyOneWins() {
  const state = createInitialState();

  assert.equal(handleBrowserSelection(state, browserEvent(UUIDS.one), OPTIONS).action, "WAIT");
  const first = assertSend(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.one), OPTIONS), UUIDS.one);
  const second = handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.one, { nowMs: 1_000_001 }), OPTIONS);

  assert.equal(second.action, "SKIP");
  assert.equal(second.reason, "ENHANCEMENT_DELIVERY_ALREADY_IN_FLIGHT");
  assert.equal(second.deliveryClaimId, first.deliveryClaimId);
}

function testRestartPreservesPendingRetryAttempts() {
  const state = createInitialState();

  assert.equal(handleBrowserSelection(state, browserEvent(UUIDS.one), OPTIONS).action, "WAIT");
  const send = assertSend(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.one), OPTIONS), UUIDS.one);
  const failure = recordGoogleAdsUploadResult(
    state,
    { appointmentUuid: UUIDS.one, deliveryClaimId: send.deliveryClaimId, googleAdsResult: { timeout: true }, nowMs: 1_010_000 },
    OPTIONS,
  );

  const restored = JSON.parse(JSON.stringify(state));
  const retry = assertSend(claimNextRetry(restored, { nowMs: failure.nextRetryAtMs }, OPTIONS), UUIDS.one);

  assert.equal(retry.deliveryAttempt, 2);
  assert.equal(restored.failedDeliveries[UUIDS.one].attempts, 2);
}

function testStaleResultDoesNotClearNewClaim() {
  const state = createInitialState();

  assert.equal(handleBrowserSelection(state, browserEvent(UUIDS.one), OPTIONS).action, "WAIT");
  const first = assertSend(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.one), OPTIONS), UUIDS.one);
  const failure = recordGoogleAdsUploadResult(
    state,
    { appointmentUuid: UUIDS.one, deliveryClaimId: first.deliveryClaimId, googleAdsResult: { timeout: true }, nowMs: 1_010_000 },
    OPTIONS,
  );
  const second = assertSend(claimNextRetry(state, { nowMs: failure.nextRetryAtMs }, OPTIONS), UUIDS.one);
  const stale = recordGoogleAdsUploadResult(
    state,
    { appointmentUuid: UUIDS.one, deliveryClaimId: first.deliveryClaimId, googleAdsResult: acceptedResult(UUIDS.one), nowMs: failure.nextRetryAtMs + 1_000 },
    OPTIONS,
  );

  assert.equal(stale.action, "STALE_RESULT");
  assert.equal(state.deliveryClaims[UUIDS.one].claimId, second.deliveryClaimId);
  assert.equal(state.acceptedOrderIds[UUIDS.one], undefined);
}

function testAcceptedCapacityIsReportedNotSilentlyPruned() {
  const state = createInitialState();
  const options = { ...OPTIONS, maxAcceptedRecords: 1 };

  state.acceptedOrderIds[UUIDS.one] = { appointmentUuid: UUIDS.one, createdAtMs: 1, expiresAtMs: 9_999_999 };
  state.acceptedOrderIds[UUIDS.two] = { appointmentUuid: UUIDS.two, createdAtMs: 2, expiresAtMs: 9_999_999 };

  const result = handleBrowserSelection(state, browserEvent(UUIDS.three, 1_000_000), options);

  assert.equal(result.action, "STORAGE_ERROR");
  assert.equal(result.reason, "ACCEPTED_ORDER_ID_CAPACITY_EXCEEDED");
  assert.deepEqual(Object.keys(state.acceptedOrderIds).sort(), [UUIDS.one, UUIDS.two].sort());
}

function testDeadLetterRetentionAndCapacityAreExplicit() {
  const state = createInitialState();
  const options = { ...OPTIONS, maxDeadLetterRecords: 1, deadLetterRetentionMs: 1000 };

  assert.equal(handleBrowserSelection(state, browserEvent(UUIDS.one), options).action, "WAIT");
  const first = assertSend(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.one), options), UUIDS.one);
  assert.equal(recordGoogleAdsUploadResult(state, {
    appointmentUuid: UUIDS.one,
    deliveryClaimId: first.deliveryClaimId,
    googleAdsResult: { statusCode: 400, body: { error: "invalid required orderId" } },
    nowMs: 1_000_100,
  }, options).action, "GIVE_UP");

  assert.equal(handleBrowserSelection(state, browserEvent(UUIDS.two, 1_000_200), options).action, "WAIT");
  const second = assertSend(handleAuthenticatedCalensoWebhook(state, calensoEvent(UUIDS.two, { nowMs: 1_000_300 }), options), UUIDS.two);
  const capacity = recordGoogleAdsUploadResult(state, {
    appointmentUuid: UUIDS.two,
    deliveryClaimId: second.deliveryClaimId,
    googleAdsResult: { statusCode: 400, body: { error: "invalid required orderId" } },
    nowMs: 1_000_400,
  }, options);
  assert.equal(capacity.action, "STORAGE_ERROR");
  assert.equal(state.deliveryClaims[UUIDS.two].claimId, second.deliveryClaimId);

  pruneState(state, 1_002_000, options);
  assert.equal(state.deadLetters[UUIDS.one], undefined);
}

const tests = [
  ["single appointment", testSingleAppointment],
  ["multiple appointments in one booking", testMultipleAppointmentsInOneBooking],
  ["same customer separate bookings", testSameCustomerSeparateBookings],
  ["reverse order and duplicates", testReverseOrderAndDuplicates],
  ["unmatched or invalid notification", testUnmatchedOrInvalidNotification],
  ["late duplicates after pending ttl do not resend accepted order", testLateDuplicatesAfterPendingTtlDoNotResendAcceptedOrder],
  ["retryable failures and partial failures are not marked sent", testRetryableFailuresAndPartialFailuresAreNotMarkedSent],
  ["restart persistence shape", testRestartPersistenceShape],
  ["google ads acceptance rules", testGoogleAdsAcceptanceRules],
  ["transient responses retry and validation is permanent", testTransientResponsesRetryAndValidationIsPermanent],
  ["uuidless error response uses preserved claim context", testUuidlessErrorResponseUsesPreservedClaimContext],
  ["scheduled retry without new webhook", testScheduledRetryWithoutNewWebhook],
  ["expired in-flight claim is reclaimed by scheduled retry", testExpiredInFlightClaimIsReclaimedByScheduledRetry],
  ["active in-flight claim is not reclaimed", testActiveInFlightClaimIsNotReclaimedByScheduledRetry],
  ["concurrent claim only one wins", testConcurrentClaimOnlyOneWins],
  ["restart preserves pending retry attempts", testRestartPreservesPendingRetryAttempts],
  ["stale result does not clear new claim", testStaleResultDoesNotClearNewClaim],
  ["accepted capacity is reported not silently pruned", testAcceptedCapacityIsReportedNotSilentlyPruned],
  ["dead-letter retention and capacity are explicit", testDeadLetterRetentionAndCapacityAreExplicit],
];

for (const [name, fn] of tests) {
  fn();
  console.log(`PASS ${name}`);
}
