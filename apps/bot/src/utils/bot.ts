import { checkFrequency, sleep } from "@achilles/utils";
import logger from "./logger";
import Chaser from "./strategies/chaser";
import InRange from "./strategies/inrange";
import { StrategyType, type BotConfig } from "@achilles/utils";
import type { PollerClient } from "./poller/client";
import { prisma } from "@achilles/db";

class Bot {
  public bot: Chaser | InRange;
  protected isRunning: boolean = false;

  constructor(botConfig: BotConfig, poller: PollerClient) {
    if (!botConfig) throw new Error(`Bot Config required!`);
    if (botConfig.strategy === StrategyType.CHASER)
      this.bot = new Chaser(botConfig, poller);
    else this.bot = new InRange(botConfig, poller);
  }

  private logRangeInfo() {
    const upper = this.bot.ticks.find(
      (tick) =>
        tick.tick ===
        (this.bot.inRangePositions?.upper?.upper_tick ??
          this.bot.currentPosition?.upper_tick)
    );
    const lower = this.bot.ticks.find(
      (tick) =>
        tick.tick ===
        (this.bot.inRangePositions?.lower?.lower_tick ??
          this.bot.currentPosition?.lower_tick)
    );
    process.stdout.write(
      `\r\x1b[K${new Date().toLocaleTimeString()} Position is in range, no action needed for ${
        this.bot.botConfig.botId
      } price: ${this.bot.price.toDecimalPlaces(9)} u:${upper?.price ?? 0} l:${
        lower?.price ?? 0
      }`
    );
  }

  async runBot() {
    this.isRunning = true;
    await this.bot.initializeStrategy();
    const MAX_FAILS = 5;
    const wait = 2;
    let fails = 0;

    while (this.isRunning) {
      if (this.bot.terminateBot) {
        this.isRunning = false;
        return;
      }
      await sleep(checkFrequency);
      try {
        const snapshot = await this.bot.poller.getSnapshot();
        // Check poller status
        if (!snapshot.isLive) {
          logger.log(this.bot.botConfig.botId, `Poller is not live.`);
          await this.bot.poller.restartPoller();
          continue;
        }

        // Poller restart logic
        const ONE_MINUTE = 60 * 1000;
        const dataAge = Date.now() - snapshot.timestamp;
        if (dataAge > ONE_MINUTE) {
          logger.log(
            this.bot.botConfig.botId,
            `Data is stale (${Math.round(
              dataAge / 1000
            )}s old). Restarting poller...`
          );
          await this.bot.poller.restartPoller();
          continue;
        }

        this.bot.price = snapshot.price;
        await this.bot.updateTicks();
        this.bot.currentTick = this.bot.getBoundingTicks();
        await this.bot.setCurrentPosition();

        if (
          this.bot.isChaserPositionInRange(this.bot.currentPosition) ||
          this.bot.isRangePositionInRange(this.bot.inRangePositions)
        ) {
          this.logRangeInfo();
          fails = 0;
          continue;
        }

        const botData = await prisma.botConfig.findFirst({
          where: { botId: this.bot.botConfig.botId },
        });

        if (!botData) {
          throw new Error(
            `Failed to fetch data for bot ${this.bot.botConfig.botId}!`
          );
        }

        if (botData.status === "UPDATE") {
          logger.log(
            this.bot.botConfig.botId,
            `Bot ${this.bot.botConfig.botId} is updating. Skipping rebalance!`
          );
          while (this.isRunning) {
            logger.log(
              this.bot.botConfig.botId,
              `Waiting for bot ${this.bot.botConfig.botId} to stop.`
            );
            await sleep(500);
          }
          continue;
        }

        if (this.bot.botConfig.strategy === StrategyType.CHASER) {
          await (this.bot as Chaser).chaserStrategy();
        } else if (this.bot.botConfig.strategy === StrategyType.INRANGE) {
          await (this.bot as InRange).inRangeStrategy();
        } else {
          console.log("Unknown strategy.");
          return;
        }
        fails = 0;
      } catch (error: any) {
        fails++;
        console.error(`Critical error for ${this.bot.botConfig.botId}`);
        logger.log(
          this.bot.botConfig.botId,
          `Critical bot error: ${error?.message ?? "Unknown error"}`
        );
        if (fails <= MAX_FAILS) {
          logger.log(
            this.bot.botConfig.botId,
            `Retry ${fails}/${MAX_FAILS}. Sleeping for ${wait ** fails}s...`
          );
          await sleep(wait ** fails * 1000);
          continue;
        }
        this.isRunning = false;
        throw error;
      }
    }
  }
}

export default Bot;
