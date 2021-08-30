import * as ds from '../utils/debugScopes'
import * as t from '../utils/types'
import { WETH_ADDR, USDC_ADDR, WETH_ADDRS_LC, NO_BLOCK_NUM } from '../utils/constants'
import { getUpdatedPairData } from '../graphProtocol/uniswapV2'
import { filterToPairIdsOfAge, getRoutePairIdsNotBlockNum, getEstimatedUSD, filterToPairIdsNotBlockNum } from './quoting'
import { stringify } from 'uuid'

const log = ds.getLog('routeGraph')



// New slightly more optimized alg.: 
//
const _routeSearch = (g: t.PairGraph, 
                     hops: number, 
                     constraints: t.Constraints,
                     route: any, 
                     rolledRoutes: t.VFStackedRoutes,
                     prevOriginAddr: string,
                     originAddr: string, 
                     destAddr: string): void => 
{
  let neighbors = g.neighbors(originAddr)
  hops++

  for (const neighbor of neighbors) {
    if (neighbor === destAddr) {
      // Optimization: rather than make this a mulitgraph, represent all pairs in a single edge and
      //               store their ids as a property of that edge.
      const _route: any = [...route, { src: originAddr, dst: neighbor, pairIds: g.edge(originAddr, neighbor).pairIds }]
      rolledRoutes.push(_route)
    } else if (constraints.maxDistance && hops < constraints.maxDistance) {
      if (neighbor === originAddr ||
          neighbor === prevOriginAddr ||    // Prevent cycle back to last origin addr (i.e. FEI TRIBE cycle of FEI > WETH > FEI > TRIBE).
                                            // We limit max hops to 3 so cycles like FEI > x > y > FEI aren't
                                            // a consideration (otherwise we'd need to expand this search's
                                            // memory of previous visits.)
          (constraints.ignoreTokenIds && constraints.ignoreTokenIds.includes(neighbor))) {
        continue
      }

      // Optimization: rather than make this a mulitgraph, represent all pairs in a single edge and
      //               store their ids as a property of that edge.
      const _route: any = [...route, { src: originAddr, dst: neighbor, pairIds: g.edge(originAddr, neighbor).pairIds }]
      _routeSearch(g, 
                   hops,
                   constraints,
                   _route,
                   rolledRoutes,
                   originAddr,
                   neighbor,
                   destAddr)
    }
  }
}

export const findRoutes = (pairGraph: t.PairGraph,
                           srcAddr: string,
                           dstAddr: string,
                           constraints?: t.Constraints,
                           verbose?: boolean): t.VFStackedRoutes =>
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

  // Special case: routing from WETH as source, reduce max hops to 1 as this starting node has 30k+
  //               neighbors and doesn't finish in reasonable time.
  if (WETH_ADDRS_LC.includes(_srcAddrLC)) {
    log.debug(`findRoutes:  detected routing from wETH, reducing max hops to 1.`)
    _constraints.maxDistance = 1
  }

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
  _routeSearch(pairGraph,
               hops,
               _constraints,
               route,
               rolledRoutes,
               '',
               _srcAddrLC,
               _dstAddrLC)

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

