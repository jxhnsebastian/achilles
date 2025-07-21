import {
  Address,
  appendTransactionMessageInstructions,
  setTransactionMessageLifetimeUsingBlockhash,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayer,
} from "@solana/web3.js";

import { setWhirlpoolsConfig, decreaseLiquidityInstructions } from "@orca-so/whirlpools";
import { DecreaseLiquidityQuote } from "@orca-so/whirlpools-core";

import { getRpc } from "../pools.js";
import { sendAndConfirmTransaction } from "../solana.js";
import { getSignerFromSecretKey } from "../wallet.js";

export async function withdrawLiquidityForPosition(
  rpcUrl: string,
  positionMint: Address,
  currentLiquidity: bigint,
  signerSecretKey: string,
): Promise<{
  signature: string;
  quote: DecreaseLiquidityQuote;
  confirmed: boolean;
  txSuccess: boolean;
}> {
  const signer = await getSignerFromSecretKey(signerSecretKey);
  await setWhirlpoolsConfig("solanaMainnet");
  const { rpc, rpcSubscriptions } = getRpc(rpcUrl);

  const { instructions, quote } = await decreaseLiquidityInstructions(
    rpc,
    positionMint,
    {
      liquidity: currentLiquidity,
    },
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
    quote,
    confirmed,
    txSuccess,
  };
}
