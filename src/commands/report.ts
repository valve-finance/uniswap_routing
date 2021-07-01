import * as ds from './../utils/debugScopes'
import * as t from './../utils/types'
import * as c from './../utils/constants'
import * as m from './../utils/misc'
import * as r from './../utils/routing'
import { initUniData } from '../utils/data'

const log = ds.getLog('test')

export const report = async(minLiquidityUSD=10000, 
                            minTokenReserves=10000,
                            maxRoutes=100): Promise<void> => {
  const _uniData: t.UniData = await initUniData()
  
  // 1. Gather all pairs with USD liquidity greater than <X> USD
  // 2. Remove pairs containing any of the hub token ids
  // 3. Create a unique list of the remaining token ids
  const filteredPairs = []
  const filteredTokenIds = new Set<string>()
  for (const pairId of _uniData.pairData.getPairIds()) {
    const pairData = _uniData.pairData.getPair(pairId)

    if (c.noHubTokenCnstr.ignoreTokenIds &&
        (c.noHubTokenCnstr.ignoreTokenIds.includes(pairData.token0.id) ||
         c.noHubTokenCnstr.ignoreTokenIds.includes(pairData.token1.id))) {
      continue
    }

    const reserveUSD = parseFloat(pairData.reserveUSD)    // TODO: big number(scaled) or big decimal
    if (reserveUSD < minLiquidityUSD) {
      continue
    }
    const reserveToken1 = parseFloat(pairData.reserve0)
    const reserveToken2 = parseFloat(pairData.reserve1)
    if (reserveToken1 < minTokenReserves || reserveToken2 < minTokenReserves) {
      continue
    }

    const _pairDataCopy = JSON.parse(JSON.stringify(pairData))    // TODO: needed? If so, better quality deep copy.
    _pairDataCopy.reserveUSDFloat = reserveUSD
    filteredPairs.push(_pairDataCopy)

    filteredTokenIds.add(pairData.token0.id)
    filteredTokenIds.add(pairData.token1.id)
  }

  log.info(`Found ${filteredTokenIds.size} unique tokens in pools with more than ${minLiquidityUSD} USD ` +
           `that are not hub tokens (WETH, DAI, USDC, USDT, COMP, MKR).`)

  log.info(`Searching for routes between them that aren't through hub tokens with ${c.noHubTokenCnstr.maxDistance} hops or less.`)

  // 4. For each token id in the unique list, try to compute a route to each other token id
  //      - O(n^2)
  //      - Ignore routes that don't have any hops (i.e. a single pool)
  const routeResults: any = {}
  let routeAttemptCount = 0
  let routeTimeSumMS = 0
  for (const srcTokenId of filteredTokenIds) {
    for (const dstTokenId of filteredTokenIds) {
      if (srcTokenId === dstTokenId) {
        continue
      }
      const srcTokenIdLC = srcTokenId
      const dstTokenIdLC = dstTokenId

      const resultKey = `${srcTokenIdLC}-${dstTokenIdLC}`
      if (!routeResults.hasOwnProperty(resultKey)) {
        const startMS = Date.now()
        const _routes = await r.findRoutes(_uniData.pairGraph, srcTokenIdLC, dstTokenIdLC, c.noHubTokenCnstr)
        const durationMS = Date.now() - startMS
        routeTimeSumMS += durationMS
        routeAttemptCount++

        if (_routes.length) {
          let singlePoolFound = false
          // Check to ensure determined route(s) does not include a single pool:
          for (const _route of _routes) {
            if (_route.length <= 1) {
              singlePoolFound = true
              // log.debug(`Single pool found for ${resultKey}:\n${JSON.stringify(_route, null, 2)}\n`)
              break
            }
          }
          if (singlePoolFound) {    // Skip this src-dst as it has it's own pool.
            continue
          }

          // log.debug(`(${durationMS} ms): Found routes from ${srcTokenIdLC} to ${dstTokenIdLC}.`)
          routeResults[resultKey] = _routes
          // } else {
          //   log.debug(`(${durationMS} ms): No routes from ${srcTokenIdLC} to ${dstTokenIdLC}.`)
        }
      }
    }
  }
  log.info(`Attempted to find ${routeAttemptCount} routes in ${routeTimeSumMS} ms (average = ${routeTimeSumMS/routeAttemptCount}).`)
  log.info(`Succeeded ${Object.keys(routeResults).length} times.`)

  // 5. Report on the top <Y> routes based on liquidity
  //      - Sort by the highest minimum liquidity of the route
  const routeReport = []
  for (const routesKey in routeResults) {
    const routesData = routeResults[routesKey]

    // routesKey to symbols:
    const routesKeyEle = routesKey.split('-')
    const symbolKey = `${_uniData.tokenData.getSymbol(routesKeyEle[0])} --> ` +
                      `${_uniData.tokenData.getSymbol(routesKeyEle[1])}`

    let routeIndex = 0
    let maxRouteLiquidity = 0
    let routeIdStr = ''

    for (const routeData of routesData) {
      routeIndex++

      const routeIds: string[] = []

      // Determine the maximum liquidity through the entire trade (i.e. if one segment has lower
      // liquidity than another, then it is the maximum liquidity possible for a single path trade):
      //
      let maxSegmentLiquidity = -1
      let segIdx = 0
      for (const segment of routeData) {
        let maxPairLiquidity = 0
        for (const pairId of segment.pairIds) {
          const pairData = _uniData.pairData.getPair(pairId)
          if (pairData) {
            const reserveUSDFloat = parseFloat(pairData.reserveUSD)   // TODO: bignum or bigdec
            if (reserveUSDFloat > maxPairLiquidity) {
              maxPairLiquidity = reserveUSDFloat
              routeIds[segIdx] = pairId
            }
          }
        }
        if (maxSegmentLiquidity === -1 || maxSegmentLiquidity > maxPairLiquidity) {
          maxSegmentLiquidity = maxPairLiquidity
        }
        segIdx++
      }

      routeData['maxSegmentLiquidity'] = maxSegmentLiquidity
      //log.info(`${symbolKey} #${routeIndex}: $${maxSegmentLiquidity} USD`)
      if (maxSegmentLiquidity > maxRouteLiquidity) {
        maxRouteLiquidity = maxSegmentLiquidity
        routeIdStr = routeIds.join(' -> ')
      }
    }

    routeReport.push({
      symbolKey,
      maxRouteLiquidity,
      routeIdStr
    })
  }
  routeReport.sort((a: any, b:any) => {return b.maxRouteLiquidity - a.maxRouteLiquidity})  // Desc. order
  for (let index = 0; index < maxRoutes; index++) {
    let leftStr = m.padStr(`${index+1}. ` + routeReport[index].symbolKey + ' :') 
    log.info(`${leftStr}\t${routeReport[index].maxRouteLiquidity.toFixed(2)} liquidity(USD)\t${routeReport[index].routeIdStr}`)
  }
}

