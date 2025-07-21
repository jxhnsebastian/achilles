import Decimal from "decimal.js";
import {
  type BotConfig,
  type UserPosition,
  type PositionBalances,
  StrategyType,
  type InRangeInfo,
  type StrategyParams,
} from "@achilles/utils";
import { serialize } from "@achilles/utils";
import logger from "../logger";
import BotUtils from "./utils";
import { memory, tokenRegistry } from "../utils";
// import memory_local from "../memory_local";
import { checkBotHealth } from "../health";
import type { PollerClient } from "../poller/client";
import { prisma } from "@achilles/db";

class InRange extends BotUtils {
  private closeBalances: { coinA: Decimal; coinB: Decimal };
  private tickRange: number = 2;
  private buffer: number = 2;

  constructor(botConfig: BotConfig, poller: PollerClient) {
    super(botConfig, poller);
    this.closeBalances = {
      coinA: new Decimal(botConfig.params?.coinA?.amount ?? 0),
      coinB: new Decimal(botConfig.params?.coinB?.amount ?? 0),
    };
    this.tickRange = this.botConfig.params?.tickRange ?? 2;
    this.buffer = Math.floor(this.tickRange * 0.05);
  }

  async initializeStrategy() {
    await this.initialize();
    await this.setCurrentPosition();

    if (this.inRangePositions?.upper && this.inRangePositions.lower) {
      logger.log(
        this.botConfig.botId,
        `Found existing positions ${this.inRangePositions?.lower.position_id} and ${this.inRangePositions?.upper.position_id}.`,
      );
    } else {
      logger.log(this.botConfig.botId, "No existing position found.");
      logger.log(this.botConfig.botId, serialize(this.closeBalances));
    }
  }

  async checkPositionClosure() {
    const openMemories = await memory.getMemories(this.botConfig.botId, 2, "open");
    const closeMemories = await memory.getMemories(this.botConfig.botId, 2, "close");

    const openPositionIds = openMemories
      .map((mem) => (mem.strategy as InRangeInfo).position?.position_id)
      .filter((id): id is string => id !== undefined);

    const closePositionIds = closeMemories
      .map((mem) => (mem.strategy as InRangeInfo).position?.position_id)
      .filter((id): id is string => id !== undefined);

    const unclosedPositions = openPositionIds.filter((id) => !closePositionIds.includes(id));

    if (unclosedPositions.length > 0) {
      throw new Error(
        `Position closure check failed! Unclosed positions: ${unclosedPositions.join(", ")}`,
      );
    }
  }

  private async createMemory(
    action: "open" | "close" | "swap" | "collect",
    balances: PositionBalances,
    position?: UserPosition,
  ) {
    await memory.createMemoryEntry(
      this.botConfig.botId,
      "inrange",
      action,
      balances,
      this.price,
      balances.digest,
      position,
    );
  }

  private async updateBalances(balances: { coinA: Decimal; coinB: Decimal }) {
    // updating here will allow us to restart with correct balances
    const { coinTypeA, coinTypeB } = this.getCoinTypes();
    this.closeBalances = {
      coinA: balances.coinA,
      coinB: balances.coinB,
    };
    await prisma.botConfig.update({
      where: { botId: this.botConfig.botId },
      data: {
        params: memory.serializeStrategy({
          coinA: {
            coinType: coinTypeA,
            amount: this.closeBalances.coinA,
          },
          coinB: {
            coinType: coinTypeB,
            amount: this.closeBalances.coinB,
          },
          tickRange: this.botConfig.params.tickRange,
        } as StrategyParams),
      },
    });
  }

