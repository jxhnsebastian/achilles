import {
  createKeyPairFromPrivateKeyBytes,
  createKeyPairSignerFromBytes,
  getBase58Encoder,
} from "@solana/web3.js";

export async function getSignerFromSecretKeyBytes(secretKeyBytes: Uint8Array) {
  return await createKeyPairFromPrivateKeyBytes(secretKeyBytes);
}

export async function getSignerFromSecretKey(secretKey: string) {
  return await createKeyPairSignerFromBytes(getBase58Encoder().encode(secretKey));
}
