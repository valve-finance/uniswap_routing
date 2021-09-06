import * as t from './types'

// Block number to ignore update to block
export const NO_BLOCK_NUM = -1

// HTTP Status Codes
//   TODO: use a real lib w/ more resolution/detail
export const OK = 200
export const BAD_REQUEST = 400
export const INTERNAL_SERVER_ERROR = 500

export const MAX_HOPS = 3
export const MAX_RESULTS = 100

export const WETH_ADDR = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"       // The legit one w/ most txns
export const USDC_ADDR = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"

export const WETH_ADDRS_LC = [WETH_ADDR,
                              "0xd73d6d4c463df976399acd80ea338384e247c64b",
                              "0x477b466750c31c890db3208816d60c8585be7f0e" ]

// Pairs that are invalid (i.e. long ago expired and mess up calculations / outcomes)
//
export const bogusTokens: any = {
  '0xfa2b9e5f4b60767d4c3ca6e316d8599311419b3e': 'Paradise Token (PDT)'
}

// Addresses for testing:
//
export const tokenAddrs = {
  DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  COMP: '0xc00e94Cb662C3520282E6f5717214004A7f26888',
  MCB: '0x4e352cf164e64adcbad318c3a1e222e9eba4ce42',
  DYP: '0x961c8c0b1aad0c0b10a51fef6a867e3091bcef17',
  AAVE: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9',
  BAL: '0xba100000625a3754423978a60c9317c58a424e3d'
}

// Tokens that can't be quoted an initial amount in USD using
// USDC through a WETH pair:
export const tokensNoWethPair = [
  "0xec4a1c7a4e9fdc7cc621b548a931c92bc08a679a",   // GOJ 
  "0xbd62253c8033f3907c0800780662eab7378a4b96",   // USDG 
  "0x965d79f1a1016b574a62986e13ca8ab04dfdd15c",   // M2 
  "0xed7e17b99804d273eda67fc7d423cc9080ea8431",   // CARBO 
  "0x8d52061af43c52204c717d0610ea8f52f955ce0b"    // MIA 
]

export const currentHubTokens = [
  WETH_ADDR,
  "0x6b175474e89094c44da98b954eedeac495271d0f",   // DAI
  USDC_ADDR,
  "0xdac17f958d2ee523a2206206994597c13d831ec7",   // USDT
  "0xc00e94cb662c3520282e6f5717214004a7f26888",   // COMP
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",   // WBTC
]

export const noHubTokenCnstr: t.Constraints = {
  maxDistance: MAX_HOPS,
  ignoreTokenIds: [
    // WETH:
    WETH_ADDR,                                      
    "0xd73d6d4c463df976399acd80ea338384e247c64b",
    "0x477b466750c31c890db3208816d60c8585be7f0e",
    // DAI:
    "0x6b175474e89094c44da98b954eedeac495271d0f",
    "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
    "0xf035f1fbdae1aedb952f904c641e7db1a2a52537",
    // USDC:
    USDC_ADDR,
    "0x0432aac809b2c07249dbc04cc5f2337091dd6e87",
    "0x2cd68ecf48b0687c95ee6c06d33389688c3cbb8e",
    "0xacf9ea5062193181120832baf6d49f5ab992338b",
    "0xc93a59888e7e6f2849ba94acf767266299c4c415",   // <-- ?
    "0xefb9326678757522ae4711d7fb5cf321d6b664e6",   // <-- ?
    // USDT:
    "0x2f34f846f57e5e31975fa29ffcceb4d84a441abb",
    "0x409ff99dc752e53e16cde354645cfaf0410a874a",
    "0x51e1ccbea22d51c8e919e85908f6490838549ff5",
    "0x601886880af940b261fef86572e1310d2787413d",
    "0x6070c2215a18cd8efaf340166876ac9ce4d1e79b",
    "0x632f2894cb421d0b09a9ae361a5db3f0163fce2d",
    "0x682dae1bf00cbd79798c8eafc9a9fe1f1cb6befd",
    "0x69d8f39cbeb10085b787a3f30cdaaba824cc1a27",
    "0x78f825c0e8eee5661d1c6bb849a4e32d5addb746",
    "0xa06725a857f26aa18f80dfad5e4a7f7e2fec2eef",
    "0xa2065164a26ecd3775dcf22510ad1d2daef8bd2a",
    "0xb0c158fdf257d601386612d0bd15d5bd4acee7d2",
    "0xc220b5df13bc1917bb692e70a84044bd9067ccc0",
    "0xc48e6a12c97ad930d9d5320376dfd821dcd3ab04",
    "0xdac17f958d2ee523a2206206994597c13d831ec7",
    "0xef1d5af0928f19d264f2febdfeb2d950aaaed8d1",
    // COMP:
    "0xb7096f353ffc826d1e65b01bcb43d55ba8aa55e7",
    "0xc00e94cb662c3520282e6f5717214004a7f26888",
    "0xeba1b95ac453291ae3156fa183b1460cff1905f2",
    // MKR:
    "0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2",
    "0xb2a9a0f34e3140de9b9a489b33fc049102a1808e"
  ]
}

