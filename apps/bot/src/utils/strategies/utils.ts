import Decimal from "decimal.js";
import { BluefinClient } from "../sui/bluefin";
import {
  ChaserStep,
  type BotConfig,
  Protocol,
  type CurrentTick,
  type PoolTick,
  type UserPosition,
  type PositionBalances,
  StrategyType,
  type RangePosition,
  sleep,
} from "@achilles/utils";
import { CetusClient } from "../sui/cetus";
import logger from "../logger";
import { Orca } from "../solana/orca";
import { address } from "@solana/kit";
import { swap, swapDCA } from "../solana/jupiter";
import { memory } from "../utils";
// import memory_local from "../memory_local";
import { Raydium } from "../solana/raydium";
import type { PollerClient } from "../poller/client";
import { convertFees } from "../convertFees";
import { prisma } from "@achilles/db";
import { activeBots } from "../../startBots";
Decimal.set({ precision: 9 });

class BotUtils {
  protected bluefin: BluefinClient;
  protected cetus: CetusClient;
  protected orca: Orca;
  protected raydium: Raydium;
  public poller: PollerClient;
  protected publicKey: string;
  protected currentStep: ChaserStep = ChaserStep.STEP1;
  protected isRunning: boolean = false;
  protected coinAmount: number = 0;
  public botConfig: BotConfig;
  public ticks: PoolTick[] = [];
  public currentTick: CurrentTick = {} as CurrentTick;
  public price: Decimal = new Decimal(0);
  public currentPosition: UserPosition | null = null;
  public inRangePositions: RangePosition | null = null;
  public terminateBot: boolean = false;

  constructor(botConfig: BotConfig, poller: PollerClient) {
    if (!botConfig) throw new Error(`Pool Config required!`);

    this.publicKey = botConfig.sender;
    this.bluefin = new BluefinClient(botConfig);
    this.cetus = new CetusClient(this.publicKey, botConfig);
    this.orca = new Orca(botConfig);
    this.raydium = new Raydium(botConfig);
    this.botConfig = botConfig;
    this.poller = poller;
  }

  getBoundingTicks(): { lowerTick: PoolTick; upperTick: PoolTick } {
    const sortedTicks = [...this.ticks].sort((a, b) => a.tick - b.tick);

    // Check for an exact price match
    const exactMatch = sortedTicks.find((tick) =>
      new Decimal(tick.price).equals(this.price)
    );
    if (exactMatch) {
      return { lowerTick: exactMatch, upperTick: exactMatch };
    }

    let lowerTick: PoolTick | null = null;
    let upperTick: PoolTick | null = null;

    for (const tick of sortedTicks) {
      const tickPrice = new Decimal(tick.price);

      if (tickPrice.lessThanOrEqualTo(this.price)) {
        lowerTick = tick;
      } else {
        upperTick = tick;
        break;
      }
    }

    return {
      lowerTick: lowerTick ? lowerTick : sortedTicks[0],
      upperTick: upperTick ? upperTick : sortedTicks[sortedTicks.length - 1],
    };
  }

  isChaserPositionInRange(position: UserPosition | null): boolean {
    if (!position) return false;

    return (
      this.price.greaterThanOrEqualTo(position.lower_price) &&
      this.price.lessThanOrEqualTo(position.upper_price)
    );
  }

  isRangePositionInRange(position: RangePosition | null): boolean {
    if (!position || !position.lower || !position.upper) return false;

    return (
      this.price.greaterThanOrEqualTo(position.lower.lower_price) &&
      this.price.lessThanOrEqualTo(position.upper.upper_price)
    );
  }

  /**
   * Get <range> no of ticks above and below <tickRange>
   */
  getRelativeTicks(
    tickRange?: CurrentTick,
    range: number = 4
  ): {
    upper: PoolTick[];
    lower: PoolTick[];
  } {
    const sortedTicks = [...this.ticks].sort((a, b) => a.tick - b.tick);
    const ticks = tickRange ?? this.currentTick;

    const lowerTicks = sortedTicks
      .filter((t) => t.tick <= ticks.lowerTick.tick)
      .slice(-1 * range);

    const upperTicks = sortedTicks
      .filter((t) => t.tick >= ticks.upperTick.tick)
      .slice(0, range);

    return { lower: lowerTicks, upper: upperTicks };
  }

  async getPoolTicks(): Promise<PoolTick[]> {
    // return this.botConfig.protocol === Protocol.BLUEFIN
    //   ? await this.bluefin.getPoolTicks()
    //   : await this.cetus.getPoolTicks();
    return (await this.poller.getLatestData()).ticks;
  }

