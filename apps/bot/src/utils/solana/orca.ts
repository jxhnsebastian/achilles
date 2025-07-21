import {
  Connection,
  PublicKey,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import {
  setWhirlpoolsConfig,
  setDefaultFunder,
  fetchPositionsForOwner,
  openPositionInstructions,
  harvestPositionInstructions,
  closePositionInstructions,
} from "@orca-so/whirlpools";
import {
  address,
  createKeyPairSignerFromBytes,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  type IInstruction,
  type IAccountLookupMeta,
  type IAccountMeta,
  type Address,
} from "@solana/kit";
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
  buildV2Transaction,
  getKeypairFromPrivateKey,
  getRpc,
  sendAndConfirmV2Transaction,
} from "./utils";
import { getBalances } from "./parser";
import { fetchWhirlpool, type Whirlpool } from "@orca-so/whirlpools-client";
import {
  tickIndexToPrice,
  sqrtPriceToPrice,
  priceToTickIndex,
} from "@orca-so/whirlpools-core";
import { getMint, type Mint } from "@solana/spl-token";
// import memory_local from "../memory_local";
import Decimal from "decimal.js";
import fordefi from "../fordefi/signer";
import { localSigner, memory } from "../utils";
import { pollers } from "../poller/server";
import { localWallets } from "../wallets";

interface PoolInfo extends Whirlpool {
  address: string;
  tokenA: Mint;
  tokenB: Mint;
}

export class Orca {
  private RPC = process.env.RPC!;
  private connection = new Connection(this.RPC, "confirmed");
  private kitRpc = getRpc(process.env.RPC!);
  public poolInfo: PoolInfo = {} as PoolInfo;
  public botConfig: BotConfig | null;

  constructor(botConfig?: BotConfig) {
    this.botConfig = botConfig ?? null;
  }

  public async setPoolInfo(poolAddress: string) {
    const poolInfo = await fetchWhirlpool(
      this.kitRpc.rpc,
      address(poolAddress)
    );

    const tokenA = await getMint(
      this.connection,
      new PublicKey(poolInfo.data.tokenMintA)
    );
    const tokenB = await getMint(
      this.connection,
      new PublicKey(poolInfo.data.tokenMintB)
    );

    if (!poolInfo || !tokenA || !tokenB)
      throw new Error("Failed to set pool config.");

    this.poolInfo = {
      ...poolInfo.data,
      address: poolInfo.address,
      tokenA,
      tokenB,
    };
  }

  public async getPoolPrice(poolId?: string): Promise<Decimal> {
    try {
      const pool = await fetchWhirlpool(
        this.kitRpc.rpc,
        address(poolId ?? this.poolInfo.address)
      );
      const price = new Decimal(
        sqrtPriceToPrice(
          pool.data.sqrtPrice,
          this.poolInfo.tokenA.decimals,
          this.poolInfo.tokenB.decimals
        )
      );
      return price;
    } catch (error) {
      throw error;
    }

    throw new Error(`Failed to fetch price for ${poolId}`);
  }

  public async getUserPositions(
    userAddress?: string,
    poolId?: string
  ): Promise<UserPosition[] | null> {
    const owner = address(userAddress ?? this.botConfig?.sender!);
    const positions = await fetchPositionsForOwner(this.kitRpc.rpc, owner);
    const userPositions: UserPosition[] = [];

    for (const position of positions) {
      if (
        !position.isPositionBundle &&
        position.data.whirlpool === (poolId ?? this.poolInfo.address)
      ) {
        userPositions.push({
          owner: userAddress ?? this.botConfig?.sender!,
          pool_id: position.data.whirlpool,
          position_id: position.data.positionMint,
          lower_tick: position.data.tickLowerIndex,
          upper_tick: position.data.tickUpperIndex,
          lower_price: new Decimal(
            tickIndexToPrice(
              position.data.tickLowerIndex,
              this.poolInfo.tokenA.decimals,
              this.poolInfo.tokenB.decimals
            )
          ),
          upper_price: new Decimal(
            tickIndexToPrice(
              position.data.tickUpperIndex,
              this.poolInfo.tokenA.decimals,
              this.poolInfo.tokenB.decimals
            )
          ),
          fee_rate: this.poolInfo.protocolFeeRate,
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
        price: tickIndexToPrice(
          tick,
          this.poolInfo.tokenA.decimals,
          this.poolInfo.tokenB.decimals
        ).toString(),
        tick,
      });
    }

    // Sort ticks
    return ticks.sort((a, b) => a.tick - b.tick);
  }

  public async getPoolTicks(): Promise<PoolTick[]> {
    const poller = pollers.get(this.poolInfo.address);
    if (!poller) throw new Error(`No poller for ${this.poolInfo.address}`);
    const poolPrice = poller.getLatestData().price;
    const currentTick = priceToTickIndex(
      poolPrice.toNumber(),
      this.poolInfo.tokenA.decimals,
      this.poolInfo.tokenB.decimals
    );
    return this.generatePoolTicks(currentTick, this.poolInfo.tickSpacing);
  }

  async execute(
    sender: string,
    instructions: IInstruction<
      string,
      readonly (IAccountLookupMeta<string, string> | IAccountMeta<string>)[]
    >[]
  ): Promise<string> {
    const { value: latestBlockhash } = await this.kitRpc.rpc
      .getLatestBlockhash()
      .send();

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayer(address(sender), message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, message),
      (message) => appendTransactionMessageInstructions(instructions, message)
    );

    let signature = "";

    if (localSigner) {
      signature = await sendAndConfirmV2Transaction(
        this.RPC,
        this.kitRpc.rpc,
        this.kitRpc.rpcSubscriptions,
        transactionMessage,
        { computeUnits: 200_000 }
      );
    } else {
      const txn = await buildV2Transaction(
        this.RPC,
        this.kitRpc.rpc,
        this.kitRpc.rpcSubscriptions,
        transactionMessage,
        { computeUnits: 200_000 }
      );
      signature = await fordefi.execute(this.botConfig?.botId ?? "bot", txn, {
        sender,
        chain: "solana",
      });
    }

    return signature;
  }

