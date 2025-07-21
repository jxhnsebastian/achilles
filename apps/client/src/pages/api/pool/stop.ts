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

      const url = `${process.env.SERVER_URL!}/api/pollers/${poolId}/stop`;
      await fetchWithRetry<any>(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      return res
        .status(200)
        .json({ message: `Poller for ${poolId} set to stop` });
    } catch (error) {
      console.error("Error stopping poller:", error);
      return res.status(500).json({ error: "Failed to stop poller!" });
    }
  } else {
    return res.status(405).json({ error: "Method not allowed" });
  }
}
