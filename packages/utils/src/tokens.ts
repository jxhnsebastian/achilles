import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { fetchWithRetry } from "./helpers";
import { TokenPriceDetails } from "./types";

interface TokenMetadata {
  address: string;
  name: string;
  symbol: string;
  uri: string;
  iconUrl?: string;
  decimals: number;
  pythId?: string;
  chainType: "solana" | "sui";
}

interface PriceData {
  [address: string]: number;
}

export class TokenRegistry {
  private tokens: Map<string, TokenMetadata>;
  private suiClient: SuiClient;
  private pythSymbolToIdMap: Map<string, string>;

  constructor() {
    this.tokens = new Map<string, TokenMetadata>();
    this.suiClient = new SuiClient({ url: getFullnodeUrl("mainnet") });
    this.pythSymbolToIdMap = new Map<string, string>();
  }

  /**
   * Determine if an address is for Solana or Sui based on format
   */
  private getChainType(address: string): "solana" | "sui" {
    // Simplistic check: Solana addresses are 32-44 characters long, base58 encoded
    // Sui addresses are 66 characters long (0x + 64 hex chars)
    if (address.startsWith("0x") && address.split("::")[0].length === 66) {
      return "sui";
    }
    return "solana";
  }

  private async indexSolanaTokens(addresses: string[]): Promise<void> {
    for (const address of addresses) {
      try {
        const asset = await fetchWithRetry<any>(
          `https://api.jup.ag/tokens/v1/token/${address}`
        );
        let pythId = await this.getPythIdForSymbol(asset.symbol);

        const tokenMetadata: TokenMetadata = {
          address,
          name: asset.name,
          symbol: asset.symbol,
          uri: asset.logoURI || "",
          iconUrl: asset.logoURI || "",
          decimals: asset.decimals,
          pythId,
          chainType: "solana",
        };

        this.tokens.set(address, tokenMetadata);
      } catch (error: any) {
        console.log(`Failed to index Solana token ${address}:`, error?.message);
        this.tokens.set(address, {
          address,
          name: address,
          symbol: address,
          uri: "",
          iconUrl: "",
          decimals: 1,
          chainType: "solana",
        });
      }
    }
  }

  private async indexSuiTokens(addresses: string[]): Promise<void> {
    for (const address of addresses) {
      try {
        const coinMetadata = await this.suiClient.getCoinMetadata({
          coinType: address,
        });

        if (coinMetadata) {
          let pythId = await this.getPythIdForSymbol(coinMetadata.symbol);

          const tokenMetadata: TokenMetadata = {
            address,
            name: coinMetadata.name,
            symbol: coinMetadata.symbol,
            uri: coinMetadata.iconUrl || "",
            iconUrl: coinMetadata.iconUrl || undefined,
            decimals: coinMetadata.decimals,
            pythId,
            chainType: "sui",
          };

          this.tokens.set(address, tokenMetadata);
        }
      } catch (error: any) {
        console.log(`Failed to index Sui token ${address}:`, error?.message);
        this.tokens.set(address, {
          address,
          name: address,
          symbol: address,
          uri: "",
          iconUrl: "",
          decimals: 1,
          chainType: "solana",
        });
      }
    }
  }

  private async getPythIdForSymbol(
    symbol: string
  ): Promise<string | undefined> {
    try {
      const normalizedSymbol = symbol.trim().toUpperCase();
      if (this.pythSymbolToIdMap.has(normalizedSymbol)) {
        return this.pythSymbolToIdMap.get(normalizedSymbol);
      }

      const data = await fetchWithRetry(
        `https://hermes.pyth.network/v2/price_feeds?query=${encodeURIComponent(
          normalizedSymbol
        )}&asset_type=crypto`
      );
      if (data && Array.isArray(data) && data.length > 0) {
        const exactMatch =
          data.find((feed) => feed.attributes.base === normalizedSymbol) ??
          data[0];

        if (exactMatch) {
          this.pythSymbolToIdMap.set(normalizedSymbol, exactMatch.id);
          console.log(`${normalizedSymbol}: ${exactMatch.id}`);
          return exactMatch.id;
        }

        return undefined;
      }

      return undefined;
    } catch (error) {
      console.log(`Failed to get Pyth ID for symbol ${symbol}:`, error);
      return undefined;
    }
  }

