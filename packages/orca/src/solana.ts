import {
  RpcMainnet,
  SolanaRpcApiMainnet,
  Signature,
  TransactionMessage,
  getBase64EncodedWireTransaction,
  prependTransactionMessageInstructions,
  FullySignedTransaction,
  TransactionMessageWithBlockhashLifetime,
  ITransactionMessageWithFeePayer,
  signTransactionMessageWithSigners,
  setTransactionMessageLifetimeUsingBlockhash,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
} from "@solana/web3.js";

import {
  getSetComputeUnitPriceInstruction,
  getSetComputeUnitLimitInstruction,
} from "@solana-program/compute-budget";

const sleep = (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

// https://github.com/anza-xyz/agave/pull/1034
async function isBlockhashExpired(
  rpc: RpcMainnet<SolanaRpcApiMainnet>,
  lastValidBlockHeight: bigint,
) {
  const currentBlockHeight = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
  return currentBlockHeight > lastValidBlockHeight;
}

export async function checkForTxConfirmedAndSuccess(
  rpc: RpcMainnet<SolanaRpcApiMainnet>,
  txId: string,
  lastValidHeight: bigint,
) {
  let hashExpired = false;
  let txSuccess = false;

  while (!hashExpired && !txSuccess) {
    const status = await rpc.getSignatureStatuses([txId as Signature]).send();
    if (
      status &&
      (status.value?.[0]?.confirmationStatus === "confirmed" ||
        status.value?.[0]?.confirmationStatus === "finalized")
    ) {
      txSuccess = !status.value[0]?.err;
      break;
    }

    hashExpired = await isBlockhashExpired(rpc, lastValidHeight);
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

export async function addTransactionPriorityAndComputeUnits(
  rpcUrl: string,
  transactionMessage: TransactionMessage &
    ITransactionMessageWithFeePayer &
    TransactionMessageWithBlockhashLifetime,
  signedTransaction: FullySignedTransaction,
  { computeUnits = 200_000, priorityLevel = "High" as const } = {},
) {
  const base64EncodedWireTransaction = getBase64EncodedWireTransaction(signedTransaction);
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "npc-get-priority-fee",
      method: "getPriorityFeeEstimate",
      params: [
        {
          transaction: base64EncodedWireTransaction,
          options: {
            transactionEncoding: "base64",
            priorityLevel,
          },
        },
      ],
    }),
  });
  const { result } = await response.json();
  const priorityFee = result.priorityFeeEstimate;

  const finalTransactionMessage = prependTransactionMessageInstructions(
    [
      getSetComputeUnitLimitInstruction({ units: computeUnits }),
      getSetComputeUnitPriceInstruction({ microLamports: priorityFee }),
    ],
    transactionMessage,
  );

  return finalTransactionMessage;
}

export async function sendAndConfirmTransaction(
  rpcUrl: string,
  rpc: RpcMainnet<SolanaRpcApiMainnet>,
  rpcSubscriptions: any,
  transactionMessage: TransactionMessage &
    ITransactionMessageWithFeePayer &
    TransactionMessageWithBlockhashLifetime,
  options: {
    computeUnits?: number;
    skipPreflight?: boolean;
  } = {},
): Promise<{
  signature: string;
  confirmed: boolean;
  txSuccess: boolean;
}> {
  const { computeUnits = 200_000, skipPreflight = true } = options;

  const signedTransactionMessage = await signTransactionMessageWithSigners(transactionMessage);
  const finalTransactionMessage = await addTransactionPriorityAndComputeUnits(
    rpcUrl,
    transactionMessage,
    signedTransactionMessage,
    { computeUnits },
  );

  const { value: finalLatestBlockhash } = await rpc.getLatestBlockhash().send();
  setTransactionMessageLifetimeUsingBlockhash(finalLatestBlockhash, finalTransactionMessage);

  const finalSignedTransaction = await signTransactionMessageWithSigners(finalTransactionMessage);
  const signature = getSignatureFromTransaction(finalSignedTransaction);

  try {
    const sendAndConfirmTx = sendAndConfirmTransactionFactory({
      rpc,
      rpcSubscriptions,
    });

    await sendAndConfirmTx(finalSignedTransaction, {
      commitment: "confirmed",
      maxRetries: 0n,
      skipPreflight,
    });

    const { confirmed, txSuccess } = await checkForTxConfirmedAndSuccess(
      rpc,
      signature,
      finalLatestBlockhash.lastValidBlockHeight,
    );

    return {
      signature,
      confirmed,
      txSuccess,
    };
  } catch (error) {
    console.error("Error sending and confirming transaction: ", error);
    return {
      signature,
      confirmed: false,
      txSuccess: false,
    };
  }
}
