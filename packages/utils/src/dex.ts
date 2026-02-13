import {
  createSolanaRpc,
  mainnet,
  createSolanaRpcSubscriptions,
  address,
} from "@solana/kit";
import { fetchWhirlpool } from "@orca-so/whirlpools-client";
import { Connection, PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import {
  RaydiumLoadParams,
  Raydium as RaydiumSDK,
} from "@raydium-io/raydium-sdk-v2";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
// import { QueryChain } from "@firefly-exchange/library-sui/dist/src/spot";
import { initCetusSDK } from "@cetusprotocol/cetus-sui-clmm-sdk";

export const getRpc = (rpcUrl: string) => {
  const endpoint = rpcUrl || "https://api.mainnet-beta.solana.com";
  const wsEndpoint = endpoint
    .replace("https://", "wss://")
    .replace("http://", "ws://");

  return {
    rpc: createSolanaRpc(mainnet(endpoint)),
    rpcSubscriptions: createSolanaRpcSubscriptions(mainnet(wsEndpoint)),
  };
};

export async function getOrcaPoolInfo(poolAddress: string) {
  const kitRpc = getRpc(process.env.RPC!);
  const connection = new Connection(process.env.RPC!, "confirmed");
  const poolInfo = await fetchWhirlpool(kitRpc.rpc, address(poolAddress));

  const tokenA = await getMint(
    connection,
    new PublicKey(poolInfo.data.tokenMintA)
  );
  const tokenB = await getMint(
    connection,
    new PublicKey(poolInfo.data.tokenMintB)
  );

  if (!poolInfo || !tokenA || !tokenB)
    throw new Error("Failed to get pool config.");

  return {
    address: poolInfo.address,
    tickSpacing: poolInfo.data.tickSpacing,
    coinA: {
      address: tokenA.address,
      decimals: tokenA.decimals,
    },
    coinB: {
      address: tokenB.address,
      decimals: tokenB.decimals,
    },
  };
}

export async function getRaydiumPoolInfo(poolAddress: string) {
  const connection = new Connection(process.env.RPC!, "confirmed");
  const loadParams: RaydiumLoadParams = {
    connection: connection,
    cluster: "mainnet",
    disableFeatureCheck: true,
    disableLoadToken: false,
    blockhashCommitment: "finalized",
  };
  const raydium = await RaydiumSDK.load(loadParams);
  const poolInfo = (await raydium.clmm.getPoolInfoFromRpc(poolAddress))
    .poolInfo;
  if (!poolInfo) throw new Error("Failed to get pool config.");

  return {
    address: poolInfo.id,
    tickSpacing: poolInfo.config.tickSpacing,
    coinA: {
      address: poolInfo.mintA.address,
      decimals: poolInfo.mintA.decimals,
    },
    coinB: {
      address: poolInfo.mintB.address,
      decimals: poolInfo.mintB.decimals,
    },
  };
}

export async function getBluefinPoolInfo(poolAddress: string) {
  // const client = new SuiClient({
  //   url: getFullnodeUrl("mainnet"),
  // });
  throw new Error("Failed to get pool config.");
  // const qc = new QueryChain(client);

  // const pool = await qc.getPool(poolAddress);
  // if (!pool) throw new Error("Failed to get pool config.");

  // return {
  //   address: pool.id,
  //   tickSpacing: pool.ticks_manager.tick_spacing,
  //   coinA: {
  //     address: pool.coin_a.address,
  //     decimals: pool.coin_a.decimals,
  //   },
  //   coinB: {
  //     address: pool.coin_b.address,
  //     decimals: pool.coin_b.decimals,
  //   },
  // };
}

export async function getCetusPoolInfo(poolAddress: string) {
  const cetusClmmSDK = initCetusSDK({ network: "mainnet" });
  const client = new SuiClient({
    url: getFullnodeUrl("mainnet"),
  });

  const pool = await cetusClmmSDK.Pool.getPool(poolAddress);
  const coinA = await client.getCoinMetadata({
    coinType: pool.coinTypeA,
  });
  const coinB = await client.getCoinMetadata({
    coinType: pool.coinTypeB,
  });

  if (!pool || !coinA || !coinB) throw new Error("Failed to get pool config.");

  return {
    address: pool.poolAddress,
    tickSpacing: pool.tickSpacing,
    coinA: {
      address: pool.coinTypeA,
      decimals: coinA.decimals,
    },
    coinB: {
      address: pool.coinTypeB,
      decimals: coinB.decimals,
    },
  };
}
