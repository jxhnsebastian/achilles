import { prisma } from "@achilles/db";
import { swap } from "./solana/jupiter";
import Decimal from "decimal.js";
import logger from "./logger";
import { address } from "@solana/kit";
import {
  StrategyType,
  type BotConfig,
  type PositionBalances,
  type UserPosition,
  Protocol,
  type BotMemoryEntry,
  type ConvertInfo,
  convertBotConfig,
} from "@achilles/utils";
import { maxRetries, serialize, sleep, wait } from "@achilles/utils";
import { Orca } from "./solana/orca";
import { Raydium } from "./solana/raydium";
import { tokenRegistry, memory } from "./utils";

const SCRIPT_ID = "fee_converter";
const TARGET_TOKEN = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";

let thread: string | undefined = "";
let sdk: Orca | Raydium;

const swapper: { [key: string]: { [key: string]: Decimal } } = {};

const log = (msg: string, info?: any) => {
  logger.log(SCRIPT_ID, msg, info);
};

const slack = async (msg: string, info?: any) => {
  thread = await logger.slack(SCRIPT_ID, msg, undefined, thread, info);
};

async function createMemory(
  botId: string,
  balances: PositionBalances,
  lastConvert: string
) {
  await memory.addMemory({
    botId,
    action: "convert_fees",
    timestamp: Date.now(),
    strategy: { lastConvert },
    digest: balances.digest,
    coinA: balances.coinA,
    coinB: balances.coinB,
    balances: balances.others ?? [],
    price: new Decimal(0),
  });
}

async function getLastConvertMemory(botId: string): Promise<string | null> {
  const lastConvertMemory = await prisma.botMemoryV2.findFirst({
    where: {
      botId: botId,
      action: "convert_fees",
    },
    orderBy: {
      timestamp: "desc",
    },
  });

  if (!lastConvertMemory) return null;

  const typedMemory = memory.convertFromDatabase(lastConvertMemory);
  return (typedMemory.strategy as ConvertInfo)?.lastConvert || null;
}

async function convertFeesToTargetToken(botId?: string) {
  try {
    log(`Starting fee conversion job at ${new Date().toISOString()}`);
    await slack("Converting fees");

    const botFilter = botId ? { botId } : {};
    const bots: BotConfig[] = (
      await prisma.botConfig.findMany({ where: botFilter })
    ).map((bot) => {
      return convertBotConfig(bot);
    });

    for (const bot of bots) {
      try {
        log(`Processing bot ${bot.botId}...`);
        await slack(bot.botId);

        let coinTypeA = "";
        let coinTypeB = "";

        switch (bot.protocol) {
          case Protocol.ORCA:
            sdk = new Orca(bot);
            await sdk.setPoolInfo(bot.poolId);
            coinTypeA = sdk.poolInfo.tokenMintA;
            coinTypeB = sdk.poolInfo.tokenMintB;
            break;
          case Protocol.RAYDIUM:
            sdk = new Raydium(bot);
            await sdk.setPoolInfo(bot.poolId);
            coinTypeA = sdk.poolInfo.mintA.address;
            coinTypeB = sdk.poolInfo.mintB.address;
            break;
          default:
            throw new Error("Unknown protocol");
        }

        await collectFees(bot);
        await convertFees(bot.botId, coinTypeA, coinTypeB, bot.sender);
      } catch (error) {
        await slack(`Error processing bot ${bot.botId}:`, error);
      }
    }
    await slack(serialize(swapper));
    await slack(`Fee conversion job completed at ${new Date().toISOString()}`);
  } catch (error) {
    log("Error in fee conversion job:", error);
  } finally {
    await prisma.$disconnect();
  }
}

async function collectFees(bot: BotConfig) {
  try {
    let retries = 0;
    let positions: UserPosition[] | null = null;
    while (retries < maxRetries) {
      positions = await sdk.getUserPositions();
      if (
        positions &&
        positions.length === (bot.strategy === StrategyType.INRANGE ? 2 : 1)
      )
        break;
      else {
        retries++;
        if (retries < maxRetries) {
          log(
            `Failed to get position for ${bot?.botId}. Retrying in ${
              wait ** retries
            }s...`
          );
          await sleep(wait ** retries * 1000);
          continue;
        }
        throw new Error("Failed to get positions!");
      }
    }

    for (const position of positions!) {
      retries = 0;
      while (retries < maxRetries) {
        try {
          log(`Collecting fee and rewards for ${position.position_id}.`);
          switch (bot.protocol) {
            case Protocol.ORCA:
              await (sdk as Orca).collectFeeAndRewards(
                address(position.position_id),
                bot.sender
              );
              break;
            case Protocol.RAYDIUM:
              await (sdk as Raydium).closePosition(
                position.position_id,
                bot.sender,
                true
              );
              break;
            default:
              throw new Error("Unknown protocol");
          }

          break;
        } catch (error: any) {
          retries++;

          if (retries < maxRetries) {
            log(
              `Attempt ${retries} to collect fees for ${
                bot.botId
              } failed: ${error}. Retrying in ${wait ** retries}...`
            );
            await sleep(wait ** retries * 1000);
            continue;
          }

          log(
            `Failed to collect for ${bot.botId} after ${maxRetries} attempts.`,
            error
          );
          throw error;
        }
      }
    }
  } catch (error) {
    await slack(`Failed to collect fees for ${bot.botId}:`, error);
  }
}

