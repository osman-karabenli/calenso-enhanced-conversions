"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");

const OUTPUT = "workflows/calenso-enhanced-conversions-pipeline.browser-matched.json";
const productionWorkflow = JSON.parse(fs.readFileSync("workflows/calenso-enhanced-conversions-pipeline.json", "utf8"));

function productionNodeCode(name) {
  const sourceNode = productionWorkflow.nodes.find((workflowNode) => workflowNode.name === name);
  if (!sourceNode || !sourceNode.parameters || typeof sourceNode.parameters.jsCode !== "string") {
    throw new Error(`Unable to find production Code node: ${name}`);
  }

  return sourceNode.parameters.jsCode;
}

function id(name) {
  return crypto.createHash("sha1").update(name).digest("hex").slice(0, 8) + "-0000-4000-8000-" + crypto.createHash("sha1").update("node:" + name).digest("hex").slice(0, 12);
}

function node(name, type, position, parameters, extra = {}) {
  return {
    parameters,
    type,
    typeVersion: extra.typeVersion || 2,
    position,
    id: id(name),
    name,
    ...extra,
  };
}

function httpStateNode(name, position, path, jsonBodyExpression) {
  return node(name, "n8n-nodes-base.httpRequest", position, {
    method: "POST",
    url: `http://calenso-state-store:8787${path}`,
    sendBody: true,
    specifyBody: "json",
    jsonBody: jsonBodyExpression,
    options: {
      timeout: 10000,
    },
  }, { typeVersion: 4.4 });
}

const flattenDecisionCode = `
const data = $json;
if (data.action !== 'SEND_ENHANCEMENT') {
  return [{ json: data }];
}
return [{
  json: {
    ...data.conversionData,
    match_status: 'SEND_ENHANCEMENT',
    match_reason: data.reason,
    match_source: data.source,
    appointment_uuid: data.appointmentUuid,
    order_id: data.orderId,
    delivery_attempt: data.deliveryAttempt,
    delivery_claim_id: data.deliveryClaimId,
  },
}];
`;

const browserRequestCode = `
let body = $json.body;
if (typeof body === 'string') {
  try {
    body = JSON.parse(body);
  } catch (error) {
    body = {};
  }
}
return [{
  json: {
    appointmentUuid: body?.appointment_uuid,
  },
}];
`;

const uploadContextCode = `
return items.map((item) => ({
  json: {
    ...item.json,
    upload_context: {
      appointmentUuid: item.json.order_id || item.json.appointment_uuid,
      deliveryClaimId: item.json.delivery_claim_id,
      deliveryAttempt: item.json.delivery_attempt,
    },
  },
}));
`;

const finalizeUploadCode = `
const context = $('Attach Upload Context').first().json.upload_context;
return [{
  json: {
    appointmentUuid: context.appointmentUuid,
    deliveryClaimId: context.deliveryClaimId,
    googleAdsResult: $json,
  },
}];
`;

