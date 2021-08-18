import * as c from './../utils/constants'
import * as ds from './../utils/debugScopes'
import * as t from './../utils/types'
import { REPORTS_DIR, 
         PARAMS_FILE,
         REPORT_FILE_NAME,
         getReportParametersHash,
         loadReportSummaries,
         reportSummariesToOptions } from '../utils/report'
import { getUniRouteV2 } from '../utils/uniswapSDK'
import { deepCopy } from '../utils/misc'
import { initUniData } from '../utils/data'
import { sanitizeProperty, sanitizePropertyType } from '../utils/misc'
import * as rg from '../routing/routeGraph'
import * as rt from '../routing/routeTree'
import { getEstimatedTokensFromUSD } from '../routing/quoting'
import { RouteCache } from '../routing/routeCache'
import { quoteRoutes } from '../routing/quoting'

import express from 'express'
import http from 'http'
import cors from 'cors'
import helmet from 'helmet'
import requestIp from 'request-ip'
import socketio from 'socket.io'
import { v4 as uuidv4 } from 'uuid'
import crawl from 'tree-crawl'
import { RouteData, RouteStats, TradeStats, TradeYieldData } from '../routing/types'
import * as fs from 'fs'
import { logger } from 'ethereum-abi-types-generator/node_modules/ethersv5'

// TODO: back with Redis instead of mem
const rateLimitMem = require('./../middleware/rateLimiterMem.js')


const log = ds.getLog('socketServer')
const USDC_CONVERT_ERR = 'Cannot convert USDC to source tokens.'


// Placeholder until we get bull / redis in
const _getRequestId = (): string => {
  return uuidv4()
}

const _preprocessRouteReq = (source: string,
                             dest: string,
                             amount: string,
                             options?: any): any =>
{
  let sanitizeStr = sanitizeProperty('source', source)
  sanitizeStr += sanitizeProperty('dest', dest)
  sanitizeStr += sanitizeProperty('amount', amount)
  if (amount) {
    let amountValue = parseFloat(amount)
    if (isNaN(amountValue) || amountValue < 0) {
      sanitizeStr += '"amount" must be a string that parses to a number greater than 0.\n'
    }
  }

  const _options: any = {
    max_hops: {
      value: 3,
      min: 1,
      max: c.MAX_HOPS,
      type: 'int'
    },
    max_results: {
      value: 5,
      min: 1,
      max: c.MAX_RESULTS,
      type: 'int'
    },
    max_impact: {
      value: 25.0,
      min: 0.0,
      max: 100.0,
      type: 'float'
    },
    update_data: {
      value: true,
      type: 'boolean'
    },
    ignore_max_hops: {
      value: false,
      type: 'boolean'
    }
  }


  if (options) {
    for (const property in _options) {
      if (options.hasOwnProperty(property)) {
        const propertyParams = _options[property]
        sanitizeStr += sanitizePropertyType(`options.${property}`, options[property])

        let value: number = NaN
        if (propertyParams.type === 'int') {
          value = parseInt(options[property])
        } else if (propertyParams.type === 'float') {
          value = parseFloat(options[property])
        } else if (propertyParams.type === 'boolean' && options.hasOwnProperty(property)) {
          _options[property].value = (options[property] === 'true') ? true : false
          continue
        }

        if (isNaN(value)) {
          sanitizeStr += `options.${property} cannot be parsed from a string to a ${propertyParams.type}.\n`
          continue
        }

        // Special case for max hops--ignore it if specified:
        if ( !(property === 'max_hops' &&
               options.hasOwnProperty('ignore_max_hops') && options['ignore_max_hops'] === 'true') ) {
          if (value > propertyParams.max || value < propertyParams.min) {
            sanitizeStr += `options.${property} must be parsable from a string to a ${propertyParams.type} ` +
                            `between ${propertyParams.min} and ${propertyParams.max}, inclusive.\n`
            continue
          }
        }

        _options[property].value = value
      }
    }
  }

  return {
    options: _options,
    error: sanitizeStr
  } 
}

