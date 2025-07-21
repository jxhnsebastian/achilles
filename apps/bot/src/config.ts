import { Protocol, StrategyType } from "@achilles/utils";

export const pools = {
  bluefin_sui_usdc:
    "0x3b585786b13af1d8ea067ab37101b6513a05d2f90cfe60e8b1d9e1b46a63c4fa",
  bluefin_deep_sui:
    "0x1b06371d74082856a1be71760cf49f6a377d050eb57afd017f203e89b09c89a2",
  bluefin_wbtc_usdc:
    "0xf0e4772e80800550368973d1f8ab2c9a7241ace8df8770452ee2bf3e3e67b8a1",
  bluefin_sui_wbtc:
    "0xd7d53e235c8a1db5e30bbde563053490db9b876ec8752b9053fee33ed845843b",
  cetus_usdc_sui:
    "0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105",
  bluefin_walrus_sui:
    "0xe60bc7ade245b9f35b49686dfab0a18e5ca9176d49bef1b90f60d67d06315ff0",
  orca_sol_usdc: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
  orca_fartcoin_sol: "C9U2Ksk6KKWvLEeo5yUQ7Xu46X7NzeBJtd9PBfuXaUSM",
  orca_cbBtc_sol: "CeaZcxBNLpJWtxzt58qQmfMBtJY8pQLvursXTJYGQpbN",
  orca_cbBtc_usdc: "HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM",
  orca_fartcoin_usdc: "HMZozbw3hH12xNdXahjYPcYLrifeaFQYHgVriSLmJs1Z",
  orca_spx_usdc: "AgeSxtVWWMojFWYNrXKnVp9cFuC5CQ7M4rzmrseLxfUj",
  orca_jlp_sol: "6a3m2EgFFKfsFuQtP4LJJXPcAe3TQYXNyHUjjZpUxYgd",
  orca_weth_sol: "HktfL7iwGKT5QHjywQkcDnZXScoh811k7akrMZJkCcEF",
  orca_orca_sol: "Hxw77h9fEx598afiiZunwHaX3vYu9UskDk9EpPNZp1mG",
  orca_spx_sol: "9YyNqgM3Wcjnzb4DXiyNBbcLEkGAyaiB4PSeQyZsFtr8",
  orca_popcat_sol: "AHTTzwf3GmVMJdxWM8v2MSxyjZj8rQR6hyAC3g9477Yj",
  orca_wbtc_sol: "B5EwJVDuAauzUEEdwvbuXzbFFgEYnUqqS37TUM1c4PQA",
  orca_ray_sol: "D3C5H4YU7rjhK7ePrGtK1Bhde4tfeiTr98axdZnA7tet",
  orca_bonk_sol: "3ne4mWqdYuNiYrYZC9TrA3FcfuFdErghH97vNPbjicr1",
  orca_pengu_sol: "FAqh648xeeaTqL7du49sztp9nfj5PjRQrfvaMccyd9cz",
  orca_house_sol: "HeaoWH5EN9ijQz69WSk7MzNfyVD88WWsSh1kCvsrg7Ly",
  raydium_sol_usdc: "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv",
  raydium_sol_house: "9UoUyQ2J2zMX7BdwKXrLU8bXhpEfu9K8bdmPfypafKKg",
};

export const poolConfigsTest = [
  {
    protocol: Protocol.RAYDIUM,
    poolId: pools.raydium_sol_house,
    pollerId: "poller_raydium_sol_house",
  },
];

export const botConfigsTest = [
  {
    botId: "ec2_raydium_sol_house_test",
    sender: "7iSrw6LAPjPQdAA4vkPmwpSpB8q8EPM1fn5F8Ja2QHo6",
    protocol: Protocol.RAYDIUM,
    strategy: StrategyType.INRANGE,
    poolId: pools.raydium_sol_house,
    coinAmount: 1,
    slippage: 0.1,
    params: {
      tickRange: 8,
    },
  },
];

