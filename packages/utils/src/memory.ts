import { Decimal } from "decimal.js";
import { prisma } from "@achilles/db";
// import { RedpandaClient, SASLMechanism } from "@achilles/redpanda";
import type {
  UserPosition,
  PositionBalances,
  ChaserStep,
  BotMemoryEntry,
  ChaserInfo,
  InRangeInfo,
  ConvertInfo,
  StrategyParams,
} from "./types";

// const redpanda = new RedpandaClient({
//   brokers: [process.env.REDPANDA_BROKER_URL ?? ""],
//   ssl: true,
//   sasl: {
//     mechanism: (process.env.REDPANDA_SASL_MECHANISM ?? "scram-sha-256") as SASLMechanism,
//     username: process.env.REDPANDA_USERNAME ?? "",
//     password: process.env.REDPANDA_PASSWORD ?? "",
//   },
//   logLevel: 5,
// });

// await redpanda.connect();

export class Memory {
  private prepareForDatabase(entry: BotMemoryEntry): any {
    return {
      botId: entry.botId,
      action: entry.action,
      timestamp: new Date(entry.timestamp),
      digest: entry.digest,
      coinA: {
        ...entry.coinA,
        amount: this.validateDecimal(entry.coinA.amount).toString(),
      },
      coinB: {
        ...entry.coinB,
        amount: this.validateDecimal(entry.coinB.amount).toString(),
      },
      strategy: this.serializeStrategy(entry.strategy),
      balances: this.serializeBalances(entry.balances),
      price: entry.price.toString(),
      user: entry.user,
    };
  }

  serializeStrategy(strategy: ChaserInfo | InRangeInfo | ConvertInfo | StrategyParams): any {
    return JSON.parse(
      JSON.stringify(strategy, (key, value) =>
        value instanceof Decimal ? value.toString() : value,
      ),
    );
  }

  private serializeBalances(balances: { coinType: string; amount: Decimal }[]): any {
    return balances.map((balance) => ({
      coinType: balance.coinType,
      amount: this.validateDecimal(balance.amount).toString(),
    }));
  }

  convertFromDatabase(record: any): BotMemoryEntry {
    return {
      botId: record.botId,
      action: record.action as "open" | "close" | "swap" | "collect" | "convert_fees" | "update",
      timestamp: new Date(record.timestamp).getTime(),
      strategy: this.deserializeStrategy(record.strategy),
      digest: record.digest,
      coinA: this.deserializeBalances(record.coinA),
      coinB: this.deserializeBalances(record.coinB),
      balances: record.balances.map((balance: any) => this.deserializeBalances(balance)),
      price: new Decimal(record.price),
      user: record?.user ?? undefined,
    };
  }

  private deserializeStrategy(
    strategyData: any,
  ): ChaserInfo | InRangeInfo | ConvertInfo | StrategyParams {
    const strategy = strategyData;

    if (strategy.position) {
      strategy.position.lower_price = new Decimal(strategy.position.lower_price);
      strategy.position.upper_price = new Decimal(strategy.position.upper_price);
    }

    if (strategy.coinA) {
      strategy.coinA = this.deserializeBalances(strategy.coinA);
    }

    if (strategy.coinB) {
      strategy.coinB = this.deserializeBalances(strategy.coinB);
    }

    return strategy;
  }

  deserializeBalances(balance: any): {
    coinType: string;
    amount: Decimal;
  } {
    return {
      coinType: balance.coinType,
      amount: new Decimal(balance.amount),
    };
  }

  async redpandaStream(entry: BotMemoryEntry, topic: string, botId: string) {
    try {
      const data = this.prepareForDatabase(entry);
      const strategy = entry.strategy as ChaserInfo | InRangeInfo;
      let message: any = {
        ...data,
        coinA_coinType: entry.coinA.coinType,
        coinA_amount: this.validateDecimal(entry.coinB.amount).toString(),
        coinB_coinType: entry.coinA.coinType,
        coinB_amount: this.validateDecimal(entry.coinA.amount).toString(),
      };
      if (strategy.position)
        Object.entries(strategy.position).forEach(([key, value]) => {
          if (key === "lower_price" || key === "upper_price") {
            message[`position_${key}`] = this.validateDecimal(value).toString();
          } else {
            message[`position_${key}`] = value;
          }
        });

      // await redpanda.sendMessage(message, { topic });
    } catch (error) {
      console.error(`Error streaming memory to redpanda for bot ${botId}:`, error);
      throw error;
    }
  }

