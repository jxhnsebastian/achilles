import {
  SuiClient,
  getFullnodeUrl,
  type SuiTransactionBlockResponse,
  type CoinMetadata,
} from "@mysten/sui/client";
import Decimal from "decimal.js";
import { BN } from "bn.js";
import CetusClmmSDK, {
  initCetusSDK,
  TickMath,
  type Pool,
  type CollectRewarderParams,
  type RewarderAmountOwed,
  Percentage,
  adjustForCoinSlippage,
  type AddLiquidityFixTokenParams,
  ClmmPoolUtil,
} from "@cetusprotocol/cetus-sui-clmm-sdk";
import {
  StrategyType,
  type BotConfig,
  type PoolTick,
  type PositionBalances,
  type UserPosition,
} from "@achilles/utils";
import { AggregatorClient, Env } from "@cetusprotocol/aggregator-sdk";
import { Transaction } from "@mysten/sui/transactions";
import { maxRetries, serialize, sleep, wait } from "@achilles/utils";
import { openPositionAlert } from "../helpers";
import {
  getBalances,
  getTransactionData,
  validateAndCreateKeypair,
} from "./utils";
import logger from "../logger";
import fordefi from "../fordefi/signer";
import { memory, localSigner } from "../utils";
import { pollers } from "../poller/server";
import { localWallets } from "../wallets";

/**
 * Interface for pool information
 */
export interface PoolInfo extends Pool {
  coinA: CoinMetadata;
  coinB: CoinMetadata;
}

/**
 * Cetus Client
 */
export class CetusClient {
  private client: SuiClient;
  private swapClient: AggregatorClient;
  private cetusClmmSDK: CetusClmmSDK;
  public poolInfo: PoolInfo = {} as PoolInfo;
  public botConfig: BotConfig | null;

  constructor(senderAddress: string, botConfig?: BotConfig) {
    this.cetusClmmSDK = initCetusSDK({ network: "mainnet" });
    this.cetusClmmSDK.senderAddress = senderAddress;

    this.client = new SuiClient({
      url: getFullnodeUrl("mainnet"),
    });

    const aggregatorURL = "https://api-sui.cetus.zone/router_v2/find_routes";
    this.swapClient = new AggregatorClient(
      aggregatorURL,
      senderAddress,
      this.client,
      Env.Mainnet
    );

    this.botConfig = botConfig ?? null;
  }

