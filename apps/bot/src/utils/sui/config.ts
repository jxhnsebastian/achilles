export const mainnet = {
  GlobalConfig:
    "0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352",
  ProtocolFeeCap:
    "0x55697473304e901372020f30228526c4e93558b23259d90bc6fdddedf83295d2",
  Display: "0x5f34ee74e113d74ae9546695af6e6d0fde51731fe8d9a71309f8e66b725d54ab",
  AdminCap:
    "0xc5e736b21175e1f8121d58b743432a39cbea8ee23177b6caf7c2a0aadba8d8b9",
  UpgradeCap:
    "0xd5b2d2159a78030e6f07e028eb75236693ed7f2f32fecbdc1edb32d3a2079c0d",
  Publisher:
    "0xd9810c5d1ec5d13eac8a70a059cc0087b34d245554d8704903b2492eebb17767",
  BasePackage:
    "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267",
  CurrentPackage:
    "0x6c796c3ab3421a68158e0df18e4657b2827b1f8fed5ed4b82dba9c935988711b",
  Operators: {
    Admin: "0x37a8d55f29e5b4bdba0cb3fe0ba51a93db8c868fe0de649e1bf36bb42ea7d959",
  },
  BLUE_COIN_TYPE:
    "dd5c4badc89f08fb2ff3c1827411c9bafbed54c64c17d8ab969f637364ca8b4f::blue::BLUE",
  Pools: [
    {
      id: "0x3b585786b13af1d8ea067ab37101b6513a05d2f90cfe60e8b1d9e1b46a63c4fa",
      coinA:
        "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
      coinB:
        "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
      coinADecimals: 9,
      coinBDecimals: 6,
      name: "SUI-USDC",
      fee: 2000,
      tickSpacing: 40,
    },
  ],
};

export const cetusPools = [{}];