  public async addMemory(entry: BotMemoryEntry): Promise<void> {
    try {
      await prisma.botMemoryV2.create({ data: this.prepareForDatabase(entry) });
      await this.redpandaStream(entry, "bot-memory-stream", entry.botId);
    } catch (error) {
      console.error(`Error persisting memory for bot ${entry.botId}:`, error);
      throw error;
    }
  }

  public async getMemories(
    botId: string,
    limit: number = 10,
    action?: string,
  ): Promise<BotMemoryEntry[]> {
    try {
      const whereClause = action ? { botId, action } : { botId };
      const memories = await prisma.botMemoryV2.findMany({
        where: whereClause,
        orderBy: { timestamp: "desc" },
        take: limit,
      });

      return memories.map((record) => this.convertFromDatabase(record)).reverse();
    } catch (error) {
      console.error(`Error retrieving memories for bot ${botId}:`, error);
      return [];
    }
  }

  public async getAllBotIds(): Promise<string[]> {
    try {
      const distinctBots = await prisma.botMemoryV2.findMany({
        distinct: ["botId"],
        select: { botId: true },
      });
      return distinctBots.map((bot: any) => bot.botId);
    } catch (error) {
      console.error("Error fetching bot IDs:", error);
      return [];
    }
  }

  /**
   * Gets the most recent memory for a specific bot, optionally filtered by action
   */
  public async getMostRecentMemory(
    botId: string,
    action?: string,
  ): Promise<BotMemoryEntry | undefined> {
    try {
      const whereClause = action ? { botId, action } : { botId, NOT: { action: "convert_fees" } };

      const memory = await prisma.botMemoryV2.findFirst({
        where: whereClause,
        orderBy: { timestamp: "desc" },
      });

      return memory ? this.convertFromDatabase(memory) : undefined;
    } catch (error) {
      console.error(`Error retrieving most recent memory for bot ${botId}:`, error);
      return undefined;
    }
  }

  public calculateLCoefficient(
    value: Decimal,
    price: Decimal,
    tickDiff: number,
    imbalance: Decimal = new Decimal(0),
    feeRate: Decimal = new Decimal(0),
  ): Decimal {
    const V = value.mul(new Decimal(1).sub(new Decimal(0.5).sub(imbalance).mul(feeRate)));

    const sqrtP = price.sqrt();
    const denominator = sqrtP
      .mul(2)
      .sub(price.add(price).div(sqrtP.mul(new Decimal(1.0001).pow(tickDiff))));

    return V.div(denominator);
  }

  validateDecimal = (value: Decimal): Decimal => {
    if (value.isNaN() || !value.isFinite()) {
      return new Decimal(0);
    }
    return value;
  };

  /**
   * Creates and stores a memory entry from position data
   */
  public async createMemoryEntry(
    botId: string,
    strategy: "chaser" | "inrange",
    action: "open" | "close" | "swap" | "collect",
    positionBalances: PositionBalances,
    price: Decimal,
    digest: string = "",
    position?: UserPosition,
    step?: ChaserStep,
  ): Promise<void> {
    let strategyInfo: ChaserInfo | InRangeInfo | ConvertInfo;

    if (strategy === "chaser") {
      strategyInfo = { type: "chaser", step, position };
    } else if (strategy === "inrange") {
      strategyInfo = { type: "inrange", position };
    } else {
      throw new Error(`Unsupported strategy type: ${strategy}`);
    }

    await this.addMemory({
      botId,
      action,
      timestamp: Date.now(),
      strategy: strategyInfo!,
      digest,
      coinA: positionBalances.coinA,
      coinB: positionBalances.coinB,
      balances: positionBalances.others ?? [],
      price,
    });
  }

  public async close(): Promise<void> {
    await prisma.$disconnect();
  }
}
