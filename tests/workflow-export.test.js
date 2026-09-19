"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const workflow = JSON.parse(fs.readFileSync("workflows/calenso-enhanced-conversions-pipeline.browser-matched.json", "utf8"));

function byName(name) {
  const found = workflow.nodes.find((node) => node.name === name);
  assert.ok(found, `missing node: ${name}`);
  return found;
}

function assertConnected(from, to) {
  const outputs = workflow.connections[from]?.main?.[0] || [];
  assert.ok(outputs.some((target) => target.node === to), `${from} must connect to ${to}`);
}

function isReachable(from, to) {
  const queue = [from];
  const visited = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (current === to) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const output of workflow.connections[current]?.main || []) {
      for (const target of output || []) queue.push(target.node);
    }
  }
  return false;
}

assert.equal(workflow.active, false);

assert.equal(byName("Claim Authenticated Calenso Match").parameters.url, "http://calenso-state-store:8787/calenso-webhook");
assert.equal(byName("Claim Browser Selected Match").parameters.url, "http://calenso-state-store:8787/browser-selection");
assert.equal(byName("Receive Browser Selected Appointment").parameters.responseMode, "responseNode");
assert.equal(byName("Respond Browser State Decision").type, "n8n-nodes-base.respondToWebhook");
assert.equal(byName("Respond Browser State Decision").parameters.responseBody, "={{ { action: $json.action } }}");
assert.doesNotMatch(byName("Respond Browser State Decision").parameters.responseBody, /conversionData|email|phone|customer_uuid|deliveryClaimId/);
assert.equal(byName("Claim Next Retryable Enhancement").parameters.url, "http://calenso-state-store:8787/next-retry");
assert.equal(byName("Record Google Ads Upload Result").parameters.url, "http://calenso-state-store:8787/upload-result");
assert.equal(byName("Poll Retryable Enhancements").type, "n8n-nodes-base.scheduleTrigger");
assert.deepEqual(byName("Poll Retryable Enhancements").parameters.rule.interval, [{ field: "minutes", minutesInterval: 20 }]);

assertConnected("Claim Authenticated Calenso Match", "Flatten State Store Decision");
assertConnected("Claim Browser Selected Match", "Respond Browser State Decision");
assertConnected("Respond Browser State Decision", "Flatten State Store Decision");
assertConnected("Claim Next Retryable Enhancement", "Flatten State Store Decision");
assertConnected("Flatten State Store Decision", "Route Matched Enhancement");
assertConnected("Prepare Google Ads Payload", "Attach Upload Context");
assertConnected("Attach Upload Context", "Upload Enhanced Conversion");
assert.equal(workflow.nodes.some((node) => node.name === "Merge Upload Response With Context"), false);
assert.equal(workflow.nodes.some((node) => node.name === "Capture Upload Context"), false);
assertConnected("Upload Enhanced Conversion", "Build Upload Result Record");
assertConnected("Build Upload Result Record", "Record Google Ads Upload Result");
assert.ok(isReachable("Receive Browser Selected Appointment", "Upload Enhanced Conversion"), "browser trigger must reach Google upload");
assert.ok(isReachable("Receive Browser Selected Appointment", "Record Google Ads Upload Result"), "browser trigger must reach upload-result");

const prepareAssignments = byName("Prepare Google Ads Payload").parameters.assignments.assignments;
assert.ok(prepareAssignments.some((item) => item.name === "order_id" && item.value.includes("appointment_uuid")));
assert.ok(prepareAssignments.some((item) => item.name === "delivery_claim_id"));
assert.ok(prepareAssignments.some((item) => item.name === "delivery_attempt"));

const buildResultCode = byName("Build Upload Result Record").parameters.jsCode;
assert.match(buildResultCode, /\$\('Attach Upload Context'\)\.first\(\)\.json\.upload_context/);
assert.match(buildResultCode, /appointmentUuid: context\.appointmentUuid/);
assert.match(buildResultCode, /deliveryClaimId: context\.deliveryClaimId/);
assert.match(buildResultCode, /googleAdsResult: \$json/);

const upload = byName("Upload Enhanced Conversion");
assert.equal(upload.onError, "continueRegularOutput");
assert.match(upload.parameters.jsonBody, /"orderId": \$json\.order_id/);

console.log("PASS workflow export state-store topology");
