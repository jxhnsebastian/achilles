import { fetchMint } from "@solana-program/token";
import {
  address,
  createSolanaRpc,
  mainnet,
  createSolanaRpcSubscriptions,
  Signature,
} from "@solana/web3.js";

import { setWhirlpoolsConfig, HydratedPosition, fetchPositionsForOwner } from "@orca-so/whirlpools";
import { fetchWhirlpool, Whirlpool } from "@orca-so/whirlpools-client";
import {
  decreaseLiquidityQuote,
  sqrtPriceToPrice,
  tickIndexToPrice,
} from "@orca-so/whirlpools-core";

import { getTokenPrices } from "@achilles/jupiter";
import { getMetadata } from "@achilles/metaplex";

import { convertToUiAmount } from "./utils.js";

export type PositionWithPrice = HydratedPosition & {
  lowerPrice: number;
  upperPrice: number;
  pool: Whirlpool;
  currentPrice: number;
  tokenA: any;
  tokenB: any;
  liquidityData: ReturnType<typeof calculateLiquidityPosition>;
  tokenAAmount: number;
  tokenBAmount: number;
  tokenAUsdValue: number;
  tokenBUsdValue: number;
  totalUsdValue: number;
};

export const getRpc = (rpcUrl: string) => {
  const endpoint = rpcUrl || "https://api.mainnet-beta.solana.com";
  const wsEndpoint = endpoint.replace("https://", "wss://").replace("http://", "ws://");

  return {
    rpc: createSolanaRpc(mainnet(endpoint)),
    rpcSubscriptions: createSolanaRpcSubscriptions(mainnet(wsEndpoint)),
  };
};

export function getWhirlpoolPrice(
  sqrtPrice: bigint,
  tokenAMintDecimals: number,
  tokenBMintDecimals: number,
  reciprocal: boolean = false,
): number {
  const price = sqrtPriceToPrice(sqrtPrice, tokenAMintDecimals, tokenBMintDecimals);

  return reciprocal ? 1 / price : price;
}

export function getPriceRange(
  tickLowerIndex: number,
  tickUpperIndex: number,
  tokenAMintDecimals: number,
  tokenBMintDecimals: number,
  reciprocal: boolean = false,
) {
  const lowerPrice = tickIndexToPrice(tickLowerIndex, tokenAMintDecimals, tokenBMintDecimals);
  const upperPrice = tickIndexToPrice(tickUpperIndex, tokenAMintDecimals, tokenBMintDecimals);

  if (reciprocal) {
    return {
      lowerPrice: 1 / upperPrice,
      upperPrice: 1 / lowerPrice,
    };
  }

  return {
    lowerPrice,
    upperPrice,
  };
}

/**
 * Calculates token proportions and amounts for a concentrated liquidity position
 * @param pMin The minimum price of the liquidity range
 * @param pMax The maximum price of the liquidity range
 * @param currentPrice The current price
 * @param shouldFlip Whether the token order should be flipped
 * @returns Object containing token proportions and amounts
 */
export function calculateLiquidityPosition(
  pMin: number,
  pMax: number,
  currentPrice: number,
  shouldFlip: boolean,
) {
  if (pMin >= pMax) {
    throw new Error("Minimum price must be less than maximum price");
  }

  if (currentPrice < pMin) {
    return {
      tokenAPercentage: 0,
      tokenBPercentage: 100,
    };
  }
  if (currentPrice > pMax) {
    return {
      tokenAPercentage: 100,
      tokenBPercentage: 0,
    };
  }

  const sqrtPMin = Math.sqrt(pMin);
  const sqrtPMax = Math.sqrt(pMax);
  const sqrtP = Math.sqrt(currentPrice);

  let tokenAProportion, tokenBProportion;

  if (shouldFlip) {
    tokenAProportion = (sqrtPMax - sqrtP) / (sqrtPMax - sqrtPMin);
    tokenBProportion = (sqrtP - sqrtPMin) / (sqrtPMax - sqrtPMin);
  } else {
    tokenAProportion = (sqrtP - sqrtPMin) / (sqrtPMax - sqrtPMin);
    tokenBProportion = (sqrtPMax - sqrtP) / (sqrtPMax - sqrtPMin);
  }

  const result = {
    tokenAPercentage: tokenAProportion * 100,
    tokenBPercentage: tokenBProportion * 100,
  };

  return result;
}