  async getPoolPrice(): Promise<Decimal> {
    // return this.botConfig.protocol === Protocol.BLUEFIN
    //   ? await this.bluefin.getPoolPrice()
    //   : await this.cetus.getPoolPrice();
    return await this.poller.getLatestPrice();
  }

  async updateTicks() {
    const sortedTicks = this.ticks.sort((a, b) => a.tick - b.tick);

    const nextTickIndex = sortedTicks.findIndex((tick) =>
      new Decimal(tick.price).greaterThanOrEqualTo(this.price)
    );

    if (nextTickIndex !== -1) {
      const ticksFromStart = nextTickIndex;
      const ticksFromEnd = sortedTicks.length - nextTickIndex - 1;

      if (ticksFromStart < 500 || ticksFromEnd < 500) {
        this.ticks = await this.getPoolTicks();
      }
    }
  }

  getCoinTypes(): { coinTypeA: string; coinTypeB: string } {
    let coinTypeA = "";
    let coinTypeB = "";

    switch (this.botConfig.protocol) {
      case Protocol.BLUEFIN:
        coinTypeA = this.bluefin.poolInfo.coin_a.address;
        coinTypeB = this.bluefin.poolInfo.coin_b.address;
        break;
      case Protocol.CETUS:
        coinTypeA = this.cetus.poolInfo.coinTypeA;
        coinTypeB = this.cetus.poolInfo.coinTypeB;
        break;
      case Protocol.ORCA:
        coinTypeA = this.orca.poolInfo.tokenMintA;
        coinTypeB = this.orca.poolInfo.tokenMintB;
        break;
      case Protocol.RAYDIUM:
        coinTypeA = this.raydium.poolInfo.mintA.address;
        coinTypeB = this.raydium.poolInfo.mintB.address;
        break;
      default:
        throw new Error("Unknown protocol");
    }
    return { coinTypeA, coinTypeB };
  }

  async getUserPositions(): Promise<UserPosition[] | null> {
    let positions: UserPosition[] | null = null;

    switch (this.botConfig.protocol) {
      case Protocol.BLUEFIN:
        positions = await this.bluefin.getUserPositions();
        break;
      case Protocol.CETUS:
        positions = await this.cetus.getUserPositions();
        break;
      case Protocol.ORCA:
        positions = await this.orca.getUserPositions();
        break;
      case Protocol.RAYDIUM:
        positions = await this.raydium.getUserPositions();
        break;
      default:
        throw new Error("Unknown protocol");
    }

    return positions;
  }

  async terminate(clear: boolean = true) {
    await logger.slack(
      this.botConfig.botId,
      `Stopping bot ${this.botConfig.botId}`
    );
    this.terminateBot = true;
    while (this.isRunning) {
      logger.log(
        this.botConfig.botId,
        `Waiting for bot ${this.botConfig.botId} to stop.`
      );
      await sleep(500);
    }
    await this.closeAllPositions();

    if (clear) {
      await logger.slack(
        this.botConfig.botId,
        `Sweeping bot ${this.botConfig.botId}`
      );
      await this.sweep();
      activeBots.delete(this.botConfig.botId);
      await prisma.botConfig.update({
        where: { botId: this.botConfig.botId },
        data: { status: "STOP" },
      });

      // Terminate non used pollers
      const distinctBots = await prisma.botConfig.findMany({
        where: {
          poolId: this.botConfig.poolId,
          status: {
            not: "STOP",
          },
        },
        distinct: ["botId"],
        select: {
          botId: true,
        },
      });
      if (distinctBots.length <= 0) {
        await prisma.pollers.update({
          where: { poolId: this.botConfig.poolId },
          data: { status: "STOP" },
        });
      }
    }
  }

  async sweep() {
    const { coinTypeA, coinTypeB } = this.getCoinTypes();
    await convertFees(
      this.botConfig.botId,
      coinTypeA,
      coinTypeB,
      this.botConfig.sender
    );
  }

  async closeAllPositions() {
    await this.initialize();
    const positions = await this.getUserPositions();

    if (!positions) return;
    console.log(`Closing ${positions.length} positions.`);
    for (const position of positions) {
      const balances = await this.closePosition(position.position_id);
      await memory.createMemoryEntry(
        this.botConfig.botId,
        this.botConfig.strategy === StrategyType.CHASER ? "chaser" : "inrange",
        "close",
        balances,
        this.price,
        balances.digest,
        position
      );
    }
  }

