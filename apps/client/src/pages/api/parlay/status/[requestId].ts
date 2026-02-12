import type { NextApiRequest, NextApiResponse } from "next";
import { RequestStatusResponse } from "@/lib/parlay-types";
import { getDbPool } from "@/lib/parlay-utils";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { requestId } = req.query;

  if (typeof requestId !== "string") {
    return res.status(400).json({ error: "Invalid requestId" });
  }

  const pool = getDbPool();
  const client = await pool.connect();

  try {
    const result = await client.query(
      `
      SELECT markets, result
      FROM requests
      WHERE request_id = $1
      `,
      [requestId],
    );

    if (!result.rows.length) {
      return res.status(200).json({ requestId });
    }

    const row = result.rows[0];

    const response: RequestStatusResponse = {
      requestId,
      markets: row.markets ?? undefined,
    };

    if (row.result) {
      const parsed = row.result;
      response.approvedParlays = parsed.approvedParlays ?? [];
      response.rejectedParlays = parsed.rejectedParlays ?? [];
    }

    return res.status(200).json(response);
  } catch (err) {
    console.error("Request status fetch failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
    await pool.end();
  }
}