const _processRouteReq = async(uniData: t.UniData,
                               routeCache: RouteCache,
                               source: string,
                               dest: string,
                               amount: string,
                               options: any): Promise<any> =>
{
  const _routeStats = new RouteStats()

  const _routesP: Promise<t.VFRoutes> = routeCache.getRoutes(source, dest, { maxHops: options.max_hops.value })
                                                   .catch(error => {
                                                     // TODO: signal an error in routing to the client
                                                     return []
                                                   })

  const _uniRouteP: Promise<any> = getUniRouteV2(source, dest, amount)
                                   .catch(error => { return { error } })
  
  const _results = await Promise.all([_routesP, _uniRouteP])
  const _routes: t.VFRoutes = deepCopy(_results[0])    // <-- TODO: cleanup route 
                                                       //           cache to dc routes by default.
  const _uniRouteResult: any = _results[1]
  const _uniRoute = _uniRouteResult.routeObj

  _routeStats.routesFound = (_routes && _routes.length) ? _routes.length : 0
  _routeStats.uniRouteFound = (_uniRoute && _uniRoute.routePath && _uniRoute.routePath.length > 0)
  if (!_routeStats.uniRouteFound) {
    _routeStats.uniError = _uniRouteResult.error ? _uniRouteResult.error : 'Unknown error.'
  }

  /**
   *    Tag the official UNI route and insert it if it's not in the cache result, so that
   *    it gets costed.
   */
  if (_uniRoute && _uniRoute.routePath && _uniRoute.routePath.length > 0) {
    let foundUniRoute = false
    const uniRoutePathAsStr = _uniRoute.routePath.join(',').toLowerCase()
    for (const _route of _routes) {
      const _routePath: string[] = []

      for (let idx = 0; idx < _route.length; idx++) {
        const _seg: t.VFSegment = _route[idx]
        if (idx === 0) {
          _routePath.push(_seg.src)
        }
        _routePath.push(_seg.dst)
      }

      if (_routePath.join(',').toLowerCase() === uniRoutePathAsStr) {
        foundUniRoute = true
        _route.forEach((_seg: t.VFSegment) => _seg.isUni = true)

        // NOTE: _uniRoute.expectedConvertQuote is the amount in tokens
        //       estimated by UNI on chain. Might be interesting to compare
        //       if update data is enabled (otherwise it would just mismatch).

        break
      }
    }

    if (!foundUniRoute) {
      log.warn(`Uni route not in results, building and adding.`)
      try {
        const newRoute: t.VFRoute = []
        for (let idx = 0; idx < _uniRoute.routePath.length-1; idx++) {
          const src = _uniRoute.routePath[idx].toLowerCase()
          const dst = _uniRoute.routePath[idx+1].toLowerCase()

          const edgeData: any = uniData.pairGraph.edge(src, dst)
          let pairId = ''
          if (edgeData && edgeData.hasOwnProperty('pairIds') ) {
            if (edgeData.pairIds.length >= 1) {
              pairId = edgeData.pairIds[0]
            }
            if (edgeData.pairIds.length !== 1)  {
              log.warn(`Building UNI route, edge data pairIds length is ${edgeData.pairIds.length} for ${src} to ${dst}.`)
            }
          } else {
            throw Error(`Unable to build UNI route; no edge data or pairIds for edge ${src} to ${dst}`)
          }

          newRoute.push({
            src,
            dst,
            pairId,
            isUni: true
          })
        }

        _routes.push(newRoute)
      } catch (error) {
        log.error(error)
      }
    }
  } else {
    log.warn(`No UNI route available for ${amount} ${source} --> ${dest}.`)
  }

  const _quotedRoutes: t.VFRoutes = await quoteRoutes(uniData.pairData, 
                                                      uniData.tokenData,
                                                      _routes,
                                                      amount,
                                                      options.max_impact.value,
                                                      options.update_data.value)

  _quotedRoutes.sort((a: t.VFRoute, b: t.VFRoute) => {    // Sort descending by amount of destination token received
    const aLastDstAmount = a[a.length-1].dstAmount
    const bLastDstAmount = b[b.length-1].dstAmount
    const aDstAmount = aLastDstAmount ? parseFloat(aLastDstAmount) : 0.0
    const bDstAmount = bLastDstAmount ? parseFloat(bLastDstAmount) : 0.0
    return bDstAmount - aDstAmount
  })
  _routeStats.routesMeetingCriteria = _quotedRoutes.length

  const _requestedQuotedRoutes: t.VFRoutes = _quotedRoutes.slice(0, options.max_results.value)
  if (uniData.wethPairData) {
    await rg.annotateRoutesWithUSD(uniData.pairData,
                                  uniData.wethPairData,
                                  _requestedQuotedRoutes,
                                  options.update_data.value)
  }

  return { routes: _requestedQuotedRoutes, uniRoute: _uniRoute.routeText, routeStats: _routeStats}
}

const _processMultiPathRouteReq = async(_uniData: t.UniData,
                                        _routeCache: RouteCache,
                                        source: string,
                                        dest: string,
                                        amount: string,
                                        _options: any):Promise<RouteData> =>
{
  // 1. Get the single path routes:
  //
  const { routes, routeStats } = await _processRouteReq(_uniData,
                                                        _routeCache,
                                                        source,
                                                        dest,
                                                        amount,
                                                        _options)
  rg.annotateRoutesWithGainToDest(routes)
  rg.annotateRoutesWithSymbols(_uniData.tokenData, routes)
  const routesTree: rt.TradeTreeNode | undefined = rt.buildTradeTree(routes)

  // 1.5 Get the Uniswap yield/output:
  //
  const uniRouteArr = routes.filter((route: t.VFRoute) => {
    return route &&
            route.length &&
            route[0].isUni === true
  })
  let uniYield: TradeYieldData = {
    usd: 0.0,
    token: 0.0
  }
  if (uniRouteArr && uniRouteArr.length && uniRouteArr[0] && uniRouteArr[0].length) {
    const uniRoute = uniRouteArr[0]
    const lastUniSeg = uniRoute[uniRoute.length - 1]
    uniYield.usd = lastUniSeg.dstUSD ? parseFloat(lastUniSeg.dstUSD) : 0.0
    uniYield.token = lastUniSeg.dstAmount ? parseFloat(lastUniSeg.dstAmount) : 0.0
  }

  // 2. Perform filtering and pruning of the single path routes
  //
  const prunedRoutes = rg.pruneRoutes(routes, {maxRoutes: 10, minGainToDest: 0.05})
  routeStats.mpRoutesMeetingCriteria = prunedRoutes.length

  // TODO: removeRoutesWithLowerOrderPairs algorithm needs attention, it's done hastily and
  //       is sub-optimal (i.e. might remove the best route if the shared pair occurs later
  //       in the tree order/level):
  const filteredRoutes = rg.removeRoutesWithLowerOrderPairs(prunedRoutes, _options)
  routeStats.mpRoutesAfterRmDupLowerOrderPair = filteredRoutes.length

  const filteredRoutesTree: rt.TradeTreeNode | undefined = rt.buildTradeTree(filteredRoutes)
  let valveOnePathYield: TradeYieldData = {
    usd: 0.0,
    token: 0.0
  }
  if (filteredRoutes && filteredRoutes.length && filteredRoutes[0] && filteredRoutes[0].length) {
    const bestRoute = filteredRoutes[0]
    const lastSeg = bestRoute[bestRoute.length - 1]
    valveOnePathYield.usd = lastSeg.dstUSD ? parseFloat(lastSeg.dstUSD) : 0.0
    valveOnePathYield.token = lastSeg.dstAmount ? parseFloat(lastSeg.dstAmount) : 0.0
  }


  // 3. Construct a multi-path route:
  //
  let valveMultiPathYield: TradeYieldData = {
    usd: 0.0,
    token: 0.0
  }
  const costedMultirouteTree = filteredRoutesTree
  if (costedMultirouteTree) {
    await rt.costTradeTree(_uniData.pairData,
                           _uniData.tokenData,
                           amount,
                           costedMultirouteTree,
                           false /* update pair data <-- TODO: tie to property */)

    if (_uniData.wethPairData) {
      await rt.annotateTradeTreeWithUSD(_uniData.pairData,
                                        _uniData.wethPairData,
                                        costedMultirouteTree,
                                        false /* update pair data */)
    }

    // Calculate the net result of the multi-route trade by summing
    // all the leaf nodes:
    //
    crawl(costedMultirouteTree,
          (node, context) => {
            if (node.children.length === 0 && node.value.trades) {
              // Multiple trades not yet supported, just use first property for now:
              const properties = Object.keys(node.value.trades)
              if (properties && properties.length) {
                const tradeId = properties[0]
                const trade = node.value.trades[tradeId]
                valveMultiPathYield.usd += trade.outputUsd ? parseFloat(trade.outputUsd) : 0.0
                valveMultiPathYield.token += parseFloat(trade.outputAmount)
              }
            }
          },
          { order: 'pre' })
  }

  // 4. Construct the route data object to return
  //
  const srcSymbol = _uniData.tokenData.getSymbol(source)
  const dstSymbol = _uniData.tokenData.getSymbol(dest)
  const routeData = new RouteData(source,
                                  srcSymbol,
                                  dest,
                                  dstSymbol)
  routeData.setInputAmount(parseFloat(amount))
  if (routesTree) {
    routeData.setSinglePathElementsFromTree(routesTree)
    routeData.setUniYield(uniYield)
    routeData.setSinglePathValveYield(valveOnePathYield)
  }

  if (costedMultirouteTree) {
    routeData.setMultiPathElementsFromTree(costedMultirouteTree)
    routeData.setMultiPathValveYield(valveMultiPathYield)
  }

  routeData.setRouteStats(routeStats)
  return routeData
}

