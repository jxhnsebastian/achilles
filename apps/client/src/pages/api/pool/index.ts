import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";
import {
  getBluefinPoolInfo,
  getCetusPoolInfo,
  getOrcaPoolInfo,
  getRaydiumPoolInfo,
} from "@achilles/utils/server";
import { Protocol } from "@achilles/utils";

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
      const { poolId, protocol } = req.query as {
        poolId: string;
        protocol: string;
      };

      switch (Number(protocol)) {
        case Protocol.BLUEFIN:
          return res
            .status(200)
            .json({ pool: await getBluefinPoolInfo(poolId) });
          break;
        case Protocol.CETUS:
          return res.status(200).json({ pool: await getCetusPoolInfo(poolId) });
          break;
        case Protocol.ORCA:
          return res.status(200).json({ pool: await getOrcaPoolInfo(poolId) });
          break;
        case Protocol.RAYDIUM:
          return res
            .status(200)
            .json({ pool: await getRaydiumPoolInfo(poolId) });
          break;
        default:
          return res.status(400).json({ error: "Invalid Protocol!" });
      }

      return res.status(500).json({ error: "Failed to fetch pool data!" });
    } catch (error) {
      console.error("Error fetching pool data:", error);
      return res.status(500).json({ error: "Failed to fetch pool data!" });
    }
  } else {
    return res.status(405).json({ error: "Method not allowed" });
  }
}