  async setCurrentPosition() {
    if (!this.inRangePositions || !this.inRangePositions?.lower || !this.inRangePositions?.upper) {
      const positions = await this.getUserPositions();

      if (positions && positions.length > 0) {
        if (this.botConfig.strategy === StrategyType.INRANGE) {
          if (positions.length !== 2) {
            logger.log(this.botConfig.botId, "Only 1 position found found for in range strategy!");
            try {
              logger.log(this.botConfig.botId, "Trying to reset funds.");
              let mem = await memory.getMostRecentMemory(this.botConfig.botId);
              if (!mem) throw new Error("Memory unavailable.");
              if (mem.action === "close" || mem.action === "collect") {
                if (mem.action === "collect") {
                  mem = await memory.getMostRecentMemory(this.botConfig.botId, "close");
                }
                if (!mem) throw new Error("Memory unavailable.");
                logger.log(this.botConfig.botId, `Closing position ${positions[0].position_id}.`);
                const balances = await this.closePosition(positions[0].position_id);
                await this.createMemory("close", balances, positions[0]);
                await this.updateBalances({
                  coinA: balances.coinA.amount.add(mem.coinA.amount),
                  coinB: balances.coinB.amount.add(mem.coinB.amount),
                });
              } else if (mem.action === "open") {
                logger.log(this.botConfig.botId, `Opening second position.`);

                // need to refresh to most recent ticks
                this.price = await this.getPoolPrice();
                await this.updateTicks();
                this.currentTick = this.getBoundingTicks();
                const markers = this.getRelativeTicks(undefined, this.tickRange + 2);
                // Open lower position with rebalancedCoinB
                this.coinAmount = this.closeBalances.coinB.add(mem.coinB.amount).toNumber();
                const balancesB = await this.openPosition(
                  markers.lower[1],
                  markers.lower[this.tickRange - this.buffer],
                  false,
                );
                await this.setCurrentPosition();
                await this.createMemory("open", balancesB, this.inRangePositions?.lower);
                await prisma.botConfig.update({
                  where: { botId: this.botConfig.botId },
                  data: { status: "RUN" },
                });
              } else throw new Error("Last memory is not close | collect | open.");
              return;
            } catch (error) {
              throw error;
            }
          }
          const sortedPositions = [...positions].sort((a, b) => a.upper_tick - b.upper_tick);
          this.inRangePositions = {
            upper: sortedPositions[1],
            lower: sortedPositions[0],
          };
          await prisma.botConfig.update({
            where: { botId: this.botConfig.botId },
            data: { status: "RUN" },
          });
        }
      } else {
        await this.checkPositionClosure();
        this.inRangePositions = null;
      }
    }
  }

  async rebalanceAndOpenPositions() {
    const { coinTypeA, coinTypeB } = this.getCoinTypes();

    await checkBotHealth(this.botConfig.botId, coinTypeA, coinTypeB);

    const currentPrice = await this.getPoolPrice();
    const coinBUsdPrice = (await tokenRegistry.getTokensPrices([coinTypeB]))[coinTypeB] || 0;
    const coinAmountA = this.closeBalances.coinA;
    const coinAmountB = this.closeBalances.coinB;

    const coinAValue = coinAmountA.mul(currentPrice);
    const coinBValue = coinAmountB;
    const difference = coinAValue.sub(coinBValue).abs();

    let rebalancedCoinA = new Decimal(0);
    let rebalancedCoinB = new Decimal(0);

    logger.log(
      this.botConfig.botId,
      `Available funds for new positions: coinA - ${coinAmountA} (${coinAValue}) | coinB - ${coinAmountB} (${coinBValue})`,
    );

    try {
      if (
        difference.div(Decimal.min(coinAValue, coinBValue)).greaterThan(0.01) ||
        difference.mul(coinBUsdPrice).greaterThan(100)
      ) {
        // Case 1: Coin A value is greater than Coin B value
        if (coinAValue.greaterThan(coinBValue)) {
          // Calculate swap amount: ((coinAValue - coinBValue) / 2) / price
          const swapAmount = coinAValue.sub(coinBValue).div(new Decimal(2)).div(currentPrice);

          logger.log(
            this.botConfig.botId,
            `Rebalancing: Swapping ${swapAmount} of ${coinTypeA} for ${coinTypeB}`,
          );

          // Execute swap
          const swap = await this.swap(swapAmount, 0.01, coinTypeA, coinTypeB);

          await this.createMemory("swap", swap);

          // Update pool amounts
          rebalancedCoinA = coinAmountA.add(swap.coinA.amount);
          rebalancedCoinB = coinAmountB.add(swap.coinB.amount);

          logger.log(
            this.botConfig.botId,
            `After rebalance: Coin A: ${rebalancedCoinA}, Coin B: ${rebalancedCoinB}`,
          );
        }
        // Case 2: Coin B value is greater than Coin A value
        else if (coinBValue.greaterThan(coinAValue)) {
          // Calculate swap amount: (coinBValue - coinAValue) / 2
          const swapAmount = coinBValue.sub(coinAValue).div(new Decimal(2));

          logger.log(
            this.botConfig.botId,
            `Rebalancing: Swapping ${swapAmount} of ${coinTypeB} for ${coinTypeA}`,
          );

          // Execute swap
          const swap = await this.swap(swapAmount, 0.01, coinTypeB, coinTypeA);

          await this.createMemory("swap", swap);

          // Update pool amounts
          rebalancedCoinA = coinAmountA.add(swap.coinB.amount);
          rebalancedCoinB = coinAmountB.add(swap.coinA.amount);

          logger.log(
            this.botConfig.botId,
            `After rebalance: Coin A: ${rebalancedCoinA}, Coin B: ${rebalancedCoinB}`,
          );
        }
      }
      // Case 3: Already balanced or below minimum threshold
      else {
        logger.log(
          this.botConfig.botId,
          `No rebalancing needed or below minimum threshold. CoinA: ${coinAmountA}, CoinB: ${coinAmountB}`,
        );

        rebalancedCoinA = coinAmountA;
        rebalancedCoinB = coinAmountB;
      }

      await this.updateBalances({
        coinA: rebalancedCoinA,
        coinB: rebalancedCoinB,
      });

      // Open positions with the rebalanced amounts
      // need to refresh to most recent ticks
      this.price = await this.getPoolPrice();
      await this.updateTicks();
      this.currentTick = this.getBoundingTicks();
      let markers = this.getRelativeTicks(undefined, this.tickRange + 2);

      // Open upper position with rebalancedCoinA
      // need to refresh to most recent ticks
      this.price = await this.getPoolPrice();
      await this.updateTicks();
      this.currentTick = this.getBoundingTicks();
      this.coinAmount = rebalancedCoinA.toNumber();
      const balancesA = await this.openPosition(
        markers.lower[this.tickRange - this.buffer],
        markers.upper[this.tickRange],
        true,
      );

      const positions = await this.getUserPositions();

      if (!positions) throw new Error("Failed to get upper position!");
      await this.createMemory("open", balancesA, positions![0]);

      // Open lower position with rebalancedCoinB
      // need to refresh to most recent ticks
      // this.price = await this.getPoolPrice();
      // this.currentTick = this.getBoundingTicks();
      // markers = this.getRelativeTicks(undefined, this.tickRange + 2);
      this.coinAmount = rebalancedCoinB.add(balancesA.coinB.amount).toNumber();
      const balancesB = await this.openPosition(
        markers.lower[1],
        markers.lower[this.tickRange - this.buffer],
        false,
      );
      await this.setCurrentPosition();
      await this.createMemory("open", balancesB, this.inRangePositions?.lower!);
      await prisma.botConfig.update({
        where: { botId: this.botConfig.botId },
        data: { status: "RUN" },
      });
    } catch (error) {
      // Handle swap failure
      logger.log(this.botConfig.botId, `Rebalancing swap failed: ${error}.`);
    }
  }

