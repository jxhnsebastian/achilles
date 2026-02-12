import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { generateParlays } from "@/lib/parlay";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { tweetId } = req.body;

    if (!tweetId) {
      return res.status(400).json({ error: "Invalid tweet id" });
    }

    const requestId = randomUUID();

    // Fire-and-forget async processing
    processAnalysis(requestId, tweetId).catch(console.error);

    return res.status(200).json({ requestId });
  } catch (error) {
    console.error("Error starting analysis:", error);
    return res.status(500).json({ error: "Failed to start analysis" });
  }
}

async function processAnalysis(requestId: string, tweetId: string) {
  try {
    await generateParlays({ requestId, tweetId });
  } catch (error) {
    console.error(`Analysis error for ${requestId}`, error);
  }
}
