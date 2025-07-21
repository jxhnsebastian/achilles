import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";
import { BotStatus, Memory, convertBotConfig, fetchWithRetry } from "@achilles/utils";
import { prisma } from "@achilles/db";
import Decimal from "decimal.js";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);

  if (!session) {
    return res.status(401).json({
      error: "You must be signed in to access this endpoint.",
    });
  }

  if (req.method === "POST") {
    try {
      const { botId }: { botId: string } = req.body;

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
      if (bot.status !== BotStatus.RUN && bot.status !== BotStatus.STOP) {
        return res.status(409).json({
          error: "Bot is currently updating or rebalancing. Try again later",
        });
      }

      const url = `${process.env.SERVER_URL!}/api/bots/${botId}/sweep`;
      await fetchWithRetry<any>(url, {
        method: "POST",
      });

      const memory = new Memory();
      await memory.addMemory({
        botId,
        action: "update",
        timestamp: Date.now(),
        strategy: bot.params,
        digest: "sweep",
        coinA: bot.params.coinA,
        coinB: bot.params.coinB,
        balances: [],
        price: new Decimal(0),
        user: session.user?.email ?? undefined,
      });

      return res.status(200).json({ message: "Sweeping triggered!" });
    } catch (error) {
      console.error("Error sweeping bot:", error);
      return res.status(500).json({ error: "Failed to sweep bot" });
    }
  } else {
    return res.status(405).json({ error: "Method not allowed" });
  }
}
