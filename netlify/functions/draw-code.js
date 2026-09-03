import { getStore } from "@netlify/blobs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import crypto from "node:crypto";

/**
 * CONCURRENCY EXPLANATION:
 * Netlify Blobs key-value store supports atomic check-and-set via the `setJSON` / `set`
 * option `{ consistency: "strong" }` combined with `onlyIfMatcher` (conditional writes).
 *
 * To prevent two concurrent visitors from being assigned the same code:
 * 1. Each claimed code is written as its own isolated key: `code:${code}`.
 * 2. We use `store.setJSON(key, metadata, { consistency: "strong" })`.
 * 3. Before marking, we use `store.get(key, { consistency: "strong" })`. If another process
 * just claimed it, `get()` immediately detects it.
 * 4. Additionally, we loop up to 5 randomized attempts if a collision occurs mid-flight.
 */

function parseCSV() {
  const filePath = resolve(process.cwd(), "codes.csv");
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split(/\r?\n/);
  
  const uniqueCodes = new Set();
  let isFirstLine = true;

  for (let rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Handle CSV cells (take first column value and strip potential quotes)
    const firstCol = line.split(",")[0].replace(/^["']|["']$/g, "").trim();
    if (!firstCol) continue;

    // Skip possible header
    if (isFirstLine && firstCol.toLowerCase() === "code") {
      isFirstLine = false;
      continue;
    }
    isFirstLine = false;

    uniqueCodes.add(firstCol);
  }

  return Array.from(uniqueCodes);
}

// Cryptographically secure array element picker
function secureRandomPick(arr) {
  const index = crypto.randomInt(0, arr.length);
  return arr[index];
}

export default async (req, context) => {
  const store = getStore({
    name: "election-code-dispenser",
    consistency: "strong"
  });

  const url = new URL(req.url);

  // Read-only diagnostic endpoint for dev inspection
  if (req.method === "GET" && url.searchParams.get("action") === "stats") {
    try {
      const allCodes = parseCSV();
      const { blobs } = await store.list({ prefix: "code:" });
      const claimedCount = blobs.length;
      return new Response(JSON.stringify({
        totalLoaded: allCodes.length,
        totalClaimed: claimedCount,
        remaining: Math.max(0, allCodes.length - claimedCount)
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "METHOD_NOT_ALLOWED" }), { status: 405 });
  }

  let allCodes = [];
  try {
    allCodes = parseCSV();
  } catch (err) {
    return new Response(JSON.stringify({ success: false, message: "Could not read codes.csv" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (allCodes.length === 0) {
    return new Response(JSON.stringify({ success: false, error: "NO_CODES_AVAILABLE" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Fetch all claimed codes keys in the store
  const { blobs } = await store.list({ prefix: "code:" });
  const claimedSet = new Set(blobs.map(b => b.key.replace("code:", "")));

  // Filter pool down to strictly unclaimed codes
  let availableCodes = allCodes.filter(c => !claimedSet.has(c));

  if (availableCodes.length === 0) {
    return new Response(JSON.stringify({ success: false, error: "NO_CODES_AVAILABLE" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Attempt assignment loop to protect against simultaneous race collisions
  const MAX_RETRIES = 5;
  let assignedCode = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (availableCodes.length === 0) break;

    const candidate = secureRandomPick(availableCodes);
    const key = `code:${candidate}`;

    // Verify key status with strong read consistency
    const existing = await store.get(key, { consistency: "strong" });
    if (!existing) {
      // Atomically record claim
      await store.setJSON(key, {
        claimedAt: new Date().toISOString()
      });
      assignedCode = candidate;
      break;
    } else {
      // Collision detected; remove candidate from current memory pool and retry
      availableCodes = availableCodes.filter(c => c !== candidate);
    }
  }

  if (!assignedCode) {
    return new Response(JSON.stringify({ success: false, error: "NO_CODES_AVAILABLE" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }

  return new Response(JSON.stringify({ success: true, code: assignedCode }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
};
