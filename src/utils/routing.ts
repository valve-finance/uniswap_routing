import * as ds from './debugScopes'
import * as t from './types'
import { getIntegerString  } from './misc'
import { ChainId,
         Token,
         WETH,
         TokenAmount,
         Route,
         Trade,
         TradeType, 
         Pair,
         Fraction} from '@uniswap/sdk'
import { getAddress } from '@ethersproject/address'
import JSBI from 'jsbi'

const log = ds.getLog('commands')


const _routeSearch = (g: t.PairGraph, 
                     hops: number, 
                     constraints: t.Constraints,
                     route: any, 
                     rolledRoutes: t.VFStackedRoutes, 
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
        _routeSearch(g, hops, constraints, _route, rolledRoutes, neighbor, destAddr)
      }
    }
  }
}

export const findRoutes = async(pairGraph: t.PairGraph,
                                srcAddr: string,
                                dstAddr: string,
                                constraints?: t.Constraints,
                                verbose?: boolean): Promise<t.VFStackedRoutes> =>
{
  let rolledRoutes: t.VFStackedRoutes= []

  const _defaultConstrs: t.Constraints = {
    maxDistance: 2
  }
  const _constraints: t.Constraints = {..._defaultConstrs, ...constraints}

  if (!srcAddr || !dstAddr) {
    log.error(`A source token address(${srcAddr}) and destination token ` +
              `address(${dstAddr}) are required.`)
    return rolledRoutes
  }
  const _srcAddrLC = srcAddr.toLowerCase()
  const _dstAddrLC = dstAddr.toLowerCase()

  if (_srcAddrLC === _dstAddrLC) {
    log.error(`Money laundering not supported (same token routes, ${srcAddr} -> ${dstAddr}).`)
  }

  if (!pairGraph.hasNode(_srcAddrLC)) {
    log.error(`Source token address, ${srcAddr}, is not in the graph.`)
    return rolledRoutes
  }
  if (!pairGraph.hasNode(_dstAddrLC)) {
    log.error(`Destination token address, ${dstAddr}, is not in the graph.`)
    return rolledRoutes
  }

  if (_constraints.ignoreTokenIds && _constraints.ignoreTokenIds.includes(_srcAddrLC)) {
    log.error(`Source token address, ${srcAddr}, is constrained out of the route search.`)
    return rolledRoutes
  }
  if (_constraints.ignoreTokenIds && _constraints.ignoreTokenIds.includes(_srcAddrLC)) {
    log.error(`Destination token address, ${dstAddr}, is constrained out of the route search.`)
    return rolledRoutes
  }

  if (verbose) {
    log.info(`Finding routes from token ${srcAddr} to token ${dstAddr} ...`)
  }

  let hops = 0
  let route: any = []
  _routeSearch(pairGraph, hops, _constraints, route, rolledRoutes, _srcAddrLC, _dstAddrLC)

  rolledRoutes.sort((a: any, b:any) => {
    return a.length - b.length    // Ascending order by route length
  })

  return rolledRoutes
}

export const routesToString = (rolledRoutes: t.VFStackedRoutes, tokenData: t.Tokens): string => 
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

export const unstackRoutes = (stackedRoutes: t.VFStackedRoutes): t.VFRoutes =>
{
  let routes: t.VFRoutes= []

  for (const stackedRoute of stackedRoutes) {
    // Unstack the route by determining the number of pairs in each segment and
    // then constructing all possible routes implied by the stacked pairs of each
    // segment. For example considering the following stacked route:
    //
    //   src --> segment1 --> segment2 --> dst
    //              p1           p2
    //                           p3
    //
    // The algorithm herein 'unstacks' this route creating two routes, implied
    // by the stacked pairs:
    //
    //  src --> p1 --> p2 --> dst
    //
    //  src --> p1 --> p3 --> dst
    //
    const segmentPairCounts: number[] = []    // Count of number of pairs in each segment.
    const segmentPairIndices: number[] = []   // Indices to be used in the conversion described 
                                              // in the comment above.
    for (let idx = 0; idx < stackedRoute.length; idx++) {
      segmentPairCounts[idx] = stackedRoute[idx].pairIds.length
      segmentPairIndices[idx] = 0
    }

    while (segmentPairIndices[segmentPairIndices.length-1] < segmentPairCounts[segmentPairCounts.length-1]) {
      const route: t.VFRoute = []
      for (let segIdx = 0; segIdx < stackedRoute.length; segIdx++) {
        const stackedSegment = stackedRoute[segIdx]
        const pairIndex = segmentPairIndices[segIdx]
        const pairId = stackedSegment.pairIds[pairIndex]

        const segment: t.VFSegment = {
          src: stackedSegment.src,
          dst: stackedSegment.dst,
          pairId
        }

        route.push(segment)
      }

      routes.push(route)

      // Ingrement the pair indices for the segments.  (Basically a counter that counts to the number of
      // pairs for each segment, then incrementing the pair index of the next segment when the number of
      // pairs for the previous segment is reached.):
      //
      for (let segIdx = 0; segIdx < stackedRoute.length; segIdx++) {
        segmentPairIndices[segIdx]++
        if ((segmentPairIndices[segIdx] < segmentPairCounts[segIdx]) || (segIdx === stackedRoute.length - 1)) {
          break
        } else {
          segmentPairIndices[segIdx] = 0
        }
      }
    }
  }
  
  return routes
}

