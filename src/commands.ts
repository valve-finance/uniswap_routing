import { DateTime, Interval, Duration } from 'luxon'
import * as uniGraphV2 from './graphProtocol/uniswapV2'
import * as ds from './utils/debugScopes'
import * as p from './utils/persistence'
import * as n from './utils/normalize'
import * as t from './utils/types'
import { ChainId,
         Token,
         WETH,
         TokenAmount,
         Route,
         Trade,
         TradeType, 
         Pair} from '@uniswap/sdk'
import { getAddress } from '@ethersproject/address'

// TODO: switch bigdecimal to https://github.com/MikeMcl/bignumber.js/
//
const bigdecimal = require('bigdecimal')
const graphlib = require('@dagrejs/graphlib')

const log = ds.getLog('commands')
const ALL_PAIRS_FILE = 'all_pairs_v2.json'
const ALL_TOKENS_FILE = 'all_tokens.json'
const MAX_DATA_AGE = Duration.fromObject({ days: 5 })

export const initUniData = async(force=false): Promise<t.UniData> => {
  log.info('Initializing Uniswap data. Please wait (~ 1 min.) ...')

  const _rawPairData: any = await getPairData({ignorePersisted: force})
  const _allTokenData: any = await getTokenData({ignorePersisted: force})
  const _pairGraph: any = await constructPairGraph(_rawPairData)

  return {
    pairGraph: _pairGraph,
    tokenData: _allTokenData,
    pairData: _rawPairData
  }
}

/**
 * getPairData:
 * @param options 
 * @returns 
 * 
 * TODO:
 *        - Singleton / block multiple calls / make atomic b/c interacting with storage.
 */
export const getPairData = async(options?: any): Promise<t.Pairs> => {
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

  let _allPairs: t.Pairs | undefined = undefined
  if (_storedObj && _storedObj.hasOwnProperty('object')) {
    _allPairs = new t.Pairs()
    _allPairs.deserialize(_storedObj.object)
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
      await p.storeObject(ALL_PAIRS_FILE, _allPairs.serialize())
    }
  }

  return _allPairs
}

export const getTokenData = async(options?: any): Promise<t.Tokens> => {
  const _defaultOpts = {
    ignorePersisted: false,
    persist: true
  }
  const _options = {..._defaultOpts, ...options}

  let _storedObj: any = undefined
  try {
    if (!_options.ignorePersisted) {
      _storedObj =  await p.retrieveObject(ALL_TOKENS_FILE)
    }
  } catch(ignoredError) {
    log.warn(`Unable to retrieve stored token data. Fetching from Graph Protocol.`)
  }

  let _allTokens: t.Tokens | undefined = undefined
  if (_storedObj && _storedObj.hasOwnProperty('object')) {
    _allTokens = new t.Tokens()
    _allTokens.deserialize(_storedObj.object)
  }

  let _storedAgeLimitExceeded = false
  if (_storedObj && _storedObj.hasOwnProperty('timeMs')) {
    const _storedInterval = Interval.fromDateTimes(DateTime.fromMillis(_storedObj.timeMs),
                                                   DateTime.now())
    _storedAgeLimitExceeded = _storedInterval.length() > MAX_DATA_AGE.toMillis()
  }

  if (!_allTokens || _storedAgeLimitExceeded) {
    _allTokens = await uniGraphV2.fetchAllTokensV2()

    if (_options.persist) {
      await p.storeObject(ALL_TOKENS_FILE, _allTokens.serialize())
    }
  }

  return _allTokens
}

