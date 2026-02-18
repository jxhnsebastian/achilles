import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";

const EC2_SERVER_URL = process.env.EC2_SERVER_URL!;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET!;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { query, tweet, marketIds } = req.body;

  if (!query) {
    return res.status(400).json({ error: "Invalid query" });
  }

  const requestId = randomUUID();

  try {
    const ecRes = await fetch(`${EC2_SERVER_URL}/enqueue`, {
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
  } catch (error) {
    console.error("Error dispatching to EC2:", error);
    return res.status(500).json({ error: "Failed to start analysis" });
  }
}