const _routeDataToPages = (routeData: RouteData): any => 
{
  let pages: any = []
  const uniYield = routeData.getUniYield()
  const routeStr = `${routeData.getSourceSymbol()} (${routeData.getSourceAddr()}) --> `+
                                      `${routeData.getDestSymbol()} (${routeData.getDestAddr()})`

  const spYield = routeData.getSinglePathValveYield()
  const spElements = routeData.getSinglePathElements()
  if (uniYield && spYield && spElements) {
    /*
     * Create this report row array:
     *
     *     Route comparison:
     *       Uniswap V2 Yield:  X tokens ($Y USD)
     *       Valve Yield:  Z tokens ($W USD)
     *       V% ([Q tokens, P USD]) [more than, less than, same as] Uniswap V2
     * 
     */
    const description: any = [ {text: routeStr}, {text: ''} ]

    let uniYieldStr = `${uniYield.token} tokens`
    if (uniYield.usd && !isNaN(uniYield.usd)) {
      uniYieldStr += ` ($${uniYield.usd.toFixed(2)} USD)`
    }
    description.push({text: `Uniswap V2 route yields ${uniYieldStr}.`})

    let spYieldStr = `${spYield.token} tokens`
    if (spYield.usd && !isNaN(spYield.usd)) {
      spYieldStr += ` ($${spYield.usd.toFixed(2)} USD)`
    }
    description.push({text: `Valve Finance route yields ${spYieldStr}.`})
    
    let comparisonStr = ''
    const delta = routeData.getPercentDifferenceSinglePath()
    const difference = routeData.getDifferenceSinglePath()
    const differenceUSD = routeData.getDifferenceSinglePath(true)
    if (!isNaN(delta)) {
      comparisonStr = `${delta.toFixed(6)}%`

      if (!isNaN(differenceUSD)) {
        comparisonStr += ` ($${differenceUSD.toFixed(2)} USD)`
      } else if (!isNaN(difference)) {
        comparisonStr += ` (${difference.toFixed(6)} tokens)`
      }
      if (delta > 0) {
        comparisonStr += ', more than Uniswap V2.'
      } else if (delta < 0) {
        comparisonStr += ', less than Uniswap V2.'
      } else {
        comparisonStr += ', same as Uniswap V2.'
      }
    }
    description.push({text: comparisonStr, textStyle: 'bold'})

    const { routesFound, routesMeetingCriteria } = routeData.getRouteStats()
    let routeStatsStr: string = ''
    routeStatsStr += (routesFound !== undefined) ? `${routesFound} routes found.` : ''
    routeStatsStr += (routesMeetingCriteria !== undefined) ?` ${routesMeetingCriteria} match criteria supplied.` : ''
    description.push({text: routeStatsStr})

    pages.push({
      title: 'Single Path Routes',
      description,
      elements: spElements,
      trade: {
        srcSymbol: routeData.getSourceSymbol(),
        dstSymbol: routeData.getDestSymbol(),
        isMultiroute: false,
        delta,
        uni: uniYield,
        valve: spYield
      }
    })
  }

  const mpYield = routeData.getMultiPathValveYield()
  const mpElements = routeData.getMultiPathElements()
  if (uniYield && mpYield && mpElements) {
    /*
     * Create this report row array:
     *
     *     Multi-Path Route Comparison:
     *       Uniswap V2 Yield:  X tokens ($Y USD)
     *       Valve Yield:  Z tokens ($W USD)
     *       V% ([Q tokens, P USD]) [more than, less than, same as] Uniswap V2
     * 
     */
    const description: any = [ {text: routeStr}, {text: ''} ]

    let uniYieldStr = `${uniYield.token} tokens`
    if (uniYield.usd && !isNaN(uniYield.usd)) {
      uniYieldStr += ` ($${uniYield.usd.toFixed(2)} USD)`
    }
    description.push({text: `Uniswap V2 route yields ${uniYieldStr}.`})

    let mpYieldStr = `${mpYield.token} tokens`
    if (mpYield.usd && !isNaN(mpYield.usd)) {
      mpYieldStr += ` ($${mpYield.usd.toFixed(2)} USD)`
    }
    description.push({text: `Valve Finance route yields ${mpYieldStr}.`})
    
    let comparisonStr = ''
    const delta = routeData.getPercentDifferenceMultiPath()
    const difference = routeData.getDifferenceMultiPath()
    const differenceUSD = routeData.getDifferenceMultiPath(true)
    if (!isNaN(delta)) {
      comparisonStr = `${delta.toFixed(6)}%`

      if (!isNaN(differenceUSD)) {
        comparisonStr += ` ($${differenceUSD.toFixed(2)} USD)`
      } else if (!isNaN(difference)) {
        comparisonStr += ` (${difference.toFixed(6)} tokens)`
      }
      if (delta > 0) {
        comparisonStr += ', more than Uniswap V2.'
      } else if (delta < 0) {
        comparisonStr += ', less than Uniswap V2.'
      } else {
        comparisonStr += ', same as Uniswap V2.'
      }
    }
    description.push({text: comparisonStr, textStyle: 'bold'})
    
    const { routesFound, mpRoutesMeetingCriteria, mpRoutesAfterRmDupLowerOrderPair } = routeData.getRouteStats()
    let routeStatsStr: string = ''
    routeStatsStr += (routesFound !== undefined) ? `${routesFound} routes found.` : ''
    routeStatsStr += (mpRoutesMeetingCriteria !== undefined) ? ` ${mpRoutesMeetingCriteria} match criteria supplied.` : ''
    routeStatsStr += (mpRoutesAfterRmDupLowerOrderPair !== undefined) ? ` ${mpRoutesAfterRmDupLowerOrderPair} after removing dup. lower order pairs.` : ''
    description.push({text: routeStatsStr})

    pages.push({
      title: `Multi-Path Route`,
      description,
      elements: mpElements,
      trade: {
        srcSymbol: routeData.getSourceSymbol(),
        dstSymbol: routeData.getDestSymbol(),
        isMultiroute: true,
        delta,
        uni: uniYield,
        valve: mpYield
      }
    })
  }

  return pages
}

