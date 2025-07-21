import {
  SuiClient,
  getFullnodeUrl,
  type SuiTransactionBlockResponse,
} from "@mysten/sui/client";
import {
  OnChainCalls,
  QueryChain,
} from "@firefly-exchange/library-sui/dist/src/spot";
import { mainnet } from "./config";
import Decimal from "decimal.js";
import { BN } from "bn.js";
import {
  ClmmPoolUtil,
  TickMath,
  toBigNumberStr,
} from "@firefly-exchange/library-sui";
import {
  type BotConfig,
  type PoolTick,
  type PositionBalances,
  type UserPosition,
  StrategyType,
} from "@achilles/utils";
import type { Pool } from "@firefly-exchange/library-sui/dist/src/spot/types";
import { maxRetries, serialize, sleep, wait } from "@achilles/utils";
import { openPositionAlert } from "../helpers";
import {
  getBalances,
  getTransactionData,
  validateAndCreateKeypair,
} from "./utils";
import logger from "../logger";
import fordefi from "../fordefi/signer";
import {
  closePosition,
  collectFeeAndRewards,
  openPositionWithFixedAmount,
} from "../fordefi/bluefin";
import { localSigner, memory } from "../utils";
import { pollers } from "../poller/server";
import { localWallets } from "../wallets";
import { fetchWithRetry } from "@achilles/utils";

interface PoolInfo {
  address: string;
  price: string;
  [key: string]: any;
}

/**
 * Bluefin Client
 */
export class BluefinClient {
  private client: SuiClient;
  private qc: QueryChain;
  private baseUrl: string = "https://swap.api.sui-prod.bluefin.io/api/v1";
  public botConfig: BotConfig | null;
  public poolInfo: Pool = {} as Pool;

  constructor(botConfig?: BotConfig) {
    this.client = new SuiClient({
      url: getFullnodeUrl("mainnet"),
    });
    this.qc = new QueryChain(this.client);

    this.botConfig = botConfig ?? null;
  }

  public async setPoolInfo(poolId: string) {
    const pool = await this.qc.getPool(poolId);

    if (!pool) throw new Error("Failed to set pool config.");

    this.poolInfo = pool;
  }

  public generatePoolTicks(
    currentTickIndex: number,
    tickSpacing: number,
    totalTicksToGenerate: number = 4000
  ): PoolTick[] {
    // Align current tick to tick spacing
    const alignedCurrentTick =
      Math.floor(currentTickIndex / tickSpacing) * tickSpacing;

    const ticks: PoolTick[] = [];

    // Generate ticks
    for (
      let i = -Math.floor(totalTicksToGenerate / 2);
      i <= Math.floor(totalTicksToGenerate / 2);
      i++
    ) {
      const tick = alignedCurrentTick + i * tickSpacing;

      ticks.push({
        price: TickMath.tickIndexToPrice(
          tick,
          this.poolInfo.coin_a.decimals,
          this.poolInfo.coin_b.decimals
        ).toString(),
        tick,
      });
    }

    // Sort ticks
    return ticks.sort((a, b) => a.tick - b.tick);
  }

  /**
   * Get pool ticks for a specific pool
   * @param poolAddress The pool address
   * @returns Promise with array of pool ticks
   */
  public async getPoolTicks(poolId?: string): Promise<PoolTick[]> {
    const poller = pollers.get(poolId ?? this.poolInfo.id);
    if (!poller) throw new Error(`No poller for ${this.poolInfo.id}`);
    const poolPrice = poller.getLatestData().price;
    const currentTick = TickMath.priceToTickIndex(
      poolPrice,
      this.poolInfo.coin_a.decimals,
      this.poolInfo.coin_b.decimals
    );
    return this.generatePoolTicks(
      currentTick,
      this.poolInfo.ticks_manager.tick_spacing
    );
  }

  /**
   * Get pool information for specific pools
   * @param poolAddresses Array of pool addresses
   * @returns Promise with array of pool info
   */
  public async getPoolsInfo(poolIds: string[]): Promise<PoolInfo[]> {
    const poolsParam = poolIds.join(",");

    const url = new URL(`${this.baseUrl}/pools/info`);
    url.searchParams.append("pools", poolsParam);
    const response = await fetchWithRetry<PoolInfo[]>(
      url.toString(),
      undefined,
      logger.log
    );

    return response || [];
  }

