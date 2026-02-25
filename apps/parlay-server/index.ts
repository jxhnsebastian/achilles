import express from "express";
import Bull from "bull";
import { getDbPool, withRetry } from "./utils";
import { generateParlays } from "./parlay";
import { getParlayPricing, PricingLegInput } from "./polymarketPricing";

const PORT = process.env.PORT || 5000;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET!;
const REDIS_URL = process.env.REDIS_URL!;
const CONCURRENCY = Number(process.env.CONCURRENCY || 2);

interface ParlayJob {
  requestId: string;
  query: string;
  tweet: boolean;
}

const parlayQueue = new Bull<ParlayJob>("parlay-generation", {
  redis: {
    host: "still-mackerel-17195.upstash.io",
    port: 6379,
    password: "AUMrAAIncDFlYTdlZGI2MjRiN2E0M2FjYmU0ODg2NGQzMDk3ZjhhMXAxMTcxOTU",
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
  res.json({ status: "ok", queue: parlayQueue.name });
});

app.post("/enqueue", async (req, res) => {
  const { requestId, query, tweet } = req.body;

  if (!requestId || !query) {
    return res.status(400).json({ error: "requestId and query are required" });
  }

  try {
    const job = await parlayQueue.add({ requestId, query, tweet: tweet ?? false });
    console.log(`[${requestId}] Enqueued as job ${job.id}`);

    return res.status(202).json({ requestId, jobId: job.id });
  } catch (err) {
    console.error("Enqueue error:", err);
    return res.status(500).json({ error: "Failed to enqueue job" });
  }
});

app.post("/pricing", async (req, res) => {
  const { legs }: { legs?: PricingLegInput[] } = req.body;

  if (!Array.isArray(legs) || !legs.length) {
    return res.status(400).json({ error: "legs are required" });
  }

  try {
    const pricing = await getParlayPricing(legs);
    return res.status(200).json(pricing);
  } catch (error) {
    console.error("Pricing error:", error);
    return res.status(500).json({ error: "Failed to fetch parlay pricing" });
  }
});

// Optional: check job status directly from queue
app.get("/job/:jobId", async (req, res) => {
  const job = await parlayQueue.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  const state = await job.getState();
  return res.json({ jobId: job.id, state, attempts: job.attemptsMade });
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`EC2 parlay server running on port ${PORT}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(INTERNAL_SECRET, REDIS_URL);
});
