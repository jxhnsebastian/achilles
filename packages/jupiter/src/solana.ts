import { Connection } from "@solana/web3.js";

const sleep = (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

// https://github.com/anza-xyz/agave/pull/1034
async function isBlockhashExpired(connection: Connection, lastValidBlockHeight: number) {
  const currentBlockHeight = await connection.getBlockHeight("finalized");
  return currentBlockHeight > lastValidBlockHeight;
}

export async function checkForTxConfirmedAndSuccess(
  connection: Connection,
  txId: string,
  lastValidHeight: number,
) {
  let hashExpired = false;
  let txSuccess = false;

  while (!hashExpired && !txSuccess) {
    const { value: status } = await connection.getSignatureStatus(txId);
    if (status && status.confirmationStatus === "finalized") {
      txSuccess = !status.err;
      break;
    }

    hashExpired = await isBlockhashExpired(connection, lastValidHeight);
    if (hashExpired) {
      break;
    }

    await sleep(2_500);
  }
  return {
    txSuccess,
    confirmed: !hashExpired,
  };
}
