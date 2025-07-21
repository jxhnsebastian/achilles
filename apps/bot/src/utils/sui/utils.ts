import Decimal from "decimal.js";
import { sleep } from "@achilles/utils";
import logger from "../logger";
import type {
  SuiClient,
  SuiTransactionBlockResponse,
} from "@mysten/sui/client";
import type { PositionBalances } from "@achilles/utils";
import { Ed25519Keypair } from "@firefly-exchange/library-sui";

export function validateAndCreateKeypair(privateKey: string): Ed25519Keypair {
  try {
    return Ed25519Keypair.fromSecretKey(privateKey);
  } catch (error: any) {
    throw new Error(`Keypair creation failed: ${error?.message}`);
  }
}

export const getBalances = (
  transactionData: SuiTransactionBlockResponse,
  coinTypeA: string,
  coinTypeB: string,
  coinDecimalsA: number,
  coinDecimalsB: number
): PositionBalances => {
  const owner = transactionData.transaction?.data.sender;
  const positionBalances: PositionBalances = {
    digest: transactionData.digest,
    coinA: { coinType: coinTypeA, amount: new Decimal(0) },
    coinB: { coinType: coinTypeB, amount: new Decimal(0) },
    others: [],
  };
  transactionData.balanceChanges?.forEach((balance) => {
    //@ts-ignore
    if (balance.owner?.AddressOwner === owner) {
      if (balance.coinType === coinTypeA) {
        positionBalances.coinA.amount = positionBalances.coinA.amount.add(
          new Decimal(balance.amount).div(new Decimal(10 ** coinDecimalsA))
        );
      } else if (balance.coinType === coinTypeB) {
        positionBalances.coinB.amount = positionBalances.coinB.amount.add(
          new Decimal(balance.amount).div(new Decimal(10 ** coinDecimalsB))
        );
      } else {
        positionBalances.others?.push({
          coinType: balance.coinType,
          amount: new Decimal(balance.amount),
        });
      }
    }
  });
  return positionBalances;
};

export async function getTransactionData(
  client: SuiClient,
  botId: string,
  digest: string,
  maxAttempts: number = 5,
  delay: number = 2
): Promise<{
  transactionData?: any;
  success: boolean;
}> {
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      logger.log(
        botId,
        `Attempt ${
          attempts + 1
        } to fetch transaction data for digest: ${digest}`
      );

      // Wait for transaction to be confirmed first
      await client.waitForTransaction({ digest });

      // Get transaction data with effects and balance changes
      const transactionData = await client.getTransactionBlock({
        digest,
        options: {
          showInput: true,
          showEffects: true,
          showBalanceChanges: true,
        },
      });

      if (
        !transactionData ||
        !transactionData?.effects ||
        !transactionData?.balanceChanges
      ) {
        logger.log(
          botId,
          `Transaction data missing for digest: ${digest}, Retrying.`
        );
        continue;
      }

      let totalAmount = new Decimal(0);
      transactionData.balanceChanges?.forEach((balance) => {
        if (balance.amount) {
          totalAmount = totalAmount.add(new Decimal(balance.amount));
        }
      });

      if (totalAmount.equals(new Decimal(0))) {
        logger.log(botId, `Zero Balances for digest: ${digest}, Retrying.`);
        continue;
      }

      // Check if transaction was successful
      const success = transactionData.effects.status.status === "success";

      if (!success) return { success };

      logger.log(
        botId,
        `Successfully retrieved transaction data for digest: ${digest}`
      );

      return {
        transactionData,
        success,
      };
    } catch (error) {
      attempts++;

      if (attempts < maxAttempts) {
        logger.log(
          botId,
          `Transaction data not available yet. Retrying in 2s... (${attempts}/${maxAttempts})`
        );
        await sleep(delay ** attempts * 1000);
        continue;
      }

      logger.log(
        botId,
        `Failed to fetch transaction data after ${maxAttempts} attempts for digest: ${digest}. Resetting attempts and retrying.`
      );
      attempts = 0;
      continue;
      // throw error;
    }
  }

  throw new Error(`Failed to get transaction data for digest: ${digest}`);
}