  public async setPoolInfo(poolId: string) {
    const pool = await this.cetusClmmSDK.Pool.getPool(poolId);
    const coinA = await this.client.getCoinMetadata({
      coinType: pool.coinTypeA,
    });
    const coinB = await this.client.getCoinMetadata({
      coinType: pool.coinTypeB,
    });

    if (!pool || !coinA || !coinB)
      throw new Error("Failed to set pool config.");

    this.poolInfo = {
      ...pool,
      coinA,
      coinB,
    };
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
          this.poolInfo.coinA.decimals,
          this.poolInfo.coinB.decimals
        ).toString(),
        tick,
      });
    }

    // Sort ticks
    return ticks.sort((a, b) => a.tick - b.tick);
  }

  /**
   * Get pool ticks for the class pool
   * @returns Promise with array of pool ticks
   */
  public async getPoolTicks(): Promise<PoolTick[]> {
    const poller = pollers.get(this.poolInfo.poolAddress);
    if (!poller) throw new Error(`No poller for ${this.poolInfo.poolAddress}`);
    const poolPrice = poller.getLatestData().price;
    const currentTick = TickMath.priceToTickIndex(
      poolPrice,
      this.poolInfo.coinA.decimals,
      this.poolInfo.coinB.decimals
    );
    return this.generatePoolTicks(
      currentTick,
      parseInt(this.poolInfo.tickSpacing)
    );
  }

  /**
   * Get pool information for specific pools
   * @param Pool addresses
   * @returns Promise with pool info
   */
  public async getPoolInfo(poolId: string): Promise<PoolInfo> {
    const pool = await this.cetusClmmSDK.Pool.getPool(poolId);
    const coinA = await this.client.getCoinMetadata({
      coinType: pool.coinTypeA,
    });
    const coinB = await this.client.getCoinMetadata({
      coinType: pool.coinTypeB,
    });

    if (!coinA || !coinB) throw new Error("Failed to fetch coin metadata");

    return {
      ...pool,
      coinA,
      coinB,
    };
  }

  /**
   * Get pool price for a specific pool
   * @param poolAddress
   * @returns Promise with pool price
   */
  public async getPoolPrice(poolId?: string): Promise<Decimal> {
    try {
      const pool = await this.cetusClmmSDK.Pool.getPool(
        poolId ?? this.poolInfo.poolAddress
      );
      return TickMath.sqrtPriceX64ToPrice(
        new BN(pool.current_sqrt_price),
        this.poolInfo.coinA.decimals,
        this.poolInfo.coinB.decimals
      );
    } catch (error) {
      throw error;
    }

    throw new Error(`Failed to fetch price for ${poolId}`);
  }

  /**
   * Get user positions
   * @param userAddress The user address to get positions for
   * @returns Promise of current user position
   */
  public async getUserPositions(
    userAddress?: string
  ): Promise<UserPosition[] | null> {
    const positions =
      (
        await this.cetusClmmSDK.Position.getPositionList(
          userAddress ?? this.botConfig?.sender!,
          [this.poolInfo.poolAddress],
          false
        )
      ).filter((position) => position.pool === this.poolInfo.poolAddress) ??
      null;

    if (positions) {
      positions.forEach((position) =>
        logger.log(this.botConfig?.botId ?? "bot", serialize(position))
      );

      return positions.map((position) => ({
        owner: position.owner,
        pool_id: position.pool,
        position_id: position.pos_object_id,
        lower_tick: position.tick_lower_index,
        upper_tick: position.tick_upper_index,
        lower_price: new Decimal(
          TickMath.tickIndexToPrice(
            position.tick_lower_index,
            this.poolInfo.coinA.decimals,
            this.poolInfo.coinB.decimals
          )
        ),
        upper_price: new Decimal(
          TickMath.tickIndexToPrice(
            position.tick_upper_index,
            this.poolInfo.coinA.decimals,
            this.poolInfo.coinB.decimals
          )
        ),
        fee_rate: this.poolInfo.fee_rate,
        botId: this.botConfig?.botId!,
      }));
    } else return null;
  }

  async execute(sender: string, txn: Transaction): Promise<string> {
    let digest = "";
    if (localSigner) {
      const privateKey = localWallets[sender].privateKey;
      const signer = validateAndCreateKeypair(privateKey);
      const suiResponse = await this.cetusClmmSDK.fullClient.sendTransaction(
        signer,
        txn
      );
      digest = (suiResponse as SuiTransactionBlockResponse).digest;
    } else {
      digest = await fordefi.execute(this.botConfig?.botId ?? "bot", txn, {
        sender,
        chain: "sui",
      });
    }
    return digest;
  }

  async collectFeeAndRewards(sender: string, posID: string) {
    logger.log(this.botConfig?.botId, "Collecting fees.");
    const collectFeeTransactionPayload =
      await this.cetusClmmSDK.Position.collectFeeTransactionPayload({
        pool_id: this.poolInfo.poolAddress,
        coinTypeA: this.poolInfo.coinTypeA,
        coinTypeB: this.poolInfo.coinTypeB,
        pos_id: posID,
      });

    const collectFeeDigest = await this.execute(
      sender,
      collectFeeTransactionPayload
    );

    const {
      transactionData: collectFeeTransactionData,
      success: collectFeeSuccess,
    } = await getTransactionData(
      this.client,
      this.botConfig?.botId ?? "bot",
      collectFeeDigest
    );

    if (!collectFeeSuccess) {
      throw new Error("Collect fee transaction failed");
    }

    const fees = getBalances(
      collectFeeTransactionData,
      this.poolInfo.coinTypeA,
      this.poolInfo.coinTypeB,
      this.poolInfo.coinA.decimals,
      this.poolInfo.coinB.decimals
    );
    logger.log(this.botConfig?.botId, "Collected fees.");
    await memory.createMemoryEntry(
      this.botConfig?.botId ?? "bot",
      this.botConfig?.strategy === StrategyType.CHASER ? "chaser" : "inrange",
      "collect",
      fees,
      new Decimal(0),
      fees.digest
    );

    logger.log(this.botConfig?.botId, "Collecting rewards");
    const rewards: RewarderAmountOwed[] =
      await this.cetusClmmSDK.Rewarder.fetchPositionRewarders(
        this.poolInfo,
        posID
      );

    if (!rewards || rewards.length === 0) {
      logger.log(this.botConfig?.botId, "No rewards to collect");
      return;
    }
    const collectRewarderParams: CollectRewarderParams = {
      pool_id: this.poolInfo.poolAddress,
      pos_id: posID,
      rewarder_coin_types: [
        ...rewards
          .filter((item) => Number(item.amount_owed) > 0)
          .map((item) => item.coin_address),
      ],
      coinTypeA: this.poolInfo.coinTypeA,
      coinTypeB: this.poolInfo.coinTypeB,
      collect_fee: false,
    };
    const collectRewarderPayload =
      await this.cetusClmmSDK.Rewarder.collectRewarderTransactionPayload(
        collectRewarderParams
      );

    const collectRewardsDigest = await this.execute(
      sender,
      collectRewarderPayload
    );

    const {
      transactionData: collectRewardsTransactionData,
      success: collectRewardsSuccess,
    } = await getTransactionData(
      this.client,
      this.botConfig?.botId ?? "bot",
      collectRewardsDigest
    );

    if (!collectRewardsSuccess) {
      throw new Error("Collect rewards transaction failed");
    }

    const rewardsBalances = getBalances(
      collectRewardsTransactionData,
      this.poolInfo.coinTypeA,
      this.poolInfo.coinTypeB,
      this.poolInfo.coinA.decimals,
      this.poolInfo.coinB.decimals
    );
    logger.log(this.botConfig?.botId, "Collected rewards.");
    await memory.createMemoryEntry(
      this.botConfig?.botId ?? "bot",
      this.botConfig?.strategy === StrategyType.CHASER ? "chaser" : "inrange",
      "collect",
      rewardsBalances,
      new Decimal(0),
      rewardsBalances.digest
    );
  }

  async closePosition(
    sender: string,
    posID: string
  ): Promise<PositionBalances> {
    let retries = 0;
    while (retries < maxRetries) {
      try {
        await this.collectFeeAndRewards(sender, posID);
        logger.log(this.botConfig?.botId, "Closing position");
        const pool = await this.cetusClmmSDK.Pool.getPool(
          this.poolInfo.poolAddress
        );
        const position = await this.cetusClmmSDK.Position.getPositionById(
          posID
        );
        const lowerSqrtPrice = TickMath.tickIndexToSqrtPriceX64(
          position.tick_lower_index
        );
        const upperSqrtPrice = TickMath.tickIndexToSqrtPriceX64(
          position.tick_upper_index
        );
        // input liquidity amount for remove
        const liquidity = new BN(position.liquidity);
        // slippage value
        const slippageTolerance = new Percentage(
          new BN((this.botConfig?.slippage ?? 0.1) * 1000),
          new BN(100000)
        );
        const curSqrtPrice = new BN(pool.current_sqrt_price);
        // Get token amount from liquidity.
        const coinAmounts = ClmmPoolUtil.getCoinAmountFromLiquidity(
          liquidity,
          curSqrtPrice,
          lowerSqrtPrice,
          upperSqrtPrice,
          false
        );
        // adjust  token a and token b amount for slippage
        const { tokenMaxA, tokenMaxB } = adjustForCoinSlippage(
          coinAmounts,
          slippageTolerance,
          false
        );

        const closePositionTransactionPayload =
          await this.cetusClmmSDK.Position.closePositionTransactionPayload({
            coinTypeA: pool.coinTypeA,
            coinTypeB: pool.coinTypeB,
            min_amount_a: tokenMaxA.toString(),
            min_amount_b: tokenMaxB.toString(),
            rewarder_coin_types: [],
            collect_fee: false,
            pool_id: pool.poolAddress,
            pos_id: posID,
          });

        const closeDigest = await this.execute(
          sender,
          closePositionTransactionPayload
        );

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
          pool.coinTypeA,
          pool.coinTypeB,
          this.poolInfo.coinA.decimals,
          this.poolInfo.coinB.decimals
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
    amount: number,
    lowerTick: number,
    upperTick: number,
    fix_amount_a: boolean
  ): Promise<PositionBalances> {
    let retries = 0;

    while (retries < maxRetries) {
      try {
        const pool = await this.cetusClmmSDK.Pool.getPool(
          this.poolInfo.poolAddress
        );
        const coinAmount = new BN(
          new Decimal(amount)
            .mul(
              10 **
                (fix_amount_a
                  ? this.poolInfo.coinA.decimals
                  : this.poolInfo.coinB.decimals)
            )
            .toFixed(0)
        );

        const curSqrtPrice = new BN(pool.current_sqrt_price);
        const slippage = this.botConfig?.slippage ?? 0.1;

        const liquidityInput =
          ClmmPoolUtil.estLiquidityAndcoinAmountFromOneAmounts(
            lowerTick,
            upperTick,
            coinAmount,
            fix_amount_a,
            true,
            slippage,
            curSqrtPrice
          );

        const amount_a = fix_amount_a
          ? coinAmount.toNumber()
          : liquidityInput.tokenMaxA.toNumber();
        const amount_b = fix_amount_a
          ? liquidityInput.tokenMaxB.toNumber()
          : coinAmount.toNumber();

        // console.log("amount: ", { amount_a, amount_b });

        const addLiquidityPayloadParams: AddLiquidityFixTokenParams = {
          coinTypeA: pool.coinTypeA,
          coinTypeB: pool.coinTypeB,
          pool_id: pool.poolAddress,
          tick_lower: lowerTick.toString(),
          tick_upper: upperTick.toString(),
          fix_amount_a,
          amount_a,
          amount_b,
          slippage,
          is_open: true,
          rewarder_coin_types: [],
          collect_fee: false,
          pos_id: "",
        };
        const createAddLiquidityTransactionPayload =
          await this.cetusClmmSDK.Position.createAddLiquidityFixTokenPayload(
            addLiquidityPayloadParams,
            {
              slippage: slippage,
              curSqrtPrice: curSqrtPrice,
            }
          );

        await openPositionAlert(
          this.botConfig?.botId ?? "bot",
          "cetus",
          liquidityInput,
          lowerTick,
          upperTick,
          this.poolInfo.coinA,
          this.poolInfo.coinB
        );
        const digest = await this.execute(
          sender,
          createAddLiquidityTransactionPayload
        );

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
          pool.coinTypeA,
          pool.coinTypeB,
          this.poolInfo.coinA.decimals,
          this.poolInfo.coinB.decimals
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

  /**
   * Executes a token swap transaction using the provided signer.
   *
   * @returns Promise<PositionBalances> - Returns swapped amounts for from(coinA) and target(coinB)
   */
  async swap(
    sender: string,
    swapAmount: Decimal,
    slippage: number,
    from: string,
    target: string
  ): Promise<PositionBalances> {
    let retries = 0;

    while (retries < maxRetries) {
      try {
        console.log(`Swap attempt ${retries + 1}`);
        const fromMeta = await this.client.getCoinMetadata({
          coinType: from,
        });
        const targetMeta = await this.client.getCoinMetadata({
          coinType: target,
        });

        if (!fromMeta || !targetMeta) {
          throw new Error("Failed to get coin metadata for swap!");
        }
        const amount = new BN(
          swapAmount.mul(10 ** fromMeta.decimals).toFixed(0)
        );

        const routers = await this.swapClient.findRouters({
          from,
          target,
          amount,
          byAmountIn: true, // true means fix input amount, false means fix output amount
        });

        const txb = new Transaction();

        if (routers != null) {
          await this.swapClient.fastRouterSwap({
            routers,
            txb,
            slippage,
          });

          const result = await this.client.devInspectTransactionBlock({
            sender,
            transactionBlock: txb,
          });

          if (result.effects.status.status === "success") {
            const digest = await this.execute(sender, txb);

            const { transactionData, success } = await getTransactionData(
              this.client,
              this.botConfig?.botId ?? "bot",
              digest
            );

            if (!success) {
              throw new Error("Swap transaction failed");
            }

            const positionBalances = getBalances(
              transactionData,
              from,
              target,
              fromMeta.decimals,
              targetMeta.decimals
            );

            logger.log(
              this.botConfig?.botId,
              `Swapped ${positionBalances.coinA.amount} ${fromMeta?.symbol} to ${positionBalances.coinB.amount} ${targetMeta?.symbol}`
            );

            return positionBalances;
          } else {
            throw new Error("Simulation failed");
          }
        } else {
          throw new Error("No routers found");
        }
      } catch (error) {
        retries++;

        if (retries < maxRetries) {
          logger.log(
            this.botConfig?.botId,
            `Attempt ${retries} failed: ${error}. Retrying in ${
              wait ** retries
            }...`
          );
          await sleep(wait ** retries * 1000);
          continue;
        }
        logger.log(
          this.botConfig?.botId,
          `Failed to swap after ${maxRetries} attempts: `,
          error
        );
        throw error;
      }
    }

    throw new Error("Swap failed");
  }
}
