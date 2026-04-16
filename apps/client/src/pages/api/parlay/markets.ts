import type { NextApiRequest, NextApiResponse } from "next";
import { PolymarketMarket } from "@/lib/parlay-types";
import connectDatabase from "@/lib/db";
import { Market } from "@/models/Market";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { marketIds }: { marketIds?: string[] } = req.body;

  if (!marketIds || !marketIds.length) {
    return res.status(200).json({ markets: [] });
  }

  // "polymarket:123" → "123"
  const ids = marketIds.map((m) => m.split(":")[1]);
  console.log(ids);
  await connectDatabase();

  try {
    const docs = await Market.find(
      { platform: "polymarket", id: { $in: ids } },
      { raw: 1, _id: 0 },
    ).lean();

    const markets = docs.map((d: any) => d.raw as PolymarketMarket);

    return res.status(200).json({ markets });
  } catch (err) {
    console.error("get-markets failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
