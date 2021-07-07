import * as ds from './debugScopes'
import * as t from './types'
import { getUpdatedPairData } from './../graphProtocol/uniswapV2'
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

const log = ds.getLog('routing')


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

export const costRoutes = async (allPairData: t.Pairs,
                                 tokenData: t.Tokens,
                                 routes: t.VFRoutes,
                                 amount: number,
                                 maxImpact: number = 10.0,
                                 updatePairData: boolean = true,
                                 cacheEstimates: boolean = true): Promise<t.VFRoutes> =>
{
  const costedRoutes: t.VFRoutes = []
  const estimateCache: any = {}

  // Convert the specified double that is maxImpact to a fractional value with reasonable
  // precision:
  const maxImpactFrac = new Fraction(JSBI.BigInt(Math.floor(maxImpact * 1e18)), JSBI.BigInt(1e18))

  /* TODO:
   *  - expand and extend this into a proper TTL based cache in Redis or other.
   *  - examine this for higher performance opportunity
   * 
   * For now, aggregate the pairIds in the route and fetch their current stats
   * in aggregate.  TODO: add the block id to the lookup and put it in the 
   *                      updatedBlock.
   * 
   */
  if (updatePairData) {
    const start: number = Date.now()
    const pairIdsToUpdate: Set<string> = getAllPairsIdsOfAge(allPairData, routes)
    const updatedPairs: t.PairLite[] = await getUpdatedPairData(pairIdsToUpdate)
    const updateTimeMs = Date.now()
    allPairData.updatePairs(updatedPairs, updateTimeMs)
    log.debug(`Finished updating ${pairIdsToUpdate.size} pairs in ${Date.now() - start} ms`)
  }

  const startCostMs: number = Date.now()
  const estStats = {
    hits: 0,
    misses: 0,
    entries: 0
  }

  for (const route of routes) {
    let inputAmount = amount.toString()
    let exceededImpact = false
    let failedRoute = false

    for (const segment of route) {
      const pairData = allPairData.getPair(segment.pairId)
      let estimate: any = undefined
      try {
        if (cacheEstimates) {
          const estimateKey = `${inputAmount}-${segment.src}-${segment.pairId}`
          estimate = estimateCache[estimateKey]
          if (!estimate) {
            estStats.misses++
            estimate = computeTradeEstimates(pairData, tokenData, segment.src, inputAmount)
            
            estStats.entries++
            estimateCache[estimateKey] = estimate
          } else {
            estStats.hits++
          }
        } else {
          estimate = computeTradeEstimates(pairData, tokenData, segment.src, inputAmount)
        }
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

  // if (cacheEstimates) {
  //   log.debug(`cacheEstimates ON:\n` +
  //             `    ${routes.length} routes submitted for costing\n` +
  //             `    ${costedRoutes.length} costed routes\n` +
  //             `    ${JSON.stringify(estStats, null, 2)}\n\n`)
  // }

  log.debug(`costRoutes completed in ${Date.now() - startCostMs} ms.`)

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
      amountIn,
      amountOut,
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

const avgBlockMs = 15000
export const getAllPairsIdsOfAge = (allPairData: t.Pairs,
                                    routes: t.VFRoutes,
                                    ageMs: number = 1 * avgBlockMs): Set<string> =>
{
  const now = Date.now()

  const pairIds = new Set<string>()
  for (const route of routes) {
    for (const segment of route) {

      // Don't add the segment if it's been updated within ageMs
      const pairData = allPairData.getPair(segment.pairId)
      if (pairData &&
          pairData.updatedMs &&
          ((now - pairData.updatedMs) < ageMs)) {
          continue
      }

      pairIds.add(segment.pairId)
    }
  }

  // log.debug(`getAllPairsIdsOfAge: returning ${pairIds.size} older than ${ageMs} ms.`)

  return pairIds
}