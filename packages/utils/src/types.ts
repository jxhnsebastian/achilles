import type Decimal from "decimal.js";

export enum StrategyType {
  CHASER,
  INRANGE,
}

export enum ChaserStep {
  STEP1, // Starting with coinA
  STEP2, // Starting with coinB
}

export interface StrategyParams {
  coinA: {
    coinType: string;
    amount: Decimal;
  };
  coinB: {
    coinType: string;
    amount: Decimal;
  };
  tickRange: number;
}

export enum Protocol {
  BLUEFIN,
  CETUS,
  ORCA,
  RAYDIUM,
}

export enum PollerStatus {
  START,
  RUN,
  RESTART,
  STOP,
}

export interface PollerConfig {
  pollerId: string;
  protocol: Protocol;
  poolId: string;
  status: PollerStatus;
}

export enum BotStatus {
  START,
  RUN,
  REBALANCE,
  UPDATE,
  STOP,
}

export interface BotConfig {
  botId: string;
  sender: string;
  protocol: Protocol;
  strategy: StrategyType;
  poolId: string;
  slippage: number;
  params: StrategyParams;
  continue?: boolean;
  status: BotStatus;
  instanceId: string;
}

export interface UserPosition {
  owner: string;
  pool_id: string;
  position_id: string;
  lower_tick: number;
  upper_tick: number;
  lower_price: Decimal;
  upper_price: Decimal;
  fee_rate: number;
  botId: string;
}

export interface PositionBalances {
  digest: string;
  coinA: {
    coinType: string;
    amount: Decimal;
  };
  coinB: {
    coinType: string;
    amount: Decimal;
  };
  others?: {
    coinType: string;
    amount: Decimal;
  }[];
}

export interface CurrentTick {
  lowerTick: PoolTick;
  upperTick: PoolTick;
}

export interface PoolTick {
  liquidity?: string;
  price: string;
  tick: number;
}

export interface RangePosition {
  upper: UserPosition;
  lower: UserPosition;
}

export interface ChaserInfo {
  type: "chaser";
  step?: ChaserStep;
  position?: UserPosition;
}

export interface InRangeInfo {
  type: "inrange";
  position?: UserPosition;
}

export interface ConvertInfo {
  lastConvert: string;
}

export interface BotMemoryEntry {
  botId: string;
  action: "open" | "close" | "swap" | "collect" | "convert_fees" | "update";
  timestamp: number;
  strategy: ChaserInfo | InRangeInfo | ConvertInfo | StrategyParams;
  digest: string;
  coinA: {
    coinType: string;
    amount: Decimal;
  };
  coinB: {
    coinType: string;
    amount: Decimal;
  };
  balances: {
    coinType: string;
    amount: Decimal;
  }[];
  price: Decimal;
  user?: string;
}

export interface TokenPriceDetails {
  id: string;
  type: "derivedPrice";
  price: string;
}

export interface FordefiWallets {
  [key: string]: {
    vaultId: string;
    privateKey: string;
    id: string;
  };
}

export interface GenericPoolInfo {
  address: string;
  tickSpacing: number;
  coinA: {
    address: string;
    decimals: number;
  };
  coinB: {
    address: string;
    decimals: number;
  };
}
