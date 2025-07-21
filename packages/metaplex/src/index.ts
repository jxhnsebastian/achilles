import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { fetchDigitalAsset, mplTokenMetadata } from "@metaplex-foundation/mpl-token-metadata";

import { publicKey } from "@metaplex-foundation/umi";
import { Connection } from "@solana/web3.js";

export const getUmi = (rpcUrl: string) => {
  const rpc = new Connection(rpcUrl);
  return createUmi(rpc).use(mplTokenMetadata());
};

export async function getMetadata(rpcUrl: string, address: string) {
  const umi = getUmi(rpcUrl);
  try {
    return await fetchDigitalAsset(umi, publicKey(address));
  } catch (error) {
    console.error("Error fetching metadata:", error);
    return null;
  }
}
