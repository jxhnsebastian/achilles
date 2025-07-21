import {
  Address,
  appendTransactionMessageInstructions,
  setTransactionMessageLifetimeUsingBlockhash,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayer,
} from "@solana/web3.js";

import { setWhirlpoolsConfig, openPositionInstructions } from "@orca-so/whirlpools";
import { IncreaseLiquidityQuote, sqrtPriceToPrice } from "@orca-so/whirlpools-core";

import { calculatePriceRange, calculateTickRange, getRpc } from "../pools.js";
import { sendAndConfirmTransaction } from "../solana.js";
import { getSignerFromSecretKey } from "../wallet.js";
import { fetchWhirlpool } from "@orca-so/whirlpools-client";

interface OpenPositionResult {
  signature: string;
  txSuccess: boolean;
  confirmed: boolean;
  quote: IncreaseLiquidityQuote;
  currentPoolData: any;
  newPositionData: any;
  positionMint: string;
  remainingAmounts: {
    tokenA: bigint;
    tokenB: bigint;
  };
}

export async function openWhirlpoolPosition(
  rpcUrl: string,
  whirlpoolAddress: string,
  tokenA: { decimals: number; mint: string },
  tokenB: { decimals: number; mint: string },
  tokenAAmount: bigint,
  tokenBAmount: bigint,
  lowerTickBips: number,
  upperTickBips: number,
  signerSecretKey: string,
  percentageToUse: number = 50,
): Promise<OpenPositionResult> {
  const signer = await getSignerFromSecretKey(signerSecretKey);
  await setWhirlpoolsConfig("solanaMainnet");
  const { rpc, rpcSubscriptions } = getRpc(rpcUrl);

  const BPS_DENOMINATOR = 10000n;
  const tokenAToUse = (tokenAAmount * BigInt(percentageToUse * 100)) / BPS_DENOMINATOR;
  const tokenBToUse = (tokenBAmount * BigInt(percentageToUse * 100)) / BPS_DENOMINATOR;

  const pool = await fetchWhirlpool(rpc, whirlpoolAddress as Address);

  const { liquidity, sqrtPrice, tickCurrentIndex, tickSpacing } = pool.data;

  const currentPrice = sqrtPriceToPrice(sqrtPrice, tokenA.decimals, tokenB.decimals);
  const { upperPrice, lowerPrice } = calculatePriceRange(
    currentPrice,
    upperTickBips,
    lowerTickBips,
  );
  const { upperTickIndex, lowerTickIndex } = calculateTickRange(
    tickCurrentIndex,
    tickSpacing,
    upperTickBips,
    lowerTickBips,
  );

  const currentPoolData = {
    liquidity,
    sqrtPrice,
    tickCurrentIndex,
    tickSpacing,
  };

  const newPositionData = {
    upperPrice,
    lowerPrice,
    upperTickIndex,
    lowerTickIndex,
    upperTickBips,
    lowerTickBips,
  };
  const param = {
    tokenA: tokenAToUse,
  };

  const { quote, instructions, initializationCost, positionMint } = await openPositionInstructions(
    rpc,
    whirlpoolAddress as Address,
    param,
    lowerPrice,
    upperPrice,
    100,
    signer,
  );

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (message) => setTransactionMessageFeePayer(signer.address, message),
    (message) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, message),
    (message) => appendTransactionMessageInstructions(instructions, message),
  );

  const { signature, confirmed, txSuccess } = await sendAndConfirmTransaction(
    rpcUrl,
    rpc,
    rpcSubscriptions,
    transactionMessage,
    { computeUnits: 200_000 },
  );

  return {
    signature,
    confirmed,
    txSuccess,
    quote,
    currentPoolData,
    newPositionData,
    positionMint,
    remainingAmounts: {
      tokenA: tokenAAmount - tokenAToUse,
      tokenB: tokenBAmount - tokenBToUse,
    },
  };
}
