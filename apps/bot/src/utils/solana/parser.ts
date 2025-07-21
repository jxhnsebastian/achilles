import {
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import type { PositionBalances } from "@achilles/utils";
import Decimal from "decimal.js";

interface TokenBalanceChange {
  userAccount: string;
  tokenAccount: string;
  mint: string;
  rawTokenAmount: {
    tokenAmount: string;
    decimals: number;
  };
}

interface AccountData {
  account: string;
  nativeBalanceChange: number;
  tokenBalanceChanges: TokenBalanceChange[];
}

interface NativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number;
}

interface TokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  fromTokenAccount: string;
  toTokenAccount: string;
  tokenAmount: number;
  mint: string;
}

interface InnerInstruction {
  accounts: string[];
  data: string;
  programId: string;
}

interface Instruction {
  accounts: string[];
  data: string;
  programId: string;
  innerInstructions?: InnerInstruction[];
}

interface ParsedTransaction {
  fee: number;
  feePayer: string;
  signature: string;
  slot: number;
  timestamp: number;
  nativeTransfers: NativeTransfer[];
  tokenTransfers: TokenTransfer[];
  accountData: AccountData[];
  transactionError: { error: string } | null;
  instructions: Instruction[];
}

export function getBalances(
  tx: ParsedTransactionWithMeta,
  signature: string,
  coinA: string,
  coinB: string,
  owner: string
): PositionBalances {
  if (!tx || !tx.meta) {
    throw new Error("Invalid transaction data");
  }

  // console.log(tx.meta);

  const positionBalances: PositionBalances = {
    digest: signature,
    coinA: { coinType: coinA, amount: new Decimal(0) },
    coinB: { coinType: coinB, amount: new Decimal(0) },
    others: [],
  };

  const balances: { account: string; mint: string; amount: Decimal }[] = [];

  if (
    tx.meta.preBalances &&
    tx.meta.postBalances &&
    tx.transaction.message.accountKeys
  ) {
    for (let i = 0; i < tx.meta.preBalances.length; i++) {
      const preBalance = tx.meta.preBalances[i];
      const postBalance = tx.meta.postBalances[i];
      const difference = new Decimal(postBalance - preBalance).div(
        new Decimal(10 ** 9)
      );
      if (owner === tx.transaction.message.accountKeys[i].pubkey.toString()) {
        if (coinA === "So11111111111111111111111111111111111111112") {
          positionBalances.coinA.amount =
            positionBalances.coinA.amount.add(difference);
        } else if (coinB === "So11111111111111111111111111111111111111112") {
          positionBalances.coinB.amount =
            positionBalances.coinB.amount.add(difference);
        } else {
          positionBalances.others?.push({
            coinType: "So11111111111111111111111111111111111111112",
            amount: difference,
          });
        }
      }
      balances.push({
        account: tx.transaction.message.accountKeys[i].pubkey.toString() ?? "",
        mint: "So11111111111111111111111111111111111111112",
        amount: difference,
      });
    }
  }

  if (tx.meta.preTokenBalances && tx.meta.postTokenBalances) {
    tx.meta.postTokenBalances.forEach((postBal, index) => {
      const preBal = tx?.meta?.preTokenBalances
        ? tx?.meta?.preTokenBalances.find(
            (balance) =>
              balance.accountIndex === postBal.accountIndex &&
              balance.mint === postBal.mint
          )
        : null;

      const preBalAmount = preBal?.uiTokenAmount?.uiAmount ?? 0;

      // console.log(postBal, postBal.uiTokenAmount, preBal?.uiTokenAmount);
      if (postBal.uiTokenAmount.uiAmount && postBal.owner === owner) {
        const difference = new Decimal(
          (postBal.uiTokenAmount.uiAmount || 0) - preBalAmount
        );
        if (coinA === postBal.mint) {
          positionBalances.coinA.amount =
            positionBalances.coinA.amount.add(difference);
        } else if (coinB === postBal.mint) {
          positionBalances.coinB.amount =
            positionBalances.coinB.amount.add(difference);
        } else {
          positionBalances.others?.push({
            coinType: postBal.mint,
            amount: difference,
          });
        }
      }

      balances.push({
        account: postBal.owner ?? "",
        mint: postBal.mint,
        amount: new Decimal(
          (postBal.uiTokenAmount.uiAmount || 0) -
            (preBal?.uiTokenAmount?.uiAmount || 0)
        ),
      });
    });
  }

  // console.log(balances);
  return positionBalances;
}

export { type ParsedTransaction };