interface TokenPair {
  tokenA: any;
  tokenB: any;
  shouldFlip: boolean;
  useReciprocal: boolean;
}

function determineTokenOrder(
  tokenFirst: any,
  tokenSecond: any,
  usdcAddress = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  solAddress = "So11111111111111111111111111111111111111112",
): TokenPair {
  // special case with sol/usdc
  if (tokenFirst === solAddress && tokenSecond === usdcAddress) {
    return {
      tokenA: tokenFirst,
      tokenB: tokenSecond,
      shouldFlip: false,
      useReciprocal: false,
    };
  }

  const firstIsPreferred =
    tokenFirst === usdcAddress || (tokenFirst === solAddress && tokenSecond !== usdcAddress);

  const shouldFlip = !firstIsPreferred;
  const useReciprocal = tokenFirst !== usdcAddress && tokenSecond !== usdcAddress;

  return {
    tokenA: shouldFlip ? tokenSecond : tokenFirst,
    tokenB: shouldFlip ? tokenFirst : tokenSecond,
    shouldFlip,
    useReciprocal,
  };
}

export async function getWhirlpoolPositionsForWallet(rpcUrl: string, ownerAddress: string) {
  try {
    await setWhirlpoolsConfig("solanaMainnet");
    const { rpc } = getRpc(rpcUrl);

    const positions = await fetchPositionsForOwner(rpc, address(ownerAddress));
    const positionsWithPrice: (PositionWithPrice & {})[] = [];

    for (const position of positions) {
      if (position.isPositionBundle) {
        continue;
      }

      const pool = await fetchWhirlpool(rpc, position.data.whirlpool);
      const tokenAMint = await fetchMint(rpc, pool.data.tokenMintA);
      const tokenBMint = await fetchMint(rpc, pool.data.tokenMintB);

      const tokenAMetadata = await getMetadata(rpcUrl, pool.data.tokenMintA.toString());
      const tokenBMetadata = await getMetadata(rpcUrl, pool.data.tokenMintB.toString());

      const { shouldFlip, useReciprocal } = determineTokenOrder(
        pool.data.tokenMintA,
        pool.data.tokenMintB,
      );

      const tokenA = shouldFlip
        ? { ...tokenBMetadata, mint: tokenBMint }
        : { ...tokenAMetadata, mint: tokenAMint };
      const tokenB = shouldFlip
        ? { ...tokenAMetadata, mint: tokenAMint }
        : { ...tokenBMetadata, mint: tokenBMint };

      const price = getWhirlpoolPrice(
        pool.data.sqrtPrice,
        tokenA.mint.data.decimals,
        tokenB.mint.data.decimals,
        useReciprocal,
      );

      const { lowerPrice, upperPrice } = getPriceRange(
        position.data.tickLowerIndex,
        position.data.tickUpperIndex,
        tokenA.mint.data.decimals,
        tokenB.mint.data.decimals,
        useReciprocal,
      );

      // Calculate total value in token B
      const liquidity = Number(position.data.liquidity);
      const sqrtPriceA = Math.sqrt(lowerPrice);
      const sqrtPriceB = Math.sqrt(upperPrice);
      const sqrtPrice = Math.sqrt(price);

      let totalValueInB = 0;
      if (price < lowerPrice) {
        // 100% value is in token B
        totalValueInB = liquidity * (sqrtPriceB - sqrtPriceA);
      } else if (price > upperPrice) {
        // 100% value is in token A
        totalValueInB = liquidity * (sqrtPriceB - sqrtPriceA) * price;
      } else {
        // split between both tokens
        const tokenAValue = liquidity * (sqrtPriceB - sqrtPrice);
        const tokenBValue = liquidity * (sqrtPrice - sqrtPriceA);
        totalValueInB = tokenBValue + tokenAValue * price;
      }

      const currentTokenSumQuote = decreaseLiquidityQuote(
        position.data.liquidity,
        0,
        pool.data.sqrtPrice,
        position.data.tickLowerIndex,
        position.data.tickUpperIndex,
      );

      const tokenAAmount = convertToUiAmount(
        currentTokenSumQuote.tokenEstA,
        tokenA.mint.data.decimals,
      );

      const tokenBAmount = convertToUiAmount(
        currentTokenSumQuote.tokenEstB,
        tokenB.mint.data.decimals,
      );

      const tokenPrices = await getTokenPrices([tokenA.mint.address, tokenB.mint.address]);
      const tokenAUsdValue = tokenAAmount * (tokenPrices[tokenA.mint.address] || 0);
      const tokenBUsdValue = tokenBAmount * (tokenPrices[tokenB.mint.address] || 0);
      const totalUsdValue = tokenAUsdValue + tokenBUsdValue;

      const liquidityData = calculateLiquidityPosition(lowerPrice, upperPrice, price, shouldFlip);

      const positionWithPrice = {
        ...position,
        lowerPrice,
        upperPrice,
        pool: pool.data,
        currentPrice: price,
        tokenA,
        tokenB,
        liquidityData,
        tokenAAmount,
        tokenBAmount,
        tokenAUsdValue,
        tokenBUsdValue,
        totalUsdValue,
      };

      positionsWithPrice.push(positionWithPrice);
    }

    return positionsWithPrice;
  } catch (error) {
    console.error("Error checking pool for owner:", error);
    throw error;
  }
}

