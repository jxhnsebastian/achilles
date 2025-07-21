import crypto from "crypto";
import { Transaction } from "@mysten/sui/transactions";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import logger from "../logger";
import { getFordefiWallets, sleep } from "@achilles/utils";

const maxRetries = 5;
const wait = 2;

const failedStates = [
  "aborted",
  "cancelled",
  "aborting",
  "canceling",
  "error_pushing_to_blockchain",
  "completed_reverted",
  "mined_reverted",
  "error_signing",
  "dropped",
  "failed",
];

export interface SolTransaction {
  txn: string;
  signatures?: any;
}

export interface TxnOptions {
  gas?: string;
  sender: string;
  chain: "sui" | "solana";
}

interface FordefiResponse {
  id?: string;
  state?: string;
  error?: string;
  detail?: string;
  error_type?: string;
  simulation_status_result?: {
    simulation_status: string;
    details: string;
  };
  expected_result?: {
    effects: {
      status: {
        status: string;
      };
    };
  };
}

interface FordefiTransactionDetailsResponse {
  id?: string;
  state?: string;
  error?: string;
  digest?: string;
  hash?: string;
  blockchain_tx_details?: {
    solana_transaction_details?: {
      signature?: string;
      logs?: string[];
      [key: string]: any;
    };
    sui_transaction_details?: {
      digest?: string;
      logs?: string[];
      [key: string]: any;
    };
  };
  [key: string]: any;
}

class Fordefi {
  private client: SuiClient;
  private secretPem: string = "";
  private accessToken: string = "";
  private vault: string | null = null;

  constructor() {
    this.client = new SuiClient({
      url: getFullnodeUrl("mainnet"),
    });
  }

  setSecrets(chain: string) {
    let pem: string | undefined = "";
    if (chain === "sui") {
      pem = process.env.FORDEFI_SUI_PRIVATE_KEY;
      this.accessToken = process.env.FORDEFI_SUI_ACCESS_TOKEN!;
    } else if (chain === "solana") {
      pem = process.env.FORDEFI_SOL_PRIVATE_KEY;
      this.accessToken = process.env.FORDEFI_SOL_ACCESS_TOKEN!;
    }

    if (!pem || !this.accessToken) {
      throw new Error(
        "Missing required Fordefi environment variables (API Key / Access Token)"
      );
    }

    this.secretPem = `-----BEGIN EC PRIVATE KEY-----\n${pem}\n-----END EC PRIVATE KEY-----`;
  }

  async getFordefiTransactionDetails(
    transactionId: string
  ): Promise<FordefiTransactionDetailsResponse> {
    const gatewayHost = "api.fordefi.com";
    const path = `api/v1/transactions/${transactionId}`;

    try {
      const response = await fetch(`https://${gatewayHost}/${path}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessToken}`,
        },
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `Fordefi API Error (${response.status}) fetching details for ${transactionId}: ${errorBody}`
        );
      }

      const responseData =
        (await response.json()) as FordefiTransactionDetailsResponse;

