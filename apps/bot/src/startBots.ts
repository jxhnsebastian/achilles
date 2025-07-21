import {
  sleep,
  type BotConfig,
  convertBotConfig,
  BotStatus,
  type StrategyParams,
  serialize,
} from "@achilles/utils";
import logger from "./utils/logger";
import Bot from "./utils/bot";
import Decimal from "decimal.js";
import { prisma } from "@achilles/db";
import { PollerClient } from "./utils/poller/client";
import { memory } from "./utils/utils";
import { getCloseBalances } from "./utils/helpers";
Decimal.config({ precision: 9 });

export const activeBots = new Map<string, { bot: Bot; promise: Promise<void> }>();
const pollerClients = new Map<string, PollerClient>();

async function monitorBots() {
  try {
    while (true) {
      try {
        const bots: BotConfig[] = (
          await prisma.botConfig.findMany({
            where: {
              instanceId: process.env.INSTANCE_ID!,
            },
          })
        ).map((bot) => {
          return convertBotConfig(bot);
        });
        // console.log(bots);

        for (const bot of bots) {
          const existingBot = activeBots.get(bot.botId);

          const update = await memory.getMostRecentMemory(bot.botId, "update");

          if (!update) throw new Error("Failed to get update memory.");

          switch (bot.status) {
            case BotStatus.START:
              if (!existingBot) {
                switch (update.digest) {
                  case "create":
                    await logger.slack(
                      bot.botId,
                      `Creating bot ${bot.botId}. Action by ${update?.user ?? "Unknown"}`,
                    );
                    break;

                  case "restart":
                    await logger.slack(
                      bot.botId,
                      `Restarting bot ${bot.botId}. Action by ${update?.user ?? "Unknown"}`,
                    );

                    if (bot.continue) {
                      logger.log(
                        bot.botId,
                        `Updating params. Current: ${serialize(bot.params)}. Update: ${serialize(update.strategy)}`,
                      );
                      bot.params.coinA.amount = bot.params.coinA.amount.add(
                        (update.strategy as StrategyParams).coinA.amount,
                      );
                      bot.params.coinB.amount = bot.params.coinB.amount.add(
                        (update.strategy as StrategyParams).coinB.amount,
                      );
                      bot.params.tickRange = (update.strategy as StrategyParams).tickRange;

                      logger.log(bot.botId, `Updated params: ${serialize(bot.params)}`);

                      await prisma.botConfig.update({
                        where: { botId: bot.botId },
                        data: {
                          params: memory.serializeStrategy(bot.params),
                          continue: false,
                        },
                      });
                    } else {
                      logger.log(
                        bot.botId,
                        `Resetting params. Current: ${serialize(bot.params)}. Update: ${serialize(update.strategy)}`,
                      );
                      bot.params.coinA.amount = (update.strategy as StrategyParams).coinA.amount;
                      bot.params.coinB.amount = (update.strategy as StrategyParams).coinB.amount;
                      bot.params.tickRange = (update.strategy as StrategyParams).tickRange;

                      logger.log(bot.botId, `New params: ${serialize(bot.params)}`);

                      await prisma.botConfig.update({
                        where: { botId: bot.botId },
                        data: {
                          params: memory.serializeStrategy(bot.params),
                          continue: false,
                        },
                      });
                    }

                    break;
                  default:
                    await logger.slack(
                      bot.botId,
                      `Bot ${bot.botId} started without valid memory. Last memory is ${
                        update.digest
                      } by ${update?.user ?? "Unknown"}`,
                    );
                    await prisma.botConfig.update({
                      where: { botId: bot.botId },
                      data: {
                        continue: false,
                        status: "STOP",
                      },
                    });
                    continue;
                    break;
                }
              }
            case BotStatus.RUN:
              if (!existingBot) {
                await logger.slack(bot.botId, `Continuing bot ${bot.botId}.`);

                const poller = pollerClients.get(bot.poolId);
                if (!poller) {
                  logger.log(bot.botId, `Creating new poller client for ${bot.poolId}`);
                  const pollerConfig = await prisma.pollers.findFirst({
                    where: { poolId: bot.poolId },
                  });

                  if (!pollerConfig)
                    await logger.slack(
                      bot.botId,
                      `Failed to start bot ${bot.botId}. Poller config not found for pool ${bot.poolId}`,
                    );

                  const pollerClient = new PollerClient(bot.poolId, process.env.SERVER_URL!);
                  pollerClients.set(bot.poolId, pollerClient);

                  while (!(await pollerClient.isLive())) {
                    logger.log(bot.botId, `Waiting for poller for ${bot.poolId} to start.`);
                    await sleep(500);
                  }
                }

                const newBot = new Bot(bot, pollerClients.get(bot.poolId)!);

                const botPromise = (async () => {
                  try {
                    await newBot.runBot();
                  } catch (error: any) {
                    await logger.slack(
                      bot.botId,
                      `Error for ${bot.botId}. Error: ${
                        error?.message ?? "unknown"
                      }.\nClosing all positions!`,
                    );
                    await newBot.bot.terminate();
                  }
                })();

                activeBots.set(bot.botId, { bot: newBot, promise: botPromise });
              }
              break;

            case BotStatus.UPDATE:
              if (existingBot) {
                try {
                  switch (update.digest) {
                    case "rug":
                      await logger.slack(
                        bot.botId,
                        `Rugging bot ${bot.botId}. Action by ${update?.user ?? "Unknown"}`,
                      );
                      await existingBot.bot.bot.terminate();
                      break;

                    case "update_params":
                      await logger.slack(
                        bot.botId,
                        `Updating bot ${bot.botId}. . Action by ${update?.user ?? "Unknown"}`,
                      );
                      await existingBot.bot.bot.terminate(false);
                      const prevCloseBalances = await getCloseBalances(bot.botId, bot.strategy);

                      bot.params.coinA.amount = prevCloseBalances.coinA.add(
                        (update.strategy as StrategyParams).coinA.amount,
                      );
                      bot.params.coinB.amount = prevCloseBalances.coinB.add(
                        (update.strategy as StrategyParams).coinB.amount,
                      );
                      bot.params.tickRange = (update.strategy as StrategyParams).tickRange;

                      await existingBot.bot.bot.checkPositionClosure();

                      activeBots.delete(bot.botId);
                      await prisma.botConfig.update({
                        where: { botId: bot.botId },
                        data: {
                          params: memory.serializeStrategy(bot.params),
                          status: "START",
                          continue: true,
                        },
                      });
                  }
                } catch (error: any) {
                  await logger.slack(
                    bot.botId,
                    `Failed to update bot ${bot.botId}. Error: ${
                      error?.message ?? "Unknown error!"
                    }`,
                  );
                }
              }
              break;
          }
        }
      } catch (error: any) {
        await logger.slack(
          "bots_manager",
          `Error monitoring bot changes: ${error?.message ?? "Unknown error!"}`,
          undefined,
          undefined,
          error,
        );
      }

      await sleep(10000);
    }
  } catch (error: any) {
    await logger.slack(
      "bots_manager",
      `Fatal error in bot monitoring loop: ${error?.message ?? "Unknown error!"}`,
    );
    process.exit(1);
  }
}

process.on("SIGINT", async () => {
  console.log("Shutting down...");
  logger.close();
  await prisma.$disconnect();
  console.log("Shutdown complete");
  process.exit(0);
});

if (require.main === module) {
  await monitorBots();
}
