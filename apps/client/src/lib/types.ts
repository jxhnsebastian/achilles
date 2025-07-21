import type { BotConfig, BotMemoryEntry, PollerConfig } from "@achilles/utils";

export interface Bot extends BotConfig {
  positions: BotMemoryEntry[];
}

export interface Poller extends PollerConfig {
  runtimeStatus: string;
}

export interface CreateBotParams extends BotConfig {
  pollerId: string;
}

export interface BotDialogData {
  open: boolean;
  bot?: Bot;
}

// Export enums as values
export {
  BotStatus,
  Protocol,
  StrategyType,
  ChaserStep,
  PollerStatus,
} from "@achilles/utils";
// Export interfaces and types as types
export type {
  StrategyParams,
  PollerConfig,
  BotConfig,
  UserPosition,
  PositionBalances,
  CurrentTick,
  PoolTick,
  RangePosition,
  ChaserInfo,
  InRangeInfo,
  ConvertInfo,
  BotMemoryEntry,
  TokenPriceDetails,
  FordefiWallets,
  GenericPoolInfo,
} from "@achilles/utils";
