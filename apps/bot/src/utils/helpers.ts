import type { LiquidityInput } from "@firefly-exchange/library-sui";
import { type LiquidityInput as LiquidityInputCetus } from "@cetusprotocol/cetus-sui-clmm-sdk";
import type { ICoin } from "@firefly-exchange/library-sui/dist/src/spot";
import type { CoinMetadata } from "@mysten/sui/client";
import Decimal from "decimal.js";
import logger from "./logger";
// import memory_local from "./memory_local";
import { memory } from "./utils";
import type {
  ApiV3Token,
  ReturnTypeGetLiquidityAmountOut,
} from "@raydium-io/raydium-sdk-v2";
import type { Mint } from "@solana/spl-token";
import type { IncreaseLiquidityQuote } from "@orca-so/whirlpools-core";
import { StrategyType } from "@achilles/utils";

export const openPositionAlert = async (
  botId: string,
  protocol: string,
  liquidityInput:
    | IncreaseLiquidityQuote
    | ReturnTypeGetLiquidityAmountOut
    | LiquidityInput
    | LiquidityInputCetus,
  lowerTick: number,
  upperTick: number,
  coinA: CoinMetadata | ICoin | Mint | ApiV3Token,
  coinB: CoinMetadata | ICoin | Mint | ApiV3Token
) => {
  const amountA = new Decimal(
    (
      ("coinAmountA" in liquidityInput
        ? liquidityInput?.coinAmountA
        : "tokenEstA" in liquidityInput
        ? liquidityInput?.tokenEstA
        : liquidityInput?.amountA.amount) ?? 0
    ).toString()
  ).div(new Decimal(10).pow(coinA.decimals));

  const amountB = new Decimal(
    (
      ("coinAmountB" in liquidityInput
        ? liquidityInput?.coinAmountB
        : "tokenEstB" in liquidityInput
        ? liquidityInput?.tokenEstB
        : liquidityInput?.amountB.amount) ?? 0
    ).toString()
  ).div(new Decimal(10).pow(coinB.decimals));

  // const maxA = new Decimal(liquidityInput.tokenMaxA.toString()).div(
  //   new Decimal(10).pow(coinA.decimals)
  // );

  // const maxB = new Decimal(liquidityInput.tokenMaxB.toString()).div(
  //   new Decimal(10).pow(coinB.decimals)
  // );

  const coinAIdentifier =
    "programId" in coinA
      ? coinA.address
      : "symbol" in coinA
      ? coinA.symbol
      : "mintAuthority" in coinA
      ? coinA.address.toString()
      : coinA.address.split("::").pop();
  const coinBIdentifier =
    "programId" in coinB
      ? coinB.address
      : "symbol" in coinB
      ? coinB.symbol
      : "mintAuthority" in coinB
      ? coinB.address.toString()
      : coinB.address.split("::").pop();

  const message = `Opening new ${protocol} position for ${botId} from ${lowerTick} to ${upperTick} for ${amountA.toString()} ${coinAIdentifier} and ${amountB.toString()} ${coinBIdentifier}`;
  logger.log(botId, message);
  // await sendAlert(message);
};

export async function getCloseBalances(
  botId: string,
  strategy: StrategyType,
  open?: boolean
): Promise<{ coinA: Decimal; coinB: Decimal }> {
  const memories = await memory.getMemories(
    botId,
    strategy === StrategyType.CHASER ? 1 : 2,
    open ? "open" : "close"
  );
  const positionBalances: { coinA: Decimal; coinB: Decimal } = {
    coinA: new Decimal(0),
    coinB: new Decimal(0),
  };
  if (memories.length !== (StrategyType.CHASER ? 1 : 2))
    throw new Error("Failed to get all memories!");
  memories.forEach((mem) => {
    positionBalances.coinA = positionBalances.coinA.add(mem.coinA.amount);
    positionBalances.coinB = positionBalances.coinB.add(mem.coinB.amount);
  });
  return positionBalances;
}
