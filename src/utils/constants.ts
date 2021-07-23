import * as t from './types'

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