export async function calculateDecreaseLiquidityAmounts(
  rpcUrl: string,
  signature: string,
  {
    mintAddressForTokenA,
    mintAddressForTokenB,
  }: {
    mintAddressForTokenA: string;
    mintAddressForTokenB: string;
  },
): Promise<{
  tokenAAmount: bigint;
  tokenBAmount: bigint;
  ownerAddress: string | null;
  tokenAMint: string | null;
  tokenBMint: string | null;
}> {
  const { rpc } = getRpc(rpcUrl);

  const tx = await rpc
    .getTransaction(signature as Signature, {
      maxSupportedTransactionVersion: 0,
      encoding: "jsonParsed",
    })
    .send();

  if (tx?.meta?.err) {
    throw new Error("Transaction failed: " + tx.meta.err);
  }

  if (!tx?.meta || !tx.transaction.message) {
    throw new Error("Transaction not found or invalid");
  }

  // console.log(serializeWeb3Object(tx));

  let tokenAAmount = 0n;
  let tokenBAmount = 0n;

  const outerIxs = tx.transaction.message.instructions;
  const innerIxs = tx.meta.innerInstructions || [];

  // whirlpool decreaseLiquidityV2 instruction
  const whirlpoolProgram = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
  const decreaseLiquidityV2Prefix = "Dq7BZxtXsw";

  let ownerAddress: string | null = null;
  let tokenAMint: string | null = null;
  let tokenBMint: string | null = null;

  for (let i = 0; i < outerIxs.length; i++) {
    const ix = outerIxs[i] as any;
    const programId = ix.programId.toString();

    if (programId !== whirlpoolProgram || !ix.data.startsWith(decreaseLiquidityV2Prefix)) {
      continue;
    }

    const innerGroup = innerIxs.find((group) => group.index === i);
    if (!innerGroup) continue;

    // console.log("innerGroup:", serializeWeb3Object(innerGroup));

    ownerAddress = ix.accounts[4].toString();

    // check the 7 and 8 are tokenA and tokenB; they can be in any order

    const orderOne =
      ix.accounts[7].toString() === mintAddressForTokenA &&
      ix.accounts[8].toString() === mintAddressForTokenB;
    const orderTwo =
      ix.accounts[7].toString() === mintAddressForTokenB &&
      ix.accounts[8].toString() === mintAddressForTokenA;

    if (!orderOne && !orderTwo) {
      throw new Error(
        `did not find expected tokens for decrease liquidity: ${mintAddressForTokenA} and ${mintAddressForTokenB} (found ${ix.accounts[7].toString()} and ${ix.accounts[8].toString()})`,
      );
    }

    // TODO: i hate solana types... why so complicated?
    for (const innerIx of innerGroup.instructions as any) {
      const programId = innerIx.programId.toString();

      if (
        programId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" &&
        innerIx.parsed?.type === "transferChecked"
      ) {
        const mint = innerIx.parsed.info.mint;

        // make sure to map the expected tokenA and tokenB from pool position
        if (mint.toString() === mintAddressForTokenA) {
          tokenAAmount += BigInt(innerIx.parsed.info.tokenAmount.amount);
        } else if (mint.toString() === mintAddressForTokenB) {
          tokenBAmount += BigInt(innerIx.parsed.info.tokenAmount.amount);
        }
      }
    }
  }

  return {
    tokenAAmount,
    tokenBAmount,
    ownerAddress,
    tokenAMint,
    tokenBMint,
  };
}