  protected async openPosition(
    lower: PoolTick,
    upper: PoolTick,
    fix_amount_a: boolean
  ): Promise<PositionBalances> {
    let balances: PositionBalances;

    switch (this.botConfig.protocol) {
      case Protocol.BLUEFIN:
        balances = await this.bluefin.openPositionWithFixedAmount(
          this.publicKey,
          this.coinAmount,
          lower.price,
          upper.price,
          fix_amount_a
        );
        break;
      case Protocol.CETUS:
        balances = await this.cetus.openPositionWithFixedAmount(
          this.publicKey,
          this.coinAmount,
          lower.tick,
          upper.tick,
          fix_amount_a
        );
        break;
      case Protocol.ORCA:
        balances = await this.orca.openPosition(
          this.publicKey,
          this.coinAmount,
          new Decimal(lower.price).toNumber(),
          new Decimal(upper.price).toNumber(),
          fix_amount_a,
          100
        );
        break;
      case Protocol.RAYDIUM:
        balances = await this.raydium.openPosition(
          this.publicKey,
          this.coinAmount,
          lower.tick,
          upper.tick,
          fix_amount_a
        );
        break;
      default:
        throw new Error("Unknown protocol");
    }

    return balances;
  }

  protected async closePosition(posID: string): Promise<PositionBalances> {
    let balances: PositionBalances;
    switch (this.botConfig.protocol) {
      case Protocol.BLUEFIN:
        balances = await this.bluefin.closePosition(this.publicKey, posID);
        break;
      case Protocol.CETUS:
        balances = await this.cetus.closePosition(this.publicKey, posID);
        break;
      case Protocol.ORCA:
        balances = await this.orca.closePosition(
          address(posID),
          this.publicKey
        );
        break;
      case Protocol.RAYDIUM:
        balances = await this.raydium.closePosition(posID, this.publicKey);
        break;
      default:
        throw new Error("Unknown protocol");
    }
    this.currentPosition = null;
    this.inRangePositions = null;
    return balances;
  }

  protected async swap(
    swapAmount: Decimal,
    slippage: number,
    from: string,
    target: string,
    dca?: boolean
  ): Promise<PositionBalances> {
    let swapBalances: PositionBalances;
    if (
      this.botConfig.protocol === Protocol.ORCA ||
      this.botConfig.protocol === Protocol.RAYDIUM
    ) {
      if (dca) {
        swapBalances = await swapDCA(
          this.publicKey,
          swapAmount,
          10, // in bps: 10 bps = 0.1%
          from,
          target,
          this.botConfig.botId
        );
      } else {
        swapBalances = await swap(
          this.publicKey,
          swapAmount,
          10, // in bps: 10 bps = 0.1%
          from,
          target,
          this.botConfig.botId
        );
      }

      if (this.botConfig.protocol === Protocol.RAYDIUM)
        this.raydium.raydium?.account.updateTokenAccount(
          await this.raydium.fetchTokenAccountData(this.botConfig.sender)
        );
    } else {
      swapBalances = await this.cetus.swap(
        this.publicKey,
        swapAmount,
        slippage,
        from,
        target
      );
    }
    return swapBalances;
  }

  async initialize() {
    const strategy =
      this.botConfig.strategy === StrategyType.CHASER ? "chaser" : "in-range";
    let poolName = "";
    let protocol = "";
    switch (this.botConfig.protocol) {
      case Protocol.BLUEFIN:
        await this.bluefin.setPoolInfo(this.botConfig.poolId);
        poolName = this.bluefin.poolInfo.name;
        protocol = "Bluefin";
        break;
      case Protocol.CETUS:
        await this.cetus.setPoolInfo(this.botConfig.poolId);
        poolName = this.cetus.poolInfo.name;
        protocol = "Cetus";
        break;
      case Protocol.ORCA:
        await this.orca.setPoolInfo(this.botConfig.poolId);
        poolName = `ORCA ${this.orca.poolInfo.tokenMintA} | ${this.orca.poolInfo.tokenMintB}`;
        protocol = "ORCA";
        break;
      case Protocol.RAYDIUM:
        await this.raydium.setPoolInfo(this.botConfig.poolId);
        poolName = `Raydium ${this.raydium.poolInfo.mintA.address} | ${this.raydium.poolInfo.mintB.address}`;
        protocol = "Raydium";
        break;
      default:
        throw new Error("Unknown protocol");
    }
    logger.log(
      this.botConfig.botId,
      `Initializing ${protocol} bot for ${poolName} pool with ${strategy} strategy.`
    );

    this.price = await this.getPoolPrice();
    this.ticks = await this.getPoolTicks();
    this.currentTick = this.getBoundingTicks();
  }
}

export default BotUtils;
