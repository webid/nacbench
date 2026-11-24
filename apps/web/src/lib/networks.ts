import type { NetworkConfig, NetworkId } from './types';

export const DEFAULT_NETWORK: NetworkId = 'previewnet';
export const NULL_SOURCE_ADDRESS = 'tz1Ke2h7sDdakHJQh8WX4Z372du1KChsksyU';
export const SAFE_SINGLETON_FACTORY = '0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7';

export const DEFAULT_FIXTURES = {
  aliceTz1: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
  alicePubKey: 'edpkvGfYw3LyB1UcCahKQk4rF2tvbMUk8GFiTuMjL75uGXrpvKXhjn',
  evmGatewayKt1: 'KT18oDJJKXMKhfE1bSuAPGp92pYcwVDiqsPw',
  freeRoutePoolEvm: '0x0d9de5e5d943c6e5118140e49b56f496d7f47003',
  deadEvm: '0x000000000000000000000000000000000000dEaD',
  sampleTz4Rejected: 'tz4HVR6aty9KwsQFHh81C1G7gBurexT7r9pN',
} as const;

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  previewnet: {
    id: 'previewnet',
    label: 'Tezos X Previewnet',
    badge: 'v0.11 · Horus 8.0 RC',
    evm: {
      rpcUrl: 'https://evm.previewnet.tezosx.nomadic-labs.com',
      chainId: 128064,
      explorerUrl: 'https://blockscout.previewnet.tezosx.nomadic-labs.com',
      blockscoutApiUrl: 'https://blockscout.previewnet.tezosx.nomadic-labs.com/api/v2',
      precompile: '0xff00000000000000000000000000000000000007',
      nacRecommendedGas: 5_000_000,
    },
    michelson: {
      rpcUrl: 'https://michelson.previewnet.tezosx.nomadic-labs.com',
      chainId: 'NetXY2oPPzkxUW1',
      explorerUrl: 'https://tzkt.previewnet.tezosx.nomadic-labs.com',
      evmGateway: 'KT18oDJJKXMKhfE1bSuAPGp92pYcwVDiqsPw',
      hardGasLimitPerOperation: 660_000,
    },
    notes:
      'Ephemeral Tezos X Previewnet v0.11 (Horus 8.0 RC). Live 1:1 block sync, callMichelsonView (0x8326329c), and materializeAlias (0xbfe88b4b).',
  },
  shadownet: {
    id: 'shadownet',
    label: 'Etherlink Shadownet',
    badge: 'Testnet · Horus Track',
    evm: {
      rpcUrl: 'https://node.shadownet.etherlink.com',
      chainId: 127823,
      explorerUrl: 'https://shadownet.explorer.etherlink.com',
      blockscoutApiUrl: 'https://shadownet.explorer.etherlink.com/api/v2',
      precompile: '0xff00000000000000000000000000000000000007',
      nacRecommendedGas: 5_000_000,
    },
    michelson: {
      rpcUrl: 'https://michelson.etherlink.shadownet.octez.io',
      chainId: 'NetXtLrzvQDobza',
      explorerUrl: 'https://shadownet.etherlink.tzkt.io',
      evmGateway: 'KT18oDJJKXMKhfE1bSuAPGp92pYcwVDiqsPw',
      hardGasLimitPerOperation: 660_000,
    },
    notes: 'Long-lived Etherlink Shadownet testnet tracking Ganesha 7.x -> Horus 8.0.',
  },
  mainnet: {
    id: 'mainnet',
    label: 'Etherlink Mainnet',
    badge: 'Production · Horus 8.0',
    evm: {
      rpcUrl: 'https://node.mainnet.etherlink.com',
      chainId: 42793,
      explorerUrl: 'https://explorer.etherlink.com',
      blockscoutApiUrl: 'https://explorer.etherlink.com/api/v2',
      precompile: '0xff00000000000000000000000000000000000007',
      nacRecommendedGas: 5_000_000,
    },
    michelson: {
      rpcUrl: 'https://michelson.etherlink.mainnet.octez.io',
      chainId: 'NetXohUVN5QWR4f',
      explorerUrl: 'https://etherlink.tzkt.io',
      evmGateway: 'KT18oDJJKXMKhfE1bSuAPGp92pYcwVDiqsPw',
      hardGasLimitPerOperation: 660_000,
    },
    notes:
      'Etherlink Mainnet (Ganesha 7.3 -> Horus 8.0). Always verify live kernel version and gateway health before broadcasting.',
  },
};

export const NETWORK_LIST: NetworkConfig[] = [
  NETWORKS.previewnet,
  NETWORKS.shadownet,
  NETWORKS.mainnet,
];
