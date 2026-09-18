"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createInitialState } = require("../lib/appointment-matcher");

const UUID = "11111111-1111-4111-8111-111111111111";

function getPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForHealth(port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("state-store health check timed out");
}

async function startStore(port, stateFile) {
  const child = spawn(process.execPath, ["services/state-store.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CALENSO_STATE_STORE_PORT: String(port),
      CALENSO_STATE_STORE_FILE: stateFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHealth(port);
  return child;
}

function startRawStore(port, stateFile) {
  return spawn(process.execPath, ["services/state-store.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CALENSO_STATE_STORE_PORT: String(port),
      CALENSO_STATE_STORE_FILE: stateFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForExit(child) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

async function stopStore(child) {
  if (!child.killed) {
    child.kill();
  }
  await new Promise((resolve) => child.once("exit", resolve));
}

async function post(port, pathName, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}

async function postRaw(port, pathName, body) {
  return fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

function calensoBody() {
  return {
    appointmentUuid: UUID,
    conversionData: {
      event_type: "appointment.booking.created",
      event_created: "2026-09-15T10:00:00",
      appointment_uuid: UUID,
      appointment_start_utc: "2026-09-20T09:00:00Z",
      customer_uuid: "customer-a",
      email: "customer@example.test",
      phone: "+4917612345678",
    },
  };
}

async function testConcurrentClaimsAndPersistence() {
  const port = await getPort();
  const stateFile = path.join(os.tmpdir(), `calenso-state-store-${process.pid}.json`);
  try {
    let child = await startStore(port, stateFile);
    assert.equal((await post(port, "/browser-selection", { appointmentUuid: UUID })).action, "WAIT");

    const [first, second] = await Promise.all([
      post(port, "/calenso-webhook", calensoBody()),
      post(port, "/calenso-webhook", calensoBody()),
    ]);

    const actions = [first.action, second.action].sort();
    assert.deepEqual(actions, ["SEND_ENHANCEMENT", "SKIP"]);
    const send = first.action === "SEND_ENHANCEMENT" ? first : second;

    const failure = await post(port, "/upload-result", {
      appointmentUuid: send.orderId,
      deliveryClaimId: send.deliveryClaimId,
      googleAdsResult: { error: "synthetic timeout" },
    });
    assert.equal(failure.action, "RETRYABLE_FAILURE");
    await stopStore(child);

    child = await startStore(port, stateFile);
    const retry = await post(port, "/next-retry", { nowMs: failure.nextRetryAtMs });
    assert.equal(retry.action, "SEND_ENHANCEMENT");
    assert.equal(retry.deliveryAttempt, 2);
    await stopStore(child);
  } finally {
    if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }
  }
}

async function testCorruptStateFailsClosedAndValidBackupRecovers() {
  const port = await getPort();
  const stateFile = path.join(os.tmpdir(), `calenso-state-recovery-${process.pid}.json`);
  const backupFile = `${stateFile}.bak`;
  try {
    let child = await startStore(port, stateFile);
    await post(port, "/browser-selection", { appointmentUuid: UUID });
    await stopStore(child);

    fs.writeFileSync(stateFile, "{broken json");
    child = await startStore(port, stateFile);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    await stopStore(child);

    fs.writeFileSync(stateFile, "{broken json");
    fs.unlinkSync(backupFile);
    const failedChild = startRawStore(port, stateFile);
    const exitCode = await waitForExit(failedChild);
    assert.notEqual(exitCode, 0);
  } finally {
    for (const file of [stateFile, backupFile]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
}

async function testRequestBodyLimit() {
  const port = await getPort();
  const stateFile = path.join(os.tmpdir(), `calenso-state-limit-${process.pid}.json`);
  try {
    const child = await startStore(port, stateFile);
    const response = await postRaw(port, "/browser-selection", JSON.stringify({
      appointmentUuid: UUID,
      padding: "x".repeat(70 * 1024),
    }));
    assert.equal(response.status, 413);
    await stopStore(child);
  } finally {
    for (const file of [stateFile, `${stateFile}.bak`]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
}

(async () => {
  await testConcurrentClaimsAndPersistence();
  console.log("PASS state-store concurrent claims and persistence");
  await testCorruptStateFailsClosedAndValidBackupRecovers();
  console.log("PASS state-store corrupt state fail-closed and backup recovery");
  await testRequestBodyLimit();
  console.log("PASS state-store request body limit");
})();