export const annotateRoutesWithUSD = async (allPairData: t.Pairs,
                                            wethPairDict: t.WethPairIdDict,
                                            routes: t.VFRoutes,
                                            updatePairData: boolean=true,
                                            blockNumber: number = NO_BLOCK_NUM): Promise<void> => {
  if (blockNumber !== NO_BLOCK_NUM) {
    const start: number = Date.now()
    // Get all the <token>:WETH pair IDs, get the WETH/USDC pair ID
    //
    const pairIdsUSD: Set<string> = new Set<string>()
    for (const route of routes) {
      for (const seg of route) {
        if (seg.src !== WETH_ADDR) {
          pairIdsUSD.add(wethPairDict[seg.src])
        }

        if (seg.dst !== WETH_ADDR) {
          pairIdsUSD.add(wethPairDict[seg.dst])
        }
      }
    }
    pairIdsUSD.add(wethPairDict[USDC_ADDR])

    const pairIdsToUpdate = filterToPairIdsNotBlockNum(allPairData, pairIdsUSD, blockNumber)
    const updatedPairs: t.PairLite[] = await getUpdatedPairData(pairIdsToUpdate, blockNumber)
    const updateTimeMs = Date.now()
    allPairData.updatePairs(updatedPairs, updateTimeMs)
    log.debug(`annotateRoutesWithUSD: Finished updating ${pairIdsToUpdate.size} pairs to block ${blockNumber} in ${Date.now() - start} ms`)
  } else if (updatePairData) {
    const start: number = Date.now()
    // Get all the <token>:WETH pair IDs, get the WETH/USDC pair ID
    //
    const pairIdsUSD: Set<string> = new Set<string>()
    for (const route of routes) {
      for (const seg of route) {
        if (seg.src !== WETH_ADDR) {
          pairIdsUSD.add(wethPairDict[seg.src])
        }

        if (seg.dst !== WETH_ADDR) {
          pairIdsUSD.add(wethPairDict[seg.dst])
        }
      }
    }
    pairIdsUSD.add(wethPairDict[USDC_ADDR])

    const pairIdsToUpdate = filterToPairIdsOfAge(allPairData, pairIdsUSD)
    const updatedPairs: t.PairLite[] = await getUpdatedPairData(pairIdsToUpdate)
    const updateTimeMs = Date.now()
    allPairData.updatePairs(updatedPairs, updateTimeMs)
    log.debug(`annotateRoutesWithUSD: Finished updating ${pairIdsToUpdate.size} pairs in ${Date.now() - start} ms`)
  }

  for (const route of routes) {
    for (const segment of route) {
      if (segment.srcAmount) {
        segment.srcUSD = getEstimatedUSD(allPairData, wethPairDict, segment.src, segment.srcAmount)
      }
      if (segment.dstAmount) {
        segment.dstUSD = getEstimatedUSD(allPairData, wethPairDict, segment.dst, segment.dstAmount)
      }
    }
  }
}

export const annotateRoutesWithSymbols = (tokenData: t.Tokens, 
                                          routes: t.VFRoutes,
                                          includeIdLast4: boolean = false): void => {
  for (const route of routes) {
    for (const seg of route) {
      seg.srcSymbol = tokenData.getSymbol(seg.src)
      seg.dstSymbol = tokenData.getSymbol(seg.dst)
      if (includeIdLast4) {
        seg.srcSymbol += ` (${seg.src.substr(seg.src.length-1-4, 4)})`
        seg.dstSymbol += ` (${seg.dst.substr(seg.dst.length-1-4, 4)})`
      }
    }
  }
}

export const annotateRoutesWithGainToDest = (routes: t.VFRoutes): void => {
  /**
   * Annotate routes with their gain at each segment to final destination.  The gain of one segment to the
   * the destination is (1 - impact).  The gain through two segments to the destination is (1 - impact_seg1) * (1 - impact_seg2).
   * If you take the amount in to the trade and multiply it by the gain, you know how much you'll receive at
   * the completion of the transaction.  The gain to destination is useful in understanding if a multi-segment path
   * is better than an adjacent path.
   */
  for (const route of routes) {
    let gainToDest: undefined | number = undefined
    for (let segIdx = route.length - 1; segIdx >= 0; segIdx--) {
      const seg: t.VFSegment = route[segIdx]
      const impact = (seg.impact === undefined) ? 0.0 : (parseFloat(seg.impact) / 100.0)
      const gain = 1.0 - impact
      gainToDest = (gainToDest === undefined) ? gain : gainToDest * gain
      seg.gainToDest = gainToDest
    }
  }
}

