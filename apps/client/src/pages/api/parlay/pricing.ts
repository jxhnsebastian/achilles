import type { NextApiRequest, NextApiResponse } from "next";
import {
  getParlayPricing,
  ParlayPricingResponse,
  PricingLegInput,
} from "@/lib/polymarketPricing";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ParlayPricingResponse | { error: string }>,
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { legs } = req.body as { legs?: PricingLegInput[] };

  if (!Array.isArray(legs) || !legs.length) {
    return res.status(400).json({ error: "legs are required" });
  }

  try {
    const pricing = await getParlayPricing(legs);
    return res.status(200).json(pricing);
  } catch (error: any) {
    console.error("Parlay pricing fetch failed:", error);
    return res.status(500).json({ error: "Failed to fetch parlay pricing" });
  }
}
