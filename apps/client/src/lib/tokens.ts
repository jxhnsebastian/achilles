import { TokenRegistry } from "@achilles/utils";

export const tokenRegistry = new TokenRegistry();

export const tickers = {
  BTC: {
    binance: "BTCUSDT",
    bybit: "BTCUSDT",
    hyperliquid: "BTC",
  },
  FARTCOIN: {
    binance: "FARTCOINUSDT",
    bybit: "FARTCOINUSDT",
    hyperliquid: "FARTCOIN",
  },
  SOL: {
    binance: "SOLUSDT",
    bybit: "SOLUSDT",
    hyperliquid: "SOL",
  },
  PENGU: {
    binance: "PENGUUSDT",
    bybit: "PENGUUSDT",
    hyperliquid: "PENGU",
  },
  DOGE: {
    binance: "DOGEUSDT",
    bybit: "DOGEUSDT",
    hyperliquid: "DOGE",
  },
  PUMP: {
    binance: "PUMPUSDT",
    bybit: "PUMPFUNUSDT",
    hyperliquid: "PUMP",
  },
  kBONK: {
    binance: "1000BONKUSDT",
    bybit: "1000BONKUSDT",
    hyperliquid: "kBONK",
  },
  XRP: {
    binance: "XRPUSDT",
    bybit: "XRPUSDT",
    hyperliquid: "XRP",
  },
};
