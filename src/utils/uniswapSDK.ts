import { UniswapPair,
         ChainId,
         UniswapVersion,
         UniswapPairSettings } from 'simple-uniswap-sdk'
import * as ds from './../utils/debugScopes'

const log = ds.getLog('server')
const { INFURA_API_KEY } = process.env
const ETH_ADDR = '0xc803698a4be31f0b9035b6eba17623698f3e2f82'

export const getUniRouteV2 = async (source: string, destination: string, amount: string): Promise<any> =>
{
  const routeObj: any = {
    uniswapVersion: '',
    expectedConvertQuote: '',
    routeText: '',
    routePath: [],
    routePathTokenMap: [] 
  }
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
    const trade = await uniswapPairFactory.trade(amount.toString())

    routeObj.uniswapVersion = trade.uniswapVersion
    routeObj.expectedConvertQuote = trade.expectedConvertQuote    // the amount in dest tokens
    routeObj.routeText = trade.routeText
    routeObj.routePath = trade.routePath
    routeObj.routePathTokenMap = trade.routePathTokenMap
    trade.destroy()
  } catch (error) {
    log.warn(`getUniRouteV2 failed. Ensure you have an internet connection. Reported error:\n${error}`)
  }

  return routeObj 
}