const _createReport = (reportParameters: any,
                       paramsHash: string,
                       tradeStats: TradeStats[]): any => 
{
  const reportPage: any = {
    title: 'Report Summary',
    description: [ {text: reportParameters.analysisDescription},
                   {text: `${tradeStats.length} trades between tokens analyzed.`} ],
    content: [],
    elements: [],
    paramsHash
  }
  const { content } = reportPage
 

  // Parameters Section:
  //
  content.push({row: 'Report Parameters', type: 'section'})
  for (const key in reportParameters) {
    content.push({row: `${key}: ${reportParameters[key]}`, textStyle: 'indent'})
  }


  const ZERO_THRESHOLD = 0.0000000000000000001   // 1^-18

  // Single Path Route Results Section:
  //
  //////////////////////////////////////////////////////////////////////////////
  content.push({row: 'Single Path Route Results', type: 'section'})

  // Sort in desc. order of single-path delta to get ordered section rows
  tradeStats.sort((statA: TradeStats, statB: TradeStats) => {
    const spDeltaA = statA.spDelta ? statA.spDelta : 0
    const spDeltaB = statB.spDelta ? statB.spDelta : 0
    return spDeltaB - spDeltaA
  })

  // Stats for single-path for section are gathered first so section titles can include counts:
  const spBetter: any = []
  const spWorse: any = []
  const spSame: any = []
  const spIncomparable: any = []
  const uniFail: any = []
  const spFail: any = []
  const spCriteriaFail: any = []
  const spUsdcConvFail: any = []

  for (const tradeStat of tradeStats) {
    const { src, dst, srcSymbol, dstSymbol, routeStats } = tradeStat
    let row = `${srcSymbol} --> ${dstSymbol}`

    if (!routeStats.uniRouteFound && routeStats.vfiError !== USDC_CONVERT_ERR) {
      // Build list of routes that UNI failed to get a route for:
      const uniRow = row + `, (${routeStats.uniError})`
      uniFail.push({row: uniRow, src, dst, view: false})
    }

    if (routeStats.vfiError === USDC_CONVERT_ERR) {
      row += `, (${routeStats.vfiError}.)`
      spUsdcConvFail.push({row, src, dst, view: false})
    } else if (routeStats.routesFound === 0) {
      // Build list of routes that Valve FI failed to get a route for:
      row += ', (No route found or unable to convert USD amount to tokens for trade.)'
      spFail.push({row, src, dst, view: false})
    } else if (routeStats.routesMeetingCriteria === 0) {
      // Build list of routes that did not meet user specified criteria:
      row += ', (No routes met specified criteria.)'
      spCriteriaFail.push({row, src, dst, view: false})
    } else {
      // Build lists of routes that were better, the same, incomparable or worse than UNI
      if (tradeStat.spDelta !== undefined) {
        const numTokensInStr = (isNaN(tradeStat.inputAmount)) ? '' : tradeStat.inputAmount.toFixed(6)
        const numTokensOutStr = (tradeStat.spYield && tradeStat.spYield.token) ?
          tradeStat.spYield.token.toFixed(6) : ''
        row += (numTokensInStr && numTokensOutStr) ?
            `, (${numTokensInStr} --> ${numTokensOutStr})` : ''

        const { spDelta } = tradeStat
        if (isNaN(spDelta)) {
          /* special case, uni result is 0, would give delta of infinity,
            likely due to no UNI route. */
          spIncomparable.push({row, src, dst, view: true})
        } else if (Math.abs(spDelta) < ZERO_THRESHOLD) {
          /* same - can't compare equality on doubles, so threshold */
          spSame.push({row, src, dst, view: true})
        } else if (tradeStat.spDelta > 0) {
          row = `+${tradeStat.spDelta.toFixed(6)}% better, ` + row
          spBetter.push({row, src, dst, view: true})
        } else if (tradeStat.spDelta < 0) {
          row = `${tradeStat.spDelta.toFixed(6)}% worse, ` + row
          spWorse.push({row, src, dst, view: true})
        } else  {
          log.error(`Failed to categorize trade for report, continuing:`, tradeStat)
        }
      }
    }
  }

  content.push({row: `${spBetter.length} Better Performing Single Path Routes`, type: 'sub-section', collapsible: (spBetter.length > 0)})
  spBetter.forEach((row: any) => { content.push(row)})

  content.push({row: `${spWorse.length} Lower Performing Single Path Routes`, type: 'sub-section', collapsible: (spWorse.length > 0)})
  spWorse.forEach((row: any) => { content.push(row)})
  
  content.push({row: `${spSame.length} Same Performing Single Path Routes`, type: 'sub-section', collapsible: (spSame.length > 0)})
  spSame.forEach((row: any) => { content.push(row)})
  
  content.push({row: `${spIncomparable.length} Incomparable Performance Single Path Routes`, type: 'sub-section', collapsible: (spIncomparable.length > 0)})
  spIncomparable.forEach((row: any) => { content.push(row)})

  
  // Multi Path Route Results Section:
  //
  //////////////////////////////////////////////////////////////////////////////
  content.push({row: 'Multi-Path Route Results', type: 'section'})

  // Sort in desc. order of multi-path delta to get ordered section rows
  tradeStats.sort((statA: TradeStats, statB: TradeStats) => {
    const mpDeltaA = statA.mpDelta ? statA.mpDelta : 0
    const mpDeltaB = statB.mpDelta ? statB.mpDelta : 0
    return mpDeltaB - mpDeltaA
  })

  // Stats for multi-path for section are gathered first so section titles can include counts:
  const mpBetter: any = []
  const mpWorse: any = []
  const mpSame: any = []
  const mpIncomparable: any = []
  const mpCriteriaFail: any = []

  for (const tradeStat of tradeStats) {
    const { src, dst, srcSymbol, dstSymbol, routeStats } = tradeStat
    let row = `${srcSymbol} --> ${dstSymbol}`

    if (routeStats.vfiError === USDC_CONVERT_ERR ||
        routeStats.routesFound === 0 ||
        routeStats.routesMeetingCriteria === 0) {
      // Do nothing (reported these in single path section)
    } else if (routeStats.mpRoutesMeetingCriteria === 0) {
      // Build list of routes that did not meet user specified criteria:
      row += ', (No routes met specified multi-path criteria.)'
      mpCriteriaFail.push({row, src, dst, view: false})
    } else {
      // Build lists of routes that were better, the same, incomparable or worse than UNI
      if (tradeStat.mpDelta !== undefined) {
        const numTokensInStr = (isNaN(tradeStat.inputAmount)) ? '' : tradeStat.inputAmount.toFixed(6)
        const numTokensOutStr = (tradeStat.mpYield && tradeStat.mpYield.token) ?
          tradeStat.mpYield.token.toFixed(6) : ''
        if (numTokensInStr && numTokensOutStr) {
          row = `${numTokensInStr} ${srcSymbol} --> ${numTokensOutStr} ${dstSymbol}`
        }

        const { mpDelta } = tradeStat
        if (isNaN(mpDelta)) {
          /* mpecial case, uni result is 0, would give delta of infinity,
            likely due to no UNI route. */
          mpIncomparable.push({row, src, dst, view: true})
        } else if (Math.abs(mpDelta) < ZERO_THRESHOLD) {
          /* same - can't compare equality on doubles, so threshold */
          mpSame.push({row, src, dst, view: true})
        } else if (tradeStat.mpDelta > 0) {
          row = `+${tradeStat.mpDelta.toFixed(6)}% better, ` + row
          mpBetter.push({row, src, dst, view: true})
        } else if (tradeStat.mpDelta < 0) {
          row = `${tradeStat.mpDelta.toFixed(6)}% worse, ` + row
          mpWorse.push({row, src, dst, view: true})
        } else  {
          log.error(`Failed to categorize trade for report, continuing:`, tradeStat)
        }
      }
    }
  }

  content.push({row: `${mpBetter.length} Better Performing Multi-Path Routes`, type: 'sub-section', collapsible: (mpBetter.length > 0)})
  mpBetter.forEach((row: any) => { content.push(row)})

  content.push({row: `${mpWorse.length} Lower Performing Multi-Path Routes`, type: 'sub-section', collapsible: (mpWorse.length > 0)})
  mpWorse.forEach((row: any) => { content.push(row)})
  
  content.push({row: `${mpSame.length} Same Performing Multi-Path Routes`, type: 'sub-section', collapsible: (mpSame.length > 0)})
  mpSame.forEach((row: any) => { content.push(row)})
  
  content.push({row: `${mpIncomparable.length} Incomparable Performance Multi-Path Routes`, type: 'sub-section', collapsible: (mpIncomparable.length > 0)})
  mpIncomparable.forEach((row: any) => { content.push(row)})
  
  // Exceptions Section:
  //
  //////////////////////////////////////////////////////////////////////////////
  content.push({row: 'Exceptions Preventing Analysis', type: 'section'})

  content.push({row: `${uniFail.length} Routes Uniswap V2 Could Not Find`, type: 'sub-section', collapsible: (uniFail.length > 0)})
  uniFail.forEach((row: any) => { content.push(row)})

  content.push({row: `${spFail.length} Routes Valve Finance Could Not Find`, type: 'sub-section', collapsible: (spFail.length > 0)})
  spFail.forEach((row: any) => { content.push(row)})
  
  content.push({row: `${spCriteriaFail.length} Routes That Did Not Fit The Specified Criteria`, type: 'sub-section', collapsible: (spCriteriaFail.length > 0)})
  spCriteriaFail.forEach((row: any) => { content.push(row)})
  
  content.push({row: `${mpCriteriaFail.length} Routes That Did Not Fit The Specified Multi-Path Criteria`, type: 'sub-section', collapsible: (mpCriteriaFail.length > 0)})
  mpCriteriaFail.forEach((row: any) => { content.push(row)})
  
  content.push({row: `${spUsdcConvFail.length} Routes That Could Not Be Evaluated From An Initial Amount In $USD`, type: 'sub-section', collapsible: (spUsdcConvFail.length > 0)})
  spUsdcConvFail.forEach((row: any) => { content.push(row)})

  return reportPage
}

