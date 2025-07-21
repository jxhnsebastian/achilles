import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import {
  SuiClient,
  getFullnodeUrl,
} from "@mysten/sui/client";
import * as classes_1 from "@firefly-exchange/library-sui/dist/src/classes";
import { bcs } from "@mysten/sui/bcs";
import BN from "bn.js";
import { mainnet as config } from "../sui/config";

function asUintN(int: any, bits = 32) {
  return BigInt.asUintN(bits, BigInt(int)).toString();
}

const suiClient = new SuiClient({
  url: getFullnodeUrl("mainnet"),
});

interface SuiPoolObject {
  data?: {
    content?: {
      fields?: {
        reward_infos: Array<{
          fields: {
            reward_coin_type: string;
            reward_coin_symbol: string;
            reward_coin_decimals: number;
          };
        }>;
      };
    };
  };
}

function _openPositionInternal(
  pool: any,
  lowerTick: any,
  upperTick: any,
  options: any
) {
  const txb = options.txb;
  const tickLowerBits = Number(asUintN(BigInt(lowerTick)).toString());
  const tickUpperBits = Number(asUintN(BigInt(upperTick)).toString());
  const [position] = txb.moveCall({
    arguments: [
      txb.object(config.GlobalConfig),
      txb.object(pool.id),
      txb.pure.u32(tickLowerBits),
      txb.pure.u32(tickUpperBits),
    ],
    target: `${config.CurrentPackage}::pool::open_position`,
    typeArguments: [pool.coin_a.address, pool.coin_b.address],
  });
  return { txb, position };
}

async function _provideLiquidityFixedAmountInternal(
  pool: any,
  position: any,
  liquidityInput: any,
  options: any,
  senderAddress: string
) {
  const txb = options.txb;
  // Use the input amount of the fixed token rather than max amount
  // else you may run into issues like user might not have more fixed tokens
  // in their wallet for instance when a user provides the max coin A or max coin B
  // liquidity.
  const [amountAMax, amountBMax] = liquidityInput.fix_amount_a
    ? [liquidityInput.coinAmount, liquidityInput.tokenMaxB]
    : [liquidityInput.tokenMaxA, liquidityInput.coinAmount];
  const amount = liquidityInput.coinAmount;
  const [splitCoinA, mergeCoinA] =
    await classes_1.CoinUtils.createCoinWithBalance(
      suiClient,
      txb,
      amountAMax.toString(),
      pool.coin_a.address,
      senderAddress
    );
  const [splitCoinB, mergeCoinB] =
    await classes_1.CoinUtils.createCoinWithBalance(
      suiClient,
      txb,
      amountBMax.toString(),
      pool.coin_b.address,
      senderAddress
    );
  txb.moveCall({
    arguments: [
      txb.object(SUI_CLOCK_OBJECT_ID),
      txb.object(config.GlobalConfig),
      txb.object(pool.id),
      txb.object(position),
      txb.object(splitCoinA),
      txb.object(splitCoinB),
      txb.pure.u64(amount.toString()),
      txb.pure.u64(amountAMax.toString()),
      txb.pure.u64(amountBMax.toString()),
      txb.pure.bool(liquidityInput.fix_amount_a),
    ],
    target: `${config.CurrentPackage}::gateway::provide_liquidity_with_fixed_amount`,
    typeArguments: [pool.coin_a.address, pool.coin_b.address],
  });
  // merge the remaining coins and send them all back to user
  const coins: any[] = [];
  [mergeCoinA, mergeCoinB].forEach((item) => {
    if (item) {
      coins.push(item);
    }
  });
  if (coins.length > 0) {
    txb.transferObjects(coins, senderAddress);
  }
  return txb;
}

