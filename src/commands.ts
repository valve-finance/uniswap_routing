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
const MAX_DATA_AGE = Duration.fromObject({ days: 5 })

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
    const _storedInterval = Interval.fromDateTimes(DateTime.fromMillis(_storedObj.timeMs),
                                                   DateTime.now())
    _storedAgeLimitExceeded = _storedInterval.length() > MAX_DATA_AGE.toMillis()
  }

  if (!_allPairs || _storedAgeLimitExceeded) {
    _allPairs = await uniGraphV2.fetchAllRawPairsV2()

    if (_options.persist) {
      await p.storeObject(ALL_PAIRS_FILE, _allPairs)
    }
  }

  return _allPairs
}

/**
 * getSymbolLookup:
 *   Uniswap pairs have an id for the pair as well as an id for each token in the pair.
 *   Oddly, the id for the token in the pair is not unique for a given symbol.  For instance
 *   given the ficticious token symbol "ABBA", it may have the id "0x0...A" in one pair and
 *   the id "0x0...F" in another pair.
 * 
 *   This method builds a system for looking up the following information:
 *      - All token ids for a given symbol.
 *      - All pair ids for a given symbol.
 * 
 * @param allPairsRaw 
 * @returns A structure allowing all token ids their corresponding pair ids for a given
 *          symbol to be examined (note all values lowercased):
 * 
 *          {
 *            <symbol>: {
 *              <symbol id>: [<pair id>, <pair id>, ...],
 *              <symbol id>: [<pair id>, <pair id>, ...],
 *              ...
 *            },
 *            <symbol>: {
 *              <symbol id>: [<pair id>, <pair id>, ...],
 *              <symbol id>: [<pair id>, <pair id>, ...],
 *              ...
 *            },
 *            ...
 *          }
 * 
 */
export const getSymbolLookup = (allPairsRaw: any): any =>
{
  const _symbolLookup: any = {}

  for (const _rawPair of allPairsRaw.pairs) {
    const lcPairId = _rawPair.id.toLowerCase

    const { token0, token1 } = _rawPair
    for (const token of [token0, token1]) {
      const lcSymbol = token.symbol.toLowerCase()
      const lcSymbolId = token.id.toLowerCase()

      if (!_symbolLookup.hasOwnProperty(lcSymbol)) {
        _symbolLookup[lcSymbol] = {
          [lcSymbolId]: [ lcPairId ]
        }
      } else {
        if (!_symbolLookup[lcSymbol].hasOwnProperty(lcSymbolId)) {
          _symbolLookup[lcSymbol][lcSymbolId] = [ lcPairId ]
        } else {
          _symbolLookup[lcSymbol][lcSymbolId].push(lcPairId)
        }
      }
    }
  }

  // Present statistics:
  //
  const numSymbols = Object.keys(_symbolLookup).length

  let maxIdsPerSymbol = 0
  let mostIdSymbol = ''

  let mostPairIdsPerSymbolId = 0
  let mostPairIdSymbolId = ''
  let mostPairIdSymbol = ''

  for (const symbol in _symbolLookup) {
    const idsPerSymbol = Object.keys(_symbolLookup[symbol]).length
    if (idsPerSymbol > maxIdsPerSymbol) {
      maxIdsPerSymbol = idsPerSymbol
      mostIdSymbol = symbol
    }

    for (const symbolId in _symbolLookup[symbol]) {
      const pairIdsPerSymbolId = _symbolLookup[symbol][symbolId].length
      if (pairIdsPerSymbolId > mostPairIdsPerSymbolId) {
        mostPairIdsPerSymbolId = pairIdsPerSymbolId
        mostPairIdSymbolId = symbolId
        mostPairIdSymbol = symbol
      }
    }
  }

  log.debug(`Symbol Lookup Stats\n` +
            `----------------------------------------\n` +
            `symbols                  = ${numSymbols}\n` +
            `max(id per symbol)       = ${maxIdsPerSymbol}   (${mostIdSymbol})\n` +
            `max(pairid per symbolid) = ${mostPairIdsPerSymbolId}   (${mostPairIdSymbol}, ${mostPairIdSymbolId})\n\n`)

  return _symbolLookup
}

/**
 * 
 * @param allPairsRaw 
 * @returns A map of all the symbols, lowercased, to their ids, lowercased.
 */
export const getSymbolIdLookup = (allPairsRaw: any): any => 
{
  const _symbolToId:any = {}
  for (const _rawPair of allPairsRaw.pairs) {
    _symbolToId[_rawPair.token0.symbol.toLowerCase()] = _rawPair.token0.id.toLowerCase()
    _symbolToId[_rawPair.token1.symbol.toLowerCase()] = _rawPair.token1.id.toLowerCase()
  }

  return _symbolToId
}

/**
 * 
 * @param allPairsRaw 
 * @returns A map of all the ids, lowercased, to their symbols, NOT lowercased.
 */
