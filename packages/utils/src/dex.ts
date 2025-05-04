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
    throw new Error("Failed to set pool config.");

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
  if (!poolInfo) throw new Error("Failed to set pool config.");

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
