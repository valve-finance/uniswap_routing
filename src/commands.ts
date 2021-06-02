import { DateTime, Interval, Duration } from 'luxon'
import * as uniGraphV2 from './graphProtocol/uniswapV2'
import * as ds from './utils/debugScopes'
import * as p from './utils/persistence'
import { ChainId,
         Token,
         WETH,
         TokenAmount,
         Route,
         Trade,
         TradeType, 
         Pair} from '@uniswap/sdk'

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
  const _options = {..._defaultOpts, ...options}

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
  const _options = {..._defaultOpts, ...options}

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
    _pair.token0Price = bigdecimal.BigDecimal(_rawPair.token0Price)
    _pair.token1Price = bigdecimal.BigDecimal(_rawPair.token1Price)

    // liquidityProviderCount is always zero for some reason in the graph:
    // _pair.liquidityProviderCount = BigInt(_rawPair.liquidityProviderCount)

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

// const getSymbolId = (symbolLookup: any, symbolLC: string, pairId: string): string => 
// {
//   for (const _symbolId in symbolLookup[symbolLC]) {
//     try {
//       const _symbolIdPairs = symbolLookup[symbolLC][_symbolId]
//       if (_symbolIdPairs.includes(pairId)) {
//         return _symbolId
//       }
//     } catch (ignoredError) {
//       log.warn(`Failure getting symbol id for ${symbolLC}.\n${ignoredError}`)
//     }
//   }

//   return ''
// }

const zeroString = (numZeros: number):string =>
{
  let _zeroStr = ''
  for (let i = numZeros; i > 0; i--) {
    _zeroStr += '0'
  }
  return _zeroStr
}

/**
 * Removes a decimal place if found and pads out to the correct
 * number of zeros.
 *
 * If no decimal found, adds appropriate number of zeros to make the
 * decimal place happen.
 * 
 * e.g.:  value=1.35, decimals=5, returns:  135000
 *        value=121, decimals=3, returns: 121000
 *  
 * @param value 
 * @param decimals 
 * 
 * TODO: tons of corner cases to handle:
 *        -  .23
 *        -  more frac digits than decimals
 * 
 */
const getNormalizedValue = (value: string, decimals: number):string =>
{
  const pointIdx = value.indexOf('.')
  if (pointIdx < 0) {
    // No point ('.')
    return value + zeroString(decimals)
  } else {
    const fracDigits = value.length - (pointIdx + 1)
    const padDigits = decimals - fracDigits
    if (padDigits < 0) {
      throw new Error(`Too many decimal places in value ${value} for expected decimal places (${decimals})`)
    }

    return value.replace('.', '') + padDigits
  }
}

/**
 * getNormalizedIntReserves:
 *   Converts the floating point numbers reserve0 and reserve1 to integer 
 *   representations with aligned least signfificant digits (padded with zero
 *   LSDs if required).
 * 
 * @param reserve0 A string representing a floating point number. (i.e. '100.23')
 * @param reserve1 A string representing a floating point number. (i.e. '1000.234')
 * 
 * TODO: handle situation where no point ('.')
 */
const getNormalizedIntReserves = (reserve0: string, reserve1: string): any =>
{
  const _res0FracDigits = reserve0.length - (reserve0.indexOf('.') + 1)
  const _res1FracDigits = reserve1.length - (reserve1.indexOf('.') + 1)

  if (_res0FracDigits === _res1FracDigits) {
    return {
      normReserve0: reserve0.replace('.', ''),
      normReserve1: reserve1.replace('.', '')
    }
  } else if (_res0FracDigits > _res1FracDigits) {
    const _padDigits = _res0FracDigits - _res1FracDigits
    return {
      normReserve0: reserve0.replace('.', ''),
      normReserve1: reserve1.replace('.', '') + zeroString(_padDigits)
    }
  } else {
    const _padDigits = _res1FracDigits - _res0FracDigits 
    return {
      normReserve0: reserve0.replace('.', '') + zeroString(_padDigits),
      normReserve1: reserve1.replace('.', '')
    }
  }
}

