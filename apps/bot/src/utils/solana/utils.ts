import {
  type RpcMainnet,
  type SolanaRpcApiMainnet,
  type Signature,
  type TransactionMessage,
  getBase64EncodedWireTransaction,
  prependTransactionMessageInstructions,
  type TransactionMessageWithBlockhashLifetime,
  type ITransactionMessageWithFeePayer,
  signTransactionMessageWithSigners,
  setTransactionMessageLifetimeUsingBlockhash,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  createSolanaRpc,
  mainnet,
  createSolanaRpcSubscriptions,
  createKeyPairSignerFromBytes,
  getBase58Encoder,
  compileTransaction,
  partiallySignTransactionMessageWithSigners,
} from "@solana/kit";
import {
  getSetComputeUnitPriceInstruction,
  getSetComputeUnitLimitInstruction,
} from "@solana-program/compute-budget";
import { sleep } from "@achilles/utils";
import {
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction,
  type BlockhashWithExpiryBlockHeight,
} from "@solana/web3.js";
import bs58 from "bs58";
import type { SolTransaction } from "../fordefi/signer";
import fordefi from "../fordefi/signer";
import { localSigner } from "../utils";
import { localWallets } from "../wallets";

export function getKeypairFromPrivateKey(privateKeyString: string): Keypair {
  const decodedKey = bs58.decode(privateKeyString);
  return Keypair.fromSecretKey(decodedKey);
}

export async function getSignerFromSecretKey(secretKey: string) {
  return await createKeyPairSignerFromBytes(
    getBase58Encoder().encode(secretKey)
  );
}

export const getRpc = (rpcUrl: string) => {
  const endpoint = rpcUrl || "https://api.mainnet-beta.solana.com";
  const wsEndpoint = endpoint
    .replace("https://", "wss://")
    .replace("http://", "ws://");

  return {
    rpc: createSolanaRpc(mainnet(endpoint)),
    rpcSubscriptions: createSolanaRpcSubscriptions(mainnet(wsEndpoint)),
  };
};

// https://github.com/anza-xyz/agave/pull/1034
async function isBlockhashExpired(
  rpc: RpcMainnet<SolanaRpcApiMainnet>,
  lastValidBlockHeight: bigint
) {
  const currentBlockHeight = await rpc
    .getBlockHeight({ commitment: "confirmed" })
    .send();
  return currentBlockHeight > lastValidBlockHeight;
}

export async function checkForTxConfirmedAndSuccess(
  rpc: RpcMainnet<SolanaRpcApiMainnet>,
  txId: string,
  lastValidHeight: bigint
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

export async function getTransactionPriorityAndComputeUnits(
  rpcUrl: string,
  txnMsg?: string,
  priorityLevel: string = "High"
) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "npc-get-priority-fee",
      method: "getPriorityFeeEstimate",
      params: [
        {
          transaction: txnMsg,
          options: {
            transactionEncoding: "base64",
            priorityLevel,
          },
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `getPriorityFeeEstimate API Error (${response.status}): ${errorBody}`
    );
  }

  const { result } = await response.json();
  // console.log(result);
  const priorityFee = result.priorityFeeEstimate;
  return priorityFee;
}

export async function addTransactionPriorityAndComputeUnits(
  rpcUrl: string,
  transactionMessage: TransactionMessage &
    ITransactionMessageWithFeePayer &
    TransactionMessageWithBlockhashLifetime,
  { computeUnits = 200_000, priorityLevel = "High" as const } = {}
) {
  const compliedTx = compileTransaction(transactionMessage);
  const base64EncodedWireTransaction =
    getBase64EncodedWireTransaction(compliedTx);

  const priorityFee = await getTransactionPriorityAndComputeUnits(
    rpcUrl,
    base64EncodedWireTransaction,
    priorityLevel
  );

  const finalTransactionMessage = prependTransactionMessageInstructions(
    [
      getSetComputeUnitLimitInstruction({ units: computeUnits }),
      getSetComputeUnitPriceInstruction({ microLamports: priorityFee }),
    ],
    transactionMessage
  );

  return finalTransactionMessage;
}