      return responseData;
    } catch (error: any) {
      throw new Error(`Failed to get transaction details: ${error?.message}`);
    }
  }

  async sendSignedRequest(requestJson: any) {
    const gatewayHost = "api.fordefi.com";
    const path = "/api/v1/transactions/create-and-wait";
    const requestBody = JSON.stringify(requestJson);
    const timestamp = new Date().getTime();
    const payload = `${path}|${timestamp}|${requestBody}`;

    try {
      if (!this.secretPem || !this.accessToken)
        throw new Error("Missing secrets!");
      const privateKey = crypto.createPrivateKey(this.secretPem);
      const sign = crypto.createSign("SHA256").update(payload, "utf8").end();
      const signature = sign.sign(privateKey, "base64");

      const response = await fetch(`https://${gatewayHost}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessToken}`,
          "X-Timestamp": timestamp.toString(),
          "X-Signature": signature,
        },
        body: requestBody,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Fordefi API Error (${response.status}): ${errorBody}`);
      }

      return await response.json();
    } catch (error: any) {
      throw new Error(`Failed to send transaction: ${error?.message}`);
    }
  }

  async waitForCompletedState(
    botId: string,
    transactionId: string,
    chainType: "sui" | "solana"
  ): Promise<string> {
    let retries = 0;

    // TODO: keep checking till it fails ? or keep limit
    while (true) {
      if (retries >= maxRetries) {
        logger.log(botId, `Resetting transaction poller for ${transactionId}.`);
        retries = 0;
      }
      try {
        const txDetails = await this.getFordefiTransactionDetails(
          transactionId
        );

        logger.log(
          botId,
          `Polling transaction ${transactionId}, current state: ${
            txDetails?.state || "unknown"
          }`
        );

        // Check for signed state
        if (txDetails?.state === "completed") {
          const signature =
            chainType === "solana"
              ? txDetails?.hash
              : txDetails?.digest ||
                txDetails?.blockchain_tx_details?.sui_transaction_details
                  ?.digest;

          if (!signature) {
            throw new Error("Transaction digest not found in response");
          }

          return signature;
        }

        // Check for error state
        if (failedStates.includes(txDetails?.state ?? "")) {
          // if transaction failed quit polling and retry a new transaction
          retries = maxRetries;
          throw new Error(
            `Transaction failed with state: ${txDetails?.state}, error: ${
              txDetails?.error || "unknown"
            }. Quitting poll and retrying.`
          );
        }

        logger.log(
          botId,
          `Transaction ${transactionId} not yet signed (state: ${
            txDetails?.state
          }). Retrying in ${wait ** retries}s...`
        );

        retries++;
        await sleep(wait ** retries * 1000);
      } catch (error: any) {
        retries++;

        if (retries <= maxRetries) {
          logger.log(
            botId,
            `Attempt ${retries} to check transaction ${transactionId} failed: ${
              error?.message
            }. Retrying in ${wait ** retries}s...`
          );

          await sleep(wait ** retries * 1000);
          continue;
        }

        throw error;
      }
    }

    throw new Error(
      `Transaction ${transactionId} did not reach signed state after ${maxRetries} retries`
    );
  }

  async buildSuiRequest(txb: Transaction, options?: TxnOptions) {
    txb.setGasBudget(BigInt(options?.gas ?? "100000000"));
    if (options?.sender) txb.setSenderIfNotSet(options.sender);

    const bcsData = await txb.build({ client: this.client });
    const bcsBase64 = Buffer.from(bcsData).toString("base64");

    return {
      signer_type: "api_signer",
      type: "sui_transaction",
      details: {
        type: "sui_binary_canonical_serialization",
        chain: "sui_mainnet",
        data: bcsBase64,
      },
      note: "Sui bot operation",
      vault_id: this.vault,
      timeout: 25,
      wait_for_state: "signed",
    };
  }

  private buildSolanaRequest(transaction: SolTransaction) {
    const details: any = {
      type: "solana_serialized_transaction_message",
      data: transaction.txn,
      chain: "solana_mainnet",
    };

    if (transaction.signatures) {
      const signatures = Object.entries(transaction.signatures).map(
        ([key, value]) => {
          return {
            data: value
              ? Buffer.from(value as Uint8Array).toString("base64")
              : null,
          };
        }
      );
      details.signatures = signatures;
    }

    return {
      vault_id: this.vault,
      signer_type: "api_signer",
      type: "solana_transaction",
      details,
      note: "Solana bot operation",
      timeout: 25,
      wait_for_state: "signed",
    };
  }

  async execute(
    botId: string,
    txb: Transaction | SolTransaction,
    options: TxnOptions
  ): Promise<string> {
    try {
      if (!options.sender) throw new Error("Missing sender!");
      if (!options.chain) throw new Error("Missing chain type!");
      this.setSecrets(options.chain);
      const wallets = await getFordefiWallets()
      this.vault = wallets[options.sender].vaultId;
      if (!this.secretPem || !this.accessToken || !this.vault)
        throw new Error("Missing secrets!");

      const requestJson =
        options.chain === "sui"
          ? await this.buildSuiRequest(txb as Transaction, options)
          : this.buildSolanaRequest(txb as SolTransaction);
      const response = (await this.sendSignedRequest(
        requestJson
      )) as FordefiResponse;

      if (!response || response?.error_type || response?.error) {
        throw new Error(`ForDefi transaction failed: ${response?.detail}`);
      }

      if (!response.id)
        throw new Error(`Response id not found: ${response?.detail}`);

      logger.log(
        botId,
        `ForDefi transaction submitted with ID: ${response.id}, state: ${
          response?.state ?? "unknown"
        }`
      );

      const digest = await this.waitForCompletedState(
        botId,
        response.id,
        options.chain
      );
      return digest;
    } catch (error: any) {
      throw new Error(`Failed to execute transaction: ${error?.message}`);
    }
  }
}

export default new Fordefi();