const nodes = [
  node("Receive Calenso Booking", "n8n-nodes-base.webhook", [0, -220], {
    httpMethod: "POST",
    path: "calenso-customer-test",
    options: {},
  }, {
    typeVersion: 2.1,
    webhookId: "88d91a37-50fb-44ef-b4f2-50e851f925db",
  }),
  node("Receive Browser Selected Appointment", "n8n-nodes-base.webhook", [0, 220], {
    httpMethod: "POST",
    path: "calenso-browser-selected-appointment",
    responseMode: "responseNode",
    options: {},
  }, {
    typeVersion: 2.1,
    webhookId: "browser-selected-appointment-local-draft",
  }),
  node("Poll Retryable Enhancements", "n8n-nodes-base.scheduleTrigger", [0, 520], {
    rule: {
      interval: [
        {
          field: "minutes",
          minutesInterval: 1,
        },
      ],
    },
  }, { typeVersion: 1.2 }),
  node("Minimize Conversion Data", "n8n-nodes-base.set", [256, -220], {
    assignments: {
      assignments: [
        { id: "event-type", name: "event_type", value: "={{ $json.body.type }}", type: "string" },
        { id: "event-created", name: "event_created", value: "={{ $json.body.created }}", type: "string" },
        { id: "appointment-uuid", name: "appointment_uuid", value: "={{ $json.body.data.appointment.uuid }}", type: "string" },
        { id: "appointment-start", name: "appointment_start_utc", value: "={{ $json.body.data.appointment.start_utc }}", type: "string" },
        { id: "customer-uuid", name: "customer_uuid", value: "={{ $json.body.data.appointment.customer.uuid }}", type: "string" },
        { id: "email", name: "email", value: "={{ $json.body.data.appointment.customer.email }}", type: "string" },
        { id: "phone", name: "phone", value: "={{ $json.body.data.appointment.customer.phone }}", type: "string" },
      ],
    },
    options: {},
  }, { typeVersion: 3.4 }),
  node("Validate Conversion Data", "n8n-nodes-base.code", [496, -220], {
    jsCode: productionNodeCode("Validate Conversion Data"),
  }),
  node("Route Valid Conversion", "n8n-nodes-base.if", [736, -220], {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 3 },
      conditions: [
        {
          id: "validation-ok",
          leftValue: "={{ $json.validation_status.trim() }}",
          rightValue: "OK",
          operator: { type: "string", operation: "equals", name: "filter.operator.equals" },
        },
      ],
      combinator: "and",
    },
    options: {},
  }, { typeVersion: 2.3 }),
  httpStateNode("Claim Authenticated Calenso Match", [976, -220], "/calenso-webhook", "={{ { appointmentUuid: $json.appointment_uuid, conversionData: $json } }}"),
  node("Normalize Browser Selection Request", "n8n-nodes-base.code", [256, 220], { jsCode: browserRequestCode }),
  httpStateNode("Claim Browser Selected Match", [496, 220], "/browser-selection", "={{ $json }}"),
  node("Respond Browser State Decision", "n8n-nodes-base.respondToWebhook", [736, 220], {
    respondWith: "json",
    responseBody: "={{ { action: $json.action } }}",
    options: {
      responseHeaders: {
        entries: [
          { name: "Access-Control-Allow-Origin", value: "https://www.physiotherapie-rieckmann.de" },
          { name: "Access-Control-Allow-Methods", value: "POST, OPTIONS" },
          { name: "Access-Control-Allow-Headers", value: "Content-Type" },
          { name: "Cache-Control", value: "no-store" },
        ],
      },
    },
  }, { typeVersion: 1.4 }),
  httpStateNode("Claim Next Retryable Enhancement", [256, 520], "/next-retry", "={{ {} }}"),
  node("Flatten State Store Decision", "n8n-nodes-base.code", [1216, 24], { jsCode: flattenDecisionCode }),
  node("Route Matched Enhancement", "n8n-nodes-base.if", [1456, 24], {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 3 },
      conditions: [
        {
          id: "matched-send",
          leftValue: "={{ $json.match_status }}",
          rightValue: "SEND_ENHANCEMENT",
          operator: { type: "string", operation: "equals", name: "filter.operator.equals" },
        },
      ],
      combinator: "and",
    },
    options: {},
  }, { typeVersion: 2.3 }),
  node("Normalize Customer Identifiers", "n8n-nodes-base.code", [1696, -64], {
    jsCode: productionNodeCode("Normalize Customer Identifiers"),
  }),
  node("Hash Email Identifier", "n8n-nodes-base.crypto", [1936, 128], {
    value: "={{ $json.normalized_email }}",
    dataPropertyName: "hashed_email",
  }, { typeVersion: 2 }),
  node("Hash Phone Identifier", "n8n-nodes-base.code", [2176, 128], {
    jsCode: productionNodeCode("Hash Phone Identifier"),
  }),
  node("Prepare Google Ads Payload", "n8n-nodes-base.set", [2416, 128], {
    assignments: {
      assignments: [
        { id: "order-id", name: "order_id", value: "={{ $json.appointment_uuid }}", type: "string" },
        { id: "delivery-claim-id", name: "delivery_claim_id", value: "={{ $json.delivery_claim_id }}", type: "string" },
        { id: "delivery-attempt", name: "delivery_attempt", value: "={{ $json.delivery_attempt }}", type: "number" },
        { id: "adjustment-type", name: "adjustment_type", value: "ENHANCEMENT", type: "string" },
        { id: "hashed-email", name: "hashed_email", value: "={{ $json.hashed_email }}", type: "string" },
        { id: "conversion-date", name: "conversion_date_time", value: "={{ $json.event_created + '+00:00' }}", type: "string" },
        { id: "conversion-action", name: "conversion_action", value: "customers/4345692592/conversionActions/7681227340", type: "string" },
      ],
    },
    includeOtherFields: true,
    options: {},
  }, { typeVersion: 3.4 }),
  node("Attach Upload Context", "n8n-nodes-base.code", [2656, 128], { jsCode: uploadContextCode }),
  node("Upload Enhanced Conversion", "n8n-nodes-base.httpRequest", [2896, 128], {
    method: "POST",
    url: "https://googleads.googleapis.com/v25/customers/4345692592:uploadConversionAdjustments",
    authentication: "genericCredentialType",
    genericAuthType: "oAuth2Api",
    sendHeaders: true,
    headerParameters: { parameters: [{ name: "developer-token", value: "={{ $env.GOOGLE_ADS_DEVELOPER_TOKEN }}" }] },
    sendBody: true,
    specifyBody: "json",
    jsonBody: "={{\n  {\n    \"partialFailure\": true,\n    \"conversionAdjustments\": [\n      {\n        \"conversionAction\": $json.conversion_action,\n        \"adjustmentType\": \"ENHANCEMENT\",\n        \"orderId\": $json.order_id,\n        \"gclidDateTimePair\": {\n          \"conversionDateTime\": $json.conversion_date_time\n        },\n        \"userIdentifiers\": [\n          {\n            \"userIdentifierSource\": \"FIRST_PARTY\",\n            \"hashedEmail\": $json.hashed_email\n          },\n          ...($json.hashed_phone\n            ? [\n                {\n                  \"userIdentifierSource\": \"FIRST_PARTY\",\n                  \"hashedPhoneNumber\": $json.hashed_phone\n                }\n              ]\n            : [])\n        ]\n      }\n    ]\n  }\n}}",
    options: {
      timeout: 30000,
    },
  }, {
    typeVersion: 4.4,
    onError: "continueRegularOutput",
    credentials: {
      oAuth2Api: {
        id: "8LjIEewYN0hjsGZV",
        name: "Unnamed credential",
      },
    },
  }),
  node("Build Upload Result Record", "n8n-nodes-base.code", [3136, 128], { jsCode: finalizeUploadCode }),
  httpStateNode("Record Google Ads Upload Result", [3376, 128], "/upload-result", "={{ $json }}"),
];

