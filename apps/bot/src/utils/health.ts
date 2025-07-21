import { Decimal } from "decimal.js";
import { prisma } from "@achilles/db";
import type { BotMemoryEntry } from "@achilles/utils";
import logger from "./logger";
import { tokenRegistry, memory } from "./utils";

export async function checkBotHealth(
  botId: string,
  coinAMint: string,
  coinBMint: string
) {
  try {
    const recentEntries = await prisma.botMemoryV2.findMany({
      where: {
        botId: botId,
        NOT: { action: "convert_fees" },
      },
      orderBy: {
        timestamp: "desc",
      },
      take: 100,
    });

    const typedEntries: BotMemoryEntry[] = recentEntries
      .map((entry) => memory.convertFromDatabase(entry))
      .sort((a, b) => a.timestamp - b.timestamp);

    // Identify rebalancing operations (starts with swap after close)
    const rebalancingOperations: BotMemoryEntry[][] = [];
    let currentRebalancing: BotMemoryEntry[] = [];
    let previousAction = "";

    for (const entry of typedEntries) {
      if (entry.action === "swap" && previousAction === "close") {
        if (currentRebalancing.length > 0) {
          rebalancingOperations.push(currentRebalancing);
        }
        currentRebalancing = [entry];
      } else {
        currentRebalancing.push(entry);
      }
      previousAction = entry.action;
    }

    if (
      currentRebalancing.length > 0 &&
      currentRebalancing.filter((step) => step.action === "close").length === 2
    ) {
      rebalancingOperations.push(currentRebalancing);
    }

    const lastThreeRebalancings = rebalancingOperations.slice(
      rebalancingOperations.length - 3
    );

    if (lastThreeRebalancings.length < 3) {
      logger.log(
        botId,
        `Not enough rebalancing operations found for bot ${botId}. Found: ${lastThreeRebalancings.length}`
      );
      return {
        botId,
        rebalancingCount: lastThreeRebalancings.length,
        tooManyRebalancings: false,
        healthStatus: "insufficient_data",
      };
    }

    // frequency check
    const firstRebalancingTime = lastThreeRebalancings[0][0].timestamp;
    const lastRebalancingTime =
      lastThreeRebalancings[2][lastThreeRebalancings[2].length - 1].timestamp;

    const timeSpanHours =
      (lastRebalancingTime - firstRebalancingTime) / (60 * 60 * 1000);
    const tooManyRebalancings = timeSpanHours <= 4;

    if (tooManyRebalancings) {
      await logger.slack(
        botId,
        `ALERT: Bot ${botId} has 3 rebalancings in ${timeSpanHours.toFixed(
          2
        )} hours. <@U08D7607G65> <@U07P4BK0RRC> <@U07CQBXLZKQ>`
      );
    }

    // pnl check
    const { totalProfitLoss, totalFees } = await calculateCombinedMetrics(
      lastThreeRebalancings,
      coinAMint,
      coinBMint
    );

    const isPLossGreaterThanFees =
      totalProfitLoss.lessThan(0) &&
      totalProfitLoss.abs().greaterThan(totalFees);

    if (isPLossGreaterThanFees) {
      await logger.slack(
        botId,
        `ALERT: Bot ${botId} has combined P/L loss (${totalProfitLoss.toFixed(
          2
        )}) greater than fees (${totalFees.toFixed(
          2
        )}) across last 3 rebalancings. <@U08D7607G65> <@U07P4BK0RRC> <@U07CQBXLZKQ>`
      );
    }

    return {
      botId,
      rebalancingCount: lastThreeRebalancings.length,
      tooManyRebalancings,
      timeSpanHours,
      totalProfitLoss,
      totalFees,
      isPLossGreaterThanFees,
      healthStatus:
        isPLossGreaterThanFees || tooManyRebalancings ? "unhealthy" : "healthy",
    };
  } catch (e: any) {
    await logger.slack(
      botId,
      `Failed to check health for ${botId}. Error: ${
        e?.message ?? "Unknown error"
      }`,
      undefined,
      e
    );
  }
}

