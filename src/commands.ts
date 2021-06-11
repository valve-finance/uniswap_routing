import { DateTime, Interval, Duration } from 'luxon'
import * as uniGraphV2 from './graphProtocol/uniswapV2'
import * as ds from './utils/debugScopes'
import * as p from './utils/persistence'
import * as n from './utils/normalize'
import { ChainId,
         Token,
         WETH,
         TokenAmount,
         Route,
         Trade,
         TradeType, 
         Pair} from '@uniswap/sdk'
import { parseOptions } from 'commander'

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

export const constructPairGraph = async(allPairsNumeric: any): Promise<any> =>
{
  const _g = new graphlib.Graph({directed: false,
                                 multigraph: false,   // Explain optimization here (attach array of pair ids for traversal speed)
                                 compound: false})
  
  let maxEdges = 0
  let maxEdgePair = ''
  for (const pair of allPairsNumeric.pairs) {
    const pairId = pair.id.toLowerCase()
    const symbol0 = pair.token0.symbol.toLowerCase()
    const symbol1 = pair.token1.symbol.toLowerCase()

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
                      rolledRoutes: any, 
                      originSymbol: string, 
                      destSymbol: string): void => 
{
  if (hops < maxHops) {
    let neighbors = g.neighbors(originSymbol)
    hops++

    for (const neighbor of neighbors) {
      // Optimization: rather than make this a mulitgraph, represent all pairs in a single edge and
      //               store their ids as a property of that edge.
      const _route: any = [...route, { src: originSymbol, dst: neighbor, pairIds: g.edge(originSymbol, neighbor).pairIds }]
      if (neighbor === destSymbol) {
        rolledRoutes.push(_route)
      }

      if (originSymbol !== neighbor) {
        _routeSearch(g, hops, maxHops, _route, rolledRoutes, neighbor, destSymbol)
      }
    }
  }
}

/* routeSearch: Terrible bicycle.
*
*                 Performs a search for routes from one node to another limited
*                 to maxHops.  Results are stored in routes.
*
*/
const routeSearch = (g: any, originSymbol: string, destSymbol: string, maxHops: number) => 
{
  let hops = 0
  let route: any = []
  let rolledRoutes: any = []

  _routeSearch(g, hops, maxHops, route, rolledRoutes, originSymbol, destSymbol)

  return rolledRoutes
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
  const rolledRoutes = routeSearch(pairGraph, _tokenSymbolSrc, _tokenSymbolDst, maxDistance)
  rolledRoutes.sort((a: any, b:any) => {
    return a.length - b.length    // Ascending order by route length
  })

  return rolledRoutes
}

export const routesToString = (rolledRoutes: any): string => 
{
  let _routeStr: string = '\n'

  let _routeNum = 0
  for (const _route of rolledRoutes) {
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

const computeTradeEstimates = (pairData:any, srcSymbolLC:string, dstSymbolLC:string ): any => 
{
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
  const { normReserve0, normReserve1 } =
    n.getNormalizedIntReserves(pairData.reserve0, pairData.reserve1)

  // 2. Construct token objects (except WETH special case)
  //
  const _token0 = (pairData.token0.symbol === 'WETH') ?
    WETH[ChainId.MAINNET] :
    new Token(ChainId.MAINNET,
              pairData.token0.id,
              _token0Decimals,
              pairData.token0.symbol,
              pairData.token0.name)

  const _token1 = (pairData.token1.symbol === 'WETH') ?
    WETH[ChainId.MAINNET] :
    new Token(ChainId.MAINNET,
              pairData.token1.id,
              _token1Decimals,
              pairData.token1.symbol,
              pairData.token1.name)

  // 3. Construct pair object after moving amounts correct number of
  //    decimal places (lookup from tokens in graph)
  //
  const _pair = new Pair( new TokenAmount(_token0, normReserve0),
                          new TokenAmount(_token1, normReserve1) )

  // 5. Construct the route & trade objects to determine the price impact.
  //
  const _srcToken = (srcSymbolLC === pairData.token0.symbol.toLowerCase()) ?
      { obj: _token0, decimals: _token0Decimals } :
      { obj: _token1, decimals: _token1Decimals }

  const valueTODO = '1'
  const _route = new Route([_pair], _srcToken.obj)
  const _trade = new Trade(_route,
                            new TokenAmount(_srcToken.obj, 
                                            n.getNormalizedValue(valueTODO, _srcToken.decimals)),
                            TradeType.EXACT_INPUT)
  return {
    route: _route,
    trade: _trade
  }
}

export const printRouteCosts = (numPairData: any, rolledRoutes: any): string =>
{
  let _routeCostStr = '\n'
  let _routeNum = 0
  for (const _route of rolledRoutes) {
    _routeCostStr += `\n` +
                     `Route ${++_routeNum}:\n` +
                     `----------------------------------------\n`

    const _measuredRoute:any = []

    for (const _pair of _route) {
      const _srcSymbolLC = _pair.src
      const _dstSymbolLC = _pair.dst
      _routeCostStr += `${_srcSymbolLC} --> ${_dstSymbolLC}:\n`

      for (const _pairId of _pair.pairIds) {
        for (const _pairData of numPairData.pairs) {
          if (_pairData.id === _pairId) {
            try {
              const est = computeTradeEstimates(_pairData, _srcSymbolLC, _dstSymbolLC)

              _routeCostStr += `     pair (${_pairId}):  ${est.trade.priceImpact.toSignificant(3)}\n`
              // _routeCostStr += `      Pair ${_pairId}:\n` +
              //                  `        token0:\n` +
              //                  `          symbol:  ${_pairData.token0.symbol}\n` +
              //                 //  `          name:    ${_pairData.token0.name}\n` +
              //                  `          id:      ${_pairData.token0.id}\n` +
              //                  `          reserve: ${_pairData.reserve0}\n` +
              //                 //  `          price:   ${_pairData.token0Price}\n` +
              //                  `        token1:\n` +
              //                  `          symbol:  ${_pairData.token1.symbol}\n` +
              //                 //  `          name:    ${_pairData.token1.name}\n` +
              //                  `          id:      ${_pairData.token1.id}\n` +
              //                  `          reserve: ${_pairData.reserve1}\n` +
              //                 //  `          price:   ${_pairData.token1Price}\n` +
              //                  `        route:     ${JSON.stringify(est.route.path)}\n` +
              //                  `        route mp:  ${est.route.midPrice.toSignificant(6)}\n` +
              //                  `        exec p:    ${est.trade.executionPrice.toSignificant(6)}\n` +
              //                  `        mid p:     ${est.trade.nextMidPrice.toSignificant(6)}\n` +
              //                  `        impact:    ${est.trade.priceImpact.toSignificant(3)}\n`
              break
            } catch(error) {
              log.error(`Failed computing trade estimates for ${_srcSymbolLC} --> ${_dstSymbolLC}:\n` +
                        `${JSON.stringify(_pairData, null, 2)}\n` +
                        error)
            }
          }
        }
      }
    }
  }

  return _routeCostStr
}

/*
 * DATATYPES FOR ROUTES
 *
 * The 'rolledRoutes' datatype:
 *
 *  [                 // Array of routes
 *    [               // Ordered array of pairs to complete the route (A -> B -> C)
 *      {
 *        src:  <symbol>
 *        dst:  <symbol>
 *        pairIds: [<pairId>, ...]
 *      },
 *      ...
 *    ]
 *  ]
 *
 * The 'costedRolledRoutes' datatype:
 * 
 *  [                 // Array of routes
 *    [               // Ordered array of pairs to complete the route (A -> B -> C)
 *      {
 *        src:  <symbol>
 *        dst:  <symbol>
 *        pairs: [ 
 *          { 
 *            id: <id>, 
 *            impact: <% number>,
 *            token0: {
 *              price: <BigDecimal>,    // price in token1,
 *              symbol: '<UC symbol>'
 *            },
 *            token1: {
 *              price: <BigDecimal>,    // price in token0,
 *              symbol: '<UC symbol>'
 *            }
 *          }, ...
 *        ]
 *      },
 *      ...
 *    ]
 *  ]
 * 
 * The 'unrolledRoutes' datatype (note that the pair ids are expanded and each route
 *                                combination is present)
 *                    // TODO: make a routes datatype with costs (cheaper than repeating
 *                    //       for expanded)
 * 
 *  [                 // Array of routes
 *    [               // Ordered array of pairs to complete the route (A -> B -> C)
 *      {
 *        src:  <symbol>
 *        dst:  <symbol>
 *        pairId: <pairId>
 *      },
 *      ...
 *    ]
 *  ]
 * 
 * The 'costedRoutes' datatype:
 *  [                                 // Array of routes
 *    {                               // Route object
 *      totalImpact: <%age>,          // Sum of all route pair impacts
 *      numSwaps: <number>,
 *      routeStr: 'A -> B -> C'
 *      orderedSwaps: [
 *        {
 *          src: 'A',
 *          dst: 'B',
 *          id: <pairId>,
 *          impact: <%age>
 *        },
 *        ...
 *        {
 *          src: 'B',
 *          dst: 'C',
 *          id: <pairId>,
 *          impact: <%age>
 *        }
 *      ]
 *    }
 *  ]
 */


/**
 * costRolledRoutes determines price impact of each individual pair id and
 * returns a rolledRoute data structure with these costs
 * 
 * @param numPairData 
 * @param rolledRoutes 
 * 
 * TODO:
 *    - improve search efficiency of pair data (log(n) perf vs O(n))
 *    - cache
 *    - heuristics
 */
export const costRolledRoutes = (numPairData: any,
                                 rolledRoutes: any): any =>
{
  const _costedRolledRoutes :any = []

  for (const _route of rolledRoutes) {
    const _costedRoute:any = []

    for (const _pair of _route) {
      const _costedSegment: any = {
        src: _pair.src,
        dst: _pair.dst,
        pairs: []
      }
      const _srcSymbolLC = _pair.src.toLowerCase()
      const _dstSymbolLC = _pair.src.toLowerCase()

      for (const _pairId of _pair.pairIds) {

        for (const _pairData of numPairData.pairs) {
          if (_pairData.id === _pairId) {
            try {
              const est = computeTradeEstimates(_pairData, _srcSymbolLC, _dstSymbolLC)
              const impact = est.trade.priceImpact.toSignificant(3)
              _costedSegment.pairs.push({
                id: _pairId,
                impact,
                token0: {
                  price: _pairData.token0Price,
                  symbol: _pairData.token0.symbol
                },
                token1: {
                  price: _pairData.token1Price,
                  symbol: _pairData.token1.symbol
                }
              })
              break
            } catch(error) {
              log.error(`Failed computing impact estimates for ${_srcSymbolLC} --> ${_dstSymbolLC}:\n` +
                        `${JSON.stringify(_pairData, null, 2)}\n` +
                        error)
            }
          }
        }

      }

      _costedRoute.push(_costedSegment)
    }

    _costedRolledRoutes.push(_costedRoute)
  }

  return _costedRolledRoutes
}

export const unrollCostedRolledRoutes = (costedRolledRoutes: any,
                                         maxImpact=10.0): any =>
{
  let routeNum = 0
  let _unrolledRoutes:any = []
  // log.debug(`Length costed rolled routes = ${costedRolledRoutes.length}`)
  for (const _route of costedRolledRoutes) {

    // Unroll each route by determining it's number of segments and then
    // constructing each individual route implied by the pairs of each segment:
    //
    const _segmentPairCounts = []
    for (let _segmentIndex = 0; _segmentIndex < _route.length; _segmentIndex++) {
      _segmentPairCounts[_segmentIndex] = _route[_segmentIndex].pairs.length
    }

    const _segmentPairIndices =[]
    for (let _index = 0; _index < _segmentPairCounts.length; _index++) {
      _segmentPairIndices[_index] = 0
    }

    // This is basically a dynamically nested for loop, iterating over each pair
    // ascribed to each route segment similar to a counter--when we are iterating
    // the last route segment past it's counte, we know we've matched all pair ids.
    // TODO: might be cleaner with an expanded multigraph or other solution.
    //
    // O(n^y), n=num pairs per segment, y = num segments
    //
    // log.debug(`Unrolling ...`)
    while (_segmentPairIndices[_segmentPairIndices.length-1] <
           _segmentPairCounts[_segmentPairCounts.length-1]) {
      // log.debug(`Segment Pair Indices: ${_segmentPairIndices}`)
      // log.debug(`Segment Pair Counts:  ${_segmentPairCounts}`)

      routeNum++
      const _routeObj:any = {
        totalImpact: 0,
        numSwaps: 0,
        routeStr: '',
        orderedSwaps: []
      }

      // log.debug(`Route ${routeNum}:\n` +
      //           `----------------------------------------`)
      for (let _segmentIndex = 0; _segmentIndex < _route.length; _segmentIndex++) {
        const _segment = _route[_segmentIndex]
        const _pairs = _segment.pairs
        const _index = _segmentPairIndices[_segmentIndex]
        const _pairData = _pairs[_index]
        // log.debug(`${_segment.src} --> ${_segment.dst}, pair id: ${_pairData.id}, impact: ${_pairData.impact}`)

        // TODO: big decimal or normalized big int here
        const _totalImpact = _routeObj.totalImpact + parseFloat(_pairData.impact)
        _routeObj.totalImpact = (_totalImpact < 100.0) ? _totalImpact : 100.0
        _routeObj.numSwaps++
        _routeObj.routeStr += (_segmentIndex === 0) ?
            `${_segment.src} -> ${_segment.dst}` : ` -> ${_segment.dst}`
        _routeObj.orderedSwaps.push({
          src: _segment.src,
          dst: _segment.dst,
          id: _pairData.id,
          impact: _pairData.impact,
          token0: _pairData.token0,
          token1: _pairData.token1
        })
      }

      if (_routeObj.totalImpact < maxImpact) {
        _unrolledRoutes.push(_routeObj)
      }

      // Increment the segment indices:
      for (let _segmentIndex = 0; _segmentIndex < _route.length; _segmentIndex++) {
        _segmentPairIndices[_segmentIndex]++
        if (_segmentPairIndices[_segmentIndex] < _segmentPairCounts[_segmentIndex]) {
          break
        } else if (_segmentIndex === _route.length - 1) {
          break
        } else {
          _segmentPairIndices[_segmentIndex] = 0
        }
      }
    }
  }

  return _unrolledRoutes.sort((a:any, b:any) => {
    return a.totalImpact - b.totalImpact    // Ascending order by total impact
  })
}