export const annotateRoutesWithYieldToDest = (routes: t.VFRoutes): void => {
  /**
   * Yield to destination is the ratio of input tokens of the current segment
   * to the whole route's destination tokens.
   * 
   * This is useful when factoring in price differences (i.e. a price / exchange might
   * be totally skewed yet slippage might be low, this allows comparison of price data)
   * 
   */
  for (const route of routes) {
    let finalDestTokens: number = 0
    for (let segIdx = route.length - 1; segIdx >= 0; segIdx--) {
      const seg: t.VFSegment = route[segIdx]
      if (segIdx === route.length - 1) {
        finalDestTokens = (seg.dstAmount) ? parseFloat(seg.dstAmount) : 0.0
      }
      const srcTokens = (seg.srcAmount) ? parseFloat(seg.srcAmount) : 0.0
      seg.yieldToDest = (isNaN(srcTokens)) ? NaN : finalDestTokens / srcTokens
    }
  }
}

/**
 * pruneRoutes removes any routes that are below the specified minimum gain to
 * destination. This is done by examining the 1st segment of each route's gain to
 * destination (which is cumulative for the entire route). Similarly, only the top
 * maxRoutes routes are returned, which is accomplished by sorting on gain to destination
 * and returning the first maxRoutes routes.
 * 
 * @param routes 
 * @param options 
 * @returns prunedRoutes in descending order by gain to destination
 */
export const pruneRoutes = (routes: t.VFRoutes, options?: any): t.VFRoutes =>
{
  const _options: any = { maxRoutes: 25, minGainToDest: 0.0, ...options }

  // 1. Compute the maximum yield to destination of all the routes to
  //    normalize them so they can be compared across routes as a percentage:
  //
  let maxYieldToDest = 0.0
  for (const route of routes) {
    if (route.length > 0) {
      // The first one is the yield across the entire route
      const seg: t.VFSegment = route[0]

      if (seg.yieldToDest &&
          !isNaN(seg.yieldToDest) &&
          seg.yieldToDest > maxYieldToDest) {
        maxYieldToDest = seg.yieldToDest
      }
    }
  }

  const prunedRoutes: t.VFRoutes = routes.filter((route: t.VFRoute) => {
    if (route.length < 1) {
      return false
    }

    const firstSeg: t.VFSegment = route[0]
    const totalGainToDest = (firstSeg.gainToDest) ? firstSeg.gainToDest : 0
    const normalizedYieldToDest = (firstSeg.yieldToDest ? firstSeg.yieldToDest : 0) / maxYieldToDest

    // log.debug(`Route:\n` +
    //           `  normalizedYTFD = ${normalizedYieldToDest}\n` +
    //           `  totalGainToDest = ${totalGainToDest}\n` +
    //           `  options.minGTD = ${options.minGainToDest}\n` )

    if (totalGainToDest < options.minGainToDest) {
      return false
    }

    // Pricing problem detection (good slippage route with pricing totally messed,
    // i.e. DAI --> ZRX via:  DAI -> BSG -> WETH -> ZRX)
    // then if the yield is way off the gain, throw the route out.
    //
    // Because these values are normalized, this is a relativistic figure and thus
    // throws away any severe outliers.
    //
    if (normalizedYieldToDest < totalGainToDest) {
      log.warn(`Pruning problem pricing route:\n` +
               `  normalizedYTFD = ${normalizedYieldToDest}\n` +
               `  totalGainToDest = ${totalGainToDest}` )
              //  `  route:\n${JSON.stringify(route, null, 2)}`)
      return false
    }

    return true
  })

  prunedRoutes.sort((routeA: t.VFRoute, routeB: t.VFRoute) => {
    if (routeA.length && 
        routeB.length &&
        routeA[0].gainToDest &&
        routeB[0].gainToDest) {
      return routeB[0].gainToDest - routeA[0].gainToDest    // descending sort
    }
    return 0.0
  })

  return prunedRoutes.slice(0, _options.maxRoutes)
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
        amountInUSD: segment.srcUSD,
        amountOutUSD: segment.dstUSD,
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