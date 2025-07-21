import {
  Connection,
  PublicKey,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import {
  StrategyType,
  type BotConfig,
  type PoolTick,
  type PositionBalances,
  type UserPosition,
} from "@achilles/utils";
import logger from "../logger";
import { maxRetries, serialize, sleep, wait } from "@achilles/utils";
import { openPositionAlert } from "../helpers";
import {
  getTransactionPriorityAndComputeUnits,
  executeVersionedTransaction,
} from "./utils";
import { getBalances } from "./parser";
// import memory_local from "../memory_local";
import Decimal from "decimal.js";
import { memory } from "../utils";
import {
  Raydium as RaydiumSDK,
  TxVersion,
  parseTokenAccountResp,
  type ApiV3PoolInfoConcentratedItem,
  TickUtils,
  type ClmmPositionLayout,
  getTransferAmountFeeV2,
  PositionUtils,
  PoolUtils,
  type RaydiumLoadParams,
  type ApiV3PoolInfoItem,
  type ClmmKeys,
  type ComputeClmmPoolInfo,
  type ReturnTypeFetchMultiplePoolTickArrays,
  type OpenPositionFromBase,
  type DecreaseLiquidity,
} from "@raydium-io/raydium-sdk-v2";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { BN } from "bn.js";
import { pollers } from "../poller/server";

export class Raydium {
  private RPC = process.env.RPC!;
  private connection = new Connection(this.RPC, "confirmed");
  public poolInfo: ApiV3PoolInfoConcentratedItem =
    {} as ApiV3PoolInfoConcentratedItem;
  public botConfig: BotConfig | null;
  public raydium: RaydiumSDK | undefined;

  constructor(botConfig?: BotConfig) {
    this.botConfig = botConfig ?? null;
  }

  initSdk = async () => {
    const loadParams: RaydiumLoadParams = {
      connection: this.connection,
      cluster: "mainnet",
      disableFeatureCheck: true,
      disableLoadToken: false,
      blockhashCommitment: "finalized",
    };
    if (this.botConfig?.sender) {
      loadParams.owner = new PublicKey(this.botConfig?.sender);
      const tokens = await this.fetchTokenAccountData(this.botConfig.sender);
      loadParams.tokenAccounts = tokens.tokenAccounts;
      loadParams.tokenAccountRawInfos = tokens.tokenAccountRawInfos;
    }
    this.raydium = await RaydiumSDK.load(loadParams);
  };

  public fetchTokenAccountData = async (user: string) => {
    const owner = new PublicKey(user);
    const solAccountResp = await this.connection.getAccountInfo(owner);
    const tokenAccountResp = await this.connection.getTokenAccountsByOwner(
      owner,
      { programId: TOKEN_PROGRAM_ID }
    );
    const token2022Req = await this.connection.getTokenAccountsByOwner(owner, {
      programId: TOKEN_2022_PROGRAM_ID,
    });
    const tokenAccountData = parseTokenAccountResp({
      owner: owner,
      solAccountResp,
      tokenAccountResp: {
        context: tokenAccountResp.context,
        value: [...tokenAccountResp.value, ...token2022Req.value],
      },
    });
    return tokenAccountData;
  };

  public async setPoolInfo(poolAddress: string) {
    if (!this.raydium) await this.initSdk();
    const poolInfo = (await this.raydium!.clmm.getPoolInfoFromRpc(poolAddress))
      .poolInfo;
    if (!poolInfo) throw new Error("Failed to set pool config.");
    this.poolInfo = {
      ...poolInfo,
    };
  }

  public async getPoolPrice(poolId?: string): Promise<Decimal> {
    try {
      const rpcData = await this.raydium!.clmm.getRpcClmmPoolInfo({
        poolId: poolId ?? this.poolInfo.id,
      });
      return new Decimal(rpcData.currentPrice);
    } catch (error) {
      throw error;
    }

    throw new Error(`Failed to fetch price for ${poolId}`);
  }

  public async getUserPositions(
    poolId?: string
  ): Promise<UserPosition[] | null> {
    this.raydium!.account.updateTokenAccount(
      await this.fetchTokenAccountData(this.botConfig?.sender!)
    );
    const positions = await this.raydium!.clmm.getOwnerPositionInfo({
      programId: this.poolInfo.programId,
    });
    const userPositions: UserPosition[] = [];

    const pool = poolId ?? this.botConfig?.poolId;

    for (const position of positions) {
      if (position.poolId.toString() === pool) {
        userPositions.push({
          owner: this.botConfig?.sender!,
          pool_id: position.poolId.toString(),
          position_id: position.nftMint.toString(),
          lower_tick: position.tickLower,
          upper_tick: position.tickUpper,
          lower_price: TickUtils.getTickPrice({
            poolInfo: this.poolInfo,
            tick: position.tickLower,
            baseIn: true,
          }).price,
          upper_price: TickUtils.getTickPrice({
            poolInfo: this.poolInfo,
            tick: position.tickUpper,
            baseIn: true,
          }).price,
          fee_rate: this.poolInfo.feeRate,
          botId: this.botConfig?.botId!,
        });
      }
    }
    userPositions.forEach((position) =>
      logger.log(this.botConfig?.botId ?? "bot", serialize(position))
    );
    return userPositions.length > 0 ? userPositions : null;
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
        price: TickUtils.getTickPrice({
          poolInfo: this.poolInfo,
          tick,
          baseIn: true,
        }).price.toString(),
        tick,
      });
    }

    // Sort ticks
    return ticks.sort((a, b) => a.tick - b.tick);
  }

  public async getPoolTicks(): Promise<PoolTick[]> {
    const poller = pollers.get(this.poolInfo.id);
    if (!poller) throw new Error(`No poller for ${this.poolInfo.id}`);
    const poolPrice = poller.getLatestData().price;
    const currentTick = TickUtils.getPriceAndTick({
      poolInfo: this.poolInfo,
      price: poolPrice,
      baseIn: true,
    });
    return this.generatePoolTicks(
      currentTick.tick,
      this.poolInfo.config.tickSpacing
    );
  }

  getPriceAndAmount = async ({
    poolInfo,
    position,
  }: {
    poolInfo: ApiV3PoolInfoConcentratedItem;
    position: ClmmPositionLayout;
  }) => {
    const priceLower = TickUtils.getTickPrice({
      poolInfo,
      tick: position.tickLower,
      baseIn: true,
    });
    const priceUpper = TickUtils.getTickPrice({
      poolInfo,
      tick: position.tickUpper,
      baseIn: true,
    });

    const epochInfo = await this.connection.getEpochInfo();
    const { amountA, amountB, amountSlippageA, amountSlippageB } =
      PositionUtils.getAmountsFromLiquidity({
        poolInfo,
        ownerPosition: position,
        liquidity: position.liquidity,
        slippage: (this.botConfig?.slippage ?? 0.1) / 100,
        add: false,
        epochInfo,
      });
    const [_amountA, _amountB] = [
      new Decimal(amountA.amount.toString()).div(10 ** poolInfo.mintA.decimals),
      new Decimal(amountB.amount.toString()).div(10 ** poolInfo.mintB.decimals),
    ];
    const [_amountSlippageA, _amountSlippageB] = [
      new Decimal(amountSlippageA.amount.toString())
        .sub(amountSlippageA.fee?.toString() ?? 0)
        .div(10 ** poolInfo.mintA.decimals),
      new Decimal(amountSlippageB.amount.toString())
        .sub(amountSlippageB.fee?.toString() ?? 0)
        .div(10 ** poolInfo.mintB.decimals),
    ];

    return {
      priceLower,
      priceUpper,
      amountA: _amountA,
      amountB: _amountB,
      amountSlippageA: _amountSlippageA,
      amountSlippageB: _amountSlippageB,
    };
  };

  async collectFeeAndRewards(
    position: ClmmPositionLayout,
    sender: string,
    pool: ApiV3PoolInfoItem,
    poolData: {
      poolInfo: ApiV3PoolInfoConcentratedItem;
      poolKeys: ClmmKeys;
      computePoolInfo: ComputeClmmPoolInfo;
      tickData: ReturnTypeFetchMultiplePoolTickArrays;
    }
  ) {
    logger.log(this.botConfig?.botId, "Collecting fee and rewards.");

    const [_amountMinA, _amountMinB] = [new BN(0), new BN(0)];

    const epochInfo = await this.connection.getEpochInfo();

    const { fee: feeA = new BN(0) } = getTransferAmountFeeV2(
      _amountMinA,
      pool.mintA.extensions.feeConfig,
      epochInfo!,
      false
    );
    const { fee: feeB = new BN(0) } = getTransferAmountFeeV2(
      _amountMinB,
      pool.mintB.extensions.feeConfig,
      epochInfo!,
      false
    );

    const rpcData = await this.raydium!.clmm.getRpcClmmPoolInfo({
      poolId: this.poolInfo.id,
    });
    pool.price = rpcData.currentPrice;

    const closePositionConfig: DecreaseLiquidity<TxVersion.V0> = {
      poolInfo: {
        ...pool,
        config: poolData.poolInfo.config,
        type: "Concentrated",
      },
      poolKeys: poolData.poolKeys,
      ownerPosition: position,
      ownerInfo: {
        useSOLBalance: true,
        closePosition: false,
      },
      liquidity: new BN(0),
      amountMinA: _amountMinA.sub(feeA),
      amountMinB: _amountMinB.sub(feeB),
      txVersion: TxVersion.V0,
      feePayer: new PublicKey(sender),
      associatedOnly: true,
      checkCreateATAOwner: true,
    };

    const { transaction: getFeeTransaction } =
      await this.raydium!.clmm.decreaseLiquidity(closePositionConfig);

    const priorityFee = await getTransactionPriorityAndComputeUnits(
      this.RPC,
      Buffer.from(getFeeTransaction.serialize()).toString("base64")
    );

    const { transaction } = await this.raydium!.clmm.decreaseLiquidity({
      ...closePositionConfig,
      computeBudgetConfig: {
        // units: 700_000,
        microLamports: priorityFee,
      },
    });

    const signature = await executeVersionedTransaction(
      transaction,
      this.connection,
      sender,
      this.botConfig?.botId
    );

    this.raydium!.account.updateTokenAccount(
      await this.fetchTokenAccountData(this.botConfig?.sender!)
    );
    let transactionData: ParsedTransactionWithMeta | null = null;
    while (!transactionData) {
      transactionData = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
    }

    const balances = getBalances(
      transactionData,
      transactionData.transaction.signatures[0],
      this.poolInfo.mintA.address,
      this.poolInfo.mintB.address,
      sender
    );

    logger.log(this.botConfig?.botId, "Collected fee and rewards.");
    await memory.createMemoryEntry(
      this.botConfig?.botId ?? "bot",
      this.botConfig?.strategy === StrategyType.CHASER ? "chaser" : "inrange",
      "collect",
      balances,
      new Decimal(0),
      balances.digest
    );

    return balances;
  }

  async closePosition(
    positionId: string,
    sender: string,
    collectFee?: boolean
  ): Promise<PositionBalances> {
    let retries = 0;
    while (retries < maxRetries) {
      try {
        const positions = await this.raydium!.clmm.getOwnerPositionInfo({
          programId: this.poolInfo.programId,
        });

        const position = positions.find(
          (pos) => pos.nftMint.toString() === positionId
        );

        if (!position) throw new Error(`Position ${position} not found`);

        const pools = await this.raydium!.api.fetchPoolById({
          ids: this.poolInfo.id,
        });
        const data = await this.raydium!.clmm.getPoolInfoFromRpc(
          this.poolInfo.id
        );

        if (!pools || !pools.length || !data.poolInfo || !data.poolKeys)
          throw new Error("Failed to fetch pool data!");

        const pool = pools[0];

        await this.collectFeeAndRewards(position, sender, pool, data);

        if (collectFee) return {} as PositionBalances;

        const { amountSlippageA, amountSlippageB } =
          await this.getPriceAndAmount({
            poolInfo: data.poolInfo,
            position,
          });

        const [positionAmountA, positionAmountB] = [
          amountSlippageA
            .toDecimalPlaces(this.poolInfo.mintA.decimals, Decimal.ROUND_FLOOR)
            .toString(),
          amountSlippageB
            .toDecimalPlaces(this.poolInfo.mintB.decimals, Decimal.ROUND_FLOOR)
            .toString(),
        ];

        const amountMinA = new Decimal(positionAmountA).toString();
        const amountMinB = new Decimal(positionAmountB).toString();

        const slippage = (this.botConfig?.slippage ?? 0.1) / 100;

        const [_amountMinA, _amountMinB] = [
          new BN(
            new Decimal(amountMinA.toString())
              .mul(1 - slippage)
              .mul(10 ** this.poolInfo.mintA.decimals)
              .toFixed(0)
          ),
          new BN(
            new Decimal(amountMinB.toString())
              .mul(1 - slippage)
              .mul(10 ** this.poolInfo.mintB.decimals)
              .toFixed(0)
          ),
        ];
        const epochInfo = await this.connection.getEpochInfo();
        const { fee: feeA = new BN(0) } = getTransferAmountFeeV2(
          _amountMinA,
          data.poolInfo.mintA.extensions.feeConfig,
          epochInfo!,
          false
        );
        const { fee: feeB = new BN(0) } = getTransferAmountFeeV2(
          _amountMinB,
          data.poolInfo.mintB.extensions.feeConfig,
          epochInfo!,
          false
        );

        const rpcData = await this.raydium!.clmm.getRpcClmmPoolInfo({
          poolId: this.poolInfo.id,
        });
        pool.price = rpcData.currentPrice;

        const closePositionConfig: DecreaseLiquidity<TxVersion.V0> = {
          poolInfo: {
            ...pool,
            config: data.poolInfo.config,
            type: "Concentrated",
          },
          poolKeys: data.poolKeys,
          ownerPosition: position,
          ownerInfo: {
            useSOLBalance: true,
            closePosition: true,
          },
          liquidity: new BN(position.liquidity),
          amountMinA: _amountMinA.sub(feeA),
          amountMinB: _amountMinB.sub(feeB),
          txVersion: TxVersion.V0,
          feePayer: new PublicKey(sender),
        };

        const { transaction: getFeeTransaction } =
          await this.raydium!.clmm.decreaseLiquidity(closePositionConfig);

        const priorityFee = await getTransactionPriorityAndComputeUnits(
          this.RPC,
          Buffer.from(getFeeTransaction.serialize()).toString("base64")
        );

        const { transaction } = await this.raydium!.clmm.decreaseLiquidity({
          ...closePositionConfig,
          computeBudgetConfig: {
            // units: 700_000,
            microLamports: priorityFee,
          },
        });

        const signature = await executeVersionedTransaction(
          transaction,
          this.connection,
          sender,
          this.botConfig?.botId
        );

        logger.log(this.botConfig?.botId, `Closed position ${positionId}`);
        this.raydium!.account.updateTokenAccount(
          await this.fetchTokenAccountData(this.botConfig?.sender!)
        );
        let transactionData: ParsedTransactionWithMeta | null = null;
        while (!transactionData) {
          transactionData = await this.connection.getParsedTransaction(
            signature,
            {
              maxSupportedTransactionVersion: 0,
            }
          );
        }

        const balances = getBalances(
          transactionData,
          transactionData.transaction.signatures[0],
          this.poolInfo.mintA.address,
          this.poolInfo.mintB.address,
          sender
        );

        return balances;
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

  async openPosition(
    sender: string,
    coinAmount: number,
    lowerTick: number,
    upperTick: number,
    fix_amount_a: boolean
  ): Promise<PositionBalances> {
    let retries = 0;

    while (retries < maxRetries) {
      try {
        const lowerPrice = TickUtils.getTickPrice({
          poolInfo: this.poolInfo,
          tick: lowerTick,
          baseIn: true,
        }).price.toNumber();
        const upperPrice = TickUtils.getTickPrice({
          poolInfo: this.poolInfo,
          tick: upperTick,
          baseIn: true,
        }).price.toNumber();

        logger.log(
          this.botConfig?.botId ?? "bot",
          `${
            fix_amount_a
              ? this.poolInfo.mintA.address
              : this.poolInfo.mintB.address
          } : ${coinAmount} from ${lowerPrice} to ${upperPrice}`
        );

        const epochInfo = await this.connection.getEpochInfo();
        const pools = await this.raydium!.api.fetchPoolById({
          ids: this.poolInfo.id,
        });
        const data = await this.raydium!.clmm.getPoolInfoFromRpc(
          this.poolInfo.id
        );

        if (!pools || !pools.length || !data.poolInfo || !data.poolKeys)
          throw new Error("Failed to fetch pool data!");

        const pool = pools[0];
        const slippage = (this.botConfig?.slippage ?? 0.1) / 100;
        const rpcData = await this.raydium!.clmm.getRpcClmmPoolInfo({
          poolId: this.poolInfo.id,
        });
        pool.price = rpcData.currentPrice;

        const amount = fix_amount_a
          ? new BN(
              new Decimal(coinAmount || "0")
                .mul(10 ** this.poolInfo.mintA.decimals)
                .toFixed(0)
            )
          : new BN(
              new Decimal(coinAmount || "0")
                .mul(10 ** this.poolInfo.mintB.decimals)
                .toFixed(0)
            );

        const res = await PoolUtils.getLiquidityAmountOutFromAmountIn({
          poolInfo: {
            ...pool,
            config: data.poolInfo.config,
            type: "Concentrated",
          },
          slippage,
          inputA: fix_amount_a,
          tickUpper: upperTick,
          tickLower: lowerTick,
          amount,
          add: true,
          amountHasFee: false,
          epochInfo: epochInfo,
        });

        console.log(
          new Decimal(res.amountA.amount.toString()).toFixed(0),
          new Decimal(res.amountB.amount.toString()).toFixed(0)
        );
        console.log(
          new Decimal(res.amountSlippageA.amount.toString()).toFixed(0),
          new Decimal(res.amountSlippageB.amount.toString()).toFixed(0)
        );

        const openPositionConfig: OpenPositionFromBase<TxVersion.V0> = {
          poolInfo: {
            ...pool,
            config: data.poolInfo.config,
            type: "Concentrated",
          },
          poolKeys: data.poolKeys,
          tickUpper: upperTick,
          tickLower: lowerTick,
          base: fix_amount_a ? "MintA" : "MintB",
          ownerInfo: {
            useSOLBalance: true,
          },
          baseAmount: new BN(
            new Decimal(
              fix_amount_a
                ? res.amountA.amount.toString()
                : res.amountB.amount.toString()
            ).toFixed(0)
          ),
          otherAmountMax: new BN(
            new Decimal(
              fix_amount_a
                ? res.amountSlippageB.amount.toString()
                : res.amountSlippageA.amount.toString()
            ).toFixed(0)
          ),
          txVersion: TxVersion.V0,
          feePayer: new PublicKey(sender),
          nft2022: true,
        };

        const { transaction: getFeeTransaction } =
          await this.raydium!.clmm.openPositionFromBase(openPositionConfig);

        const priorityFee = await getTransactionPriorityAndComputeUnits(
          this.RPC,
          Buffer.from(getFeeTransaction.serialize()).toString("base64")
        );

        const { transaction } = await this.raydium!.clmm.openPositionFromBase({
          ...openPositionConfig,
          computeBudgetConfig: {
            // units: 700_000,
            microLamports: priorityFee,
          },
        });

        await openPositionAlert(
          this.botConfig?.botId ?? "bot",
          "raydium",
          res,
          lowerPrice,
          upperPrice,
          this.poolInfo.mintA,
          this.poolInfo.mintB
        );

        const signature = await executeVersionedTransaction(
          transaction,
          this.connection,
          sender,
          this.botConfig?.botId
        );
        logger.log(this.botConfig?.botId, "Position opened.");
        this.raydium!.account.updateTokenAccount(
          await this.fetchTokenAccountData(this.botConfig?.sender!)
        );
        let transactionData: ParsedTransactionWithMeta | null = null;
        while (!transactionData) {
          transactionData = await this.connection.getParsedTransaction(
            signature,
            {
              maxSupportedTransactionVersion: 0,
            }
          );
        }

        const balances = getBalances(
          transactionData,
          transactionData.transaction.signatures[0],
          this.poolInfo.mintA.address,
          this.poolInfo.mintB.address,
          sender
        );

        return balances;
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
