import { UniswapPair,
  ChainId,
  UniswapVersion,
  UniswapPairSettings } from 'simple-uniswap-sdk'
import * as ds from './../utils/debugScopes'

const log = ds.getLog('server')
const { INFURA_API_KEY } = process.env
const ETH_ADDR = '0xc803698a4be31f0b9035b6eba17623698f3e2f82'

export const UNI_ROUTER_ERRORS = {
  NO_ERROR: 'No Error.',
  INSUFFICIENT_LIQUIDITY: 'Insufficient Liquidity Error.',
  NO_ROUTE: 'No Route Error.',
  UNKNOWN: 'Unknown Error.'
}

const _processError = (error: string): string => {
  if (!error) {
    return UNI_ROUTER_ERRORS.NO_ERROR
  } else if (error.includes('invalid BigNumber string')) {
    return UNI_ROUTER_ERRORS.INSUFFICIENT_LIQUIDITY
  } else if (error.includes('No routes found')) {
    return UNI_ROUTER_ERRORS.NO_ROUTE
  }

  return UNI_ROUTER_ERRORS.UNKNOWN
}

export const getUniRouteV2 = async (source: string, destination: string, amount: string): Promise<any> =>
{
  const method = 'getUniRouteV2'
  const result: any = {
    routeObj: {
      uniswapVersion: '',
      expectedConvertQuote: '',
      routeText: '',
      routePath: [],
      routePathTokenMap: [] 
    },
    unprocessedError: undefined,
    error: UNI_ROUTER_ERRORS.NO_ERROR
  }

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

  let uniswapPairFactory: any = undefined
  try {
    uniswapPairFactory = await uniswapPair.createFactory()
  } catch (error) {
    log.error(`${method}: failed while creating Uniswap Pair factory.\n${error}`)
    result.unprocessedError = error.toString()
    result.error = _processError(error.toString())

    return result
  }

  let trade: any = undefined
  try {
    trade = await uniswapPairFactory.trade(amount.toString())
  } catch (error) {
    log.warn(`${method}: failed while computing trade of ${amount} ${source} --> ${destination}:\n${error}`)
    result.unprocessedError = error.toString()
    result.error = _processError(error.toString())

    return result
  }

  if (trade) {
    result.routeObj = {
      uniswapVersion: trade.uniswapVersion,
      expectedConvertQuote: trade.expectedConvertQuote,    // the amount in dest tokens
      routeText: trade.routeText,
      routePath: trade.routePath,
      routePathTokenMap: trade.routePathTokenMap
    }

    trade.destroy()
  } else {
    result.unprocessedError = UNI_ROUTER_ERRORS.UNKNOWN
    result.error = UNI_ROUTER_ERRORS.UNKNOWN
  }

  return result
}