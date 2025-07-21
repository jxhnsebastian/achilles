import Decimal from "decimal.js";
import {
  ChaserStep,
  type BotConfig,
  type UserPosition,
  type PositionBalances,
  type ChaserInfo,
  type StrategyParams,
} from "@achilles/utils";
import logger from "../logger";
import BotUtils from "./utils";
import { memory } from "../utils";
import type { PollerClient } from "../poller/client";
import { prisma } from "@achilles/db";
// import memory_local from "../memory_local";
Decimal.set({ precision: 9 });

class Chaser extends BotUtils {
  private tickRange: number = 2;

  constructor(botConfig: BotConfig, poller: PollerClient) {
    if (!botConfig) throw new Error(`Pool Config required!`);
    super(botConfig, poller);
    this.tickRange = this.botConfig.params?.tickRange ?? 2;
  }

  async initializeStrategy() {
    await this.initialize();
    await this.setCurrentPosition();

    const mem = await memory.getMostRecentMemory(this.botConfig.botId);
    if (this.currentPosition) {
      if (mem && mem.action === "open") {
        if (
          (mem?.strategy as ChaserInfo)?.position?.position_id !== this.currentPosition.position_id
        )
          throw new Error("Last memory position was not closed!");

        this.currentStep = (mem.strategy as ChaserInfo).step!;
      } else {
        const lowerTick = this.ticks.find(
          (tick) => tick.tick === this.currentPosition!.lower_tick,
        )!;
        this.currentStep = this.price.lessThanOrEqualTo(new Decimal(lowerTick.price))
          ? ChaserStep.STEP1
          : ChaserStep.STEP2;
      }

      await prisma.botConfig.update({
        where: { botId: this.botConfig.botId },
        data: { status: "RUN" },
      });

      logger.log(
        this.botConfig.botId,
        `Found existing position: ${this.currentPosition.position_id} in step ${
          this.currentStep + 1
        }`,
      );
    } else {
      logger.log(this.botConfig.botId, "No existing position found, starting with Step 1");

      const { coinTypeA, coinTypeB } = this.getCoinTypes();
      const { coinA, coinB } = {
        coinA: new Decimal(this.botConfig.params?.coinA?.amount ?? 0),
        coinB: new Decimal(this.botConfig.params?.coinB?.amount ?? 0),
      };
      if (coinA.greaterThan(coinB)) {
        if (coinB.greaterThan(0)) {
          const swap = await this.swap(coinB, 0.01, coinTypeB, coinTypeA);
          await this.createMemory("swap", swap);
          this.coinAmount = coinA.add(swap.coinB.amount).toNumber();
          this.currentStep = ChaserStep.STEP1;
          await this.updateBalances({
            coinA: coinA.add(swap.coinB.amount),
            coinB: new Decimal(0),
          });
        }
      } else {
        if (coinA.greaterThan(0)) {
          const swap = await this.swap(coinA, 0.01, coinTypeA, coinTypeB);
          await this.createMemory("swap", swap);
          this.coinAmount = coinB.add(swap.coinB.amount).toNumber();
          this.currentStep = ChaserStep.STEP2;
          await this.updateBalances({
            coinA: new Decimal(0),
            coinB: coinB.add(swap.coinB.amount),
          });
        }
      }
    }
  }

  async checkPositionClosure() {
    const openMemory = await memory.getMostRecentMemory(this.botConfig.botId, "open");
    const closeMemory = await memory.getMostRecentMemory(this.botConfig.botId, "close");
    const openPositionId = (openMemory?.strategy as ChaserInfo)?.position?.position_id ?? null;
    const closePositionId = (closeMemory?.strategy as ChaserInfo)?.position?.position_id ?? null;

    if (openPositionId !== closePositionId)
      throw new Error(
        `Position closure check failed! Open: ${
          (openMemory?.strategy as ChaserInfo).position?.position_id ?? ""
        } | Close: ${(closeMemory?.strategy as ChaserInfo).position?.position_id ?? ""}`,
      );
  }

  private async createMemory(
    action: "open" | "close" | "swap" | "collect",
    balances: PositionBalances,
    position?: UserPosition,
  ) {
    await memory.createMemoryEntry(
      this.botConfig.botId,
      "chaser",
      action,
      balances,
      this.price,
      balances.digest,
      position,
      this.currentStep,
    );
  }

