import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { generateParlays } from "@/lib/parlay";

const PARLAY_SERVER_URL = process.env.PARLAY_SERVER_URL!;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET!;
const USE_LOCAL_PARLAY = process.env.USE_LOCAL_PARLAY === "true";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { query, tweet } = req.body;

  if (!query) {
    return res.status(400).json({ error: "Invalid query" });
  }

  const requestId = randomUUID();

  try {
    if (USE_LOCAL_PARLAY) {
      // Local execution (fire-and-forget)
      console.log(`[${requestId}] Using LOCAL parlay execution`);
      processAnalysisLocally(requestId, query, tweet).catch(console.error);
      return res.status(200).json({ requestId });
    } else {
      // EC2 execution (queue job)
      console.log(`[${requestId}] Using EC2 parlay execution`);
      console.log(PARLAY_SERVER_URL, INTERNAL_SECRET, query, tweet);
      
      const ecRes = await fetch(`${PARLAY_SERVER_URL}/enqueue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": INTERNAL_SECRET,
        },
        body: JSON.stringify({ requestId, query, tweet }),
      });

      if (!ecRes.ok) {
        const err = await ecRes.json();
        console.error("EC2 enqueue failed:", err);
        return res.status(502).json({ error: "Failed to enqueue job" });
      }

      return res.status(200).json({ requestId });
    }
  } catch (error) {
    console.error("Error starting analysis:", error);
    return res.status(500).json({ error: "Failed to start analysis" });
  }
}

async function processAnalysisLocally(requestId: string, query: string, tweet: boolean) {
  try {
    await generateParlays({ requestId, query, tweet });
  } catch (error) {
    console.error(`Analysis error for ${requestId}`, error);
  }
}
