"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const {
  claimNextRetry,
  createInitialState,
  handleAuthenticatedCalensoWebhook,
  handleBrowserSelection,
  recordGoogleAdsUploadResult,
} = require("../lib/appointment-matcher");

const PORT = Number(process.env.CALENSO_STATE_STORE_PORT || 8787);
const STATE_FILE = process.env.CALENSO_STATE_STORE_FILE || "/data/calenso-enhancement-state.json";
const BACKUP_FILE = `${STATE_FILE}.bak`;
const configuredBodyLimit = Number(process.env.CALENSO_STATE_STORE_MAX_BODY_BYTES || 64 * 1024);
const MAX_BODY_BYTES = Number.isFinite(configuredBodyLimit) && configuredBodyLimit > 0 ? configuredBodyLimit : 64 * 1024;

let state;
let chain = Promise.resolve();

function isStateObject(value) {
  const buckets = ["browserSelections", "pendingCalenso", "deliveryClaims", "acceptedOrderIds", "failedDeliveries", "deadLetters"];
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && buckets.every((key) => (
    value[key] && typeof value[key] === "object" && !Array.isArray(value[key])
  )));
}

function readStateFile(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!isStateObject(parsed)) {
    throw new Error(`invalid state schema in ${filePath}`);
  }
  return parsed;
}

function loadState() {
  try {
    return readStateFile(STATE_FILE);
  } catch (error) {
    if (error.code === "ENOENT") {
      if (fs.existsSync(BACKUP_FILE)) {
        const recovered = readStateFile(BACKUP_FILE);
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.copyFileSync(BACKUP_FILE, STATE_FILE);
        console.warn(`state recovered from backup ${BACKUP_FILE}`);
        return recovered;
      }
      return createInitialState();
    }

    try {
      const recovered = readStateFile(BACKUP_FILE);
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.copyFileSync(BACKUP_FILE, STATE_FILE);
      console.warn(`state recovered from backup after primary failure: ${error.message}`);
      return recovered;
    } catch (backupError) {
      throw new Error(`state load failed and no valid backup is available: ${error.message}; backup: ${backupError.message}`);
    }
  }
}

function saveState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tempFile = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(state, null, 2)}\n`);
  if (fs.existsSync(STATE_FILE)) {
    fs.copyFileSync(STATE_FILE, BACKUP_FILE);
  }
  fs.renameSync(tempFile, STATE_FILE);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let receivedBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    if (Number(req.headers["content-length"] || 0) > MAX_BODY_BYTES) {
      fail(Object.assign(new Error("request body too large"), { code: "BODY_TOO_LARGE" }));
      req.resume();
      return;
    }

    req.on("data", (chunk) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_BODY_BYTES) {
        fail(Object.assign(new Error("request body too large"), { code: "BODY_TOO_LARGE" }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      if (chunks.length === 0) {
        settled = true;
        resolve({});
        return;
      }
      try {
        settled = true;
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        fail(error);
      }
    });
    req.on("error", fail);
  });
}

function writeJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(`${JSON.stringify(body)}\n`);
}

function withStateLock(fn) {
  const run = chain.then(async () => {
    const result = await fn();
    saveState();
    return result;
  });
  chain = run.catch(() => {});
  return run;
}

function decisionStatus(decision) {
  if (decision.action === "REJECT") {
    return 400;
  }
  if (decision.action === "STORAGE_ERROR") {
    return 507;
  }
  return 200;
}

async function route(req, res) {
  if (req.method === "GET" && req.url === "/health") {
    writeJson(res, 200, { ok: true });
    return;
  }

  if (req.method !== "POST") {
    writeJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    if (error.code === "BODY_TOO_LARGE") {
      writeJson(res, 413, { error: "REQUEST_BODY_TOO_LARGE" });
      return;
    }
    writeJson(res, 400, { error: "INVALID_JSON" });
    return;
  }

  try {
    const decision = await withStateLock(() => {
      if (req.url === "/browser-selection") {
        return handleBrowserSelection(state, body);
      }
      if (req.url === "/calenso-webhook") {
        return handleAuthenticatedCalensoWebhook(state, body);
      }
      if (req.url === "/upload-result") {
        return recordGoogleAdsUploadResult(state, body);
      }
      if (req.url === "/next-retry") {
        return claimNextRetry(state, body);
      }
      return { action: "REJECT", reason: "UNKNOWN_ROUTE" };
    });
    writeJson(res, decisionStatus(decision), decision);
  } catch (error) {
    console.error(`state operation failed: ${error.stack || error.message}`);
    writeJson(res, 500, { action: "STORAGE_ERROR", reason: "STATE_STORE_OPERATION_FAILED" });
  }
}

try {
  state = loadState();
  if (!fs.existsSync(STATE_FILE)) {
    saveState();
  }
  http.createServer(route).listen(PORT, "0.0.0.0", () => {
    console.log(`calenso state store listening on ${PORT}, file=${STATE_FILE}`);
  });
} catch (error) {
  console.error(`state store refused to start: ${error.stack || error.message}`);
  process.exitCode = 1;
}
