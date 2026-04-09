import "dotenv/config";
import express from "express";
import Bull from "bull";
import { getDbPool, withRetry } from "./utils";
import { generateParlays } from "./parlay";
import { Request, Response } from "express";
import { ParlayInput, calculateParlayOdds, validateParlayInput } from "./odds";

const PORT = process.env.PORT || 5000;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET!;
const REDIS_URL = process.env.REDIS_URL;
const SKIP_REDIS = process.env.SKIP_REDIS === "true" || !REDIS_URL;
const CONCURRENCY = Number(process.env.CONCURRENCY || 2);

interface ParlayJob {
  requestId: string;
  query: string;
  tweet: boolean;
}

// Only initialize Bull queue if not skipping Redis
const parlayQueue = SKIP_REDIS
  ? null
  : new Bull<ParlayJob>("parlay-generation", {
      redis: {
        host: "knowing-airedale-30341.upstash.io",
        port: 6379,
        password: "AXaFAAIncDJiZWY1MWMyMDFkMzc0OTNhYWQ5MTRmOTIyNzQ3NGM1MXAyMzAzNDE",
        username: "default",
        tls: {},
      },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    });

async function updateRequestStatus(requestId: string, status: "pending" | "completed" | "failed") {
  const pool = getDbPool();

  await withRetry(
    async () => {
      const client = await pool.connect();
      try {
        await client.query(
          `UPDATE requests
           SET status = $1,
               updated_at = CURRENT_TIMESTAMP
           WHERE request_id = $2`,
          [status, requestId],
        );
        console.log(`[${requestId}] Status updated to ${status}`);
      } finally {
        client.release();
      }
    },
    { maxRetries: 2, initialDelay: 1000 },
    `updateRequestStatus for ${requestId}`,
  );
}

// Only set up Bull queue processing if not skipping Redis
if (!SKIP_REDIS && parlayQueue) {
  parlayQueue.process(CONCURRENCY, async (job: any) => {
    const { requestId, query, tweet } = job.data;
    console.log(`[${requestId}] Processing job ${job.id}`);

    await updateRequestStatus(requestId, "pending");

    try {
      await generateParlays({ requestId, query, tweet });

      await updateRequestStatus(requestId, "completed");
      console.log(`[${requestId}] Completed`);
    } catch (err) {
      console.error(`[${requestId}] Generation failed:`, err);
      if (job.attemptsMade >= (job.opts.attempts ?? 1) - 1) {
        await updateRequestStatus(requestId, "failed");
      }
      throw err;
    }
  });

  parlayQueue.on("failed", (job, err) => {
    console.error(`Job ${job.id} failed after all attempts:`, err.message);
  });

  parlayQueue.on("completed", (job) => {
    console.log(`Job ${job.id} completed successfully`);
  });
}

// ── Middleware ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Simple shared-secret auth for all routes
app.use((req, res, next) => {
  if (req.path === "/health") return next(); // health check is public
  const secret = req.headers["x-internal-secret"];
  if (!secret || secret !== INTERNAL_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ── Routes ─────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", mode: SKIP_REDIS ? "direct" : "queue" });
});

app.post("/enqueue", async (req, res) => {
  const { requestId, query, tweet } = req.body;

  if (!requestId || !query) {
    return res.status(400).json({ error: "requestId and query are required" });
  }

  try {
    if (SKIP_REDIS) {
      // Direct execution mode (local dev)
      console.log(`[${requestId}] Running directly (SKIP_REDIS mode)`);
      await updateRequestStatus(requestId, "pending");

      // Run async without blocking the response
      generateParlays({ requestId, query, tweet: tweet ?? false })
        .then(async () => {
          await updateRequestStatus(requestId, "completed");
          console.log(`[${requestId}] Completed`);
        })
        .catch(async (err) => {
          console.error(`[${requestId}] Generation failed:`, err);
          await updateRequestStatus(requestId, "failed");
        });

      return res.status(202).json({ requestId, mode: "direct" });
    } else {
      // Queue mode (production with Redis)
      const job = await parlayQueue!.add({ requestId, query, tweet: tweet ?? false });
      console.log(`[${requestId}] Enqueued as job ${job.id}`);

      return res.status(202).json({ requestId, jobId: job.id, mode: "queue" });
    }
  } catch (err) {
    console.error("Enqueue error:", err);
    return res.status(500).json({ error: "Failed to enqueue job" });
  }
});

// Optional: check job status directly from queue
app.get("/job/:jobId", async (req, res) => {
  if (SKIP_REDIS || !parlayQueue) {
    return res.status(404).json({ error: "Queue mode not enabled" });
  }

  const job = await parlayQueue.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  const state = await job.getState();
  return res.json({ jobId: job.id, state, attempts: job.attemptsMade });
});

// ─────────────────────────────────────────────
// POST /parlay/odds
// ─────────────────────────────────────────────

/**
 * POST /parlay/odds
 *
 * Request body:
 * {
 *   betAmount: number,           // USD amount to bet
 *   legs: [
 *     {
 *       source: "polymarket" | "kalshi",
 *       marketSlug: string,      // Polymarket slug or Kalshi ticker
 *       outcome: string          // Outcome label; Kalshi must be "yes" | "no"
 *     },
 *     ...                        // 2–10 legs
 *   ]
 * }
 *
 * Response 200:
 * {
 *   success: true,
 *   data: ParlayResult
 * }
 *
 * Response 400: validation errors
 * Response 500: unexpected internal error
 */

app.post("/parlay/odds", async (req: Request, res: Response) => {
  const { data, errors } = validateParlayInput(req.body);

  if (errors.length > 0 || data === null) {
    return res.status(400).json({
      success: false,
      error: "Invalid request body",
      details: errors,
    });
  }

  let result;
  try {
    result = await calculateParlayOdds(data as ParlayInput);
  } catch (err) {
    console.error("[POST /parlay/odds] Unexpected error:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error while calculating parlay odds",
      ...(process.env.NODE_ENV !== "production" && {
        detail: err instanceof Error ? err.message : String(err),
      }),
    });
  }

  // 200 even when some legs are invalid — the caller can inspect per-leg errors.
  // Only escalate to 422 if every single leg failed (nothing useful to return).
  const allLegsFailed = result.legs.every((leg) => leg.invalidReason !== undefined);

  if (allLegsFailed) {
    return res.status(422).json({
      success: false,
      error: "All parlay legs failed to resolve",
      data: result,
    });
  }

  return res.status(200).json({
    success: true,
    data: result,
  });
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`EC2 parlay server running on port ${PORT}`);
  console.log(`Mode: ${SKIP_REDIS ? "DIRECT (SKIP_REDIS)" : "QUEUE (Redis)"}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Auth: ${INTERNAL_SECRET ? "✓" : "✗"}`);
});
