import { UniswapPair,
         ChainId,
         UniswapVersion,
         UniswapPairSettings } from 'simple-uniswap-sdk'
import * as ds from './../utils/debugScopes'

const log = ds.getLog('server')
const { INFURA_API_KEY } = process.env
const ETH_ADDR = '0xc803698a4be31f0b9035b6eba17623698f3e2f82'

export const getUniRouteV2 = async (source: string, destination: string, amount: string): Promise<string> => {
  let routeText = ''
  try {
    const settings = new UniswapPairSettings({
      slippage: 0.005,
      deadlineMinutes: 20,
      disableMultihops: false,
      uniswapVersions: [UniswapVersion.v2],
    })

    const uniswapPair = new UniswapPair({
      fromTokenContractAddress: source.toLowerCase(),
      toTokenContractAddress: destination.toLowerCase(),
      ethereumAddress: ETH_ADDR,
      providerUrl: `https://mainnet.infura.io/v3/${INFURA_API_KEY}`,
      chainId: ChainId.MAINNET,
      settings,
    })

    const uniswapPairFactory = await uniswapPair.createFactory()
    // const provider = new ethers.providers.JsonRpcProvider(
    //   uniswapPairFactory.providerUrl
    // )

    // TODO: probably want to cache this for ~block time (15s)
    const trade = await uniswapPairFactory.trade(amount.toString())
    routeText = trade.routeText 
    trade.destroy()
  } catch (error) {
    log.warn(`getUniRouteV2 failed.\n${error}`)
  }

  return routeText
}
