// pages/api/bots/create.ts
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";
import { prisma } from "@achilles/db";
import { BotStatus } from "@achilles/utils";
import { StatusLabels } from "@achilles/utils";

export interface BotParameters {
  id: string;
  orderSize: number;
  maxPositionSize: number;
  gamma: number;
  ticker: string;
  exchange: string;
  duration: number;
  status: BotStatus;
}

const instances = ["mm-server", "mm-server-2"];

export async function getOptimalInstance(ticker: string, exchange: string): Promise<string> {
  try {
    // Get instances that don't have a bot with the same ticker
    const instancesWithTicker = await prisma.orderBookBot.findMany({
      where: {
        ticker: ticker,
        exchange: exchange,
        instanceId: {
          in: instances,
        },
        status: {
          not: StatusLabels[BotStatus.STOP],
        },
      },
      select: {
        instanceId: true,
      },
    });

    const usedInstances = new Set(instancesWithTicker.map((bot) => bot.instanceId));
    const availableInstances = instances.filter((instance) => !usedInstances.has(instance));

    // If we have available instances without the ticker, pick the one with least load
    if (availableInstances.length > 0) {
      const instanceCounts = await prisma.orderBookBot.groupBy({
        by: ["instanceId"],
        where: {
          instanceId: {
            in: availableInstances,
          },
          status: {
            not: StatusLabels[BotStatus.STOP],
          },
        },
        _count: {
          instanceId: true,
        },
      });

      const instanceMap = availableInstances.map((instanceId) => {
        const found = instanceCounts.find((item) => item.instanceId === instanceId);
        return {
          instanceId,
          count: found ? found._count.instanceId : 0,
        };
      });

      const optimalInstance = instanceMap.reduce((min, current) =>
        current.count < min.count ? current : min,
      );

      console.log("Available instances for ticker", ticker, "exchange", exchange, ":", instanceMap);
      console.log("Selected instance:", optimalInstance.instanceId);

      return optimalInstance.instanceId;
    }

    // If all instances have the ticker, return error
    throw new Error(`All instances already have a bot running for ticker: ${ticker}`);
  } catch (error) {
    console.error("Error in load balancer:", error);
    throw error;
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
    const botData = req.body as Omit<BotParameters, "id" | "status">;

    // Check if all required fields are present
    if (
      !botData.orderSize ||
      !botData.maxPositionSize ||
      !botData.gamma ||
      !botData.ticker ||
      !botData.exchange ||
      !botData.duration
    ) {
      return res.status(400).json({
        error:
          "Missing required fields: orderSize, maxPositionSize, gamma, ticker, exchange, duration",
      });
    }

    // Validate data types and values
    if (typeof botData.orderSize !== "number" || botData.orderSize <= 0) {
      return res.status(400).json({ error: "orderSize must be a positive number" });
    }
    if (typeof botData.maxPositionSize !== "number" || botData.maxPositionSize <= 0) {
      return res.status(400).json({ error: "maxPositionSize must be a positive number" });
    }
    if (typeof botData.gamma !== "number" || botData.gamma <= 0) {
      return res.status(400).json({ error: "gamma must be a positive number" });
    }
    if (typeof botData.duration !== "number" || botData.duration <= 0) {
      return res.status(400).json({ error: "duration must be a positive number" });
    }
    if (typeof botData.ticker !== "string" || !botData.ticker.trim()) {
      return res.status(400).json({ error: "ticker must be a non-empty string" });
    }
    if (typeof botData.exchange !== "string" || !botData.exchange.trim()) {
      return res.status(400).json({ error: "exchange must be a non-empty string" });
    }

    // Get optimal instance (one that doesn't have the same ticker)
    let instanceId: string;
    try {
      instanceId = await getOptimalInstance(botData.ticker, botData.exchange);
    } catch (error) {
      return res.status(409).json({
        error: error instanceof Error ? error.message : "Unable to find available instance",
      });
    }

    // Create the bot configuration object
    const botConfig: Omit<BotParameters, "id"> = {
      orderSize: botData.orderSize,
      maxPositionSize: botData.maxPositionSize,
      gamma: botData.gamma,
      ticker: botData.ticker,
      exchange: botData.exchange,
      duration: botData.duration,
      status: BotStatus.START, // Default status
    };

    // Add instanceId to the bot config for database storage
    const botConfigWithInstance = {
      ...botConfig,
      instanceId,
    };

    const createdBot = await prisma.orderBookBot.create({
      data: { ...botConfigWithInstance, status: "START" },
    });

    return res.status(201).json({
      ...createdBot,
      message: `Bot created successfully on instance ${instanceId}`,
    });
  } catch (error) {
    console.error("Error creating bot:", error);
    return res.status(500).json({ error: "Failed to create bot" });
  }
}