export async function sendAndConfirmV2Transaction(
  rpcUrl: string,
  rpc: RpcMainnet<SolanaRpcApiMainnet>,
  rpcSubscriptions: any,
  transactionMessage: TransactionMessage &
    ITransactionMessageWithFeePayer &
    TransactionMessageWithBlockhashLifetime,
  options: {
    computeUnits?: number;
    skipPreflight?: boolean;
  } = {}
): Promise<string> {
  const { computeUnits = 200_000, skipPreflight = true } = options;

  const finalTransactionMessage = await addTransactionPriorityAndComputeUnits(
    rpcUrl,
    transactionMessage,
    { computeUnits }
  );

  const { value: finalLatestBlockhash } = await rpc.getLatestBlockhash().send();
  setTransactionMessageLifetimeUsingBlockhash(
    finalLatestBlockhash,
    finalTransactionMessage
  );

  const finalSignedTransaction = await signTransactionMessageWithSigners(
    finalTransactionMessage
  );
  const signature = getSignatureFromTransaction(finalSignedTransaction);

  try {
    const sendAndConfirmTx = sendAndConfirmTransactionFactory({
      rpc,
      rpcSubscriptions,
    });

    let hashExpired = await isBlockhashExpired(
      rpc,
      finalLatestBlockhash.lastValidBlockHeight
    );
    while (!hashExpired) {
      await sendAndConfirmTx(finalSignedTransaction, {
        commitment: "confirmed",
        maxRetries: 0n,
        skipPreflight,
      });
      const status = await rpc
        .getSignatureStatuses([signature as Signature])
        .send();
      // console.log(status.value);
      if (
        status &&
        (status.value?.[0]?.confirmationStatus === "confirmed" ||
          status.value?.[0]?.confirmationStatus === "finalized")
      ) {
        if (status.value[0]?.err) {
          const error =
            typeof status.value[0]?.err === "string"
              ? status.value[0]?.err
              : JSON.stringify(status.value[0]?.err);

          throw new Error(`Transaction failed: ${error}`);
        } else {
          return signature;
        }
      }
      hashExpired = await isBlockhashExpired(
        rpc,
        finalLatestBlockhash.lastValidBlockHeight
      );
      console.log("Transaction not confirmed. Retrying.");
      continue;
    }

    throw new Error(`Failed to confirm transaction : ${signature}`);
  } catch (error) {
    throw error;
  }
}

export async function sendAndConfirmV1Transaction(
  transaction: Transaction | VersionedTransaction,
  blockhashContext: BlockhashWithExpiryBlockHeight,
  connection: Connection
) {
  const { lastValidBlockHeight } = blockhashContext;
  let blockheight = await connection.getBlockHeight();

  let txn = "";

  while (blockheight < lastValidBlockHeight) {
    txn = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true,
      maxRetries: 0,
    });
    await sleep(1000);
    const status = await connection
      .getSignatureStatuses([txn])
      .then((statuses) => statuses.value[0]);

    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      if (status.err) {
        const error =
          typeof status.err === "string"
            ? status.err
            : JSON.stringify(status.err);

        throw new Error(error);
      } else {
        return txn;
      }
    }

    blockheight = await connection.getBlockHeight();
  }

  throw new Error(`Failed to confirm transaction : ${txn}`);
}

export async function buildV2Transaction(
  rpcUrl: string,
  rpc: RpcMainnet<SolanaRpcApiMainnet>,
  rpcSubscriptions: any,
  transactionMessage: TransactionMessage &
    ITransactionMessageWithFeePayer &
    TransactionMessageWithBlockhashLifetime,
  options: {
    computeUnits?: number;
    skipPreflight?: boolean;
  } = { computeUnits: 200_000, skipPreflight: true }
): Promise<SolTransaction> {
  const { computeUnits } = options;

  const transactionMessageWithFees =
    await addTransactionPriorityAndComputeUnits(rpcUrl, transactionMessage, {
      computeUnits,
    });

  const { value: finalLatestBlockhash } = await rpc.getLatestBlockhash().send();
  setTransactionMessageLifetimeUsingBlockhash(
    finalLatestBlockhash,
    transactionMessageWithFees
  );

  const signedTransactionMessage =
    await partiallySignTransactionMessageWithSigners(
      transactionMessageWithFees
    );

  const serializedTx = Buffer.from(
    signedTransactionMessage.messageBytes
  ).toString("base64");
  // console.log("Signatures: ", signedTransactionMessage.signatures);
  // const serializedTx = getBase64EncodedWireTransaction(compliedTx);
  return { txn: serializedTx, signatures: signedTransactionMessage.signatures };
}

export async function executeVersionedTransaction(
  transaction: VersionedTransaction,
  connection: Connection,
  sender: string,
  botId?: string
) {
  let signature = "";
  if (localSigner) {
    const privateKey = localWallets[sender].privateKey;
    const keypair = getKeypairFromPrivateKey(privateKey);

    const latestBlockHash = await connection.getLatestBlockhash("confirmed");
    // transaction.message.recentBlockhash = latestBlockHash.blockhash;
    transaction.sign([keypair]);

    signature = await sendAndConfirmV1Transaction(
      transaction,
      latestBlockHash,
      connection
    );
  } else {
    const compiledTx = transaction.message.serialize();
    const serializedTx = Buffer.from(compiledTx).toString("base64");

    const signatures: { [key: string]: Uint8Array } = {};
    transaction.signatures.forEach((signature, index) => {
      signatures[`signature_${index}`] = signature;
    });

    signature = await fordefi.execute(
      botId ?? "bot",
      { txn: serializedTx, signatures },
      {
        sender,
        chain: "solana",
      }
    );
  }

  return signature;
}
