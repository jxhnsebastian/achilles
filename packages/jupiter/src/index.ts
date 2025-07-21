import bs58 from "bs58";

import { QuoteResponse, SwapMode, SwapResponse } from "@jup-ag/api";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";

import { checkForTxConfirmedAndSuccess } from "./solana.js";

interface SwapQuote {
  inputAmount: number;
  outputAmount: number;
  price: number;
}

export async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
): Promise<SwapQuote | null> {
  try {
    console.log("Getting Jupiter quote for:", inputMint, outputMint, amount);
    const quoteResponse = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50&swapMode=${SwapMode.ExactIn}`,
    );

    const quote = (await quoteResponse.json()) as QuoteResponse;

    console.log(quote);
    if (!quote || !quote.outAmount) {
      console.error("No quote found");
      return null;
    }

    return {
      inputAmount: Number(amount),
      outputAmount: Number(quote.outAmount),
      price: Number(quote.priceImpactPct),
    };
  } catch (error) {
    console.error("Error getting Jupiter quote:", error);
    return null;
  }
}

interface TokenPriceDetails {
  id: string;
  type: "derivedPrice";
  price: string;
}

export async function getTokenPrices(tokenMints: string[]): Promise<Record<string, number>> {
  try {
    const response = await fetch(`https://api.jup.ag/price/v2?ids=${tokenMints.join(",")}`);
    const { data } = (await response.json()) as { data: Record<string, TokenPriceDetails> };

    // tokenId -> price mapping
    return Object.entries(data).reduce(
      (acc, [tokenId, details]) => {
        if (details === null) {
          // jupiter didn't have a price; return 0
          acc[tokenId] = 0;
          return acc;
        }

        acc[tokenId] = Number(details.price);
        return acc;
      },
      {} as Record<string, number>,
    );
  } catch (error) {
    console.error("Error fetching token prices:", error);
    throw error;
  }
}

function getSigner(signerSecretKey: string) {
  const signer = Keypair.fromSecretKey(bs58.decode(signerSecretKey));
  return signer;
}

export async function executeJupiterSwap(
  rpcUrl: string,
  signerSecretKey: string,
  inputMint: string,
  outputMint: string,
  amount: number,
): Promise<{
  success: boolean;
  swapDetails: { inputMint: string; outputMint: string; amount: number };
  error?: any;
  txSignature?: string;
  swapQuote?: QuoteResponse;
}> {
  const connection = new Connection(rpcUrl);

  let swapQuote: QuoteResponse | undefined = undefined;
  let txSignature: string | undefined = undefined;

  try {
    const signer = getSigner(signerSecretKey);

    const quoteResponse = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50&swapMode=${SwapMode.ExactIn}`,
    );

    swapQuote = (await quoteResponse.json()) as QuoteResponse;

    const swapResponse = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        quoteResponse: swapQuote,
        userPublicKey: signer.publicKey.toString(),
        wrapAndUnwrapSol: true,
      }),
    });

    const swapResult = (await swapResponse.json()) as SwapResponse;
    const { swapTransaction, lastValidBlockHeight } = swapResult;

    const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    if (!transaction) {
      throw new Error("Failed to deserialize swap transaction");
    }

    transaction.sign([signer]);

    txSignature = await connection.sendRawTransaction(transaction.serialize());
    const { txSuccess, confirmed } = await checkForTxConfirmedAndSuccess(
      connection,
      txSignature,
      lastValidBlockHeight,
    );

    return {
      success: txSuccess && confirmed,
      swapDetails: {
        inputMint,
        outputMint,
        amount,
      },
      txSignature,
      swapQuote: swapQuote,
    };
  } catch (error) {
    console.error("Error executing Jupiter swap:", error);
    return {
      success: false,
      swapDetails: {
        inputMint,
        outputMint,
        amount,
      },
      txSignature,
      swapQuote,
      error,
    };
  }
}