export const deprecatedTokenCnstr: t.Constraints = {
  maxDistance: MAX_HOPS,
  ignoreTokenIds: [
    "0xd233d1f6fd11640081abb8db125f722b5dc729dc"  // Old USD Token:
  ]
}


export const uniswapDefaultTokens = [
  {
    "chainId": 1,
    "address": "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
    "name": "Aave",
    "symbol": "AAVE",
    "decimals": 18,
    "logoURI": "https://assets.coingecko.com/coins/images/12645/thumb/AAVE.png?1601374110"
  },
  {
    "chainId": 1,
    "address": "0xfF20817765cB7f73d4bde2e66e067E58D11095C2",
    "name": "Amp",
    "symbol": "AMP",
    "decimals": 18,
    "logoURI": "https://assets.coingecko.com/coins/images/12409/thumb/amp-200x200.png?1599625397"
  },
  {
    "name": "Aragon Network Token",
    "address": "0x960b236A07cf122663c4303350609A66A7B288C0",
    "symbol": "ANT",
    "decimals": 18,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x960b236A07cf122663c4303350609A66A7B288C0/logo.png"
  },
  {
    "name": "Balancer",
    "address": "0xba100000625a3754423978a60c9317c58a424e3D",
    "symbol": "BAL",
    "decimals": 18,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xba100000625a3754423978a60c9317c58a424e3D/logo.png"
  },
  {
    "chainId": 1,
    "address": "0xBA11D00c5f74255f56a5E366F4F77f5A186d7f55",
    "name": "Band Protocol",
    "symbol": "BAND",
    "decimals": 18,
    "logoURI": "https://assets.coingecko.com/coins/images/9545/thumb/band-protocol.png?1568730326"
  },
  {
    "name": "Bancor Network Token",
    "address": "0x1F573D6Fb3F13d689FF844B4cE37794d79a7FF1C",
    "symbol": "BNT",
    "decimals": 18,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x1F573D6Fb3F13d689FF844B4cE37794d79a7FF1C/logo.png"
  },
  {
    "name": "Compound",
    "address": "0xc00e94Cb662C3520282E6f5717214004A7f26888",
    "symbol": "COMP",
    "decimals": 18,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xc00e94Cb662C3520282E6f5717214004A7f26888/logo.png"
  },
  {
    "name": "Curve DAO Token",
    "address": "0xD533a949740bb3306d119CC777fa900bA034cd52",
    "symbol": "CRV",
    "decimals": 18,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xD533a949740bb3306d119CC777fa900bA034cd52/logo.png"
  },
  {
    "chainId": 1,
    "address": "0x41e5560054824eA6B0732E656E3Ad64E20e94E45",
    "name": "Civic",
    "symbol": "CVC",
    "decimals": 8,
    "logoURI": "https://assets.coingecko.com/coins/images/788/thumb/civic.png?1547034556"
  },
  {
    "name": "Dai Stablecoin",
    "address": "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    "symbol": "DAI",
    "decimals": 18,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x6B175474E89094C44Da98b954EedeAC495271d0F/logo.png"
  },
  {
    "chainId": 1,
    "address": "0x0AbdAce70D3790235af448C88547603b945604ea",
    "name": "district0x",
    "symbol": "DNT",
    "decimals": 18,
    "logoURI": "https://assets.coingecko.com/coins/images/849/thumb/district0x.png?1547223762"
  },
  {
    "name": "Gnosis Token",
    "address": "0x6810e776880C02933D47DB1b9fc05908e5386b96",
    "symbol": "GNO",
    "decimals": 18,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x6810e776880C02933D47DB1b9fc05908e5386b96/logo.png"
  },
  {
    "chainId": 1,
    "address": "0xc944E90C64B2c07662A292be6244BDf05Cda44a7",
    "name": "The Graph",
    "symbol": "GRT",
    "decimals": 18,
    "logoURI": "https://assets.coingecko.com/coins/images/13397/thumb/Graph_Token.png?1608145566"
  },
  {
    "chainId": 1,
    "address": "0x85Eee30c52B0b379b046Fb0F85F4f3Dc3009aFEC",
    "name": "Keep Network",
    "symbol": "KEEP",
    "decimals": 18,
    "logoURI": "https://assets.coingecko.com/coins/images/3373/thumb/IuNzUb5b_400x400.jpg?1589526336"
  },
  {
    "name": "Kyber Network Crystal",
    "address": "0xdd974D5C2e2928deA5F71b9825b8b646686BD200",
    "symbol": "KNC",
    "decimals": 18,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdd974D5C2e2928deA5F71b9825b8b646686BD200/logo.png"
  },
  {
    "name": "ChainLink Token",
    "address": "0x514910771AF9Ca656af840dff83E8264EcF986CA",
    "symbol": "LINK",
    "decimals": 18,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x514910771AF9Ca656af840dff83E8264EcF986CA/logo.png"
  },
  {
    "name": "Loom Network",
    "address": "0xA4e8C3Ec456107eA67d3075bF9e3DF3A75823DB0",
    "symbol": "LOOM",
    "decimals": 18,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA4e8C3Ec456107eA67d3075bF9e3DF3A75823DB0/logo.png"
  },
  {
    "name": "LoopringCoin V2",
    "address": "0xBBbbCA6A901c926F240b89EacB641d8Aec7AEafD",
    "symbol": "LRC",
    "decimals": 18,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xBBbbCA6A901c926F240b89EacB641d8Aec7AEafD/logo.png"
  },
  {
    "chainId": 1,
    "address": "0x0F5D2fB29fb7d3CFeE444a200298f468908cC942",
    "name": "Decentraland",
    "symbol": "MANA",
    "decimals": 18,
    "logoURI": "https://assets.coingecko.com/coins/images/878/thumb/decentraland-mana.png?1550108745"
  },
  {
    "name": "Maker",
    "address": "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2",
    "symbol": "MKR",
    "decimals": 18,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2/logo.png"
  },
  {
    "chainId": 1,
    "address": "0xec67005c4E498Ec7f55E092bd1d35cbC47C91892",
    "name": "Melon",
    "symbol": "MLN",
    "decimals": 18,
    "logoURI": "https://assets.coingecko.com/coins/images/605/thumb/melon.png?1547034295"
  },
  {
    "name": "Numeraire",
    "address": "0x1776e1F26f98b1A5dF9cD347953a26dd3Cb46671",
    "symbol": "NMR",
    "decimals": 18,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x1776e1F26f98b1A5dF9cD347953a26dd3Cb46671/logo.png"
  },
  {
    "chainId": 1,
    "address": "0x4fE83213D56308330EC302a8BD641f1d0113A4Cc",
    "name": "NuCypher",
    "symbol": "NU",
    "decimals": 18,
    "logoURI": "https://assets.coingecko.com/coins/images/3318/thumb/photo1198982838879365035.jpg?1547037916"
  },
  {
    "name": "Orchid",
    "address": "0x4575f41308EC1483f3d399aa9a2826d74Da13Deb",
    "symbol": "OXT",
    "decimals": 18,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x4575f41308EC1483f3d399aa9a2826d74Da13Deb/logo.png"
  },
  {
    "name": "Republic Token",
    "address": "0x408e41876cCCDC0F92210600ef50372656052a38",
    "symbol": "REN",
    "decimals": 18,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x408e41876cCCDC0F92210600ef50372656052a38/logo.png"
  },
  {
    "name": "Reputation Augur v1",
    "address": "0x1985365e9f78359a9B6AD760e32412f4a445E862",
    "symbol": "REP",
    "decimals": 18,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x1985365e9f78359a9B6AD760e32412f4a445E862/logo.png"
  },
  {
    "name": "Reputation Augur v2",
    "address": "0x221657776846890989a759BA2973e427DfF5C9bB",
    "symbol": "REPv2",
    "decimals": 18,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x221657776846890989a759BA2973e427DfF5C9bB/logo.png"
  },
  {
    "name": "Synthetix Network Token",
    "address": "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F",
    "symbol": "SNX",
    "decimals": 18,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F/logo.png"
  },
  {
    "name": "Storj Token",
    "address": "0xB64ef51C888972c908CFacf59B47C1AfBC0Ab8aC",
    "symbol": "STORJ",
    "decimals": 8,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xB64ef51C888972c908CFacf59B47C1AfBC0Ab8aC/logo.png"
  },
  {
    "chainId": 1,
    "address": "0x8dAEBADE922dF735c38C80C7eBD708Af50815fAa",
    "name": "tBTC",
    "symbol": "TBTC",
    "decimals": 18,
    "logoURI": "https://assets.coingecko.com/coins/images/11224/thumb/tBTC.png?1589620754"
  },
  {
    "name": "UMA Voting Token v1",
    "address": "0x04Fa0d235C4abf4BcF4787aF4CF447DE572eF828",
    "symbol": "UMA",
    "decimals": 18,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x04Fa0d235C4abf4BcF4787aF4CF447DE572eF828/logo.png"
  },
  {
    "name": "Uniswap",
    "address": "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    "symbol": "UNI",
    "decimals": 18,
    "chainId": 1,
    "logoURI": "ipfs://QmXttGpZrECX5qCyXbBQiqgQNytVGeZW5Anewvh2jc4psg"
  },
  {
    "name": "USDCoin",
    "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "symbol": "USDC",
    "decimals": 6,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png"
  },
  {
    "name": "Tether USD",
    "address": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    "symbol": "USDT",
    "decimals": 6,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png"
  },
  {
    "name": "Wrapped BTC",
    "address": "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    "symbol": "WBTC",
    "decimals": 8,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png"
  },
  {
    "name": "Wrapped Ether",
    "address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    "symbol": "WETH",
    "decimals": 18,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png"
  },
  {
    "chainId": 1,
    "address": "0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e",
    "name": "yearn finance",
    "symbol": "YFI",
    "decimals": 18,
    "logoURI": "https://assets.coingecko.com/coins/images/11849/thumb/yfi-192x192.png?1598325330"
  },
  {
    "name": "0x Protocol Token",
    "address": "0xE41d2489571d322189246DaFA5ebDe1F4699F498",
    "symbol": "ZRX",
    "decimals": 18,
    "chainId": 1,
    "logoURI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xE41d2489571d322189246DaFA5ebDe1F4699F498/logo.png"
  }
]