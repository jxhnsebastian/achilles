import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import { v4 as uuidv4 } from "uuid";
import { generateParlays } from "./parlay";
import { Request, Response } from "express";
import { ParlayInput, calculateParlayOdds, validateParlayInput } from "./odds";
import { Request as RequestModel, RequestStatus } from "./models/Request";
import connectDatabase from "./db";

const PORT = process.env.PORT || 5000;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET!;
const MONGO_URL = process.env.MONGO_URI!;
const CONCURRENCY = Number(process.env.CONCURRENCY || 2);

// ── Mongo ──────────────────────────────────────────────────────────────────────
connectDatabase()
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// ── In-memory Queue ────────────────────────────────────────────────────────────

interface QueueJob {
  jobId: string;
  requestId: string;
  query: string;
  tweet: boolean;
  enqueuedAt: Date;
  startedAt?: Date;
  status: "waiting" | "running";
  attempts: number;
}

const runningJobs = new Map<string, QueueJob>();
const waitQueue: QueueJob[] = [];

function queueStats() {
  return {
    running: runningJobs.size,
    waiting: waitQueue.length,
    runningJobs: Array.from(runningJobs.values()).map((j) => ({
      jobId: j.jobId,
      requestId: j.requestId,
      startedAt: j.startedAt,
      attempts: j.attempts,
    })),
  };
}

async function updateRequestStatus(requestId: string, status: RequestStatus) {
  await RequestModel.findOneAndUpdate({ requestId }, { status, updatedAt: new Date() });
  console.log(`[${requestId}] Status updated to ${status}`);
}

async function executeJob(job: QueueJob) {
  job.status = "running";
  job.startedAt = new Date();
  runningJobs.set(job.jobId, job);

  console.log(`[${job.requestId}] Starting job ${job.jobId} (running: ${runningJobs.size})`);

  try {
    await generateParlays({
      requestId: job.requestId,
      query: job.query,
      tweet: job.tweet,
    });
    await updateRequestStatus(job.requestId, "completed");
    console.log(`[${job.requestId}] Job ${job.jobId} completed`);
  } catch (err) {
    job.attempts += 1;
    console.error(`[${job.requestId}] Job ${job.jobId} failed (attempt ${job.attempts}):`, err);
    await updateRequestStatus(job.requestId, "failed");
  } finally {
    runningJobs.delete(job.jobId);
    drainQueue();
  }
}

function drainQueue() {
  while (runningJobs.size < CONCURRENCY && waitQueue.length > 0) {
    const next = waitQueue.shift()!;
    console.log(
      `[${next.requestId}] Dequeuing job ${next.jobId} from waitQueue (position was ${waitQueue.length})`,
    );
    executeJob(next); // intentionally not awaited — fire and forget
  }
}

async function enqueueJob(requestId: string, query: string, tweet: boolean): Promise<QueueJob> {
  const job: QueueJob = {
    jobId: uuidv4(),
    requestId,
    query,
    tweet,
    enqueuedAt: new Date(),
    status: "waiting",
    attempts: 0,
  };

  if (runningJobs.size < CONCURRENCY) {
    executeJob(job); // fire and forget
  } else {
    waitQueue.push(job);
    console.log(
      `[${requestId}] Job ${job.jobId} queued (position: ${waitQueue.length}, running: ${runningJobs.size})`,
    );
  }

  return job;
}

// ── Middleware ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const secret = req.headers["x-internal-secret"];
  if (!secret || secret !== INTERNAL_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ── Routes ─────────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", ...queueStats() });
});

app.post("/enqueue", async (req, res) => {
  const { requestId, query, tweet } = req.body;

  if (!requestId || !query) {
    return res.status(400).json({ error: "requestId and query are required" });
  }

  try {
    // Write pending entry to Mongo
    await RequestModel.create({
      requestId,
      markets: [], // populated later by generateParlays if needed
      status: "pending",
    });

    const job = await enqueueJob(requestId, query, tweet ?? false);

    return res.status(202).json({
      requestId,
      jobId: job.jobId,
      status: job.status,
      queuePosition: job.status === "waiting" ? waitQueue.length : null,
    });
  } catch (err) {
    console.error("Enqueue error:", err);
    return res.status(500).json({ error: "Failed to enqueue job" });
  }
});

// Inspect live queue state
app.get("/queue/status", (_req, res) => {
  return res.json(queueStats());
});

// ── POST /parlay/odds ──────────────────────────────────────────────────────────

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

  const allLegsFailed = result.legs.every((leg) => leg.invalidReason !== undefined);

  if (allLegsFailed) {
    return res.status(422).json({
      success: false,
      error: "All parlay legs failed to resolve",
      data: result,
    });
  }

  return res.status(200).json({ success: true, data: result });
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Parlay server running on port ${PORT}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Auth: ${INTERNAL_SECRET ? "✓" : "✗"}`);
});
