import {
  Address,
  appendTransactionMessageInstructions,
  setTransactionMessageLifetimeUsingBlockhash,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayer,
} from "@solana/web3.js";

import { setWhirlpoolsConfig, closePositionInstructions } from "@orca-so/whirlpools";

import { getSignerFromSecretKey } from "../wallet.js";
import { getRpc } from "../pools.js";
import { sendAndConfirmTransaction } from "../solana.js";

export async function closeWhirlpoolPosition(
  rpcUrl: string,
  positionMint: Address,
  signerSecretKey: string,
): Promise<{
  signature: string;
  txSuccess: boolean;
  confirmed: boolean;
}> {
  const signer = await getSignerFromSecretKey(signerSecretKey);

  await setWhirlpoolsConfig("solanaMainnet");
  const { rpc, rpcSubscriptions } = getRpc(rpcUrl);

  const { instructions } = await closePositionInstructions(rpc, positionMint, 100, signer);

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
  };
}
