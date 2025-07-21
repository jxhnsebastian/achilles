import { type QuoteResponse, SwapMode } from "@jup-ag/api";
import {
  Connection,
  VersionedTransaction,
  type ParsedTransactionWithMeta,
  SendTransactionError,
  PublicKey,
} from "@solana/web3.js";
import logger from "../logger";
import { serialize } from "@achilles/utils";
import { fetchWithRetry, sleep } from "@achilles/utils";
import { getBalances } from "./parser";
import type { PositionBalances, TokenPriceDetails } from "@achilles/utils";
import { getMint } from "@solana/spl-token";
import { BN } from "bn.js";
import { executeVersionedTransaction } from "./utils";
import Decimal from "decimal.js";
import { memory } from "../utils";

const RPC = process.env.RPC!;
const connection = new Connection(RPC, "confirmed");

function calculateSlippageFromQuote(
  quote: QuoteResponse,
  inDecimals: number,
  outDecimals: number,
  prices: Record<string, number>
): Decimal {
  const inTokens = new Decimal(quote.inAmount).div(10 ** inDecimals);
  const outTokens = new Decimal(quote.outAmount).div(10 ** outDecimals);
  const inUSD = inTokens.mul(prices[quote.inputMint] ?? 0);
  const outUSD = outTokens.mul(prices[quote.outputMint] ?? 0);

  const slippage = inUSD.minus(outUSD).div(inUSD).mul(10000); // bps

  console.log(
    `${inTokens.toFixed(2)}(${inUSD}) ${outTokens.toFixed(
      2
    )}(${outUSD}) slippage: ${slippage} bps`
  );
  return slippage;
}

export async function getTokenPrices(
  tokenMints: string[]
): Promise<Record<string, number>> {
  try {
    const url = `https://api.jup.ag/price/v2?ids=${tokenMints.join(",")}`;
    const { data } = await fetchWithRetry<{
      data: Record<string, TokenPriceDetails>;
    }>(url, undefined, logger.log);

    // tokenId -> price mapping
    return Object.entries(data).reduce((acc, [tokenId, details]) => {
      if (details === null) {
        // jupiter didn't have a price; return 0
        acc[tokenId] = 0;
        return acc;
      }

      acc[tokenId] = Number(details.price);
      return acc;
    }, {} as Record<string, number>);
  } catch (error) {
    console.error("Error fetching token prices:", error);
    throw error;
  }
}

/**
 * Get jupiter quote
 * @param amount from amount with decimal scaling
 * @param slippage in bps. 10bps = 0.1%
 * @returns Promise of QuoteResponse
 */
