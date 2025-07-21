// pages/api/bots/update.ts
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";
import { prisma } from "@achilles/db";
import { BotStatus, type StrategyParams, ProtocolLabels } from "@achilles/utils";
import { Memory, convertBotConfig, StatusLabels } from "@achilles/utils";
import Decimal from "decimal.js";
import { getOptimalInstance } from "./create";

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
    const {
      botId,
      action,
      params,
      continueFlag,
    }: { botId: string; action: string; params?: StrategyParams; continueFlag?: boolean } =
      req.body;

    if (!botId) {
      return res.status(400).json({ error: "Bot ID is required" });
    }

    const existingBot = await prisma.botConfig.findFirst({
      where: { botId },
    });

    if (!existingBot) {
      return res.status(404).json({ error: "Bot not found" });
    }

    const bot = convertBotConfig(existingBot);
    if (
      (action === "start" && bot.status !== BotStatus.STOP) ||
      (action !== "start" && bot.status !== BotStatus.RUN)
    ) {
      return res.status(409).json({
        error: "Bot is currently updating or rebalancing. Try again later",
      });
    }

    const memory = new Memory();
    if (params) {
      params.coinA = memory.deserializeBalances(params.coinA);
      params.coinB = memory.deserializeBalances(params.coinB);
    }

    if (action === "start") {
      if (!params?.coinA || !params?.coinB) {
        return res.status(400).json({ error: "Coin amounts are required to restart!" });
      }

      const existingPoller = await prisma.pollers.findFirst({
        where: {
          poolId: bot.poolId,
        },
      });

      if (!existingPoller) {
        await prisma.pollers.create({
          data: {
            pollerId: `poller-${ProtocolLabels[bot.protocol]}-${
              params.coinA.coinType
            }-${params.coinB.coinType}`,
            protocol: ProtocolLabels[bot.protocol],
            poolId: bot.poolId,
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

      await memory.addMemory({
        botId,
        action: "update",
        timestamp: Date.now(),
        strategy: params,
        digest: "restart",
        coinA: params.coinA,
        coinB: params.coinB,
        balances: [],
        price: new Decimal(0),
        user: session.user?.email ?? undefined,
      });

      const instanceId = await getOptimalInstance();
      await prisma.botConfig.update({
        where: { botId },
        data: {
          continue: continueFlag ?? false,
          status: StatusLabels[BotStatus.START],
          instanceId,
        },
      });
    } else if (action === "stop") {
      await memory.addMemory({
        botId,
        action: "update",
        timestamp: Date.now(),
        strategy: bot.params,
        digest: "rug",
        coinA: bot.params.coinA,
        coinB: bot.params.coinB,
        balances: [],
        price: new Decimal(0),
        user: session.user?.email ?? undefined,
      });
      await prisma.botConfig.update({
        where: { botId },
        data: {
          continue: false,
          status: StatusLabels[BotStatus.UPDATE],
        },
      });
    } else if (action === "update") {
      if (!params) {
        return res.status(400).json({ error: "Update parameters are required" });
      }
      await memory.addMemory({
        botId,
        action: "update",
        timestamp: Date.now(),
        strategy: params,
        digest: "update_params",
        coinA: bot.params.coinA,
        coinB: bot.params.coinB,
        balances: [],
        price: new Decimal(0),
        user: session.user?.email ?? undefined,
      });

      await prisma.botConfig.update({
        where: { botId },
        data: {
          continue: false,
          status: StatusLabels[BotStatus.UPDATE],
        },
      });
    } else return res.status(400).json({ error: "Invalid update action!" });

    return res.status(201).json({ success: true });
  } catch (error) {
    console.error("Error updating bot:", error);
    return res.status(500).json({ error: "Failed to update bot" });
  }
}
