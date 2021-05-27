import { DateTime, Interval, Duration } from 'luxon'
import * as uniGraphV2 from './graphProtocol/uniswapV2'
import * as ds from './utils/debugScopes'
import * as p from './utils/persistence'

// TODO: switch bigdecimal to https://github.com/MikeMcl/bignumber.js/
//
const bigdecimal = require('bigdecimal')
const graphlib = require('@dagrejs/graphlib')

const log = ds.getLog('commands')
const ALL_PAIRS_FILE = 'all_pairs_v2.json'
const MAX_DATA_AGE = Duration.fromObject({ days: 1 })

/**
 * getRawPairData:
 * @param options 
 * @returns 
 * 
 * TODO:
 *        - Singleton / block multiple calls / make atomic b/c interacting with storage.
 */
export const getRawPairData = async(options?: any): Promise<any> => {
  const _defaultOpts = {
    ignorePersisted: false,
    persist: true
  }
  const _options = {..._defaultOpts, options}

  let _storedObj: any = undefined
  try {
    if (!_options.ignorePersisted) {
      _storedObj =  await p.retrieveObject(ALL_PAIRS_FILE)
    }
  } catch(ignoredError) {
    log.warn(`Unable to retrieve stored swap data. Fetching from Graph Protocol.`)
  }

  let _allPairs: any = undefined
  if (_storedObj && _storedObj.hasOwnProperty('object')) {
    _allPairs = _storedObj.object
  }

  let _storedAgeLimitExceeded = false
  if (_storedObj && _storedObj.hasOwnProperty('timeMs')) {
    const _storedInterval = Interval.fromDateTimes(DateTime.now(),
                                                   DateTime.fromMillis(_storedObj.timeMs))
    _storedAgeLimitExceeded = _storedInterval.length() > MAX_DATA_AGE.toMillis()
  }

  if (!_allPairs || _storedAgeLimitExceeded) {
    _allPairs = await uniGraphV2.fetchAllRawPairsV2()

    if (_options.persist) {
      p.storeObject(ALL_PAIRS_FILE, _allPairs)
    }
  }

  return _allPairs
}

/**
 * convertRawToNumericPairData:
 *    Converts string reserve values of pairs to bigdecimal types and sorts
 *    the pairs.  Default sort is descending by reserve USD amount.
 * 
 * TODO:
 *    - TS types
 */
export const convertRawToNumericPairData = (allPairsRaw: any, 
                                            options?: any): any => {
  const _defaultOpts = {
    sort: true,
    descending: true
  }
  const _options = {..._defaultOpts, options}

  const _allPairsNumeric: any = {
    timeMs: allPairsRaw.timeMs,
    pairs: []
  }
  for (const _rawPair of allPairsRaw.pairs) {
    const _pair:any = {}
    _pair.id = _rawPair.id
    _pair.reserve0 = bigdecimal.BigDecimal(_rawPair.reserve0)
    _pair.reserve1 = bigdecimal.BigDecimal(_rawPair.reserve1)
    _pair.reserveUSD = bigdecimal.BigDecimal(_rawPair.reserveUSD)
    _pair.token0 = _rawPair.token0
    _pair.token1 = _rawPair.token1

    _allPairsNumeric.pairs.push(_pair)
  }

  if (_options.sort) {
    _allPairsNumeric.pairs.sort((a: any, b: any) => {
      return (!_options.descending) ?
        a.reserveUSD.subtract(b.reserveUSD) :
        b.reserveUSD.subtract(a.reserveUSD)
    })
  }

  return _allPairsNumeric
}

export const constructPairGraph = async(allPairsNumeric: any): Promise<any> =>
{
  const _g = new graphlib.Graph({directed: true,
                                 multigraph: false,
                                 compound: false})
  for (const pair of allPairsNumeric.pairs) {
    const symbol0 = pair.token0.symbol.toLowerCase()
    const symbol1 = pair.token1.symbol.toLowerCase()
    _g.setEdge(symbol0, symbol1, {id: pair.id})
    _g.setEdge(symbol1, symbol0, {id: pair.id})
  }

  log.info(`Constructed graph containing:\n` +
           `    ${_g.nodes().length} tokens\n` +
           `    ${_g.edges().length} pairs\n`)

  return _g
}

const _routeSearch = (g: any, 
                      swaps: number, 
                      maxHops: number, 
                      route: string[], 
                      routes: any, 
                      origin: string, 
                      destination: string): void => 
{
  //  log.debug(`_routeSearch: rs: ${routes.length}, r: ${route.length}, s: ${swaps}, ${origin} -> ${destination}`)
  if (swaps < maxHops) {
    let neighbors = g.neighbors(origin)
    swaps++

    for (const neighbor of neighbors) {
      const _route = [...route, neighbor]
      //    log.debug(`   _route: ${_route.join(' --> ')}`)
      if (neighbor === destination) {
        routes[_route.join(':')]= _route
      }

      if (origin !== neighbor) {
        _routeSearch(g, swaps, maxHops, _route, routes, neighbor, destination)
      }
    }
  }
}

/* routeSearch: Terrible bicycle.
*
*                 Performs a search for routes from one node to another limited
*                 to maxHops.  Results are stored in routes.
*
*                 For example, to initiate a search from 'A' to 'Z':
*/
const routeSearch = (g: any, origin: string, destination: string, maxHops: number) => 
{
  let swaps = 0
  let route = [origin]
  let routes: any = {}

  _routeSearch(g, swaps, maxHops, route, routes, origin, destination)

  return routes
}

export const findRoutes = async(pairGraph: any,
                                symbolSrc: string,
                                symbolDst: string,
                                maxDistance=2): Promise<any> =>
{
  if (!symbolSrc || !symbolDst) {
    log.error(`A source token symbol (${symbolSrc}) and destination token ` +
              `symbol (${symbolDst}) are required.`)
    return
  }
  const _symbolSrc = symbolSrc.toLowerCase()
  const _symbolDst = symbolDst.toLowerCase()

  if (_symbolSrc === _symbolDst) {
    log.error(`Money laundering not supported (same token routes, ${symbolSrc} -> ${symbolDst}).`)
  }

  if (!pairGraph.hasNode(_symbolSrc)) {
    log.error(`Source token symbol, ${symbolSrc}, is not in the graph.`)
    return
  }
  if (!pairGraph.hasNode(_symbolDst)) {
    log.error(`Destination token symbol, ${symbolDst}, is not in the graph.`)
    return
  }

  log.info(`Finding routes from token ${symbolSrc} to token ${symbolDst} ...`)
  const routes = routeSearch(pairGraph, _symbolSrc, _symbolDst, maxDistance)

  // Convert the routes dictionary to an ordered list of routes
  //
  const routesArr: any = Object.values(routes)
  routesArr.sort((a: any, b: any) => {
    return a.length - b.length    // Ascending order by route length
  })
  for (const route of routesArr) {
    log.info(`route (${route.length-1} hops):  ${route.join(' -> ')}`)
  }

  return routesArr
}

export const updatePairGraph = async(continuous = false): Promise<any> =>
{
}

export const findRoutesBySymbol = async(fromSymbol: string, toSymbol: string, maxRoutes: 5): Promise<any> =>
{
}

export const findRoutesByAddr = async(fromAddr: string, toAddr: string, maxRoutes: 5): Promise<any> =>
{
}