  async collectFeeAndRewards(positionMint: Address, sender: string) {
    logger.log(this.botConfig?.botId, "Collecting fee and rewards.");

    let funder = undefined;
    if (localSigner) {
      const privateKey = localWallets[sender].privateKey;
      const keypair = getKeypairFromPrivateKey(privateKey);
      funder = await createKeyPairSignerFromBytes(keypair.secretKey);
    }
    setDefaultFunder(address(sender));
    await setWhirlpoolsConfig("solanaMainnet");

    const { feesQuote, rewardsQuote, instructions } =
      await harvestPositionInstructions(this.kitRpc.rpc, positionMint, funder);

    const hasFeesToCollect = feesQuote.feeOwedA > 0n || feesQuote.feeOwedB > 0n;
    const hasRewardsToCollect = rewardsQuote.rewards.some(
      (r) => r.rewardsOwed > 0n
    );

    if (!hasFeesToCollect && !hasRewardsToCollect) {
      logger.log(this.botConfig?.botId, "Nothing to harvest.");
      return;
    }
    const signature = await this.execute(sender, instructions);
    let transaction: ParsedTransactionWithMeta | null = null;
    while (!transaction) {
      transaction = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
    }

    const balances = getBalances(
      transaction,
      transaction.transaction.signatures[0],
      this.poolInfo.tokenMintA,
      this.poolInfo.tokenMintB,
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
    positionMint: Address,
    sender: string
  ): Promise<PositionBalances> {
    let retries = 0;
    while (retries < maxRetries) {
      try {
        await this.collectFeeAndRewards(positionMint, sender);

        let funder = undefined;
        if (localSigner) {
          const privateKey = localWallets[sender].privateKey;
          const keypair = getKeypairFromPrivateKey(privateKey);
          funder = await createKeyPairSignerFromBytes(keypair.secretKey);
        }
        setDefaultFunder(address(sender));
        await setWhirlpoolsConfig("solanaMainnet");

        const { instructions } = await closePositionInstructions(
          this.kitRpc.rpc,
          positionMint,
          100,
          funder
        );

        const signature = await this.execute(sender, instructions);

        logger.log(this.botConfig?.botId, `Closed position ${positionMint}`);
        let transaction: ParsedTransactionWithMeta | null = null;
        while (!transaction) {
          transaction = await this.connection.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
          });
        }

        const balances = getBalances(
          transaction,
          transaction.transaction.signatures[0],
          this.poolInfo.tokenMintA,
          this.poolInfo.tokenMintB,
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
    lowerPrice: number,
    upperPrice: number,
    fix_amount_a: boolean,
    slippage: number
  ): Promise<PositionBalances> {
    let retries = 0;

    while (retries < maxRetries) {
      try {
        logger.log(
          this.botConfig?.botId ?? "bot",
          `${
            fix_amount_a ? this.poolInfo.tokenMintA : this.poolInfo.tokenMintB
          } : ${coinAmount} from ${lowerPrice} to ${upperPrice}`
        );

        let funder = undefined;
        if (localSigner) {
          const privateKey = localWallets[sender].privateKey;
          const keypair = getKeypairFromPrivateKey(privateKey);
          funder = await createKeyPairSignerFromBytes(keypair.secretKey);
        }
        setDefaultFunder(address(sender));

        const param = fix_amount_a
          ? {
              tokenA: BigInt(
                new Decimal(coinAmount)
                  .mul(10 ** this.poolInfo.tokenA.decimals)
                  .toFixed(0)
              ),
            }
          : {
              tokenB: BigInt(
                new Decimal(coinAmount)
                  .mul(10 ** this.poolInfo.tokenB.decimals)
                  .toFixed(0)
              ),
            };

        logger.log(this.botConfig?.botId, "Fetching quote.");
        const { quote, instructions } = await openPositionInstructions(
          this.kitRpc.rpc,
          address(this.poolInfo.address),
          param,
          lowerPrice,
          upperPrice,
          slippage,
          funder
        );
        logger.log(this.botConfig?.botId, "Quote fetched.");
        await openPositionAlert(
          this.botConfig?.botId ?? "bot",
          "orca",
          quote,
          lowerPrice,
          upperPrice,
          this.poolInfo.tokenA,
          this.poolInfo.tokenB
        );

        const signature = await this.execute(sender, instructions);
        logger.log(this.botConfig?.botId, "Position opened.");
        let transaction: ParsedTransactionWithMeta | null = null;
        while (!transaction) {
          transaction = await this.connection.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
          });
        }

        const balances = getBalances(
          transaction,
          transaction.transaction.signatures[0],
          this.poolInfo.tokenMintA,
          this.poolInfo.tokenMintB,
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
