import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";
import { prisma } from "@achilles/db";
import { Memory } from "@achilles/utils";

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
      const memory = new Memory();
      const { sender, botId } = req.query;

      const whereClause: any = {};
      if (sender && typeof sender === "string") {
        whereClause.sender = sender;
      }
      if (botId && typeof botId === "string") {
        whereClause.botId = botId;
      }

      // Get all bot configs
      const botConfigs = await prisma.botConfig.findMany({
        where: whereClause,
        orderBy: { timestamp: "desc" },
      });

      // Enrich bots with their positions
      const enrichedBots = await Promise.all(
        botConfigs.map(async (botConfig) => {
          const positions =
            botConfig.status === "RUN"
              ? await memory.getMemories(botConfig.botId, 2, "open")
              : [];
          return {
            ...botConfig,
            positions,
          };
        })
      );

      return res.status(200).json(enrichedBots);
    } catch (error) {
      console.error("Error fetching bots:", error);
      return res.status(500).json({ error: "Failed to fetch bots" });
    }
  } else {
    return res.status(405).json({ error: "Method not allowed" });
  }
}