export async function calculateWhirlpoolFeeRewards(
  rpcUrl: string,
  signature: string,
): Promise<{
  tokenAAmount: bigint;
  tokenBAmount: bigint;
  ownerAddress: string | null;
  tokenAMint: string | null;
  tokenBMint: string | null;
}> {
  const { rpc } = getRpc(rpcUrl);

  const tx = await rpc
    .getTransaction(signature as Signature, {
      maxSupportedTransactionVersion: 0,
      encoding: "jsonParsed",
    })
    .send();

  if (!tx?.meta || !tx.transaction.message) {
    throw new Error("Transaction not found or invalid");
  }

  // console.log(serializeWeb3Object(tx));

  let tokenAAmount = 0n;
  let tokenBAmount = 0n;

  const outerIxs = tx.transaction.message.instructions;
  const innerIxs = tx.meta.innerInstructions || [];

  // whirlpool collectFeesV2 instruction
  const whirlpoolProgram = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
  const collectFeesV2Prefix = "3eAETRMr8nJVm";

  let ownerAddress: string | null = null;
  let tokenAMint: string | null = null;
  let tokenBMint: string | null = null;

  for (let i = 0; i < outerIxs.length; i++) {
    const ix = outerIxs[i] as any;
    const programId = ix.programId.toString();

    if (programId !== whirlpoolProgram || !ix.data.startsWith(collectFeesV2Prefix)) {
      continue;
    }

    const innerGroup = innerIxs.find((group) => group.index === i);
    if (!innerGroup) continue;

    // console.log("innerGroup:", serializeWeb3Object(innerGroup));

    ownerAddress = ix.accounts[1].toString();
    tokenAMint = ix.accounts[4].toString();
    tokenBMint = ix.accounts[5].toString();

    // TODO: i hate solana types... why so complicated?
    for (const innerIx of innerGroup.instructions as any) {
      const programId = innerIx.programId.toString();

      if (
        programId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" &&
        innerIx.parsed?.type === "transferChecked"
      ) {
        const mint = innerIx.parsed.info.mint;

        if (mint.toString() === tokenAMint) {
          tokenAAmount += BigInt(innerIx.parsed.info.tokenAmount.amount);
        } else if (mint.toString() === tokenBMint) {
          tokenBAmount += BigInt(innerIx.parsed.info.tokenAmount.amount);
        }
      }
    }
  }

  return {
    tokenAAmount,
    tokenBAmount,
    ownerAddress,
    tokenAMint,
    tokenBMint,
  };
}

export function calculateTickRange(
  currentTickIndex: number,
  tickSpacing: number,
  upperTickBips: number,
  lowerTickBips: number,
) {
  const rawUpperTick = currentTickIndex + upperTickBips;
  const rawLowerTick = currentTickIndex - lowerTickBips;

  const upperTickIndex = Math.floor(rawUpperTick / tickSpacing) * tickSpacing;
  const lowerTickIndex = Math.ceil(rawLowerTick / tickSpacing) * tickSpacing;

  return {
    upperTickIndex,
    lowerTickIndex,
  };
}

export function calculatePriceRange(currentPrice: number, bipsUp: number, bipsDown: number) {
  const upperMultiplier = Math.pow(1.0001, bipsUp); // e.g., 1.0001^500
  const lowerMultiplier = Math.pow(1.0001, -bipsDown); // e.g., 1.0001^-500

  const upperPrice = currentPrice * upperMultiplier;
  const lowerPrice = currentPrice * lowerMultiplier;

  return {
    upperPrice,
    lowerPrice,
  };
}