export const costRoutes = (allPairData: t.Pairs,
                           tokenData: t.Tokens,
                           routes: t.VFRoutes,
                           amount: number,
                           maxImpact:number = 10.0): t.VFRoutes =>
{
  const costedRoutes: t.VFRoutes = []

  let inputAmount = amount.toString()
  // Convert the specified double that is maxImpact to a fractional value with reasonable
  // precision:
  const maxImpactFrac = new Fraction(JSBI.BigInt(Math.floor(maxImpact * 1e18)), JSBI.BigInt(1e18))

  for (const route of routes) {
    let exceededImpact = false
    let failedRoute = false

    for (const segment of route) {
      const pairData = allPairData.getPair(segment.pairId)
      let estimate: any = undefined
      try {
        estimate = computeTradeEstimates(pairData, tokenData, segment.src, inputAmount)
      } catch (ignoredError) {
        // log.warn(`Failed computing impact estimates for ${segment.src} --> ${segment.dst}:\n` +
        //          `${JSON.stringify(pairData, null, 2)}\n` +
        //          ignoredError)
        failedRoute = true
        break
      }
      
      // TODO: see why this next line is not working, for now, though parseFloat workaround:
      // if (estimate.trade.priceImpact.greaterThan(maxImpactFrac)) {
      if (parseFloat(estimate.trade.priceImpact.toSignificant(18)) > maxImpact) {
        exceededImpact = true
        break
      }

      // TODO: optimization - compute the cumulative impact and if that exceeds
      //       maxImpactFrac, then break.

      // Two different types at play here--Big & Currency (Currency is Big wrapped with decimal info for a token).
      // See more here:
      //    - https://github.com/Uniswap/uniswap-sdk-core/tree/main/src/entities/fractions
      //    - specifically fraction.ts and currencyAmount.ts
      //
      segment.impact = estimate.trade.priceImpact.toSignificant(18)
      segment.srcAmount = estimate.trade.inputAmount.toExact()
      segment.dstAmount = estimate.trade.outputAmount.toExact()

      // TODOs: 
      //       1. This is ugly and will lose precision, we need to either complete the TODO on the
      //       computeTradeEstimates method (estimate entire routes), or find an alternate solution
      //       to prevent precision loss.
      //
      //       2. Check assumption that slippage is multiplied into outputAmount (may need to use
      //          other methods in Uni API / JSBI etc.)
      //
      inputAmount = estimate.trade.outputAmount.toExact()
    }

    if (failedRoute) {
      // log.debug(`Route failed in estimation, not adding:\n${JSON.stringify(route, null, 2)}`)
      continue
    }

    if (exceededImpact) {
      // log.debug(`Route exceeded impact, not adding:\n${JSON.stringify(route, null, 2)}`)
      continue
    }

    costedRoutes.push(route)
  }

  return costedRoutes
}