  private async updateBalances(balances: { coinA: Decimal; coinB: Decimal }) {
    // updating here will allow us to restart with correct balances
    const { coinTypeA, coinTypeB } = this.getCoinTypes();
    await prisma.botConfig.update({
      where: { botId: this.botConfig.botId },
      data: {
        params: memory.serializeStrategy({
          coinA: {
            coinType: coinTypeA,
            amount: balances.coinA,
          },
          coinB: {
            coinType: coinTypeB,
            amount: balances.coinB,
          },
          tickRange: this.botConfig.params.tickRange,
        } as StrategyParams),
      },
    });
  }

  async setCurrentPosition() {
    if (!this.currentPosition) {
      const positions = await this.getUserPositions();

      const mem = await memory.getMostRecentMemory(this.botConfig.botId);

      if (positions && positions.length > 0) {
        this.currentPosition = positions[0];
      } else if (mem && mem.action === "open") {
        throw new Error(
          `Unable to find position ${(mem.strategy as ChaserInfo).position?.position_id}`,
        );
      } else {
        await this.checkPositionClosure();
        this.currentPosition = null;
      }
    }
  }

  private async resetFunds() {
    const mem = await memory.getMostRecentMemory(this.botConfig.botId);
    if (mem && mem.action === "close") {
      const { coinTypeA, coinTypeB } = this.getCoinTypes();

      if (this.currentStep === ChaserStep.STEP1 && mem.coinB.amount.greaterThan(0)) {
        const swap = await this.swap(mem.coinB.amount, 0.01, coinTypeB, coinTypeA);
        await this.createMemory("swap", swap);
        this.coinAmount = mem.coinA.amount.add(swap.coinB.amount).toNumber();
        await this.updateBalances({
          coinA: mem.coinA.amount.add(swap.coinB.amount),
          coinB: new Decimal(0),
        });
      } else if (this.currentStep === ChaserStep.STEP2 && mem.coinA.amount.greaterThan(0)) {
        const swap = await this.swap(mem.coinA.amount, 0.01, coinTypeA, coinTypeB);
        await this.createMemory("swap", swap);
        this.coinAmount = mem.coinB.amount.add(swap.coinB.amount).toNumber();
        await this.updateBalances({
          coinA: new Decimal(0),
          coinB: mem.coinB.amount.add(swap.coinB.amount),
        });
      }
    }

    if (mem && mem.action !== "close" && mem.action !== "swap")
      throw new Error("Last position was not closed or recorded!");
  }

  private async executeStep1Strategy(position: UserPosition | null): Promise<void> {
    const buffer = Math.floor(this.tickRange * 0.05);
    const markers = this.getRelativeTicks(undefined, this.tickRange + buffer + 2);

    // Entry condition: create LP from ticker+1 to ticker+2
    if (!position) {
      await this.resetFunds();
      const balances = await this.openPosition(
        markers.upper[buffer],
        markers.upper[this.tickRange + buffer],
        true,
      );
      await this.setCurrentPosition();
      await this.createMemory("open", balances, this.currentPosition!);
      await prisma.botConfig.update({
        where: { botId: this.botConfig.botId },
        data: { status: "RUN" },
      });
      return;
    }

    const prevMarkers = this.getRelativeTicks(
      {
        lowerTick: this.ticks.find((tick) => tick.tick === position.lower_tick)!,
        upperTick: this.ticks.find((tick) => tick.tick === position.upper_tick)!,
      },
      this.tickRange + 2,
    );

    // Exit condition: MP beyond average of upperTick and upperTick+1
    const exitThreshold = new Decimal(prevMarkers.upper[0].price)
      .add(new Decimal(prevMarkers.upper[1].price))
      .div(2);

    if (this.price.greaterThan(exitThreshold)) {
      await prisma.botConfig.update({
        where: { botId: this.botConfig.botId },
        data: { status: "REBALANCE" },
      });

      logger.log(
        this.botConfig.botId,
        `Step 1: Exit threshold crossed for ${this.botConfig.botId}.`,
      );
      const balances = await this.closePosition(position.position_id);
      await this.createMemory("close", balances, position);
      this.coinAmount = balances.coinB.amount.toNumber();
      this.currentStep = ChaserStep.STEP2;
      await this.updateBalances({
        coinA: new Decimal(0),
        coinB: balances.coinB.amount,
      });
      return;
    }

    // Rebalance condition: MP beyond average of lowerTick-1 and lowerTick-2
    const rebalanceThreshold = new Decimal(prevMarkers.lower[2].price)
      .add(new Decimal(prevMarkers.lower[1].price))
      .div(2);
    if (this.price.lessThan(rebalanceThreshold)) {
      await prisma.botConfig.update({
        where: { botId: this.botConfig.botId },
        data: { status: "REBALANCE" },
      });

      logger.log(
        this.botConfig.botId,
        `Step 1: Rebalance threshold crossed for ${this.botConfig.botId}.`,
      );
      const balances = await this.closePosition(position.position_id);
      await this.createMemory("close", balances, position);
      this.coinAmount = balances.coinA.amount.toNumber();
      this.currentStep = ChaserStep.STEP1;
      await this.updateBalances({
        coinA: balances.coinA.amount,
        coinB: new Decimal(0),
      });
      return;
    }
    process.stdout.write(
      `\r\x1b[K${new Date().toLocaleTimeString()} Step 1: No action. ${
        this.botConfig.botId
      } p: ${this.price.toDecimalPlaces(9)} e: ${exitThreshold} r: ${rebalanceThreshold}`,
    );
  }

