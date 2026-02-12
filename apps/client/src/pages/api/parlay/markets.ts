import type { NextApiRequest, NextApiResponse } from "next";
import { getDbPool } from "@/lib/parlay-utils";
import { PolymarketMarket } from "@/lib/parlay-types";

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
  console.log(ids)
  const pool = getDbPool();
  const client = await pool.connect();

  try {
    const result = await client.query(
      `
      SELECT raw
      FROM markets
      WHERE platform = 'polymarket'
      AND id = ANY($1)
      `,
      [ids],
    );

    const markets = result.rows.map((r) => r.raw as PolymarketMarket);

    return res.status(200).json({ markets });
  } catch (err) {
    console.error("get-markets failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
    await pool.end();
  }
}