export const startSocketServer = async(port: string): Promise<void> => {
  log.info(`Starting Uniswap Routing Socket Server on port ${port}...\n` +
           `(wait until 'READY' appears before issuing requests)`)

  const app = express()

  app.set('trust proxy', true)
  app.use(cors())
  app.use(helmet())
  app.use(requestIp.mw())
  if (process.env.NODE_ENV != 'development') {
    app.use(rateLimitMem)
  } else {
    log.warn('Rate limiting disabled in development environment.')
  }
  app.use(express.json({limit: '5mb'}))
  app.use(express.urlencoded({extended: true, limit: '5mb'}))

  app.get(/.*/, async (req:any, res:any) => {
    res.status(c.OK).send('Welcome to Uniswap V2 Route Optimization Service.')
  })

  app.post(/.*/, async (req:any, res:any) => {
    res.status(c.OK).send('Welcome to Uniswap V2 Route Optimization Service.')
  })

  const server = new http.Server(app)

  let _uniData: t.UniData = await initUniData()
  let _routeCache = new RouteCache(_uniData.pairGraph, c.deprecatedTokenCnstr)
 
  let _reportSummaries = await loadReportSummaries()
  let _reportOptions = reportSummariesToOptions(_reportSummaries)

  let _blockNumberOptions = [
    {
      key: _uniData.pairData.getLowestBlockNumber(),
      text: _uniData.pairData.getLowestBlockNumber().toString(),
      value: _uniData.pairData.getLowestBlockNumber()
    }
  ]

  // Lightweight copy of _uniData that permits quote updates on real-time side:
  //
  let serializedPairData = deepCopy(_uniData.pairData.serialize())
  const pairDataDC = new t.Pairs()
  pairDataDC.deserialize(serializedPairData)

  let _uniDataQuotable: t.UniData = {
    pairGraph: _uniData.pairGraph,
    tokenData: _uniData.tokenData,
    pairData: pairDataDC,               // Can modify with up-to-date quotes w/o affecting report
    wethPairData: _uniData.wethPairData
  }

  //  NOTE: 
  //        - May need to look at rate limiting socket requests/commands too. (TODO)
  //        - May need to tune/multiple process/core to deal with
  //          potential transport close errors when this gets too busy.
  //          See: https://github.com/socketio/socket.io/issues/3025
  //
  //  See these resources for cors options/examples:
  //        - https://github.com/expressjs/cors#configuration-options
  //        - https://socket.io/docs/v3/handling-cors/
  //
  const corsObj = {
      origin: ["http://localhost:3000", "https://playground.valve.finance"],
      methods: ["GET", "POST"]
    }
  //
  const socketServer = new socketio.Server(server, { cors: corsObj })

  const clientSockets: any = {}
  socketServer.on('connection', (socket: socketio.Socket) => {
    clientSockets[socket.id] = socket
    log.debug(`${socket.id} connected (${Object.keys(clientSockets).length} connections).`)


    socket.on('route', async (source: string,
                              dest: string,
                              amount: string,
                              options?: any) => {
      const requestId = _getRequestId()
      const reqType = 'route'
      socket.emit(reqType, { requestId, status: 'Analyzing input parameters.' })

      log.debug(`\nRoute Request: ${amount} ${source} to ${dest}` +
                `\n  options: ${JSON.stringify(options, null, 0)}\n`)
      
      const _startMs = Date.now()
      const sanitizeObj = _preprocessRouteReq(source, dest, amount, options)
      const _options = sanitizeObj.options
      const _error = sanitizeObj.error
      
      if (_error !== '') {
        log.warn(_error)
        socket.emit(reqType, { requestId, status: 'Error, input parameters are incorrect.', error: _error })
      } else {
        const routeReqObj = await _processRouteReq(_uniDataQuotable, _routeCache, source, dest, amount, _options)
        const legacyFmtRoutes = rg.convertRoutesToLegacyFmt(_uniDataQuotable.pairData, _uniDataQuotable.tokenData, routeReqObj.routes)
        socket.emit(reqType, 
                    {
                      requestId,
                      status: 'Completed request.',
                      routes: legacyFmtRoutes,
                      uniRoute: routeReqObj.routeText
                    })
      }

      log.debug(`Processed request in ${Date.now() - _startMs} ms`)
    })

    socket.on('usdTokenQuote', (source: string, usdAmount: string) => {
      let tokens = ''

      if (!isNaN(parseFloat(usdAmount)) && _uniDataQuotable.wethPairData) {
        tokens = getEstimatedTokensFromUSD(_uniDataQuotable.pairData,
                                           _uniDataQuotable.wethPairData,
                                           source.toLowerCase(),
                                           usdAmount)
      }

      socket.emit('usdTokenQuote', {tokens})
    }) 

    socket.on('multipath', async(source: string,
                                 dest: string,
                                 amount: string,
                                 options?: any) => {
      const requestId = _getRequestId()
      const reqType = 'multipath'
      socket.emit(reqType, { requestId, status: 'Analyzing input parameters.' })

      log.debug(`\nMultipath Route Request: ${amount} ${source} to ${dest}` +
                `\n  options: ${JSON.stringify(options, null, 0)}\n`)
      
      const _startMs = Date.now()
      const sanitizeObj = _preprocessRouteReq(source, dest, amount, options)
      const _options = sanitizeObj.options
      const _error = sanitizeObj.error
      
      if (_error !== '') {
        log.warn(_error)
        socket.emit(reqType, { requestId, status: 'Error, input parameters are incorrect.', error: _error })
        return
      }

      _options.max_results.value = 20 
      const routeData = await _processMultiPathRouteReq(_uniDataQuotable,
                                                        _routeCache,
                                                        source,
                                                        dest,
                                                        amount,
                                                        _options)
      const pages = _routeDataToPages(routeData)

      socket.emit(reqType, {
        requestId,
        pages
      })
      log.debug(`Processed request in ${Date.now() - _startMs} ms`)
    })

    socket.on('report-init', async (clientId: string) => {
      socket.emit('report-init',
                  { 
                    reportOptionsState: {
                      blockNumberOptions: _blockNumberOptions,
                      existingAnalysisOptions: _reportOptions,
                      tokenSetOptions: [
                        {
                          key: 'TSO_0',
                          text: 'Uniswap Default List',
                          value: 'Uniswap Default List'
                        },
                        {
                          key: 'TSO_1',
                          text: 'Tokens in Pairs with $100M Liquidity',
                          value: 'Tokens in Pairs with $100M Liquidity',
                        },
                        {
                          key: 'TSO_2',
                          text: 'Tokens in Pairs with $10M Liquidity',
                          value: 'Tokens in Pairs with $10M Liquidity',
                        },
                        {
                          key: 'TSO_3',
                          text: 'Tokens in Pairs with $1M Liquidity',
                          value: 'Tokens in Pairs with $1M Liquidity',
                        },
                        {
                          key: 'TSO_4',
                          text: 'Tokens in pairs that do not include WETH',
                          value: 'Tokens in pairs that do not include WETH',
                        }
                      ],
                      proportioningAlgorithmOptions: [
                        {
                          key: 'PAO_0',
                          text: '(Maximum Gain to Destination)^4',
                          value: 'MGTD4'
                        }
                      ],
                      maximumSwapsPerPathOptions: [
                        {
                          key: 'MSPPO_0',
                          text: '1',
                          value: '1'
                        },
                        {
                          key: 'MSPPO_1',
                          text: '2',
                          value: '2'
                        },
                        {
                          key: 'MSPPO_2',
                          text: '3',
                          value: '3'
                        }
                      ]
                    }
                  })
    })

    socket.on('report-select', async (paramsHash: string) => {
      const requestId = _getRequestId()
      const reqType = 'report-select'
      const path = [ REPORTS_DIR, paramsHash, REPORT_FILE_NAME]
      const reportFilePath = path.join('/')

      const responseObj = await new Promise((resolve) => {
        fs.readFile(reportFilePath, (err, data) => {
          if (err) {
            resolve({
              requestId,
              error: `Failed to read ${reportFilePath}.\n${err}`
            })
          } else {
            try {
              const reportObj = JSON.parse(data.toString())
              resolve({
                requestId,
                pages: [reportObj]
              })
            } catch (parseErr) {
              resolve({
                requestId,
                error: `Failed to process contents of ${reportFilePath}.\n${parseErr}`
              })
            }
          }
        })
      })

      socket.emit(reqType, responseObj)
    })

    socket.on('report-generate', async (reportParameters: any) => {
      // Training Wheels:
      let maxTrades = 100


      const requestId = _getRequestId()
      const reqType = 'report-generate'

      const {
        analysisDescription,
        tokenSet,
        tradeAmount,
        proportioningAlgorithm,
        maximumSwapsPerPath,
        maximumSegmentSlippage,
        maximumRouteSlippage,
        maximumConcurrentPaths,
        maximumRoutesConsidered,
        removeLowerOrderDuplicatePairs,
        limitSwapsForWETH } = reportParameters
      
      // -1. Make sure an area to store the report output exists
      //
      const path = []
      path.push(REPORTS_DIR)
      if (!fs.existsSync(path.join('/'))) {
        fs.mkdirSync(path.join('/'))
      }

      const paramsHash = getReportParametersHash(reportParameters)
      path.push(paramsHash)
      if (!fs.existsSync(path.join('/'))) {
        fs.mkdirSync(path.join('/'))
      }
      
      // If the report already exists then return it and skip the trade calculations below
      //
      path.push(REPORT_FILE_NAME)
      const reportFilePath = path.join('/')
      if (fs.existsSync(reportFilePath)) {
        try {
          const reportPageStrBuf = fs.readFileSync(reportFilePath)
          socket.emit(reqType, {
            requestId,
            pages: [ JSON.parse(reportPageStrBuf.toString()) ]
          })
          log.debug(`Returned existing report ${reportFilePath}. Skipping generation of new report.`)
          return
        } catch (error) {
          log.warn(`Failed to find/read ${reportFilePath}. Generating new report.`)
        }
      }
      path.pop()

      path.push(PARAMS_FILE)
      const paramsFilePath = path.join('/')
      fs.writeFileSync(paramsFilePath, JSON.stringify(reportParameters, null, 2))
      path.pop()

    
      // 0. Get the set of tokens that we're trading:
      //    TODO - for now we'll just use the 100M case, but we need to expand this properly
      //
      const _tokenSet: Set<string> = new Set<string>()

      if (tokenSet !== 'Tokens in pairs that do not include WETH') {
        const _minPairLiquidity = 100000000
        for (const pairId of _uniData.pairData.getPairIds()) {
          const pair = _uniData.pairData.getPair(pairId)
          const usd = parseFloat(pair.reserveUSD)
          if (usd > _minPairLiquidity) {
            _tokenSet.add(pair.token0.id.toLowerCase())
            _tokenSet.add(pair.token1.id.toLowerCase())
          }
        }
        log.debug(`Found ${_tokenSet.size} tokens in pairs with > $${_minPairLiquidity} USD liquidity.\n` +
                  `tokenSet: ${tokenSet}\n` +
                  `================================================================================`)
      } else {  /* non-weth pair set */
        // Find all tokens that are in a pair with a token other than WETH:
        //
        for (const pairId of _uniData.pairData.getPairIds()) {
          const pair = _uniData.pairData.getPair(pairId)
          const usd = parseFloat(pair.reserveUSD)
          const _minPairLiquidity = 5000000
          if (usd > _minPairLiquidity) {
            if (!c.WETH_ADDRS_LC.includes(pair.token0.id.toLowerCase()) &&
                !c.WETH_ADDRS_LC.includes(pair.token1.id.toLowerCase())) {
              _tokenSet.add(pair.token0.id.toLowerCase())
              _tokenSet.add(pair.token1.id.toLowerCase())
            }
          }
        }
        log.debug(`Found ${_tokenSet.size} tokens not in pairs with WETH.\n` +
                  `tokenSet: ${tokenSet}\n` +
                  `================================================================================`)
      }


      // 1. Construct a list of all the trades we'll be performing so that they
      //    can be randomized if we're limiting results to get more diverse token arrangments.
      //    (Randomize by sorting in order of the random value.)
      //
      type Trade = {src: string, dst: string, randomValue: number}
      const trades: Trade[] = []
      for (const src of _tokenSet) {
        for (const dst of _tokenSet) {
          if (src !== dst) {
            trades.push({src, dst, randomValue: Math.random()})
          }
        }
      }
      trades.sort((tradeA: Trade, tradeB: Trade) => { return tradeB.randomValue - tradeA.randomValue })   // Asc. order.

      // 1.5. Construct an options object that is applicable to all trades given provided parameters:
      //
      const options = {
        max_hops: {
          value: parseInt(maximumSwapsPerPath)
        },
        max_results: {
          value: parseInt(maximumRoutesConsidered)
        },
        max_impact: {
          value: parseFloat(maximumSegmentSlippage)
        },
        update_data: {
          value: false
        },
        ignore_max_hops: {
          value: false
        }
      }

      if (!_uniData.wethPairData) {
        throw Error(`wETH pair data needs to be initialized to run reports.`)
      }

      // 2. For each token, construct a trade to each other token. Set the
      //    amount to token amount USD.
      //
      const tradeStats: TradeStats[] = []
      const pages: any = []
      let tradeCount = 0
      const numTrades = (maxTrades > trades.length) ? trades.length : maxTrades
      while (tradeCount < numTrades) {
        const startMs = Date.now()
        const { src, dst } = (trades[tradeCount])
        tradeCount++

        const amountSrc = getEstimatedTokensFromUSD(_uniData.pairData,
                                                    _uniData.wethPairData,
                                                    src,
                                                    tradeAmount)

        const srcSymbol = _uniData.tokenData.getSymbol(src.toLowerCase())
        const dstSymbol = _uniData.tokenData.getSymbol(dst.toLowerCase())

        if (amountSrc === '') {
          const failRouteStats = new RouteStats()
          failRouteStats.vfiError = USDC_CONVERT_ERR
          const failRouteData = new RouteData(src,
                                              srcSymbol,
                                              dst,
                                              dstSymbol,
                                              options)
          failRouteData.setRouteStats(failRouteStats)

          const failTradeStats = new TradeStats(failRouteData)
          tradeStats.push(failTradeStats)
          continue
        }

        socket && socket.emit('status', {
          status: `Processing trade ${tradeCount} of ${numTrades} (${srcSymbol} --> ${dstSymbol}).`
        })

        log.debug(`Processing trade ${tradeCount} of ${numTrades} (${srcSymbol} --> ${dstSymbol}, ` +
                  `${amountSrc}tokens, $${tradeAmount}USD).`)

        const routeData: RouteData = await _processMultiPathRouteReq(_uniData,
                                                                      _routeCache,
                                                                      src,
                                                                      dst,
                                                                      amountSrc,
                                                                      options)

        const routeFileName = `${src}_${dst}.json`
        path.push(routeFileName)
        const filePath = path.join('/')
        fs.writeFile(filePath,
                      routeData.serialize(),
                      (err) => { err && log.warn(`Failed to write ${filePath} because\n${err}`) })
        path.pop()


        log.debug(`Trade computed in ${Date.now() - startMs} ms.`)

        tradeStats.push(new TradeStats(routeData))
      }

      // Future - more time:  push these results to a DB and craft the report from the DB

      // 3. Create a report and content:
      //
      const reportPage = _createReport(reportParameters, paramsHash, tradeStats)
      pages.unshift(reportPage)

      socket.emit(reqType, {
        requestId,
        pages
      })

      // Store the report page 
      fs.writeFile(reportFilePath,
                   JSON.stringify(reportPage),
                   (err) => { err && log.warn(`Failed to write ${reportFilePath} because\n${err}`) })
      
      // Update the report summaries data and broadcast it to 
      // all connected clients:
      //
      _reportSummaries.push({
        reportSubdir: paramsHash,
        params: reportParameters
      })
      _reportOptions = reportSummariesToOptions(_reportSummaries)
      for (const socketId in clientSockets) {
        const clientSocket = clientSockets[socketId]
        log.debug(`Emitting 'report-update' to ${socketId} (${clientSocket ? 'socket exists' : 'socket undefined'})`)
        clientSocket.emit('report-update', { 
          existingAnalysisOptions: _reportOptions
        })
      }
    })

    socket.on('report-fetch-route', async (routeParameters: any) => {
      const {paramsHash, src, dst} = routeParameters

      if (!paramsHash || !src || !dst) {
        socket.emit('report-fetch-route', { error: 'Invalid request--paramsHash, src and dst must be defined.' })
      } else {
        const REPORTS_DIR = 'reports'
        const routeFileName = `${src}_${dst}.json`
        const path = [REPORTS_DIR, 
                      paramsHash,
                      routeFileName]

        log.debug(`report-fetch-route: reading route ${path.join('/')}...`)

        fs.readFile(path.join('/'), (err, data) => {
          if (err) {
            socket.emit('report-fetch-route', { error: `Failed reading route information.\n${err}` })
          } else {
            const routeData = new RouteData()
            routeData.initFromSerialization(data.toString())

            const pages = _routeDataToPages(routeData)

            log.debug(`report-fetch-route: route pages length ${pages.length}.`)
            socket.emit('report-fetch-route', { paramsHash, src, dst, pages })
          }
        })
      }
    })

    socket.on('disconnect', (reason: string) => {
      if (clientSockets.hasOwnProperty(socket.id)) {
        delete clientSockets[socket.id]
      }
      log.debug(`${socket.id} disconnected (${Object.keys(clientSockets).length} connections).\n` +
                reason)
    })
  })

  server.listen(port, async () => {
    log.info(`Server on port ${port} READY!`)
  })
}