async function convertFees(
  botId: string,
  coinAType: string,
  coinBType: string,
  sender: string
) {
  // Get the last conversion memory to find the last processed collect transaction
  const lastConvertDigest = await getLastConvertMemory(botId);

  log(
    `Last conversion digest for bot ${botId}: ${lastConvertDigest || "None"}`
  );

  // Query to find collect entries after the last conversion
  const collectEntriesQuery: any = {
    where: {
      botId: botId,
      action: "collect",
    },
    orderBy: {
      timestamp: "asc",
    },
  };

  // If we have a last conversion, only get collect transactions after that one
  if (lastConvertDigest) {
    // Find the timestamp of the last converted collect transaction
    const lastCollectTx = await prisma.botMemoryV2.findFirst({
      where: {
        botId: botId,
        action: "collect",
        digest: lastConvertDigest,
      },
    });

    if (lastCollectTx) {
      // Only get collect transactions after the last converted one
      collectEntriesQuery.where = {
        ...collectEntriesQuery.where,
        timestamp: {
          gt: lastCollectTx.timestamp,
        },
      };
    }
  }

  const collectEntries = await prisma.botMemoryV2.findMany(collectEntriesQuery);

  if (collectEntries.length === 0) {
    await slack(`No new collect entries found for bot ${botId}`);
    return;
  }

  log(`Found ${collectEntries.length} new collect entries to process`);

  const typedEntries: BotMemoryEntry[] = collectEntries.map((entry: any) =>
    memory.convertFromDatabase(entry)
  );

  const feeBalances: Map<string, Decimal> = new Map();

  // to get the target token price later on
  feeBalances.set(TARGET_TOKEN, new Decimal(0));

  for (const entry of typedEntries) {
    // console.log(entry.coinA, entry.coinB)
    if (entry.coinA.amount.greaterThan(0)) {
      const currentAmount = (feeBalances.get(coinAType) || new Decimal(0)).add(
        entry.coinA.amount
      );
      feeBalances.set(coinAType, currentAmount);
    }

    if (entry.coinB.amount.greaterThan(0)) {
      const currentAmount = (feeBalances.get(coinBType) || new Decimal(0)).add(
        entry.coinB.amount
      );
      feeBalances.set(coinBType, currentAmount);
    }

    for (const balance of entry.balances) {
      if (balance.amount.greaterThan(0)) {
        const currentAmount = (
          feeBalances.get(balance.coinType) || new Decimal(0)
        ).add(balance.amount);
        feeBalances.set(balance.coinType, currentAmount);
      }
    }
  }

  const tokens = Array.from(feeBalances.keys());
  const prices = await tokenRegistry.getTokensPrices(tokens);
  // console.log(prices);
  const swapBalances: { coinType: string; amount: Decimal }[] = [];

  for (const [coinType, amount] of feeBalances.entries()) {
    if (coinType === TARGET_TOKEN) continue;

    // if (amount.mul(prices[coinType]).lessThanOrEqualTo(1)) continue;

    swapBalances.push({ coinType, amount: amount.mul(0.9) });
  }

  // Store the latest collect entry's digest for the next conversion reference
  const lastCollectDigest = typedEntries[typedEntries.length - 1]?.digest;

  for (const balance of swapBalances) {
    try {
      log(
        `Swapping ${balance.amount.toString()} of ${
          balance.coinType
        } to ${TARGET_TOKEN} for bot ${botId}`
      );

      if (!swapper[sender]) swapper[sender] = {};
      if (!swapper[sender][balance.coinType])
        swapper[sender][balance.coinType] = new Decimal(0);

      swapper[sender][balance.coinType] = swapper[sender][balance.coinType].add(
        balance.amount
      );

      const balances = await swap(
        sender,
        balance.amount,
        50,
        balance.coinType,
        TARGET_TOKEN,
        botId
      );

      // Create memory with the last collect transaction's digest
      await createMemory(botId, balances, lastCollectDigest);

      await slack(
        `${"`"}${balances.coinA.amount.toString()} ($${balances.coinA.amount
          .mul(prices[balance.coinType] || 0)
          .toString()}) ${
          tokenRegistry.getTokenData(balance.coinType).symbol
        } to ${balances.coinB.amount.toString()} ($${balances.coinB.amount
          .mul(prices[TARGET_TOKEN] || 0)
          .toString()}) ${
          tokenRegistry.getTokenData(TARGET_TOKEN).symbol
        }${"`"}`
      );

      log(`Swap completed successfully for ${balance.coinType}`);
    } catch (error) {
      log(`Error swapping ${balance.coinType} to ${TARGET_TOKEN}:`, error);
    }
  }

  log(`Fee conversion completed for bot ${botId}`);
}

if (require.main === module) {
  await convertFeesToTargetToken();
}

export { convertFeesToTargetToken, convertFees };