export const convertRoutesToLegacyFmt = (allPairData: t.Pairs, tokenData: t.Tokens, routes: t.VFRoutes): any => {
  const legacyRoutesFmt: any = []
  for (const route of routes) {
    let remainingImpactPercent = 1
    const numSwaps = route.length
    let routeStr = ''
    let routeIdStr = ''
    let srcData: any = {}
    let dstData: any = {}
    let amountIn: string | undefined = ''
    let amountOut: string | undefined = ''
    const orderedSwaps = []

    for (let segIdx = 0; segIdx < route.length; segIdx++) {
      const segment = route[segIdx]

      const pairData = allPairData.getPair(segment.pairId)
      const { token0, token1 } = pairData

      const swap: any = {
        src: segment.src,
        dst: segment.dst,
        id: segment.pairId,
        impact: segment.impact,
        amountIn: segment.srcAmount,
        amountOut: segment.dstAmount,
        token0,
        token1
      }

      orderedSwaps.push(swap)

      if (segment.impact !== undefined) {
        remainingImpactPercent = remainingImpactPercent * (1 - parseFloat(segment.impact)/100)
      }

      if (segIdx === 0) {
        routeStr += `${tokenData.getSymbol(segment.src)} > ${tokenData.getSymbol(segment.dst)}`
        routeIdStr += `${segment.src} > ${segment.dst}`
      } else {
        routeStr += ` > ${tokenData.getSymbol(segment.dst)}`
        routeIdStr += ` > ${segment.dst}`
      }

      if (segIdx === 0) {
        srcData = tokenData.getToken(segment.src)
        amountIn = segment.srcAmount
      }
      if (segIdx === route.length - 1) {
        dstData = tokenData.getToken(segment.dst)
        amountOut = segment.dstAmount
      }
    }
    
    const legacyRoute: any = {
      totalImpact: (1 - remainingImpactPercent) * 100,
      numSwaps,
      routeStr,
      routeIdStr,
      srcData,
      dstData,
      orderedSwaps
    }

    legacyRoutesFmt.push(legacyRoute)
  }

  return legacyRoutesFmt
}

/**
 *  TODO TODO TODO:
 * 
 *    1. This method should take advantage of complete routes
 *       to ensure that precision is not lost beyond 18 decimals
 *       instead of being called for a single route segment at a time.
 *        - the toExact method means we might be able to construct a
 *          trade (if another method exists) where we specify the last
 *          input.
 * 
 *    2. If 1 is not yet completed, a more resolute way of passing in
 *       an input value is desireable.
 */
const computeTradeEstimates = (pairData: t.Pair, 
                               tokenData: t.Tokens,
                               srcAddrLC:string,
                               amount: string): any => 
{
  // 1. Get token0 & token1 decimals
  //
  const token0 = tokenData.getToken(pairData.token0.id)
  const token1 = tokenData.getToken(pairData.token1.id)
  if (!token0) {
    throw new Error(`Unable to find token data for token id ${pairData.token0.id}.`)
  }
  if (!token1) {
    throw new Error(`Unable to find token data for token id ${pairData.token1.id}.`)
  }
  const token0Decimals = parseInt(token0.decimals)
  const token1Decimals = parseInt(token1.decimals)

  // 2. Construct token objects (except WETH special case)
  //
  const token0UniObj = (token0.symbol === 'WETH') ?
    WETH[ChainId.MAINNET] :
    new Token(ChainId.MAINNET,
              getAddress(token0.id),   // Use Ethers to get checksummed address
              token0Decimals,
              token0.symbol,
              token0.name)

  const token1UniObj = (token1.symbol === 'WETH') ?
    WETH[ChainId.MAINNET] :
    new Token(ChainId.MAINNET,
              getAddress(token1.id),   // Use Ethers to get checksummed address
              token1Decimals,
              token1.symbol,
              token1.name)

  // 4. Construct pair object after moving amounts correct number of
  //    decimal places (lookup from tokens in graph)
  //
  const reserve0IntStr = getIntegerString(pairData.reserve0, token0Decimals)
  const reserve1IntStr = getIntegerString(pairData.reserve1, token1Decimals)
  const _pair = new Pair( new TokenAmount(token0UniObj, reserve0IntStr),
                          new TokenAmount(token1UniObj, reserve1IntStr) )

  // 5. Construct the route & trade objects to determine the price impact.
  //
  const _srcToken = (srcAddrLC === token0.id) ?
      { obj: token0UniObj, decimals: token0Decimals } :
      { obj: token1UniObj, decimals: token1Decimals }

  const _route = new Route([_pair], _srcToken.obj)
  const _tradeAmount = new TokenAmount(_srcToken.obj, getIntegerString(amount, _srcToken.decimals))
  const _trade = new Trade(_route, _tradeAmount, TradeType.EXACT_INPUT)
  
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
            const impact = est.trade.priceImpact.toSignificant(6)
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
