// pages/api/bots/create.ts
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";
import { prisma } from "@achilles/db";
import { BotStatus, Memory } from "@achilles/utils";
import { CreateBotParams } from "@/lib/types";
import { ProtocolLabels, StatusLabels, StrategyLabels } from "@achilles/utils";
import Decimal from "decimal.js";

const instances = ["bot-server-1", "bot-server-2"];

export async function getOptimalInstance(): Promise<string> {
  try {
    const instanceCounts = await prisma.botConfig.groupBy({
      by: ["instanceId"],
      where: {
        instanceId: {
          in: instances,
        },
        status: {
          not: StatusLabels[BotStatus.STOP],
        },
      },
      _count: {
        instanceId: true,
      },
    });

    const instanceMap = instances.map((instanceId) => {
      const found = instanceCounts.find((item) => item.instanceId === instanceId);
      return {
        instanceId,
        count: found ? found._count.instanceId : 0,
      };
    });

    const optimalInstance = instanceMap.reduce((min, current) =>
      current.count < min.count ? current : min,
    );

    console.log("Instance load distribution:", instanceMap);
    console.log("Selected instance:", optimalInstance.instanceId);

    return optimalInstance.instanceId;
  } catch (error) {
    console.error("Error in load balancer, falling back to first instance:", error);
    return instances[0];
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
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
    const botData = req.body as Omit<CreateBotParams, "instanceId" | "status" | "continue">;

    if (!botData.sender || !botData.protocol || !botData.strategy || !botData.poolId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const existingBot = await prisma.botConfig.findFirst({
      where: {
        sender: botData.sender,
        poolId: botData.poolId,
      },
    });

    if (existingBot) {
      return res.status(409).json({
        error: "A bot with the same sender and poolId already exists",
      });
    }

    const existingPoller = await prisma.pollers.findFirst({
      where: {
        poolId: botData.poolId,
      },
    });

    if (!existingPoller) {
      await prisma.pollers.create({
        data: {
          pollerId: botData.pollerId,
          protocol: ProtocolLabels[botData.protocol],
          poolId: botData.poolId,
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

    const instanceId = await getOptimalInstance();

    const memory = new Memory();
    const botConfig = {
      botId: botData.botId,
      sender: botData.sender,
      protocol: ProtocolLabels[botData.protocol],
      strategy: StrategyLabels[botData.strategy],
      poolId: botData.poolId,
      slippage: botData.slippage || 0.1,
      params: memory.serializeStrategy(botData.params),
      continue: false,
      status: StatusLabels[BotStatus.START],
      instanceId,
    };

    const createdBot = await prisma.botConfig.create({
      data: botConfig,
    });

    await memory.addMemory({
      botId: botData.botId,
      action: "update",
      timestamp: Date.now(),
      strategy: botData.params,
      digest: "create",
      coinA: botData.params.coinA,
      coinB: botData.params.coinB,
      balances: [],
      price: new Decimal(0),
      user: session.user?.email ?? undefined,
    });

    return res.status(201).json({
      ...botConfig,
      id: createdBot.id,
      timestamp: createdBot.timestamp,
    });
  } catch (error) {
    console.error("Error creating bot:", error);
    return res.status(500).json({ error: "Failed to create bot" });
  }
}