async function _collectRewardInternal(
  pool: any,
  position: any,
  options: any,
  senderAddress: string
) {
  const txb = options.txb;
  let rewardCoinsType = options.rewardCoinsType;
  // if reward coins types are not explicitly supplied then find reward coins in Pool from chain
  if (
    !rewardCoinsType ||
    (rewardCoinsType === null || rewardCoinsType === void 0
      ? void 0
      : rewardCoinsType.length) == 0
  ) {
    const rewardCoinsInPool = await getRewardCoinsInPool(pool);
    rewardCoinsType = rewardCoinsInPool.map(
      (rewardCoin) => rewardCoin.coinType
    );
  }
  const claimableRewardTypes = [];
  // check for which reward types , a position has non zero rewards (zero rewards are not claimable on chain)
  for (const rewardCoinType of rewardCoinsType) {
    const tempTx = new Transaction();
    tempTx.moveCall({
      arguments: [
        tempTx.object(SUI_CLOCK_OBJECT_ID),
        tempTx.object(pool.id),
        tempTx.object(position),
      ],
      target: `${config.CurrentPackage}::pool::get_accrued_rewards`,
      typeArguments: [pool.coin_a.address, pool.coin_b.address, rewardCoinType],
    });
    const inspectResult = await suiClient.devInspectTransactionBlock({
      transactionBlock: tempTx,
      sender: senderAddress,
    });
    const rewards = new BN(
      bcs.U64.parse(
        Uint8Array.from(
          inspectResult.results?.[0]?.returnValues?.[0]?.[0] ?? []
        )
      )
    );
    if (!rewards.isZero()) claimableRewardTypes.push(rewardCoinType);
  }
  // only include claim call for claimable rewards
  for (const rewardCoinType of claimableRewardTypes) {
    txb.moveCall({
      arguments: [
        txb.object(SUI_CLOCK_OBJECT_ID),
        txb.object(config.GlobalConfig),
        txb.object(pool.id),
        txb.object(position),
      ],
      target: `${config.CurrentPackage}::gateway::collect_reward`,
      typeArguments: [pool.coin_a.address, pool.coin_b.address, rewardCoinType],
    });
  }
  return txb;
}

async function _collectFeeInternal(pool: any, position: any, options: any) {
  const txb = options.txb;
  txb.moveCall({
    arguments: [
      txb.object(SUI_CLOCK_OBJECT_ID),
      txb.object(config.GlobalConfig),
      txb.object(pool.id),
      txb.object(position),
    ],
    target: `${config.CurrentPackage}::gateway::collect_fee`,
    typeArguments: [pool.coin_a.address, pool.coin_b.address],
  });
  return txb;
}

async function getRewardCoinsInPool(pool: any) {
  const poolObject = (await suiClient.getObject({
    id: pool.id,
    options: { showContent: true },
  })) as SuiPoolObject;
  const fields = poolObject.data?.content?.fields;
  const rewardInfos = fields?.reward_infos.map(
    (reward_infos: any) => reward_infos.fields
  );
  const availableRewardCoinsInPool = [];
  for (const rewardInfo of rewardInfos!) {
    // Temporary fix: Do not include rewards with type of blue coin
    // this is to cater the pools which have been assigned blue coin which we can not give to users.
    if (rewardInfo.reward_coin_type != config.BLUE_COIN_TYPE) {
      const rewardCoin = {
        coinType: rewardInfo.reward_coin_type,
        coinSymbol: rewardInfo.reward_coin_symbol,
        coinDecimals: rewardInfo.reward_coin_decimals,
      };
      availableRewardCoinsInPool.push(rewardCoin);
    }
  }
  return availableRewardCoinsInPool;
}

export async function collectFeeAndRewards(
  pool: any,
  position: any,
  senderAddress: string,
  options?: any
): Promise<Transaction> {
  let txb = options?.txb ?? new Transaction();
  txb = await _collectFeeInternal(pool, position, { txb: txb });
  txb = await _collectRewardInternal(
    pool,
    position,
    {
      txb: txb,
    },
    senderAddress
  );
  return txb;
}

export async function closePosition(
  pool: any,
  position: any,
  senderAddress: string
) {
  let txb = new Transaction();
  txb = await _collectRewardInternal(
    pool,
    position,
    { txb: txb },
    senderAddress
  );

  txb.moveCall({
    arguments: [
      txb.object(SUI_CLOCK_OBJECT_ID),
      txb.object(config.GlobalConfig),
      txb.object(pool.id),
      txb.object(position),
      txb.pure.address(senderAddress),
    ],
    target: `${config.CurrentPackage}::gateway::close_position`,
    typeArguments: [pool.coin_a.address, pool.coin_b.address],
  });
  return txb;
}

export async function openPositionWithFixedAmount(
  pool: any,
  lowerTick: any,
  upperTick: any,
  params: any,
  senderAddress: string
): Promise<Transaction> {
  let txb = new Transaction();
  const result = _openPositionInternal(pool, lowerTick, upperTick, {
    txb,
  });
  txb = result.txb;
  const position = result.position;
  txb = await _provideLiquidityFixedAmountInternal(
    pool,
    position,
    params,
    {
      txb,
    },
    senderAddress
  );

  txb.transferObjects([position], senderAddress);
  return txb;
}