async function calculateCombinedMetrics(
  rebalancings: BotMemoryEntry[][],
  coinAMint: string,
  coinBMint: string
): Promise<{ totalProfitLoss: Decimal; totalFees: Decimal }> {
  let totalFees = new Decimal(0);

  for (const rebalancing of rebalancings) {
    for (const entry of rebalancing.filter(
      (entry) => entry.action === "close" || entry.action === "collect"
    )) {
      const uniqueCoinTypes = new Set<string>([
        ...entry.balances
          .filter((balance) => balance.amount.greaterThan(0))
          .map((balance) => balance.coinType),
        coinAMint,
        coinBMint,
      ]);

      const tokens = Array.from(uniqueCoinTypes);
      const prices = await tokenRegistry.getTokensPrices(
        tokens,
        entry.timestamp / 1000
      );

      if (entry.action === "close") {
        for (const balance of entry.balances) {
          if (balance.amount.greaterThan(0))
            totalFees = totalFees.add(
              calculateBalance(balance.amount, balance.coinType).mul(
                prices[balance.coinType]
              )
            );
        }
      } else if (entry.action === "collect") {
        if (entry.coinA.amount.greaterThan(0))
          totalFees = totalFees.add(entry.coinA.amount.mul(prices[coinAMint]));
        if (entry.coinB.amount.greaterThan(0))
          totalFees = totalFees.add(entry.coinB.amount.mul(prices[coinBMint]));
        for (const balance of entry.balances) {
          if (balance.amount.greaterThan(0))
            totalFees = totalFees.add(
              calculateBalance(balance.amount, balance.coinType).mul(
                prices[balance.coinType]
              )
            );
        }
      }
    }
  }

  const firstRebalancing = rebalancings[0];
  const lastRebalancing = rebalancings[rebalancings.length - 1];

  let initialCloseValue = new Decimal(0);
  const initialCloseEntries = firstRebalancing.filter(
    (entry) => entry.action === "close"
  );
  for (const entry of initialCloseEntries) {
    const prices = await tokenRegistry.getTokensPrices(
      [coinAMint, coinBMint],
      entry.timestamp / 1000
    );
    initialCloseValue = initialCloseValue
      .add(entry.coinA.amount.mul(prices[coinAMint]))
      .add(entry.coinB.amount.mul(prices[coinBMint]));
    // console.log(entry.coinA, entry.coinB, prices);
  }

  let finalCloseValue = new Decimal(0);
  const finalCloseEntries = lastRebalancing.filter(
    (entry) => entry.action === "close"
  );
  for (const entry of finalCloseEntries) {
    const prices = await tokenRegistry.getTokensPrices(
      [coinAMint, coinBMint],
      entry.timestamp / 1000
    );
    finalCloseValue = finalCloseValue
      .add(entry.coinA.amount.mul(prices[coinAMint]))
      .add(entry.coinB.amount.mul(prices[coinBMint]));
    // console.log(entry.coinA, entry.coinB, prices);
  }

  console.log(initialCloseValue, finalCloseValue, totalFees);
  const totalProfitLoss = finalCloseValue.sub(initialCloseValue);

  return {
    totalProfitLoss,
    totalFees,
  };
}

const calculateBalance = (amount: Decimal, address: string): Decimal => {
  const token = tokenRegistry.getTokenData(address);
  return amount.div(token.chainType === "solana" ? 1 : 10 ** token.decimals);
};

