import type { NextApiRequest, NextApiResponse } from "next";
import { RequestStatusResponse } from "@/lib/parlay-types";
import connectDatabase from "@/lib/db";
import { Request } from "@/models/Request";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { requestId } = req.query;

  if (typeof requestId !== "string") {
    return res.status(400).json({ error: "Invalid requestId" });
  }

  await connectDatabase();

  try {
    const doc = await Request.findOne({ requestId }, { markets: 1, result: 1, _id: 0 }).lean();

    if (!doc) {
      return res.status(200).json({ requestId });
    }

    const response: RequestStatusResponse = {
      requestId,
      markets: doc.markets ?? undefined,
    };

    if (doc.result) {
      response.approvedParlays = (doc.result.approvedParlays as any) ?? [];
      response.rejectedParlays = (doc.result.rejectedParlays as any) ?? [];
      console.log(
        `✅ Returning status for ${requestId}: ${response.approvedParlays?.length || 0} approved, ${response.rejectedParlays?.length || 0} rejected`,
      );
    }

    return res.status(200).json(response);
  } catch (err) {
    console.error("Request status fetch failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