export const poolConfigs1 = [
  {
    protocol: Protocol.ORCA,
    poolId: pools.orca_fartcoin_sol,
    pollerId: "poller_orca_fartcoin_sol",
  },
  {
    protocol: Protocol.ORCA,
    poolId: pools.orca_pengu_sol,
    pollerId: "poller_orca_pengu_sol",
  },
  {
    protocol: Protocol.ORCA,
    poolId: pools.orca_spx_usdc,
    pollerId: "poller_orca_spx_usdc",
  },
  {
    protocol: Protocol.ORCA,
    poolId: pools.orca_orca_sol,
    pollerId: "poller_orca_orca_sol",
  },
  {
    protocol: Protocol.ORCA,
    poolId: pools.orca_spx_sol,
    pollerId: "poller_orca_spx_sol",
  },
  {
    protocol: Protocol.ORCA,
    poolId: pools.orca_house_sol,
    pollerId: "poller_orca_house_sol",
  },
];

export const poolConfigs2 = [
  {
    protocol: Protocol.ORCA,
    poolId: pools.orca_sol_usdc,
    pollerId: "poller_orca_sol_usdc",
  },
  {
    protocol: Protocol.ORCA,
    poolId: pools.orca_fartcoin_usdc,
    pollerId: "poller_orca_fartcoin_usdc",
  },
  {
    protocol: Protocol.ORCA,
    poolId: pools.orca_bonk_sol,
    pollerId: "poller_orca_bonk_sol",
  },
  {
    protocol: Protocol.ORCA,
    poolId: pools.orca_popcat_sol,
    pollerId: "poller_orca_popcat_sol",
  },
  {
    protocol: Protocol.ORCA,
    poolId: pools.orca_ray_sol,
    pollerId: "poller_orca_ray_sol",
  },
];