  async inRangeStrategy() {
    if (!this.inRangePositions) {
      await this.rebalanceAndOpenPositions();
      return;
    }

    const prevMarkers = this.getRelativeTicks({
      lowerTick: this.ticks.find((tick) => tick.tick === this.inRangePositions?.lower!.lower_tick)!,
      upperTick: this.ticks.find((tick) => tick.tick === this.inRangePositions?.upper!.upper_tick)!,
    });

    const upperThreshold = new Decimal(prevMarkers.upper[1].price)
      .add(new Decimal(prevMarkers.upper[2].price))
      .div(2);
    const lowerThreshold = new Decimal(prevMarkers.lower[1].price)
      .add(new Decimal(prevMarkers.lower[2].price))
      .div(2);

    if (this.price.greaterThan(upperThreshold)) {
      await prisma.botConfig.update({
        where: { botId: this.botConfig.botId },
        data: { status: "REBALANCE" },
      });

      logger.log(this.botConfig.botId, `Upper threshold crossed for ${this.botConfig.botId}.`);
      // saving to local variable as this will be set to null after closing lower position
      const inRangePositions = this.inRangePositions;
      const upperPositionBalances = await this.closePosition(inRangePositions.upper.position_id);
      await this.createMemory("close", upperPositionBalances, inRangePositions.upper);
      const lowerPositionBalances = await this.closePosition(inRangePositions.lower.position_id);
      await this.createMemory("close", lowerPositionBalances, inRangePositions.lower);

      await this.updateBalances({
        coinA: lowerPositionBalances.coinA.amount.add(upperPositionBalances.coinA.amount),
        coinB: lowerPositionBalances.coinB.amount.add(upperPositionBalances.coinB.amount),
      });

      await this.rebalanceAndOpenPositions();
      return;
    }

    if (this.price.lessThan(lowerThreshold)) {
      await prisma.botConfig.update({
        where: { botId: this.botConfig.botId },
        data: { status: "REBALANCE" },
      });

      logger.log(this.botConfig.botId, `Lower threshold crossed for ${this.botConfig.botId}.`);
      // saving to local variable as this will be set to null after closing lower position
      const inRangePositions = this.inRangePositions;
      const upperPositionBalances = await this.closePosition(inRangePositions.upper.position_id);
      await this.createMemory("close", upperPositionBalances, inRangePositions.upper);
      const lowerPositionBalances = await this.closePosition(inRangePositions.lower.position_id);
      await this.createMemory("close", lowerPositionBalances, inRangePositions.lower);

      await this.updateBalances({
        coinA: lowerPositionBalances.coinA.amount.add(upperPositionBalances.coinA.amount),
        coinB: lowerPositionBalances.coinB.amount.add(upperPositionBalances.coinB.amount),
      });

      await this.rebalanceAndOpenPositions();
      return;
    }
    process.stdout.write(
      `\r\x1b[K${new Date().toLocaleTimeString()} No action. ${
        this.botConfig.botId
      } p: ${this.price.toDecimalPlaces(9)} u: ${upperThreshold} l: ${lowerThreshold}`,
    );
  }
}

export default InRange;
