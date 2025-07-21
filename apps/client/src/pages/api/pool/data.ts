// pages/api/bots/update.ts
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";
import { prisma } from "@achilles/db";
import {
  ProtocolLabels,
  Protocol,
  sleep,
  fetchWithRetry,
  type PoolTick,
} from "@achilles/utils";

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

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      poolId,
      protocol,
      pollerId,
    }: { poolId: string; protocol: Protocol; pollerId: string } = req.body;

    if (!poolId || !protocol) {
      return res.status(400).json({ error: "Missing parameters!" });
    }

    const existingPoller = await prisma.pollers.findFirst({
      where: {
        poolId: poolId,
      },
    });

    if (!existingPoller) {
      await prisma.pollers.create({
        data: {
          pollerId: pollerId,
          protocol: ProtocolLabels[protocol],
          poolId: poolId,
          status: "START",
        },
      });
    } else {
      if (existingPoller.status === "STOP")
        await prisma.pollers.update({
          where: { id: existingPoller.id },
          data: { status: "START" },
        });
    }

    const url = `${process.env.SERVER_URL!}/api/pollers/${poolId}`;

    while (true) {
      const status = await fetchWithRetry<{ runtimeStatus: string }>(url);
      if (
        status.runtimeStatus === "RUNNING" ||
        status.runtimeStatus === "RESTARTING"
      )
        break;
      else await sleep(500);
    }

    const poolData = await fetchWithRetry<{
      price: number;
      ticks: PoolTick[];
      timestamp: number;
    }>(`${url}/data`);

    return res.status(200).json(poolData);
  } catch (error) {
    console.error("Error fetching pool data:", error);
    return res.status(500).json({ error: "Failed to fetch pool data." });
  }
}