export const botConfigs1 = [
  {
    botId: "ec2_sol_fartcoin_sol_60k",
    sender: "Ao8worHr46EMrrvYDrstStkmAQkZa5KvSPPWAEDrWGk8",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_fartcoin_sol,
    coinAmount: 413,
    slippage: 0.1,
    params: {
      tickRange: 56,
    },
  },
  {
    botId: "ec2_sol2_fartcoin_sol_80k",
    sender: "AUKFR7oRtZwpgG8BbdqKJwZZHzE1ohv5HCQXToCDm8sr",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_fartcoin_sol,
    coinAmount: 86,
    slippage: 0.1,
    params: {
      tickRange: 56,
    },
  },
  {
    botId: "ec2_sol3_fartcoin_sol_75k",
    sender: "CJtdxqGBs91CHg6xch2Tv47wifdCsptcnhtgq5Nk913q",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_fartcoin_sol,
    coinAmount: 565.13,
    slippage: 0.1,
    params: {
      tickRange: 56,
    },
  },
  {
    botId: "ec2_sol4_fartcoin_sol_80k",
    sender: "9DhXBeBmnMvBoLDHpQGDuQc9jCtZL7knpPLcazgDXQmS",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_fartcoin_sol,
    coinAmount: 287,
    slippage: 0.1,
    params: {
      tickRange: 56,
    },
  },
  {
    botId: "ec2_sol5_fartcoin_sol_60k",
    sender: "5cNAjcCqDgQAGD2Jac9tCiiM6LcekbYUQzBSWjNiz1yH",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_fartcoin_sol,
    coinAmount: 442,
    slippage: 0.1,
    params: {
      tickRange: 56,
    },
  },
  {
    botId: "ec2_sol5_pengu_sol_20k",
    sender: "5cNAjcCqDgQAGD2Jac9tCiiM6LcekbYUQzBSWjNiz1yH",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_pengu_sol,
    coinAmount: 157.5,
    slippage: 0.1,
    params: {
      tickRange: 20,
    },
  },
  {
    botId: "ec2_sol5_spx_usdc_10k",
    sender: "5cNAjcCqDgQAGD2Jac9tCiiM6LcekbYUQzBSWjNiz1yH",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_spx_usdc,
    coinAmount: 10000,
    slippage: 0.1,
    params: {
      tickRange: 34,
    },
  },
  {
    botId: "ec2_sol6_fartcoin_sol_60k",
    sender: "J79GjhyoujU8UcTbP11m3wE2jjKaDjWAJJwXxwYR4CJz",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_fartcoin_sol,
    coinAmount: 451,
    slippage: 0.1,
    params: {
      tickRange: 75,
    },
  },
  {
    botId: "ec2_sol6_orca_sol_15k",
    sender: "J79GjhyoujU8UcTbP11m3wE2jjKaDjWAJJwXxwYR4CJz",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_orca_sol,
    coinAmount: 113,
    slippage: 0.1,
    params: {
      tickRange: 63,
    },
  },
  {
    botId: "ec2_sol6_spx_sol_15k",
    sender: "J79GjhyoujU8UcTbP11m3wE2jjKaDjWAJJwXxwYR4CJz",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_spx_sol,
    coinAmount: 113,
    slippage: 0.1,
    params: {
      tickRange: 23,
    },
  },
  {
    botId: "ec2_sol7_fartcoin_sol_30k",
    sender: "EQWF6zAJydeiE9dR4e6LXs61b79CPjybBRKisjXKw5uE",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_fartcoin_sol,
    coinAmount: 76,
    slippage: 0.1,
    params: {
      tickRange: 70,
    },
  },
  {
    botId: "ec2_sol8_fartcoin_sol_60k",
    sender: "Y7nRrtFFC84XbHrUuoi5Uzec7oN3bmZcSWbfy8NbHKh",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_fartcoin_sol,
    coinAmount: 427,
    slippage: 0.1,
    params: {
      tickRange: 56,
    },
  },
  {
    botId: "ec2_sol9_fartcoin_sol_60k",
    sender: "9zWrn2KTANmF93Ag1pf1AiGnQqhfRZ5gN664FgevcWKA",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_fartcoin_sol,
    coinAmount: 427,
    slippage: 0.1,
    params: {
      tickRange: 56,
    },
  },
  {
    botId: "ec2_sol10_fartcoin_sol_60k",
    sender: "BajisfQ15TEikxBFW7oXGxz46JKuDrQ7mkfBcqr4xSZ7",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_fartcoin_sol,
    coinAmount: 425,
    slippage: 0.1,
    params: {
      tickRange: 56,
    },
  },
  {
    botId: "ec2_sol8_house_sol_30k",
    sender: "Y7nRrtFFC84XbHrUuoi5Uzec7oN3bmZcSWbfy8NbHKh",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_house_sol,
    coinAmount: 210,
    slippage: 0.1,
    params: {
      tickRange: 30,
    },
  },
  {
    botId: "ec2_sol9_house_sol_30k",
    sender: "9zWrn2KTANmF93Ag1pf1AiGnQqhfRZ5gN664FgevcWKA",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_house_sol,
    coinAmount: 210,
    slippage: 0.1,
    params: {
      tickRange: 30,
    },
  },
  {
    botId: "ec2_sol10_house_sol_30k",
    sender: "BajisfQ15TEikxBFW7oXGxz46JKuDrQ7mkfBcqr4xSZ7",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_house_sol,
    coinAmount: 210,
    slippage: 0.1,
    params: {
      tickRange: 30,
    },
  },
];