export const constructPairGraph = async(allPairData: t.Pairs): Promise<t.PairGraph> =>
{
  const _g: t.PairGraph = new graphlib.Graph({directed: false,
                                              multigraph: false,   // Explain optimization here (attach array of pair ids for traversal speed)
                                              compound: false})
  
  let maxEdges = 1
  let maxEdgePair = ''
  for (const pairId of allPairData.getPairIds()) {
    const pair = allPairData.getPair(pairId)
    const { token0, token1 } = pair
    let edges = _g.edge(token0.id, token1.id)

    // Duplicate edges were only happening when graph vertices are symbols. There
    // are no duplicate pairs connecting by token IDs:
    if (edges) {
      log.warn(`Existing Edge Found:\n` +
               `${token0.id} (${token0.symbol}) <---> ${token1.id} (${token1.symbol})`)

      edges = {
        pairIds: [...edges.pairIds, pairId]
      }

      if (edges.pairIds.length > maxEdges) {
        maxEdges = edges.pairIds.length
        maxEdgePair = `${token0.id} (${token0.symbol}) <---> ${token1.id} (${token1.symbol})`
      }
    } else {
      edges = {
        pairIds: [pairId]
      }
    }
    _g.setEdge(token0.id, token1.id, edges)   // <-- pairID set for label and edge
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

const routeSearch = (g: t.PairGraph, 
                     hops: number, 
                     constraints: t.Constraints,
                     route: any, 
                     rolledRoutes: any, 
                     originAddr: string, 
                     destAddr: string): void => 
{
  if (constraints.maxDistance && hops < constraints.maxDistance) {
    let neighbors = g.neighbors(originAddr)
    hops++

    for (const neighbor of neighbors) {
      if (constraints.ignoreTokenIds && constraints.ignoreTokenIds.includes(neighbor)) {
        continue
      }

      // TODO: filter the pairIds of the edge with the constraints.ignorePairIds and then continue
      //       constructing the route.

      // Optimization: rather than make this a mulitgraph, represent all pairs in a single edge and
      //               store their ids as a property of that edge.
      const _route: any = [...route, { src: originAddr, dst: neighbor, pairIds: g.edge(originAddr, neighbor).pairIds }]
      if (neighbor === destAddr) {
        rolledRoutes.push(_route)
        continue
      }

      if (originAddr !== neighbor) {
        routeSearch(g, hops, constraints, _route, rolledRoutes, neighbor, destAddr)
      }
    }
  }
}

export const findRoutes = async(pairGraph: t.PairGraph,
                                srcAddr: string,
                                dstAddr: string,
                                constraints?: t.Constraints,
                                verbose?: boolean): Promise<any> =>
{
  const _defaultConstrs: t.Constraints = {
    maxDistance: 2
  }
  const _constraints: t.Constraints = {..._defaultConstrs, ...constraints}

  if (!srcAddr || !dstAddr) {
    log.error(`A source token address(${srcAddr}) and destination token ` +
              `address(${dstAddr}) are required.`)
    return
  }
  const _srcAddrLC = srcAddr.toLowerCase()
  const _dstAddrLC = dstAddr.toLowerCase()

  if (_srcAddrLC === _dstAddrLC) {
    log.error(`Money laundering not supported (same token routes, ${srcAddr} -> ${dstAddr}).`)
  }

  if (!pairGraph.hasNode(_srcAddrLC)) {
    log.error(`Source token address, ${srcAddr}, is not in the graph.`)
    return
  }
  if (!pairGraph.hasNode(_dstAddrLC)) {
    log.error(`Destination token address, ${dstAddr}, is not in the graph.`)
    return
  }

  if (_constraints.ignoreTokenIds && _constraints.ignoreTokenIds.includes(_srcAddrLC)) {
    log.error(`Source token address, ${srcAddr}, is constrained out of the route search.`)
    return
  }
  if (_constraints.ignoreTokenIds && _constraints.ignoreTokenIds.includes(_srcAddrLC)) {
    log.error(`Destination token address, ${dstAddr}, is constrained out of the route search.`)
    return
  }

  if (verbose) {
    log.info(`Finding routes from token ${srcAddr} to token ${dstAddr} ...`)
  }

  let hops = 0
  let route: any = []
  let rolledRoutes: any = []
  routeSearch(pairGraph, hops, _constraints, route, rolledRoutes, _srcAddrLC, _dstAddrLC)

  rolledRoutes.sort((a: any, b:any) => {
    return a.length - b.length    // Ascending order by route length
  })

  return rolledRoutes
}

export const routesToString = (rolledRoutes: any, tokenData: t.Tokens): string => 
{
  let _routeStr: string = '\n'

  let _routeNum = 0
  for (const _route of rolledRoutes) {
    _routeStr += `Route ${++_routeNum}:\n` +
                `----------------------------------------\n`
    for (const _pair of _route) {
      let srcStr = _pair.src
      let dstStr = _pair.dst
      if (tokenData) {
        srcStr += ` (${tokenData.getSymbol(_pair.src)})`
        dstStr += ` (${tokenData.getSymbol(_pair.dst)})`
      }

      _routeStr += `  ${srcStr} --> ${dstStr}, ${_pair.pairIds.length} pairs:\n`
      for (const _pairId of _pair.pairIds) {
        _routeStr += `      ${_pairId}\n`
      }
    }
    _routeStr += '\n'
  }

  return _routeStr
}

const computeTradeEstimates = (pairData: t.Pair, 
                               tokenData: t.Tokens,
                               srcAddrLC:string,
                               amount: string): any => 
{
  // 1. Get token0 & token1 decimals
  //
  const _token0Data = tokenData.getToken(pairData.token0.id)
  const _token1Data = tokenData.getToken(pairData.token1.id)
  if (!_token0Data) {
    throw new Error(`Unable to find token data for token id ${pairData.token0.id}.`)
  }
  if (!_token1Data) {
    throw new Error(`Unable to find token data for token id ${pairData.token1.id}.`)
  }
  const _token0Decimals = parseInt(_token0Data.decimals)
  const _token1Decimals = parseInt(_token1Data.decimals)

  // 2 Get normalized reserves (i.e. shift them both to have no decimal
  //     places but be aligned):
  //
  const { normReserve0, normReserve1 } =
    n.getNormalizedIntReserves(pairData.reserve0, pairData.reserve1)

  // 2. Construct token objects (except WETH special case)
  //
  const _token0 = (_token0Data.symbol === 'WETH') ?
    WETH[ChainId.MAINNET] :
    new Token(ChainId.MAINNET,
              getAddress(_token0Data.id),   // Use Ethers to get checksummed address
              _token0Decimals,
              _token0Data.symbol,
              _token0Data.name)

  const _token1 = (_token1Data.symbol === 'WETH') ?
    WETH[ChainId.MAINNET] :
    new Token(ChainId.MAINNET,
              getAddress(_token1Data.id),   // Use Ethers to get checksummed address
              _token1Decimals,
              _token1Data.symbol,
              _token1Data.name)

  // 3. Construct pair object after moving amounts correct number of
  //    decimal places (lookup from tokens in graph)
  //
  const _pair = new Pair( new TokenAmount(_token0, normReserve0),
                          new TokenAmount(_token1, normReserve1) )

  // 5. Construct the route & trade objects to determine the price impact.
  //
  const _srcToken = (srcAddrLC === _token0Data.id) ?
      { obj: _token0, decimals: _token0Decimals } :
      { obj: _token1, decimals: _token1Decimals }

  const _route = new Route([_pair], _srcToken.obj)
  const _trade = new Trade(_route,
                            new TokenAmount(_srcToken.obj, 
                                            n.getNormalizedValue(amount, _srcToken.decimals)),
                            TradeType.EXACT_INPUT)
  return {
    route: _route,
    trade: _trade
  }
}

export const printRouteCosts = (allPairData: t.Pairs,
                                tokenData: t.Tokens,
                                rolledRoutes: any,
                                amount: string): string =>
{
  let _routeCostStr = '\n'
  let _routeNum = 0
  for (const _route of rolledRoutes) {
    _routeCostStr += `\n` +
                     `Route ${++_routeNum}:\n` +
                     `----------------------------------------\n`

    const _measuredRoute:any = []

    for (const _pair of _route) {
      const _srcAddr = _pair.src
      const _dstAddr = _pair.dst
      _routeCostStr += `${_srcAddr} --> ${_dstAddr}:\n`

      for (const _pairId of _pair.pairIds) {
        const _pairData = allPairData.getPair(_pairId)
        if (_pairData) {
          try {
            const est = computeTradeEstimates(_pairData, tokenData, _srcAddr, amount)

            _routeCostStr += `     pair (${_pairId}):  ${est.trade.priceImpact.toSignificant(3)}\n`
            // TODO: delete this commented str when ready for prime time:
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
            log.error(`Failed computing trade estimates for ${_srcAddr} --> ${_dstAddr}:\n` +
                      `${JSON.stringify(_pairData, null, 2)}\n` +
                      error)
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
 *        src:  <address>
 *        dst:  <address>
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
 *        src:  <token LC address>
 *        dst:  <token LC address>
 *        pairs: [ 
 *          { 
 *            id: <id>, 
 *            impact: <% number>,
 *            token0: {
 *              price: <BigDecimal>,    // price in token1,
 *              symbol: '<UC symbol>',
 *              name: '<token name>',
 *              id: <token LC address>
 *            },
 *            token1: {
 *              price: <BigDecimal>,    // price in token0,
 *              symbol: '<UC symbol>'
 *              name: '<token name>',
 *              id: <token LC address>
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
 *        src:  <address>
 *        dst:  <address>
 *        pairId: <pairId>
 *      },
 *      ...
 *    ]
 *  ]
 * 
 * The 'unrolledCostedRoutes' datatype:
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
 * @param allPairData 
 * @param rolledRoutes 
 * 
 * TODO:
 *    - profile and if sensible, discard impact calcs if obviously insufficient
 *      liquidity
 *    - cache
 *    - heuristics
 */
export const costRolledRoutes = (allPairData: t.Pairs,
                                 tokenData: t.Tokens,
                                 amount: string,
                                 rolledRoutes: any): any =>
{
  const _costedRolledRoutes :any = []

  for (const _route of rolledRoutes) {
    const _costedRoute:any = []

    let failedRoute = false
    for (const _pair of _route) {
      const _costedSegment: any = {
        src: _pair.src,
        dst: _pair.dst,
        pairs: []
      }
      // log.debug(`costRolledRoutes:\n` +
      //           `pair - ${JSON.stringify(_pair, null, 2)}\n` +
      //           `_route - ${JSON.stringify(_route, null, 2)}\n`)

      const _srcAddr = _pair.src
      const _dstAddr = _pair.dst

      for (const _pairId of _pair.pairIds) {
        const _pairData = allPairData.getPair(_pairId)
        if (_pairData) {
          try {
            const est = computeTradeEstimates(_pairData, tokenData, _srcAddr, amount)
            const impact = est.trade.priceImpact.toSignificant(3)
            _costedSegment.pairs.push({
              id: _pairId,
              impact,
              token0: {
                price: _pairData.token0Price,
                symbol: _pairData.token0.symbol,
                name: _pairData.token0.name,
                id: _pairData.token0.id
              },
              token1: {
                price: _pairData.token1Price,
                symbol: _pairData.token1.symbol,
                name: _pairData.token1.name,
                id: _pairData.token1.id
              }
            })
          } catch(ignoredError) {
            // log.warn(`Failed computing impact estimates for ${_srcAddr} --> ${_dstAddr}: ${ignoredError}`)
            // Super verbose version for debugging ...
            // log.warn(`Failed computing impact estimates for ${_srcAddr} --> ${_dstAddr}:\n` +
            //          `${JSON.stringify(_pairData, null, 2)}\n` +
            //          ignoredError)
          }
        }
      }

      // Sometimes pairs have insufficient liquidity or other issues resulting in errors above
      // such as:
      //    - InsufficientReservesError
      //    - InsufficientInputAmountError 
      // In this situation, a costed segment may have no pairs and thus the route
      // cannot be completed, so we skip costing the remainder of the route and do not add it.
      if (_costedSegment.pairs.length === 0) {
        // log.debug(`Failed routed detected for ${_srcAddr} --> ${_dstAddr}`)
        failedRoute = true
      }
      _costedRoute.push(_costedSegment)
    }

    if (!failedRoute) {
      _costedRolledRoutes.push(_costedRoute)
    }
  }

  return _costedRolledRoutes
}

export const unrollCostedRolledRoutes = (costedRolledRoutes: any,
                                         tokenData: t.Tokens,
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
    // O(n^y) worst case, n=max num pairs per segment, y = num segments
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
        routeIdStr: '',
        srcData: {
          symbol: '',
          name: '',
          id: ''
        },
        dstData: {
          symbol: '',
          name: '',
          id: ''
        },
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

        // if (!_pairData) {
        //   log.debug(`Before failure:\n` +
        //             `  _segmentIndex: ${_segmentIndex}\n` +
        //             `  route length: ${_route.length}\n` +
        //             `  _index: ${_segmentPairIndices}\n` +
        //             `  pairs length: ${_pairs.length}\n` +
        //             `  _route:\n` +
        //             `${JSON.stringify(_route, null, 2)}\n`)
        // }
        const _totalImpact = _routeObj.totalImpact + parseFloat(_pairData.impact)
        _routeObj.totalImpact = (_totalImpact < 100.0) ? _totalImpact : 100.0
        _routeObj.numSwaps++
        if (_segmentIndex === 0) {
          _routeObj.routeStr += `${tokenData.getSymbol(_segment.src)} -> ${tokenData.getSymbol(_segment.dst)}`
          _routeObj.routeIdStr += `${_segment.src} -> ${_segment.dst}`
        } else {
          _routeObj.routeStr += ` -> ${tokenData.getSymbol(_segment.dst)}`
          _routeObj.routeIdStr += ` -> ${_segment.dst}`
        }
        _routeObj.orderedSwaps.push({
          src: _segment.src,
          dst: _segment.dst,
          id: _pairData.id,
          impact: _pairData.impact,
          token0: _pairData.token0,
          token1: _pairData.token1
        })

        if (_segmentIndex === 0) {
          // Handle top-level source symbol information:
          //
          const tokenProp = (_segment.src === _pairData.token0.id) ?
            'token0' : 'token1'
          _routeObj.srcData = {
            symbol: _pairData[tokenProp].symbol,
            name: _pairData[tokenProp].name,
            id: _pairData[tokenProp].id,
          }
        } 
        if (_segmentIndex === (_route.length-1)) {
          // Handle top-level destination symbol information:
          //
          const tokenProp = (_segment.dst === _pairData.token0.id) ?
            'token0' : 'token1'
          _routeObj.dstData = {
            symbol: _pairData[tokenProp].symbol,
            name: _pairData[tokenProp].name,
            id: _pairData[tokenProp].id,
          }
        }
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