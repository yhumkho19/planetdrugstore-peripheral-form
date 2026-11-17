const crypto = require("node:crypto");
const http = require("node:http");
const admin = require("../functions/node_modules/firebase-admin");

const PROJECT_ID = "demo-peripherals-local";
const PORT = 5002;
const allowedOrigins = new Set([
  "http://127.0.0.1:5000",
  "http://localhost:5000"
]);

if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8081"
    || process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9099") {
  throw new Error("Local employee authentication requires both local Firebase emulators.");
}

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const app = admin.initializeApp({
  credential: admin.credential.cert({
    projectId: PROJECT_ID,
    clientEmail: "local-test-auth@demo-peripherals-local.iam.gserviceaccount.com",
    privateKey
  }),
  projectId: PROJECT_ID
}, "local-employee-auth");
const db = admin.firestore(app);
db.settings({ host: "127.0.0.1:8081", ssl: false });

const attemptsByAddress = new Map();
const MAX_ATTEMPTS = 10;
const RATE_WINDOW_MS = 5 * 60 * 1000;

function sendJson(response, status, body, origin) {
  response.writeHead(status, {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    vary: "Origin"
  });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => {
      body += chunk;
      if (body.length > 8192) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function allowAttempt(address) {
  const now = Date.now();
  const recentAttempts = (attemptsByAddress.get(address) || [])
    .filter(timestamp => now - timestamp < RATE_WINDOW_MS);
  if (recentAttempts.length >= MAX_ATTEMPTS) {
    attemptsByAddress.set(address, recentAttempts);
    return false;
  }
  recentAttempts.push(now);
  attemptsByAddress.set(address, recentAttempts);
  return true;
}

function matchesPassword(password, passwordHash) {
  if (typeof passwordHash !== "string" || !/^[a-f0-9]{64}$/i.test(passwordHash)) return false;
  const supplied = Buffer.from(crypto.createHash("sha256").update(password, "utf8").digest("hex"));
  const stored = Buffer.from(passwordHash.toLowerCase());
  return crypto.timingSafeEqual(supplied, stored);
}

const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin || "";
  if (!allowedOrigins.has(origin)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {}, origin);
    return;
  }
  if (request.url === "/health" && request.method === "GET") {
    sendJson(response, 200, { ok: true, projectId: PROJECT_ID }, origin);
    return;
  }
  if (request.url !== "/employee-authenticate" || request.method !== "POST") {
    sendJson(response, 404, { error: "Not found." }, origin);
    return;
  }
  if (!allowAttempt(request.socket.remoteAddress || "local")) {
    sendJson(response, 429, { error: "Too many sign-in attempts. Please wait and try again." }, origin);
    return;
  }

  try {
    const body = await readJson(request);
    const staffIdInput = typeof body.staffId === "string" ? body.staffId.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!staffIdInput || staffIdInput.length > 120 || !password || password.length > 256) {
      sendJson(response, 400, { error: "Enter your Staff ID and password." }, origin);
      return;
    }

    const staffId = staffIdInput.toLowerCase();
    const employeeSnapshot = await db.collection("employees").doc(staffId).get();
    if (!employeeSnapshot.exists) {
      sendJson(response, 401, { error: "Incorrect Staff ID or password." }, origin);
      return;
    }
    const employee = employeeSnapshot.data();
    if (!matchesPassword(password, employee.passwordHash)
        || typeof employee.staffId !== "string"
        || employee.staffId.trim().toLowerCase() !== staffId) {
      sendJson(response, 401, { error: "Incorrect Staff ID or password." }, origin);
      return;
    }

    const tokenStaffId = employee.staffId.trim().toLowerCase();
    const uid = `employee-${crypto.createHash("sha256").update(tokenStaffId).digest("hex").slice(0, 40)}`;
    const customToken = await admin.auth(app).createCustomToken(uid, {
      employee: true,
      staffId: tokenStaffId,
      employeeDepartment: typeof employee.department === "string"
        ? employee.department.trim().toLowerCase()
        : ""
    });
    sendJson(response, 200, {
      customToken,
      employee: {
        staffId: employee.staffId,
        name: typeof employee.name === "string" ? employee.name : "",
        email: typeof employee.email === "string" ? employee.email : "",
        department: typeof employee.department === "string" ? employee.department : "",
        branch: typeof employee.branch === "string" ? employee.branch : ""
      }
    }, origin);
  } catch (error) {
    console.error("Local employee authentication failed:", error);
    sendJson(response, 503, { error: "Local employee sign-in is unavailable. Check that the Firebase emulators are running." }, origin);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Local employee authentication is ready at http://127.0.0.1:${PORT}.`);
});

function stopServer() {
  server.close(() => {
    void app.delete().finally(() => process.exit(0));
  });
}

process.on("SIGINT", stopServer);
process.on("SIGTERM", stopServer);
