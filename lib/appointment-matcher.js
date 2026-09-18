"use strict";

const DEFAULT_OPTIONS = {
  pendingTtlMs: 30 * 60 * 1000,
  claimTtlMs: 2 * 60 * 1000,
  sentRetentionMs: 30 * 24 * 60 * 60 * 1000,
  maxPendingRecords: 500,
  maxAcceptedRecords: 5000,
  deadLetterRetentionMs: 30 * 24 * 60 * 60 * 1000,
  maxDeadLetterRecords: 5000,
  maxUploadAttempts: 3,
  retryBackoffMs: [60 * 1000, 5 * 60 * 1000],
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createInitialState() {
  return {
    browserSelections: {},
    pendingCalenso: {},
    deliveryClaims: {},
    acceptedOrderIds: {},
    failedDeliveries: {},
    deadLetters: {},
  };
}

function normalizeOptions(options) {
  return {
    ...DEFAULT_OPTIONS,
    ...(options || {}),
  };
}

function ensureState(state) {
  state.browserSelections = state.browserSelections || {};
  state.pendingCalenso = state.pendingCalenso || {};
  state.deliveryClaims = state.deliveryClaims || {};
  state.acceptedOrderIds = state.acceptedOrderIds || state.sentOrderIds || {};
  state.failedDeliveries = state.failedDeliveries || {};
  state.deadLetters = state.deadLetters || {};
  delete state.sentOrderIds;
  return state;
}

function isValidAppointmentUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

function normalizeAppointmentUuid(value) {
  return String(value || "").trim().toLowerCase();
}

function pruneBucket(bucket, nowMs, maxRecords, shouldDelete) {
  for (const [key, record] of Object.entries(bucket)) {
    if (!record || shouldDelete(record, nowMs)) {
      delete bucket[key];
    }
  }

  const records = Object.entries(bucket);
  if (records.length <= maxRecords) {
    return null;
  }

  records
    .sort((a, b) => (a[1].createdAtMs || a[1].lastUpdatedAtMs || 0) - (b[1].createdAtMs || b[1].lastUpdatedAtMs || 0))
    .slice(0, records.length - maxRecords)
    .forEach(([key]) => {
      delete bucket[key];
    });
  return null;
}

function pruneState(state, nowMs, rawOptions) {
  const options = normalizeOptions(rawOptions);
  ensureState(state);

  pruneBucket(state.browserSelections, nowMs, options.maxPendingRecords, (record) => record.expiresAtMs <= nowMs);
  pruneBucket(state.pendingCalenso, nowMs, options.maxPendingRecords, (record) => record.expiresAtMs <= nowMs);
  pruneBucket(state.deliveryClaims, nowMs, options.maxPendingRecords, (record) => record.expiresAtMs <= nowMs);
  pruneBucket(state.failedDeliveries, nowMs, Number.MAX_SAFE_INTEGER, (record) => record.expiresAtMs <= nowMs);

  if (Object.keys(state.failedDeliveries).length > options.maxPendingRecords) {
    return {
      action: "STORAGE_ERROR",
      reason: "FAILED_DELIVERY_CAPACITY_EXCEEDED",
      failedDeliveryCount: Object.keys(state.failedDeliveries).length,
      maxPendingRecords: options.maxPendingRecords,
    };
  }

  for (const [key, record] of Object.entries(state.acceptedOrderIds)) {
    if (!record || record.expiresAtMs <= nowMs) {
      delete state.acceptedOrderIds[key];
    }
  }

  if (Object.keys(state.acceptedOrderIds).length > options.maxAcceptedRecords) {
    return {
      action: "STORAGE_ERROR",
      reason: "ACCEPTED_ORDER_ID_CAPACITY_EXCEEDED",
      acceptedCount: Object.keys(state.acceptedOrderIds).length,
      maxAcceptedRecords: options.maxAcceptedRecords,
    };
  }

  for (const [key, record] of Object.entries(state.deadLetters)) {
    if (!record || (record.expiresAtMs && record.expiresAtMs <= nowMs)) {
      delete state.deadLetters[key];
    }
  }

  if (Object.keys(state.deadLetters).length > options.maxDeadLetterRecords) {
    return {
      action: "STORAGE_ERROR",
      reason: "DEAD_LETTER_CAPACITY_EXCEEDED",
      deadLetterCount: Object.keys(state.deadLetters).length,
      maxDeadLetterRecords: options.maxDeadLetterRecords,
    };
  }

  return null;
}

function accepted(state, appointmentUuid) {
  return state.acceptedOrderIds[appointmentUuid];
}

function failureRecord(state, appointmentUuid) {
  return state.failedDeliveries[appointmentUuid] || null;
}

function buildWait(source, appointmentUuid, reason) {
  return {
    action: "WAIT",
    reason,
    source,
    appointmentUuid,
  };
}

function buildSkip(source, appointmentUuid, reason, extra = {}) {
  return {
    action: "SKIP",
    reason,
    source,
    appointmentUuid,
    ...extra,
  };
}

function createClaimId(appointmentUuid, attempt, nowMs) {
  return `${appointmentUuid}:${attempt}:${nowMs}`;
}

function nextRetryAt(nowMs, attempt, options) {
  const delay = options.retryBackoffMs[Math.max(0, attempt - 1)] ?? options.retryBackoffMs[options.retryBackoffMs.length - 1] ?? options.claimTtlMs;
  return nowMs + delay;
}

function beginDeliveryClaim(state, appointmentUuid, nowMs, rawOptions, source) {
  const options = normalizeOptions(rawOptions);
  const capacityError = pruneState(state, nowMs, options);
  if (capacityError) {
    return { ...capacityError, source, appointmentUuid };
  }

  const pending = state.pendingCalenso[appointmentUuid];
  const selection = state.browserSelections[appointmentUuid];

  if (!pending) {
    return buildWait(source, appointmentUuid, "WAITING_FOR_AUTHENTICATED_CALENSO_WEBHOOK");
  }

  if (!selection) {
    return buildWait(source, appointmentUuid, "WAITING_FOR_BROWSER_SELECTED_APPOINTMENT_UUID");
  }

  if (accepted(state, appointmentUuid)) {
    return buildSkip(source, appointmentUuid, "ORDER_ID_ALREADY_ACCEPTED_BY_GOOGLE_ADS");
  }

  const existingClaim = state.deliveryClaims[appointmentUuid];
  if (existingClaim && existingClaim.expiresAtMs > nowMs) {
    return buildSkip(source, appointmentUuid, "ENHANCEMENT_DELIVERY_ALREADY_IN_FLIGHT", {
      deliveryAttempt: existingClaim.attempt,
      deliveryClaimId: existingClaim.claimId,
    });
  }

  const failed = failureRecord(state, appointmentUuid);
  if (failed?.status === "PERMANENT_FAILURE") {
    return buildSkip(source, appointmentUuid, "PERMANENT_UPLOAD_FAILURE_RECORDED", {
      attempts: failed.attempts,
    });
  }

  const attempt = (failed?.attempts || 0) + 1;
  if (attempt > options.maxUploadAttempts) {
    state.deadLetters[appointmentUuid] = {
      appointmentUuid,
      reason: "MAX_UPLOAD_ATTEMPTS_EXHAUSTED",
      attempts: failed?.attempts || 0,
      createdAtMs: state.deadLetters[appointmentUuid]?.createdAtMs || nowMs,
      lastUpdatedAtMs: nowMs,
      expiresAtMs: nowMs + options.deadLetterRetentionMs,
    };
    return buildSkip(source, appointmentUuid, "MAX_UPLOAD_ATTEMPTS_EXHAUSTED", {
      attempts: failed?.attempts || 0,
    });
  }

  const claimId = createClaimId(appointmentUuid, attempt, nowMs);
  state.deliveryClaims[appointmentUuid] = {
    appointmentUuid,
    claimId,
    attempt,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + options.claimTtlMs,
  };
  state.failedDeliveries[appointmentUuid] = {
    appointmentUuid,
    attempts: attempt,
    status: "IN_FLIGHT",
    createdAtMs: failed?.createdAtMs || nowMs,
    lastUpdatedAtMs: nowMs,
    expiresAtMs: nowMs + options.pendingTtlMs,
    nextRetryAtMs: null,
    lastReason: null,
  };

  return {
    action: "SEND_ENHANCEMENT",
    reason: "BROWSER_SELECTION_MATCHED_AUTHENTICATED_CALENSO_WEBHOOK",
    source,
    appointmentUuid,
    orderId: appointmentUuid,
    deliveryAttempt: attempt,
    deliveryClaimId: claimId,
    conversionData: {
      ...pending.conversionData,
      appointment_uuid: appointmentUuid,
      order_id: appointmentUuid,
      delivery_attempt: attempt,
      delivery_claim_id: claimId,
    },
  };
}

function handleBrowserSelection(state, input, rawOptions) {
  const options = normalizeOptions(rawOptions);
  const nowMs = input.nowMs || Date.now();
  ensureState(state);

  if (!isValidAppointmentUuid(input.appointmentUuid)) {
    return {
      action: "REJECT",
      reason: "INVALID_BROWSER_APPOINTMENT_UUID",
      source: "browser",
    };
  }

  const appointmentUuid = normalizeAppointmentUuid(input.appointmentUuid);
  const capacityError = pruneState(state, nowMs, options);
  if (capacityError) {
    return { ...capacityError, source: "browser", appointmentUuid };
  }

  if (accepted(state, appointmentUuid)) {
    return buildSkip("browser", appointmentUuid, "ORDER_ID_ALREADY_ACCEPTED_BY_GOOGLE_ADS");
  }

  state.browserSelections[appointmentUuid] = {
    appointmentUuid,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + options.pendingTtlMs,
  };

  return beginDeliveryClaim(state, appointmentUuid, nowMs, options, "browser");
}

function handleAuthenticatedCalensoWebhook(state, input, rawOptions) {
  const options = normalizeOptions(rawOptions);
  const nowMs = input.nowMs || Date.now();
  ensureState(state);

  if (!isValidAppointmentUuid(input.appointmentUuid)) {
    return {
      action: "REJECT",
      reason: "INVALID_CALENSO_APPOINTMENT_UUID",
      source: "calenso",
    };
  }

  const appointmentUuid = normalizeAppointmentUuid(input.appointmentUuid);
  const capacityError = pruneState(state, nowMs, options);
  if (capacityError) {
    return { ...capacityError, source: "calenso", appointmentUuid };
  }

  if (accepted(state, appointmentUuid)) {
    return buildSkip("calenso", appointmentUuid, "ORDER_ID_ALREADY_ACCEPTED_BY_GOOGLE_ADS");
  }

  state.pendingCalenso[appointmentUuid] = {
    appointmentUuid,
    conversionData: {
      ...input.conversionData,
      appointment_uuid: appointmentUuid,
      order_id: appointmentUuid,
    },
    createdAtMs: nowMs,
    expiresAtMs: nowMs + options.pendingTtlMs,
  };

  return beginDeliveryClaim(state, appointmentUuid, nowMs, options, "calenso");
}

function classifyGoogleAdsResult(result) {
  if (!result) {
    return { accepted: false, retryable: true, reason: "MISSING_GOOGLE_ADS_RESULT" };
  }

  const statusCode = Number(result.statusCode || result.status || 0);
  const body = result.body || result.response || result;
  if (body.partialFailureError) {
    return { accepted: false, retryable: false, reason: "GOOGLE_ADS_PARTIAL_FAILURE" };
  }

  const errorText = typeof result.error === "object"
    ? JSON.stringify(result.error)
    : String(result.error || result.message || result.code || "");
  if (result.timeout || /timeout|econnreset|econnrefused|enotfound|network|connection|socket|fetch failed|aborted|reset by peer/i.test(errorText)) {
    return { accepted: false, retryable: true, reason: "TIMEOUT_OR_UNKNOWN_RESULT" };
  }

  if (statusCode >= 500) {
    return { accepted: false, retryable: true, reason: "GOOGLE_ADS_SERVER_ERROR" };
  }

  if (statusCode === 429) {
    return { accepted: false, retryable: true, reason: "GOOGLE_ADS_RATE_LIMITED" };
  }

  if (statusCode >= 400 && statusCode < 500) {
    const validationText = JSON.stringify(body).toLowerCase();
    const explicitValidation = statusCode === 400 && /validation|invalid|malformed|required|missing|order.?id/i.test(validationText);
    return {
      accepted: false,
      retryable: !explicitValidation,
      reason: explicitValidation ? "GOOGLE_ADS_VALIDATION_FAILURE" : "GOOGLE_ADS_CLIENT_RESPONSE_UNCERTAIN",
    };
  }

  if (statusCode && (statusCode < 200 || statusCode >= 300)) {
    return { accepted: false, retryable: true, reason: "GOOGLE_ADS_HTTP_RESPONSE_UNCERTAIN" };
  }

  if (!Array.isArray(body?.results) || !body.results.some((item) => item && item.orderId)) {
    return { accepted: false, retryable: true, reason: "EXPECTED_ORDER_ID_RESULT_MISSING" };
  }

  return { accepted: null, retryable: true, reason: "EXPECTED_ORDER_ID_RESULT_MISSING" };
}

function googleAdsUploadAccepted(result, appointmentUuid) {
  if (!isValidAppointmentUuid(appointmentUuid)) {
    return false;
  }

  const classification = classifyGoogleAdsResult(result);
  if (classification.accepted === false) {
    return false;
  }

  const body = result?.body || result?.response || result;
  if (!Array.isArray(body?.results)) {
    return false;
  }

  return body.results.some((item) => item && item.orderId === appointmentUuid);
}

function recordGoogleAdsUploadResult(state, input, rawOptions) {
  const options = normalizeOptions(rawOptions);
  const nowMs = input.nowMs || Date.now();
  ensureState(state);

  if (!isValidAppointmentUuid(input.appointmentUuid)) {
    return {
      action: "REJECT",
      reason: "INVALID_UPLOAD_RESULT_APPOINTMENT_UUID",
      source: "google_ads",
    };
  }

  const appointmentUuid = normalizeAppointmentUuid(input.appointmentUuid);
  const claim = state.deliveryClaims[appointmentUuid];
  if (!claim || claim.claimId !== input.deliveryClaimId) {
    return {
      action: "STALE_RESULT",
      reason: "UPLOAD_RESULT_CLAIM_DOES_NOT_MATCH_ACTIVE_CLAIM",
      source: "google_ads",
      appointmentUuid,
      deliveryClaimId: input.deliveryClaimId,
      activeDeliveryClaimId: claim?.claimId || null,
    };
  }

  const acceptedUpload = googleAdsUploadAccepted(input.googleAdsResult, appointmentUuid);
  const classification = classifyGoogleAdsResult(input.googleAdsResult);

  if (!acceptedUpload && !classification.retryable && !state.deadLetters[appointmentUuid]
      && Object.keys(state.deadLetters).length >= options.maxDeadLetterRecords) {
    return {
      action: "STORAGE_ERROR",
      reason: "DEAD_LETTER_CAPACITY_EXCEEDED",
      source: "google_ads",
      appointmentUuid,
      deliveryClaimId: input.deliveryClaimId,
      attempts: claim.attempt,
      maxDeadLetterRecords: options.maxDeadLetterRecords,
    };
  }

  delete state.deliveryClaims[appointmentUuid];

  if (acceptedUpload) {
    state.acceptedOrderIds[appointmentUuid] = {
      appointmentUuid,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + options.sentRetentionMs,
      googleAdsStatus: "ACCEPTED",
      deliveryClaimId: input.deliveryClaimId,
      attempts: claim.attempt,
    };
    delete state.browserSelections[appointmentUuid];
    delete state.pendingCalenso[appointmentUuid];
    delete state.failedDeliveries[appointmentUuid];

    return {
      action: "MARK_SENT",
      reason: "GOOGLE_ADS_UPLOAD_ACCEPTED_FOR_ORDER_ID",
      source: "google_ads",
      appointmentUuid,
      deliveryClaimId: input.deliveryClaimId,
      attempts: claim.attempt,
    };
  }

  const retryable = classification.retryable && claim.attempt < options.maxUploadAttempts;
  state.failedDeliveries[appointmentUuid] = {
    appointmentUuid,
    attempts: claim.attempt,
    status: retryable ? "RETRYABLE_FAILURE" : "PERMANENT_FAILURE",
    createdAtMs: state.failedDeliveries[appointmentUuid]?.createdAtMs || nowMs,
    lastUpdatedAtMs: nowMs,
    expiresAtMs: retryable ? nowMs + options.pendingTtlMs : nowMs + options.deadLetterRetentionMs,
    nextRetryAtMs: retryable ? nextRetryAt(nowMs, claim.attempt, options) : null,
    lastReason: classification.reason,
  };

  if (!retryable) {
    state.deadLetters[appointmentUuid] = {
      appointmentUuid,
      reason: claim.attempt >= options.maxUploadAttempts ? "MAX_UPLOAD_ATTEMPTS_EXHAUSTED" : classification.reason,
      attempts: claim.attempt,
      createdAtMs: state.deadLetters[appointmentUuid]?.createdAtMs || nowMs,
      lastUpdatedAtMs: nowMs,
      expiresAtMs: nowMs + options.deadLetterRetentionMs,
    };
  }

  return {
    action: retryable ? "RETRYABLE_FAILURE" : "GIVE_UP",
    reason: retryable ? classification.reason : state.deadLetters[appointmentUuid].reason,
    source: "google_ads",
    appointmentUuid,
    deliveryClaimId: input.deliveryClaimId,
    attempts: claim.attempt,
    nextRetryAtMs: state.failedDeliveries[appointmentUuid]?.nextRetryAtMs || null,
  };
}

function claimNextRetry(state, input = {}, rawOptions) {
  const options = normalizeOptions(rawOptions);
  const nowMs = input.nowMs || Date.now();
  ensureState(state);
  const capacityError = pruneState(state, nowMs, options);
  if (capacityError) {
    return { ...capacityError, source: "retry" };
  }

  for (const record of Object.values(state.failedDeliveries)) {
    if (record.status !== "IN_FLIGHT") {
      continue;
    }

    const activeClaim = state.deliveryClaims[record.appointmentUuid];
    if (activeClaim && activeClaim.expiresAtMs > nowMs) {
      continue;
    }

    if (record.attempts >= options.maxUploadAttempts) {
      record.status = "PERMANENT_FAILURE";
      record.nextRetryAtMs = null;
      record.lastUpdatedAtMs = nowMs;
      record.lastReason = "MAX_UPLOAD_ATTEMPTS_EXHAUSTED";
      state.deadLetters[record.appointmentUuid] = {
        appointmentUuid: record.appointmentUuid,
        reason: "MAX_UPLOAD_ATTEMPTS_EXHAUSTED",
        attempts: record.attempts,
        createdAtMs: state.deadLetters[record.appointmentUuid]?.createdAtMs || nowMs,
        lastUpdatedAtMs: nowMs,
        expiresAtMs: nowMs + options.deadLetterRetentionMs,
      };
      continue;
    }

    record.status = "RETRYABLE_FAILURE";
    record.nextRetryAtMs = nowMs;
    record.lastUpdatedAtMs = nowMs;
    record.lastReason = "DELIVERY_CLAIM_EXPIRED_OR_MISSING";
  }

  const due = Object.values(state.failedDeliveries)
    .filter((record) => record.status === "RETRYABLE_FAILURE" && record.nextRetryAtMs <= nowMs)
    .sort((a, b) => a.nextRetryAtMs - b.nextRetryAtMs);

  for (const record of due) {
    const decision = beginDeliveryClaim(state, record.appointmentUuid, nowMs, options, "retry");
    if (decision.action === "SEND_ENHANCEMENT") {
      return decision;
    }
  }

  return {
    action: "WAIT",
    reason: "NO_RETRYABLE_ENHANCEMENT_DUE",
    source: "retry",
  };
}

module.exports = {
  DEFAULT_OPTIONS,
  classifyGoogleAdsResult,
  claimNextRetry,
  createInitialState,
  googleAdsUploadAccepted,
  handleAuthenticatedCalensoWebhook,
  handleBrowserSelection,
  isValidAppointmentUuid,
  normalizeAppointmentUuid,
  pruneState,
  recordGoogleAdsUploadResult,
};