  /**
   * Get pool price for a specific pool
   * @param poolAddress
   * @returns Promise with pool price
   */
  public async getPoolPrice(poolId?: string): Promise<Decimal> {
    try {
      const pool = await this.qc.getPool(poolId ?? this.poolInfo.id);
      return TickMath.sqrtPriceX64ToPrice(
        new BN(pool.current_sqrt_price),
        pool.coin_a.decimals,
        pool.coin_b.decimals
      );

      // const poolInfo = await this.getPoolsInfo([poolAddress]);
      // if (poolInfo.length > 0 && poolInfo[0].price) {
      //   return new Decimal(poolInfo[0].price);
      // }
    } catch (error) {
      throw error;
    }

    throw new Error(`Failed to fetch price for ${poolId}`);
  }

  public calcPoolPrice(pool: Pool): Decimal {
    try {
      return TickMath.sqrtPriceX64ToPrice(
        new BN(pool.current_sqrt_price),
        pool.coin_a.decimals,
        pool.coin_b.decimals
      );
    } catch (error) {
      throw error;
    }

    throw new Error(`Failed to fetch price for ${pool.id}`);
  }

  /**
   * Get user positions
   * @param userAddress The user address to get positions for
   * @param poolAddress Optional pool address to filter positions
   * @returns Promise of current user position
   */
  public async getUserPositions(
    userAddress?: string,
    poolId?: string
  ): Promise<UserPosition[] | null> {
    let positions = await this.qc.getUserPositions(
      mainnet.BasePackage,
      userAddress ?? this.botConfig?.sender!
    );

    positions?.forEach((position) =>
      logger.log(this.botConfig?.botId ?? "bot", serialize(position))
    );

    return (
      positions
        .filter((position) => position.pool_id === (poolId ?? this.poolInfo.id))
        .map((position) => ({
          ...position,
          lower_price: TickMath.tickIndexToPrice(
            position.lower_tick,
            this.poolInfo.coin_a.decimals,
            this.poolInfo.coin_b.decimals
          ),
          upper_price: TickMath.tickIndexToPrice(
            position.upper_tick,
            this.poolInfo.coin_a.decimals,
            this.poolInfo.coin_b.decimals
          ),
          botId: this.botConfig?.botId!,
        })) ?? null
    );
  }

  async closePosition(
    sender: string,
    posID: string
  ): Promise<PositionBalances> {
    let retries = 0;
    while (retries < maxRetries) {
      try {
        let pos = await this.qc.getPositionDetails(posID);
        let pool = await this.qc.getPool(pos.pool_id);
        let oc: OnChainCalls | null = null;

        if (localSigner) {
          const privateKey = localWallets[sender].privateKey;
          const signer = validateAndCreateKeypair(privateKey);
          oc = new OnChainCalls(this.client, mainnet, { signer });
        }

        let collectDigest = "";
        if (localSigner && oc) {
          let collectTxn = await oc.collectFeeAndRewards(pool, posID);
          collectDigest = (collectTxn as SuiTransactionBlockResponse).digest;
        } else {
          let collectTxn = await collectFeeAndRewards(pool, posID, sender);
          collectDigest = await fordefi.execute(
            this.botConfig?.botId ?? "bot",
            collectTxn,
            {
              sender,
              chain: "sui",
            }
          );
        }

        const {
          transactionData: collectTransactionData,
          success: collectSuccess,
        } = await getTransactionData(
          this.client,
          this.botConfig?.botId ?? "bot",
          collectDigest
        );

        if (!collectSuccess) {
          throw new Error("Collect fee and rewards transaction failed");
        }

        const balances = getBalances(
          collectTransactionData,
          pool.coin_a.address,
          pool.coin_b.address,
          pool.coin_a.decimals,
          pool.coin_b.decimals
        );
        logger.log(this.botConfig?.botId, "Collected fee and rewards.");
        await memory.createMemoryEntry(
          this.botConfig?.botId ?? "bot",
          this.botConfig?.strategy === StrategyType.CHASER
            ? "chaser"
            : "inrange",
          "collect",
          balances,
          this.calcPoolPrice(pool),
          balances.digest
        );

        let closeDigest = "";
        if (localSigner && oc) {
          let closeTxn = await oc.closePosition(pool, posID);
          closeDigest = (closeTxn as SuiTransactionBlockResponse).digest;
        } else {
          let closeTxn = await closePosition(pool, posID, sender);
          closeDigest = await fordefi.execute(
            this.botConfig?.botId ?? "bot",
            closeTxn,
            {
              sender,
              chain: "sui",
            }
          );
        }

        const { transactionData: closeTransactionData, success: closeSuccess } =
          await getTransactionData(
            this.client,
            this.botConfig?.botId ?? "bot",
            closeDigest
          );

        if (!closeSuccess) {
          throw new Error("Close position transaction failed");
        }
        logger.log(this.botConfig?.botId, `Closed position ${posID}`);
        logger.log(
          this.botConfig?.botId,
          JSON.stringify(closeTransactionData.balanceChanges)
        );
        return getBalances(
          closeTransactionData,
          pool.coin_a.address,
          pool.coin_b.address,
          pool.coin_a.decimals,
          pool.coin_b.decimals
        );
      } catch (error: any) {
        retries++;

        if (retries < maxRetries) {
          logger.log(
            this.botConfig?.botId,
            `Attempt ${retries} to close position for ${
              this.botConfig?.botId
            } failed: ${error}. Retrying in ${wait ** retries}...`
          );
          await sleep(wait ** retries * 1000);
          continue;
        }

        logger.log(
          this.botConfig?.botId,
          `Failed to close position for ${this.botConfig?.botId} after ${maxRetries} attempts.`,
          error
        );
        throw error;
      }
    }

    throw new Error("Failed to close position");
  }

