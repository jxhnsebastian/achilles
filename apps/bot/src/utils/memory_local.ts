import { Decimal } from "decimal.js";
import * as fs from "fs";
import * as path from "path";
import type {
  UserPosition,
  PositionBalances,
  ChaserStep,
  BotMemoryEntry,
  ChaserInfo,
  InRangeInfo,
} from "@achilles/utils";

class Memory {
  private memories: Map<string, BotMemoryEntry[]> = new Map();
  private fileStreams: Map<string, fs.WriteStream> = new Map();
  private readonly maxMemoriesPerBot: number = 10;
  private readonly persistDirectory: string;

  constructor(persistDirectory: string = "./memories") {
    this.persistDirectory = persistDirectory;
    this.ensureDirectoryExists();
  }

  private ensureDirectoryExists(): void {
    if (!fs.existsSync(this.persistDirectory)) {
      fs.mkdirSync(this.persistDirectory, { recursive: true });
    }
  }

  private getFilePath(botId: string): string {
    return path.join(this.persistDirectory, `${botId}-memories.json`);
  }

  private getFileStream(botId: string): fs.WriteStream {
    if (!this.fileStreams.has(botId)) {
      const filePath = this.getFilePath(botId);

      // Open the file stream in append mode
      const stream = fs.createWriteStream(filePath, {
        flags: "a", // Use append mode
        encoding: "utf-8",
      });

      this.fileStreams.set(botId, stream);
    }

    return this.fileStreams.get(botId)!;
  }

  private appendMemoryToFile(botId: string, memory: BotMemoryEntry): void {
    try {
      const stream = this.getFileStream(botId);
      // Convert memory to JSON string and write with newline
      stream.write(JSON.stringify(memory) + "\n");
    } catch (error) {
      console.error(`Error persisting memory for bot ${botId}:`, error);
    }
  }

  private loadRecentMemoriesFromFile(botId: string): void {
    const filePath = this.getFilePath(botId);

    if (!fs.existsSync(filePath)) {
      this.memories.set(botId, []);
      return;
    }

    try {
      const fileContent = fs.readFileSync(filePath, "utf-8");
      const lines = fileContent.trim().split("\n");

      // Parse each line as a separate JSON object
      const memories: BotMemoryEntry[] = [];
      for (const line of lines) {
        if (line.trim()) {
          try {
            memories.push(JSON.parse(line));
          } catch (e) {
            console.error(`Error parsing memory line: ${line}`);
          }
        }
      }

      // Get only most recent entries
      const recentMemories = memories.slice(-this.maxMemoriesPerBot);
      this.memories.set(botId, recentMemories);
    } catch (error) {
      console.error(`Error loading memories for bot ${botId}:`, error);
      this.memories.set(botId, []);
    }
  }

  public addMemory(entry: BotMemoryEntry): void {
    const botId = entry.botId;

    // Initialize bot memory array if it doesn't exist
    if (!this.memories.has(botId)) {
      this.memories.set(botId, []);
      this.loadRecentMemoriesFromFile(botId);
    }

    const botMemories = this.memories.get(botId)!;

    // Add new memory to in-memory store
    botMemories.push(entry);

    // Keep only most recent maxMemoriesPerBot memories
    if (botMemories.length > this.maxMemoriesPerBot) {
      botMemories.shift();
    }

    // Always persist the memory to file
    this.appendMemoryToFile(botId, entry);
  }

  public getMemories(
    botId: string,
    limit: number = 10,
    action?: string
  ): BotMemoryEntry[] {
    if (!this.memories.has(botId)) {
      this.loadRecentMemoriesFromFile(botId);
    }
    let memories = this.memories.get(botId);

    if (action) {
      memories = memories?.filter((mem) => mem.action === action);
    }

    return memories?.slice(-1 * limit) || [];
  }

  public getAllBotIds(): string[] {
    // First check files in the directory to get all bot IDs
    const botIdsFromFiles = fs
      .readdirSync(this.persistDirectory)
      .filter((file) => file.endsWith("-memories.json"))
      .map((file) => file.replace("-memories.json", ""));

    // Combine with in-memory bot IDs
    const inMemoryBotIds = Array.from(this.memories.keys());

    // Return unique IDs
    return [...new Set([...botIdsFromFiles, ...inMemoryBotIds])];
  }

  public getMostRecentMemory(
    botId: string,
    action?: string
  ): BotMemoryEntry | undefined {
    // Ensure memories are loaded for this bot
    if (!this.memories.has(botId)) {
      this.loadRecentMemoriesFromFile(botId);
    }

    const botMemories = this.memories.get(botId) || [];

    // If there are no memories, return undefined
    if (botMemories.length === 0) {
      return undefined;
    }

    // If action is specified, filter memories by that action
    if (action) {
      const filteredMemories = botMemories.filter(
        (memory) => memory.action === action
      );
      // Return the most recent memory with the specified action, or undefined if none found
      return filteredMemories.length > 0
        ? filteredMemories[filteredMemories.length - 1]
        : undefined;
    }

    // If no action specified, return the latest memory (last in array)
    return botMemories[botMemories.length - 1];
  }

  // Utility function to calculate L coefficient
  public calculateLCoefficient(
    value: Decimal,
    price: Decimal,
    tickDiff: number,
    imbalance: Decimal = new Decimal(0),
    feeRate: Decimal = new Decimal(0)
  ): Decimal {
    // V = lp_position['value'] * (1 - (0.5 - lp_position['imbalance']) * lp_position['fee_rate'])
    const V = value.mul(
      new Decimal(1).sub(new Decimal(0.5).sub(imbalance).mul(feeRate))
    );

    // Calculate L = V / (2*sqrt(P) - (P+P)/(sqrt(P)*(1.0001^t)))
    const sqrtP = price.sqrt();
    const denominator = sqrtP
      .mul(2)
      .sub(price.add(price).div(sqrtP.mul(new Decimal(1.0001).pow(tickDiff))));

    return V.div(denominator);
  }

  // Create a memory entry from position data
  public createMemoryEntry(
    botId: string,
    strategy: "chaser" | "inrange",
    action: "open" | "close" | "swap" | "collect",
    positionBalances: PositionBalances,
    price: Decimal,
    digest: string = "",
    position?: UserPosition,
    step?: ChaserStep
  ) {
    let strategyInfo: ChaserInfo | InRangeInfo = {} as ChaserInfo | InRangeInfo;

    if (strategy === "chaser") {
      strategyInfo = { type: "chaser", step, position };
    } else if (strategy === "inrange") {
      strategyInfo = { type: "inrange", position };
    } else {
      throw new Error(`Unsupported strategy type: ${strategy}`);
    }

    this.addMemory({
      botId,
      action,
      timestamp: Date.now(),
      strategy: strategyInfo,
      digest,
      coinA: positionBalances.coinA,
      coinB: positionBalances.coinB,
      balances: positionBalances.others ?? [],
      price,
    });
  }

  // Clean up when shutting down
  public close(): void {
    // Close all file streams
    for (const stream of this.fileStreams.values()) {
      stream.end();
    }
    this.fileStreams.clear();
  }
}

export default new Memory();
