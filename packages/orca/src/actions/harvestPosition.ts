import {
  Address,
  appendTransactionMessageInstructions,
  setTransactionMessageLifetimeUsingBlockhash,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayer,
} from "@solana/web3.js";

import { setWhirlpoolsConfig, harvestPositionInstructions } from "@orca-so/whirlpools";
import { CollectFeesQuote, CollectRewardsQuote } from "@orca-so/whirlpools-core";

import { getRpc } from "../pools.js";
import { sendAndConfirmTransaction } from "../solana.js";
import { getSignerFromSecretKey } from "../wallet.js";

export async function harvestWhirlpoolPositionRewards(
  rpcUrl: string,
  positionMint: Address,
  signerSecretKey: string,
): Promise<{
  signature: string | null;
  txSuccess: boolean;
  confirmed: boolean;
  feesQuote: CollectFeesQuote;
  rewardsQuote: CollectRewardsQuote;
  harvestedSomething: boolean;
}> {
  const signer = await getSignerFromSecretKey(signerSecretKey);
  await setWhirlpoolsConfig("solanaMainnet");
  const { rpc, rpcSubscriptions } = getRpc(rpcUrl);

  const { feesQuote, rewardsQuote, instructions } = await harvestPositionInstructions(
    rpc,
    positionMint,
    signer,
  );

  const hasFeesToCollect = feesQuote.feeOwedA > 0n || feesQuote.feeOwedB > 0n;
  const hasRewardsToCollect = rewardsQuote.rewards.some((r) => r.rewardsOwed > 0n);

  if (!hasFeesToCollect && !hasRewardsToCollect) {
    return {
      signature: null,
      txSuccess: false,
      confirmed: false,
      feesQuote,
      rewardsQuote,
      harvestedSomething: false,
    };
  }

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (message) => setTransactionMessageFeePayer(signer.address, message),
    (message) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, message),
    (message) => appendTransactionMessageInstructions(instructions, message),
  );

  const { signature, txSuccess, confirmed } = await sendAndConfirmTransaction(
    rpcUrl,
    rpc,
    rpcSubscriptions,
    transactionMessage,
    { computeUnits: 200_000 },
  );

  return {
    txSuccess,
    confirmed,
    signature,
    feesQuote,
    rewardsQuote,
    harvestedSomething: true,
  };
}