  async openPositionWithFixedAmount(
    sender: string,
    coinAmount: number,
    lowerPrice: string,
    upperPrice: string,
    fix_amount_a: boolean,
    poolID?: string
  ): Promise<PositionBalances> {
    let retries = 0;

    while (retries < maxRetries) {
      try {
        let oc: OnChainCalls | null = null;
        if (localSigner) {
          const privateKey = localWallets[sender].privateKey;
          const signer = validateAndCreateKeypair(privateKey);
          oc = new OnChainCalls(this.client, mainnet, { signer });
        }

        let pool = await this.qc.getPool(poolID ?? this.poolInfo.id);

        let coinAmountBN = new BN(
          toBigNumberStr(
            coinAmount,
            fix_amount_a ? pool.coin_a.decimals : pool.coin_b.decimals
          )
        );
        let lowerTick = TickMath.priceToInitializableTickIndex(
          new Decimal(lowerPrice),
          pool.coin_a.decimals,
          pool.coin_b.decimals,
          pool.ticks_manager.tick_spacing
        );
        let upperTick = TickMath.priceToInitializableTickIndex(
          new Decimal(upperPrice),
          pool.coin_a.decimals,
          pool.coin_b.decimals,
          pool.ticks_manager.tick_spacing
        );

        const curSqrtPrice = new BN(pool.current_sqrt_price);
        const slippage = this.botConfig?.slippage ?? 0.1;
        let roundUp = true;

        const liquidityInput =
          ClmmPoolUtil.estLiquidityAndCoinAmountFromOneAmounts(
            lowerTick,
            upperTick,
            coinAmountBN,
            fix_amount_a,
            roundUp,
            slippage,
            curSqrtPrice
          );
        await openPositionAlert(
          this.botConfig?.botId ?? "bot",
          "bluefin",
          liquidityInput,
          lowerTick,
          upperTick,
          pool.coin_a,
          pool.coin_b
        );

        let digest = "";
        if (localSigner && oc) {
          let openTxn = await oc.openPositionWithFixedAmount(
            pool,
            lowerTick,
            upperTick,
            liquidityInput
          );
          digest = (openTxn as SuiTransactionBlockResponse).digest;
        } else {
          let openTxn = await openPositionWithFixedAmount(
            pool,
            lowerTick,
            upperTick,
            liquidityInput,
            sender
          );
          digest = await fordefi.execute(
            this.botConfig?.botId ?? "bot",
            openTxn,
            {
              sender,
              chain: "sui",
            }
          );
        }

        const { transactionData, success } = await getTransactionData(
          this.client,
          this.botConfig?.botId ?? "bot",
          digest
        );

        if (!success) {
          throw new Error("Open position transaction failed");
        }

        logger.log(this.botConfig?.botId, "Position opened.");

        return getBalances(
          transactionData,
          pool.coin_a.address,
          pool.coin_b.address,
          pool.coin_a.decimals,
          pool.coin_b.decimals
        );
      } catch (error) {
        retries++;

        if (retries < maxRetries) {
          logger.log(
            this.botConfig?.botId,
            `Attempt ${retries} to open position for ${
              this.botConfig?.botId
            } failed: ${error}. Retrying in ${wait ** retries}...`
          );
          await sleep(wait ** retries * 1000);
          continue;
        }
        logger.log(
          this.botConfig?.botId,
          `Failed to open position for ${this.botConfig?.botId} after ${maxRetries} attempts: `,
          error
        );
        throw error;
      }
    }

    throw new Error("Failed to open position");
  }
}