export const botConfigs2 = [
  {
    botId: "ec2_sol_popcat_sol_40k",
    sender: "Ao8worHr46EMrrvYDrstStkmAQkZa5KvSPPWAEDrWGk8",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_popcat_sol,
    coinAmount: 275,
    slippage: 0.1,
    params: {
      tickRange: 80,
    },
  },
  {
    botId: "ec2_sol_fartcoin_usdc_30k",
    sender: "Ao8worHr46EMrrvYDrstStkmAQkZa5KvSPPWAEDrWGk8",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_fartcoin_usdc,
    coinAmount: 72,
    slippage: 0.1,
    params: {
      tickRange: 68,
    },
  },
  {
    botId: "ec2_sol2_sol_usdc_20k",
    sender: "AUKFR7oRtZwpgG8BbdqKJwZZHzE1ohv5HCQXToCDm8sr",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_sol_usdc,
    coinAmount: 86,
    slippage: 0.1,
    params: {
      tickRange: 125,
    },
  },
  {
    botId: "ec2_sol2_popcat_sol_50k",
    sender: "AUKFR7oRtZwpgG8BbdqKJwZZHzE1ohv5HCQXToCDm8sr",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_popcat_sol,
    coinAmount: 326,
    slippage: 0.1,
    params: {
      tickRange: 80,
    },
  },
  {
    botId: "ec2_sol3_sol_usdc_30k",
    sender: "CJtdxqGBs91CHg6xch2Tv47wifdCsptcnhtgq5Nk913q",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_sol_usdc,
    coinAmount: 180,
    slippage: 0.1,
    params: {
      tickRange: 250,
    },
  },
  {
    botId: "ec2_sol3_bonk_sol_30k",
    sender: "CJtdxqGBs91CHg6xch2Tv47wifdCsptcnhtgq5Nk913q",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_bonk_sol,
    coinAmount: 202,
    slippage: 0.1,
    params: {
      tickRange: 33,
    },
  },
  {
    botId: "ec2_sol4_sol_usdc_30k",
    sender: "9DhXBeBmnMvBoLDHpQGDuQc9jCtZL7knpPLcazgDXQmS",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_sol_usdc,
    coinAmount: 180,
    slippage: 0.1,
    params: {
      tickRange: 250,
    },
  },
  {
    botId: "ec2_sol5_popcat_sol_10k",
    sender: "5cNAjcCqDgQAGD2Jac9tCiiM6LcekbYUQzBSWjNiz1yH",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_popcat_sol,
    coinAmount: 78,
    slippage: 0.1,
    params: {
      tickRange: 80,
    },
  },
  {
    botId: "ec2_sol6_popcat_sol_10k",
    sender: "J79GjhyoujU8UcTbP11m3wE2jjKaDjWAJJwXxwYR4CJz",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_popcat_sol,
    coinAmount: 76,
    slippage: 0.1,
    params: {
      tickRange: 80,
    },
  },
  {
    botId: "ec2_sol7_popcat_sol_50k",
    sender: "EQWF6zAJydeiE9dR4e6LXs61b79CPjybBRKisjXKw5uE",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_popcat_sol,
    coinAmount: 141,
    slippage: 0.1,
    params: {
      tickRange: 80,
    },
  },
  {
    botId: "ec2_sol7_ray_sol_20k",
    sender: "EQWF6zAJydeiE9dR4e6LXs61b79CPjybBRKisjXKw5uE",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_ray_sol,
    coinAmount: 141,
    slippage: 0.1,
    params: {
      tickRange: 17,
    },
  },
  {
    botId: "ec2_sol8_popcat_sol_10k",
    sender: "Y7nRrtFFC84XbHrUuoi5Uzec7oN3bmZcSWbfy8NbHKh",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_popcat_sol,
    coinAmount: 72,
    slippage: 0.1,
    params: {
      tickRange: 80,
    },
  },
  {
    botId: "ec2_sol9_popcat_sol_10k",
    sender: "9zWrn2KTANmF93Ag1pf1AiGnQqhfRZ5gN664FgevcWKA",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_popcat_sol,
    coinAmount: 72,
    slippage: 0.1,
    params: {
      tickRange: 80,
    },
  },
  {
    botId: "ec2_sol10_popcat_sol_10k",
    sender: "BajisfQ15TEikxBFW7oXGxz46JKuDrQ7mkfBcqr4xSZ7",
    protocol: Protocol.ORCA,
    strategy: StrategyType.INRANGE,
    poolId: pools.orca_popcat_sol,
    coinAmount: 72,
    slippage: 0.1,
    params: {
      tickRange: 80,
    },
  },
];