  private async getPythPrice(
    timeInSec: number,
    ids: string[]
  ): Promise<Record<string, number>> {
    const idsQueryParams = ids.map((id) => `ids%5B%5D=${id}`).join("&");
    const data = await fetchWithRetry<any>(
      `https://hermes.pyth.network/v2/updates/price/${timeInSec.toFixed(
        0
      )}?${idsQueryParams}`
    );

    const result: Record<string, number> = {};

    if (data.parsed && Array.isArray(data.parsed)) {
      for (const item of data.parsed) {
        if (item.price && item.id) {
          if (item.price.publish_time + 2 < timeInSec) {
            throw new Error(`Stale price feed for ID: ${item.id}!`);
          }

          const calculatedPrice =
            item.price.price * Math.pow(10, item.price.expo);
          result[item.id] = calculatedPrice;
        }
      }
    }

    return result;
  }

  private async getJupiterPrices(
    tokenMints: string[]
  ): Promise<Record<string, number>> {
    try {
      const url = `https://api.jup.ag/price/v2?ids=${tokenMints.join(",")}`;
      const { data } = await fetchWithRetry<{
        data: Record<string, TokenPriceDetails>;
      }>(url);

      // tokenId -> price mapping
      return Object.entries(data).reduce((acc, [tokenId, details]) => {
        if (details === null) {
          // jupiter didn't have a price; return 0
          acc[tokenId] = 0;
          return acc;
        }

        acc[tokenId] = Number(details.price);
        return acc;
      }, {} as Record<string, number>);
    } catch (error) {
      console.error("Error fetching token prices:", error);
      throw error;
    }
  }

  async indexTokens(addresses: string[]): Promise<void> {
    const solanaAddresses: string[] = [];
    const suiAddresses: string[] = [];

    for (const address of addresses) {
      if (!this.tokens.has(address)) {
        if (this.getChainType(address) === "solana") {
          solanaAddresses.push(address);
        } else {
          suiAddresses.push(address);
        }
      }
    }

    if (solanaAddresses.length > 0) {
      await this.indexSolanaTokens(solanaAddresses);
    }

    if (suiAddresses.length > 0) {
      await this.indexSuiTokens(suiAddresses);
    }
  }

  async getTokensMetadata(
    addresses: string[]
  ): Promise<{ [address: string]: TokenMetadata }> {
    const result: { [address: string]: TokenMetadata } = {};
    const missingAddresses: string[] = [];

    for (const address of addresses) {
      const token = this.tokens.get(address);
      if (token) {
        result[address] = token;
      } else {
        missingAddresses.push(address);
      }
    }

    if (missingAddresses.length > 0) {
      await this.indexTokens(missingAddresses);

      for (const address of missingAddresses) {
        const token = this.tokens.get(address);
        if (token) {
          result[address] = token;
        }
      }
    }

    return result;
  }

  async getTokensPrices(
    addresses: string[],
    timeInSec?: number
  ): Promise<PriceData> {
    let result: PriceData = {};
    const pythIds: string[] = [];
    const addressToPythId: Map<string, string> = new Map();

    const missingAddresses: string[] = addresses.filter(
      (address) => !this.tokens.has(address)
    );

    if (missingAddresses.length > 0) await this.indexTokens(missingAddresses);
    const solAddresses = [];

    for (const address of addresses) {
      const token = this.tokens.get(address);
      if (token && token.pythId) {
        pythIds.push(token.pythId);
        addressToPythId.set(address, token.pythId);
      } else {
        // Token without Pyth ID - jupiter fallback for sol tokens, 0 for sui tokens
        if (this.getChainType(address) === "solana") {
          solAddresses.push(address);
        } else result[address] = 0;
      }
    }

    if (solAddresses.length) {
      try {
        const prices = await this.getJupiterPrices(solAddresses);
        result = { ...result, ...prices };
      } catch (error) {
        console.log("Failed to fetch jupiter prices:", error);

        solAddresses.forEach((address) => {
          if (!result[address]) {
            result[address] = 0;
          }
        });
      }
    }

    if (pythIds.length > 0) {
      try {
        const pythPrices = await this.getPythPrice(
          timeInSec || Math.floor(Date.now() / 1000 - 1),
          pythIds
        );

        // Map Pyth IDs back to addresses
        for (const [address, pythId] of addressToPythId.entries()) {
          result[address] = pythPrices[pythId] || 0;
        }
      } catch (error) {
        console.log("Failed to fetch Pyth prices:", error);

        addresses.forEach((address) => {
          if (!result[address]) {
            result[address] = 0;
          }
        });
      }
    }

    return result;
  }

  getTokenData(address: string): TokenMetadata {
    return (
      this.tokens.get(address) ?? {
        address: address,
        name: "",
        symbol: "",
        uri: "",
        iconUrl: "",
        decimals: 1,
        pythId: "",
        chainType: this.getChainType(address),
      }
    );
  }
}