  private async executeStep2Strategy(position: UserPosition | null): Promise<void> {
    const buffer = Math.floor(this.tickRange * 0.05);
    const markers = this.getRelativeTicks(undefined, this.tickRange + 2);

    // Entry condition: create LP from ticker+1 to ticker+2
    if (!position) {
      await this.resetFunds();
      const balances = await this.openPosition(
        markers.lower[1],
        markers.lower[this.tickRange + 1 - buffer],
        false,
      );
      await this.setCurrentPosition();
      await this.createMemory("open", balances, this.currentPosition!);
      await prisma.botConfig.update({
        where: { botId: this.botConfig.botId },
        data: { status: "RUN" },
      });
      return;
    }

    const prevMarkers = this.getRelativeTicks({
      lowerTick: this.ticks.find((tick) => tick.tick === position.lower_tick)!,
      upperTick: this.ticks.find((tick) => tick.tick === position.upper_tick)!,
    });

    // Exit condition: MP beyond average of lowerTick and lowerTick-1
    const exitThreshold = new Decimal(prevMarkers.lower[3].price)
      .add(new Decimal(prevMarkers.lower[2].price))
      .div(2);
    if (this.price.lessThan(exitThreshold)) {
      await prisma.botConfig.update({
        where: { botId: this.botConfig.botId },
        data: { status: "REBALANCE" },
      });

      logger.log(
        this.botConfig.botId,
        `Step 2: Exit threshold crossed for ${this.botConfig.botId}.`,
      );
      const balances = await this.closePosition(position.position_id);
      await this.createMemory("close", balances, position);
      this.coinAmount = balances.coinA.amount.toNumber();
      this.currentStep = ChaserStep.STEP1;
      await this.updateBalances({
        coinA: balances.coinA.amount,
        coinB: new Decimal(0),
      });
      return;
    }

    // Rebalance condition: MP beyond average of upperTick+1 and upperTick+2
    const rebalanceThreshold = new Decimal(prevMarkers.upper[1].price)
      .add(new Decimal(prevMarkers.upper[2].price))
      .div(2);

    if (this.price.greaterThan(rebalanceThreshold)) {
      await prisma.botConfig.update({
        where: { botId: this.botConfig.botId },
        data: { status: "REBALANCE" },
      });

      logger.log(
        this.botConfig.botId,
        `Step 2: Rebalance threshold crossed for ${this.botConfig.botId}.`,
      );
      const balances = await this.closePosition(position.position_id);
      await this.createMemory("close", balances, position);
      this.coinAmount = balances.coinB.amount.toNumber();
      this.currentStep = ChaserStep.STEP2;
      await this.updateBalances({
        coinA: new Decimal(0),
        coinB: balances.coinB.amount,
      });
      return;
    }

    process.stdout.write(
      `\r\x1b[K${new Date().toLocaleTimeString()} Step 2: No action. ${
        this.botConfig.botId
      } p: ${this.price.toDecimalPlaces(9)} e: ${exitThreshold} r: ${rebalanceThreshold}`,
    );
  }

  async chaserStrategy() {
    if (this.currentStep === ChaserStep.STEP1) {
      await this.executeStep1Strategy(this.currentPosition);
    } else {
      await this.executeStep2Strategy(this.currentPosition);
    }
  }
}

export default Chaser;