export const determineRouteCosts = (numPairData: any, routes: any): string =>
{
  let _routeCostStr = '\n'
  let _routeNum = 0
  for (const _route of routes) {
    _routeCostStr += `\n` +
                     `Route ${++_routeNum}:\n` +
                     `----------------------------------------\n`
    for (const _pair of _route) {
      const _srcSymbolLC = _pair.src
      const _dstSymbolLC = _pair.dst
      log.debug(`_pair:\n${JSON.stringify(_pair, null, 2)}\n`)
      _routeCostStr += `\n` +
                       `  ${_srcSymbolLC} --> ${_dstSymbolLC}:\n`

      for (const _pairId of _pair.pairIds) {
        // Not needed--in the pair data:
        // const srcSymbolId = getSymbolId(symbolLookup, _srcSymbolLC, _pairId)
        // const dstSymbolId = getSymbolId(symbolLookup, _dstSymbolLC, _pairId)
        let _pairData: any = undefined
        for (_pairData of numPairData.pairs) {
          if (_pairData.id === _pairId) {
            // 0. Future TODO: determine if the pair is invalid b/c the tokens are 
            //    bad/stale/old.
            //
            // TODO TODO ^^^^ TODO TODO

            // 1. Get token0 & token1 decimals
            //
            const _token0Decimals = 18
            const _token1Decimals = 18

            // 2 Get normalized reserves (i.e. shift them both to have no decimal
            //     places but be aligned):
            //
            const { normReserve0, normReserve1 } = getNormalizedIntReserves(_pairData.reserve0, _pairData.reserve1)

            // 2. Construct token objects (except WETH special case)
            //
            const _token0 = (_pairData.token0.symbol === 'WETH') ?
              WETH[ChainId.MAINNET] :
              new Token(ChainId.MAINNET,
                        _pairData.token0.id,
                        _token0Decimals,
                        _pairData.token0.symbol,
                        _pairData.token0.name)

            const _token1 = (_pairData.token1.symbol === 'WETH') ?
              WETH[ChainId.MAINNET] :
              new Token(ChainId.MAINNET,
                        _pairData.token1.id,
                        _token1Decimals,
                        _pairData.token1.symbol,
                        _pairData.token1.name)

            // 3. Construct pair object after moving amounts correct number of
            //    decimal places (lookup from tokens in graph)
            //
            const _pair = new Pair( new TokenAmount(_token0, normReserve0), new TokenAmount(_token1, normReserve1) )

            // 5. Construct the route & trade objects to determine the price impact.
            //
            const _srcToken = (_srcSymbolLC === _pairData.token0.symbol.toLowerCase()) ?
                { obj: _token0, decimals: _token0Decimals } :
                { obj: _token1, decimals: _token1Decimals }

            const valueTODO = '1'
            const _route = new Route([_pair], _srcToken.obj)
            const _trade = new Trade(_route,
                                     new TokenAmount(_srcToken.obj, getNormalizedValue(valueTODO, _srcToken.decimals)),
                                     TradeType.EXACT_INPUT)

            _routeCostStr += `      Pair ${_pairId}:\n` +
                             `        token0:\n` +
                             `          symbol:  ${_pairData.token0.symbol}\n` +
                            //  `          name:    ${_pairData.token0.name}\n` +
                             `          id:      ${_pairData.token0.id}\n` +
                             `          reserve: ${_pairData.reserve0}\n` +
                            //  `          price:   ${_pairData.token0Price}\n` +
                             `        token1:\n` +
                             `          symbol:  ${_pairData.token1.symbol}\n` +
                            //  `          name:    ${_pairData.token1.name}\n` +
                             `          id:      ${_pairData.token1.id}\n` +
                             `          reserve: ${_pairData.reserve1}\n` +
                            //  `          price:   ${_pairData.token1Price}\n` +
                             `        route:     ${JSON.stringify(_route.path)}\n` +
                             `        route mp:  ${_route.midPrice.toSignificant(6)}\n` +
                             `        exec p:    ${_trade.executionPrice.toSignificant(6)}\n` +
                             `        mid p:     ${_trade.nextMidPrice.toSignificant(6)}\n` +
                             `        impact:    ${_trade.priceImpact.toSignificant(3)}\n`
          }
        }
      }
    }
  }

  return _routeCostStr
}