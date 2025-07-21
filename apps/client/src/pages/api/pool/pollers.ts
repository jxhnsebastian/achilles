import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";
import { fetchWithRetry } from "@achilles/utils";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);

  if (!session) {
    return res.status(401).json({
      error: "You must be signed in to access this endpoint.",
    });
  }

  if (req.method === "GET") {
    try {
      const { poolId } = req.query as {
        poolId?: string;
      };

      const url = `${process.env.SERVER_URL!}/api/pollers${poolId ? `/${poolId}` : ""}`;
      const pollers = await fetchWithRetry(url);
      return res.status(200).json(pollers);
    } catch (error) {
      console.error("Error fetching pollers:", error);
      return res.status(500).json({ error: "Failed to fetch pollers!" });
    }
  } else {
    return res.status(405).json({ error: "Method not allowed" });
  }
}