//@ts-ignore
export async function calculateLoss(
  botId: string,
  coinAMint: string,
  coinBMint: string
): Promise<void> {
  const recentEntries = await prisma.botMemoryV2.findMany({
    where: {
      botId: botId,
      NOT: { action: "convert_fees" },
    },
    orderBy: {
      timestamp: "desc",
    },
    take: 100,
  });

  const typedEntries: BotMemoryEntry[] = recentEntries
    .map((entry) => memory.convertFromDatabase(entry))
    .sort((a, b) => a.timestamp - b.timestamp);

  // Identify rebalancing operations (starts with swap after close)
  const rebalancings: BotMemoryEntry[][] = [];
  let currentRebalancing: BotMemoryEntry[] = [];
  let previousAction = "";

  for (const entry of typedEntries) {
    if (entry.action === "swap" && previousAction === "close") {
      if (currentRebalancing.length > 0) {
        rebalancings.push(currentRebalancing);
      }
      currentRebalancing = [entry];
    } else {
      currentRebalancing.push(entry);
    }
    previousAction = entry.action;
  }

  if (currentRebalancing.length > 0) {
    rebalancings.push(currentRebalancing);
  }

  console.log("Total: ", rebalancings.flatMap((entry) => entry).length);
  console.log(
    "Swaps: ",
    rebalancings.flatMap((entry) =>
      entry.filter((item) => item.action === "swap")
    ).length,
    "Opens: ",
    rebalancings.flatMap((entry) =>
      entry.filter((item) => item.action === "open")
    ).length,
    "Closes: ",
    rebalancings.flatMap((entry) =>
      entry.filter((item) => item.action === "close")
    ).length,
    "Collects: ",
    rebalancings.flatMap((entry) =>
      entry.filter((item) => item.action === "collect")
    ).length,
    "Converts: ",
    rebalancings.flatMap((entry) =>
      entry.filter((item) => item.action === "convert_fees")
    ).length
  );
  let pnl = new Decimal(0);
  let totalFees = new Decimal(0);
  for (const rebalancing of rebalancings) {
    let open = new Decimal(0);
    let close = new Decimal(0);
    let fees = new Decimal(0);
    for (const entry of rebalancing) {
      const uniqueCoinTypes = new Set<string>([
        // ...rebalancing
        //   .flatMap((entry) => entry.balances)
        //   .map((balance) => balance.coinType),
        coinAMint,
        coinBMint,
        "So11111111111111111111111111111111111111112",
      ]);
      const tokens = Array.from(uniqueCoinTypes);
      const prices = await tokenRegistry.getTokensPrices(
        tokens,
        entry.timestamp / 1000
      );

      // prices[coinBMint] = entry.price.lessThanOrEqualTo(0)
      //   ? 0
      //   : prices["So11111111111111111111111111111111111111112"] /
      //     entry.price.toNumber()

      if (entry.action === "open") {
        open = open
          .add(entry.coinA.amount.abs().mul(prices[coinAMint]))
          .add(entry.coinB.amount.abs().mul(prices[coinBMint]));
      }
      if (entry.action === "close") {
        close = close
          .add(entry.coinA.amount.abs().mul(prices[coinAMint]))
          .add(entry.coinB.amount.abs().mul(prices[coinBMint]));
        for (const balance of entry.balances) {
          if (balance.amount.greaterThan(0))
            fees = fees.add(
              calculateBalance(balance.amount, balance.coinType).mul(
                prices[balance.coinType]
              )
            );
        }
      } else if (entry.action === "collect") {
        if (entry.coinA.amount.greaterThan(0))
          fees = fees.add(entry.coinA.amount.mul(prices[coinAMint]));
        if (entry.coinB.amount.greaterThan(0))
          fees = fees.add(entry.coinB.amount.mul(prices[coinBMint]));
        for (const balance of entry.balances) {
          if (balance.amount.greaterThan(0))
            fees = fees.add(
              calculateBalance(balance.amount, balance.coinType).mul(
                prices[balance.coinType]
              )
            );
        }
      }
    }
    console.log(open, close, close.sub(open), fees);
    pnl = pnl.add(close.greaterThan(0) ? close.sub(open) : 0);
    totalFees = totalFees.add(fees);
  }
  console.log(pnl, totalFees);
}