const connect = (nodeName, targets) => ({ [nodeName]: { main: [targets.map((target) => ({ node: target, type: "main", index: 0 }))] } });

const workflow = {
  name: "Calenso Enhanced Conversions - Browser Selected UUID Matching",
  nodes,
  pinData: {},
  connections: {
    ...connect("Receive Calenso Booking", ["Minimize Conversion Data"]),
    ...connect("Minimize Conversion Data", ["Validate Conversion Data"]),
    ...connect("Validate Conversion Data", ["Route Valid Conversion"]),
    "Route Valid Conversion": {
      main: [[{ node: "Claim Authenticated Calenso Match", type: "main", index: 0 }]],
    },
    ...connect("Claim Authenticated Calenso Match", ["Flatten State Store Decision"]),
    ...connect("Receive Browser Selected Appointment", ["Normalize Browser Selection Request"]),
    ...connect("Normalize Browser Selection Request", ["Claim Browser Selected Match"]),
    ...connect("Claim Browser Selected Match", ["Respond Browser State Decision"]),
    ...connect("Respond Browser State Decision", ["Flatten State Store Decision"]),
    ...connect("Poll Retryable Enhancements", ["Claim Next Retryable Enhancement"]),
    ...connect("Claim Next Retryable Enhancement", ["Flatten State Store Decision"]),
    ...connect("Flatten State Store Decision", ["Route Matched Enhancement"]),
    "Route Matched Enhancement": {
      main: [[{ node: "Normalize Customer Identifiers", type: "main", index: 0 }]],
    },
    ...connect("Normalize Customer Identifiers", ["Hash Email Identifier"]),
    ...connect("Hash Email Identifier", ["Hash Phone Identifier"]),
    ...connect("Hash Phone Identifier", ["Prepare Google Ads Payload"]),
    ...connect("Prepare Google Ads Payload", ["Attach Upload Context"]),
    ...connect("Attach Upload Context", ["Upload Enhanced Conversion"]),
    ...connect("Upload Enhanced Conversion", ["Build Upload Result Record"]),
    ...connect("Build Upload Result Record", ["Record Google Ads Upload Result"]),
  },
  active: false,
  settings: {
    executionOrder: "v1",
    binaryMode: "separate",
    availableInMCP: false,
  },
  versionId: "00000000-0000-4000-8000-000000000001",
  meta: {
    templateCredsSetupCompleted: false,
  },
  nodeGroups: [],
  id: "calensoBrowserMatchedDraft",
  tags: [],
};

fs.writeFileSync(OUTPUT, JSON.stringify(workflow, null, 2) + "\n");
console.log(`wrote ${OUTPUT}`);
