import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";
import { fetchWithRetry } from "@achilles/utils";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const session = await getServerSession(req, res, authOptions);

  if (!session) {
    return res.status(401).json({
      error: "You must be signed in to access this endpoint.",
    });
  }

  if (req.method === "GET") {
    try {
      const { poolId } = req.query as {
        poolId: string;
      };

      const url = `${process.env.SERVER_URL!}/api/pollers/${poolId}/snapshot`;
      const priceData = await fetchWithRetry<{
        price: number;
        timestamp: number;
        isLive: boolean;
      }>(url);
      return res.status(200).json({ price: priceData.price });
    } catch (error) {
      console.error("Error fetching pool data:", error);
      return res.status(500).json({ error: "Failed to fetch pool price!" });
    }
  } else {
    return res.status(405).json({ error: "Method not allowed" });
  }
}