async function getQuote(
  amount: string,
  inputMint: string,
  outputMint: string,
  slippage?: number
): Promise<QuoteResponse> {
  const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${
    slippage ?? 0
  }&swapMode=${SwapMode.ExactIn}`;

  return await fetchWithRetry<QuoteResponse>(url, undefined, logger.log);
}

/**
 * Get the effective price for a small amount (for price monitoring).
 */
async function getEffectivePrice(
  inputMint: string,
  outputMint: string,
  inputDecimals: number,
  outputDecimals: number
): Promise<Decimal> {
  const amount = new BN(10 ** inputDecimals);

  try {
    const quote = await getQuote(amount.toString(), inputMint, outputMint, 1);

    const inputAmount = new Decimal(amount.toString()).div(10 ** inputDecimals);
    const outputAmount = new Decimal(quote.outAmount).div(
      10 ** (outputDecimals || 0)
    );

    return outputAmount.div(inputAmount);
  } catch (error) {
    throw new Error(`Failed to get effective price: ${error}`);
  }
}

async function performSwap(
  swapInstructions: any,
  sender: string,
  botId?: string
) {
  try {
    const { swapTransaction } = swapInstructions;
    const transactionBuf = Buffer.from(swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(transactionBuf);
    let signature = await executeVersionedTransaction(
      transaction,
      connection,
      sender,
      botId
    );

    return signature;
  } catch (error: any) {
    console.error("Swap execution failed:", error);
    if (error instanceof SendTransactionError) {
      logger.log(botId ?? "bot", "Transaction logs:", error.logs);
    }
    throw error;
  }
}

/**
 * Perform jupiter swap
 * @param slippage in bps. 10bps = 0.1%
 * @returns Promise of current user position
 */
export async function swap(
  sender: string,
  swapAmount: Decimal,
  slippage: number,
  from: string,
  target: string,
  botId: string
): Promise<PositionBalances> {
  let retries = 0;
  const maxRetries = 5;
  const wait = 2;

  while (retries < maxRetries) {
    try {
      console.log(`Swap attempt ${retries + 1}`);

      const fromMeta = await getMint(connection, new PublicKey(from));

      if (!fromMeta) {
        throw new Error("Failed to get coin metadata for swap!");
      }
      const amount = new BN(swapAmount.mul(10 ** fromMeta.decimals).toFixed(0));

      const quote = await getQuote(amount.toString(), from, target, slippage);
      // console.log(quote.priceImpactPct);
      // return {} as PositionBalances;
      const swapInstructionsResponse = await fetch(
        "https://quote-api.jup.ag/v6/swap",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            quoteResponse: quote,
            userPublicKey: sender,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: {
              priorityLevelWithMaxLamports: {
                maxLamports: 1000000,
                global: false,
                priorityLevel: "high",
              },
            },
            dynamicSlippage: { maxBps: slippage },
            wrapAndUnwrapSol: true,
          }),
        }
      );

      if (!swapInstructionsResponse.ok) {
        throw new Error(
          `Swap instruction request failed: ${swapInstructionsResponse.statusText}`
        );
      }

      const swapInstructions = await swapInstructionsResponse.json();

      const signature = await performSwap(swapInstructions, sender);
      let transaction: ParsedTransactionWithMeta | null = null;
      while (!transaction) {
        transaction = await connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
        });
      }

      const balances = getBalances(
        transaction,
        transaction.transaction.signatures[0],
        from,
        target,
        sender
      );

      logger.log(
        botId,
        `Swapped ${balances.coinA.amount} ${from} to ${balances.coinB.amount} ${target}`
      );

      return balances;
    } catch (error) {
      retries++;

      if (retries < maxRetries) {
        logger.log(
          botId,
          `Attempt ${retries} failed: ${error}. Retrying in ${
            wait ** retries
          }...`
        );
        await sleep(wait ** retries * 1000);
        continue;
      }
      logger.log(botId, `Failed to swap after ${maxRetries} attempts: `, error);
      throw error;
    }
  }
  throw new Error("Swap failed");
}

/**
 * Performs a DCA (Dollar-Cost Averaging) swap by breaking down a large order into
 * smaller chunks based on price impact and market conditions.
 *
 * @param sender public key of the sender
 * @param totalAmount total amount to swap
 * @param maxSlippage max slippage in basis points (e.g., 100 = 1%)
 * @param from
 * @param target
 * @param botId
 * @param options
 * @param options.minChunkSizePercent - Minimum size of each swap chunk as percentage of total (e.g., 1 = 1%)
 * @param options.maxWaitTime - Maximum time to wait between swaps in seconds
 * @param options.minWaitTime - Minimum time to wait between swaps in seconds
 * @param options.priceBoundaryPercent - Acceptable price deviation range as percentage (e.g., 5 = ±5%)
 * @param options.priceSamplePoints - Number of price points to sample
 * @returns Aggregated position balances for all the swaps
 */
export async function swapDCA(
  sender: string,
  totalAmount: Decimal,
  maxSlippage: number,
  from: string,
  target: string,
  botId: string,
  options: {
    minChunkSizePercent?: number; // in percentage (eg: 1%)
    maxWaitTime?: number; // in seconds
    minWaitTime?: number; // in seconds
    priceBoundaryPercent?: number; // in percentage (eg: 5 = ±5%)
    priceSamplePoints?: number;
  } = {}
): Promise<PositionBalances> {
  const {
    minChunkSizePercent = 1,
    maxWaitTime = 10,
    minWaitTime = 5,
    priceBoundaryPercent = 5,
    priceSamplePoints = 5,
  } = options;
  const chunks = [];
  logger.log(botId, `Starting DCA swap of ${totalAmount} ${from} -> ${target}`);
  const results: PositionBalances[] = [];

  const fromMeta = await getMint(connection, new PublicKey(from));
  const targetMeta = await getMint(connection, new PublicKey(target));
  if (!fromMeta || !targetMeta) {
    throw new Error("Failed to get token metadata for swap!");
  }

  const minChunkSize = totalAmount.mul(minChunkSizePercent).div(100);
  logger.log(botId, `Minimum chunk size set to ${minChunkSize} ${from}`);

  // price boundary calculation
  let currentPrice = await getEffectivePrice(
    from,
    target,
    fromMeta.decimals,
    targetMeta.decimals
  );
  const upperPriceBound = currentPrice.mul(1 + priceBoundaryPercent / 100);
  const lowerPriceBound = currentPrice.mul(1 - priceBoundaryPercent / 100);

  logger.log(
    botId,
    `Price boundaries set: ${lowerPriceBound.toFixed(
      6
    )} - ${upperPriceBound.toFixed(6)}`
  );

  let remainingAmount: Decimal = totalAmount;
  let swapCount = 0;

  while (remainingAmount.gt(0)) {
    // Check current price against boundaries
    // currentPrice = await getEffectivePrice(
    //   from,
    //   target,
    //   fromMeta.decimals,
    //   targetMeta.decimals
    // );

    // if (currentPrice.lt(lowerPriceBound) || currentPrice.gt(upperPriceBound)) {
    //   logger.log(
    //     botId,
    //     `Current price (${currentPrice.toFixed(
    //       6
    //     )}) outside boundaries, waiting...`
    //   );
    //   await sleep(maxWaitTime * 1000);
    //   continue;
    // }

    // Determine optimal chunk size through price impact analysis
    const optimalChunkSize = await determineOptimalChunkSize(
      remainingAmount,
      minChunkSize,
      from,
      target,
      maxSlippage,
      priceSamplePoints,
      fromMeta.decimals,
      targetMeta.decimals
    );

    // If optimal chunk size is smaller than minimum, use minimum
    const chunkSize = Decimal.max(optimalChunkSize, minChunkSize);

    // Ensure we don't exceed remaining amount
    const finalChunkSize = Decimal.min(chunkSize, remainingAmount);

    logger.log(
      botId,
      `Executing chunk ${
        swapCount + 1
      }: ${finalChunkSize} ${from} (${finalChunkSize
        .div(totalAmount)
        .mul(100)
        .toFixed(2)}% of total)`
    );

    try {
      // Execute the swap using your existing swap function
      const result = await swap(
        sender,
        finalChunkSize,
        maxSlippage,
        from,
        target,
        botId
      );

      await memory.createMemoryEntry(
        botId,
        "inrange",
        "swap",
        result,
        currentPrice,
        result.digest
      );

      // Add result to results array
      results.push(result);

      // Update remaining amount
      remainingAmount = remainingAmount.sub(result.coinA.amount.abs());
      chunks.push(result.coinA.amount.abs());

      // chunks.push(finalChunkSize);
      // remainingAmount = remainingAmount.sub(finalChunkSize);
      swapCount++;

      // Calculate wait time - can be randomized between min and max
      const waitTime =
        minWaitTime + Math.random() * (maxWaitTime - minWaitTime);

      logger.log(
        botId,
        `Swap successful. Remaining: ${remainingAmount} ${from}. Waiting ${waitTime.toFixed(
          1
        )}s before next chunk.`
      );

      // Wait between swaps to allow pool to rebalance
      if (remainingAmount.gt(0)) {
        await sleep(waitTime * 1000);
      }
    } catch (error) {
      logger.log(
        botId,
        `Error executing chunk swap: ${error}. Retrying in ${maxWaitTime}s.`
      );
      await sleep(maxWaitTime * 1000);
      continue;

      // TODO: needed? -> Implement backoff strategy - reduce chunk size and wait longer
    }
  }

  logger.log(botId, `DCA swap completed. Executed ${swapCount} swaps.`);
  console.log(chunks);

  const aggregateBalances: PositionBalances = {
    digest: results[0].digest,
    coinA: {
      coinType: results[0].coinA.coinType,
      amount: new Decimal(0),
    },
    coinB: {
      coinType: results[0].coinB.coinType,
      amount: new Decimal(0),
    },
  };
  const otherCoinMap: Record<string, Decimal> = {};

  results.forEach((balance) => {
    aggregateBalances.coinA.amount = aggregateBalances.coinA.amount.add(
      balance.coinA.amount
    );
    aggregateBalances.coinB.amount = aggregateBalances.coinB.amount.add(
      balance.coinB.amount
    );

    if (balance.others?.length) {
      for (const otherCoin of balance.others) {
        otherCoinMap[otherCoin.coinType] = (
          otherCoinMap[otherCoin.coinType] || new Decimal(0)
        ).add(otherCoin.amount);
      }
    }
  });

  const othersArray = Object.entries(otherCoinMap).map(
    ([coinType, amount]) => ({
      coinType,
      amount,
    })
  );

  if (othersArray.length > 0) {
    aggregateBalances.others = othersArray;
  }
  logger.log(botId, `Completed dca swap: ${serialize(aggregateBalances)}`);
  return aggregateBalances;
}

/**
 * Determines the optimal chunk size for a swap based on price impact analysis.
 * Uses a sampling approach from highest to lowest size, with retry logic.
 */
async function determineOptimalChunkSize(
  totalAmount: Decimal,
  minChunkSize: Decimal,
  fromToken: string,
  toToken: string,
  maxSlippage: number,
  samplePoints: number,
  fromDecimals: number,
  toDecimals: number
): Promise<Decimal> {
  const sampleSizes: Decimal[] = [];
  const prices = await getTokenPrices([fromToken, toToken]);
  console.log(prices);
  for (let i = 0; i < samplePoints; i++) {
    const ratio = i / (samplePoints - 1);
    // use a logarithmic scale to have more samples at smaller sizes
    const logRatio = Math.pow(ratio, 2);
    const sampleSize = minChunkSize.add(
      totalAmount.sub(minChunkSize).mul(logRatio)
    );

    sampleSizes.push(sampleSize);
  }
  console.log("Sample sizes: ", sampleSizes);

  for (let i = sampleSizes.length - 1; i >= 0; i--) {
    const sampleSize = sampleSizes[i];
    const amount = new BN(sampleSize.mul(10 ** fromDecimals).toFixed(0));

    for (let attempt = 0; attempt < 5; attempt++) {
      const quote = await getQuote(amount.toString(), fromToken, toToken);
      const slippage = calculateSlippageFromQuote(
        quote,
        fromDecimals,
        toDecimals,
        prices
      );

      // console.log(
      //   `Quote attempt ${attempt + 1} for size ${sampleSize.toString()}: ${
      //     quote.inAmount
      //   } ${quote.outAmount} ${
      //     quote.priceImpactPct
      //   } slippage: ${slippage.toString()} bps`
      // );

      if (slippage.lessThanOrEqualTo(maxSlippage)) {
        return sampleSize;
      }

      await sleep(1000);
    }
    continue;
  }

  // If no size worked, return minimum chunk size
  console.log(
    "No sample size found with acceptable slippage, using minimum chunk size"
  );
  return minChunkSize;
}
