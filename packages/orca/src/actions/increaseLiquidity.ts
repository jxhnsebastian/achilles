import {
  Address,
  appendTransactionMessageInstructions,
  setTransactionMessageLifetimeUsingBlockhash,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayer,
} from "@solana/web3.js";

import { setWhirlpoolsConfig, increaseLiquidityInstructions } from "@orca-so/whirlpools";
import { IncreaseLiquidityQuote } from "@orca-so/whirlpools-core";

import { getRpc } from "../pools.js";
import { sendAndConfirmTransaction } from "../solana.js";
import { getSignerFromSecretKey } from "../wallet.js";

export interface IncreaseLiquidityResult {
  signature: string;
  txSuccess: boolean;
  confirmed: boolean;
  quote: IncreaseLiquidityQuote;
  remainingAmounts: {
    tokenA: bigint;
    tokenB: bigint;
  };
}

export async function increaseWhirlpoolPositionLiquidity(
  rpcUrl: string,
  positionMint: string,
  tokenAAmount: bigint,
  tokenBAmount: bigint,
  signerSecretKey: string,
): Promise<IncreaseLiquidityResult> {
  const signer = await getSignerFromSecretKey(signerSecretKey);
  await setWhirlpoolsConfig("solanaMainnet");
  const { rpc, rpcSubscriptions } = getRpc(rpcUrl);

  const tokenAToUse = (tokenAAmount * BigInt(90)) / 100n;

  const param = {
    tokenA: tokenAToUse,
  };

  const { quote, instructions } = await increaseLiquidityInstructions(
    rpc,
    positionMint as Address,
    param,
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

  const remainingTokenA = tokenAAmount - quote.tokenEstA;
  const remainingTokenB = tokenBAmount - quote.tokenEstB;

  return {
    signature,
    confirmed,
    txSuccess,
    quote,
    remainingAmounts: {
      tokenA: remainingTokenA,
      tokenB: remainingTokenB,
    },
  };
}