export const getIdSymbolLookup = (allPairsRaw: any): any => 
{
  const _idToSymbol:any = {}
  for (const _rawPair of allPairsRaw.pairs) {
    _idToSymbol[_rawPair.token0.id.toLowerCase()] = _rawPair.token0.symbol.toLowerCase()
    _idToSymbol[_rawPair.token1.id.toLowerCase()] = _rawPair.token1.symbol.toLowerCase()
  }

  return _idToSymbol
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
  const _g = new graphlib.Graph({directed: false,
                                 multigraph: false,   // Explain optimization here (attach array of pair ids for traversal speed)
                                 compound: false})
  
  let maxEdges = 0
  let maxEdgePair = ''
  for (const pair of allPairsNumeric.pairs) {
    const pairId = pair.id.toLowerCase()
    // const symbol0Id = pair.token0.id.toLowerCase()
    // const symbol1Id = pair.token1.id.toLowerCase()
    // _g.setEdge(symbol0Id, symbol1Id, pairId)
    // _g.setEdge(symbol0Id, symbol1Id, {id: pairId})
    // _g.setEdge(symbol1Id, symbol0Id, {id: pairId})

    const symbol0 = pair.token0.symbol.toLowerCase()
    const symbol1 = pair.token1.symbol.toLowerCase()


    // _g.setEdge(symbol0, symbol1, pairId, pairId)  // <-- pairID set for label and edge
    //                                               // !!! Needed for multigraph

    let edges = _g.edge(symbol0, symbol1)
    if (edges) {
      edges = {
        pairIds: [...edges.pairIds, pairId]
      }

      if (edges.pairIds.length > maxEdges) {
        maxEdges = edges.pairIds.length
        maxEdgePair = `${symbol0} <---> ${symbol1}`
      }
    } else {
      edges = {
        pairIds: [pairId]
      }
    }
    _g.setEdge(symbol0, symbol1, edges)  // <-- pairID set for label and edge
                                          // !!! Needed for multigraph

    // _g.setEdge(symbol0, symbol1, {id: pairId})
    // _g.setEdge(symbol1, symbol0, {id: pairId})
  }

  const edges = _g.edges()
  const numRawEdges = edges.length
  let numMappedEdges = 0
  for (const edge of edges) {
    numMappedEdges += _g.edge(edge).pairIds.length
  }
  log.info(`Constructed graph containing:\n` +
           `    ${_g.nodes().length} tokens\n` +
           `    ${numRawEdges} edges\n` +
           `    ${numMappedEdges} pairs\n` +
           `    ${maxEdgePair} (${maxEdges} connecting edges)\n`)

  await p.storeObject('Graph_Data.json', _g)
  return _g
}

const _routeSearch = (g: any, 
                      hops: number, 
                      maxHops: number, 
                      route: any, 
                      routes: any, 
                      originSymbol: string, 
                      destSymbol: string): void => 
{
  // log.debug(`_routeSearch: rs: ${routes.length}, r: ${route.length}, h: ${hops}, ${originSymbol} -> ${destSymbol}`)
  if (hops < maxHops) {
    let neighbors = g.neighbors(originSymbol)
    hops++

    for (const neighbor of neighbors) {
      // TODO: handle multiple edges (multi-graph) (first version of this didn't do that)
      //       as a multi-graph, there will be multiple edges!
      const _route: any = [...route, { src: originSymbol, dst: neighbor, pairIds: g.edge(originSymbol, neighbor).pairIds }]
      // const _route = [...route, neighbor]
      //    log.debug(`   _route: ${_route.join(' --> ')}`)
      if (neighbor === destSymbol) {
        // routes[_route.join(':')]= _route
        routes.push(_route)
      }

      if (originSymbol !== neighbor) {
        _routeSearch(g, hops, maxHops, _route, routes, neighbor, destSymbol)
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
const routeSearch = (g: any, originSymbol: string, destSymbol: string, maxHops: number) => 
{
  let hops = 0
  let route: any = []
  let routes: any = []

  _routeSearch(g, hops, maxHops, route, routes, originSymbol, destSymbol)

  return routes
}

export const findRoutes = async(pairGraph: any,
                                tokenSymbolSrc: string,
                                tokenSymbolDst: string,
                                maxDistance=2): Promise<any> =>
{
  if (!tokenSymbolSrc || !tokenSymbolDst) {
    log.error(`A source token symbol(${tokenSymbolSrc}) and destination token ` +
              `symbol(${tokenSymbolDst}) are required.`)
    return
  }
  const _tokenSymbolSrc = tokenSymbolSrc.toLowerCase()
  const _tokenSymbolDst = tokenSymbolDst.toLowerCase()

  if (_tokenSymbolSrc === _tokenSymbolDst) {
    log.error(`Money laundering not supported (same token routes, ${tokenSymbolSrc} -> ${tokenSymbolDst}).`)
  }

  if (!pairGraph.hasNode(_tokenSymbolSrc)) {
    log.error(`Source token symbol, ${tokenSymbolSrc}, is not in the graph.`)
    return
  }
  if (!pairGraph.hasNode(_tokenSymbolDst)) {
    log.error(`Destination token symbol, ${tokenSymbolDst}, is not in the graph.`)
    return
  }

  log.info(`Finding routes from token ${tokenSymbolSrc} to token ${tokenSymbolDst} ...`)
  const routes = routeSearch(pairGraph, _tokenSymbolSrc, _tokenSymbolDst, maxDistance)
  routes.sort((a: any, b:any) => {
    return a.length - b.length    // Ascending order by route length
  })

  return routes
}

export const routesToString = (routes: any): string => 
{
  let _routeStr: string = '\n'

  let _routeNum = 0
  for (const _route of routes) {
    _routeStr += `Route ${++_routeNum}:\n` +
                `----------------------------------------\n`
    for (const _pair of _route) {
      _routeStr += `  ${_pair.src} --> ${_pair.dst}, ${_pair.pairIds.length} pairs:\n`
      for (const _pairId of _pair.pairIds) {
        _routeStr += `      ${_pairId}\n`
      }
    }
    _routeStr += '\n'
  }

  return _routeStr
}

export const updatePairGraph = async(continuous = false): Promise<any> =>
{
}

export const findRoutesByAddr = async(fromAddr: string, toAddr: string, maxRoutes: 5): Promise<any> =>
{
}