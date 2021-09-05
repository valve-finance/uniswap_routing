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

// TODO: back with Redis instead of mem
const rateLimitMem = require('./../middleware/rateLimiterMem.js')


const log = ds.getLog('socketServer')
const USDC_CONVERT_ERR = 'Cannot convert USDC to source tokens.'
const DELTA_PRECISION = 6
const DELTA_ZERO_THRESHOLD = 1.0 * Math.pow(10, -DELTA_PRECISION)

const TOKEN_SET_NAMES: any = {
  NO_WETH_MIN_100M: 'Tokens in pairs beyond WETH, liquidity > $100M',
  NO_WETH_MIN_50M: 'Tokens in pairs beyond WETH, liquidity > 50M',
  NO_WETH_MIN_25M: 'Tokens in pairs beyond WETH, liquidity > 25M',
  NO_HUB_MIN_50M: 'Tokens in pairs beyond hub tokens, liquidity > $50M',
  NO_HUB_MIN_25M: 'Tokens in pairs beyond hub tokens, liquidity > $25M',
  UNI_DEFAULT: 'Uniswap default list tokens'
}

const getTokensInPairs = (pairData: t.Pairs,
                          excludePairsWithTokens: string[] = [],
                          minLiquidity?: number,
                          maxLiquidity?: number): Set<string> =>
{
  const _tokenSet = new Set<string>()
  for (const pairId of pairData.getPairIds()) {
    const pair = pairData.getPair(pairId)

    const usd = parseFloat(pair.reserveUSD)
    if (minLiquidity && usd < minLiquidity) {
      continue
    }
    if (maxLiquidity && usd >= maxLiquidity) {
      continue
    }

    const { token0, token1 } = pair
    const lcToken0Addr = token0.id.toLowerCase()
    const lcToken1Addr = token1.id.toLowerCase()
    if (excludePairsWithTokens.length > 0 &&
        (excludePairsWithTokens.includes(lcToken0Addr) ||
         excludePairsWithTokens.includes(lcToken1Addr)) ) {
      continue
    }

    _tokenSet.add(lcToken0Addr)
    _tokenSet.add(lcToken1Addr)
  }

  return _tokenSet
}

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
    },
    block: {
      value: -1,      // indicates unspecified
      min: 0,
      type: 'int'
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

        if (property === 'block') {                           // Special case for block; only check minimum.
          if (value <= propertyParams.min) {
            sanitizeStr += `options.${property} must be parsable from a string to a ${propertyParams.type} ` +
                            `greater than ${propertyParams.min}.\n`
            continue
          }
        } else if ( !(property === 'max_hops' &&              // Special case for max hops--ignore it if specified:
               options.hasOwnProperty('ignore_max_hops') && 
               options['ignore_max_hops'] === 'true') ) {
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
                                                      options.update_data.value,
                                                      options.block.value)

  _quotedRoutes.sort((a: t.VFRoute, b: t.VFRoute) => {    // Sort descending by amount of destination token received
    const aLastDstAmount = a[a.length-1].dstAmount
    const bLastDstAmount = b[b.length-1].dstAmount
    const aDstAmount = aLastDstAmount ? parseFloat(aLastDstAmount) : 0.0
    const bDstAmount = bLastDstAmount ? parseFloat(bLastDstAmount) : 0.0
    return bDstAmount - aDstAmount
  })
  _routeStats.routesMeetingCriteria = _quotedRoutes.length

  /**
   * Tag the best sp route as the valve fi route (this is the first route from sorting
   * above.)
   */
  if (_quotedRoutes.length > 0) {
    const bestSpRoute = _quotedRoutes[0]
    bestSpRoute.forEach((_seg: t.VFSegment) => _seg.isBest = true)
  }

  const _requestedQuotedRoutes: t.VFRoutes = _quotedRoutes.slice(0, options.max_results.value)
  if (uniData.wethPairData) {
    await rg.annotateRoutesWithUSD(uniData.pairData,
                                  uniData.wethPairData,
                                  _requestedQuotedRoutes,
                                  options.update_data.value,
                                  options.block.value)
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
  rg.annotateRoutesWithYieldToDest(routes)
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
  // log.debug(`Routes:\n` +
  //           `================================================================================`)
  // log.debug(routes)

  // 2. Add the best single path route as the Valve Fi Route
  //
  let valveOnePathYield: TradeYieldData = {
    usd: 0.0,
    token: 0.0
  }
  if (routes && routes.length && routes[0] && routes[0].length) {
    const bestRoute = routes[0]
    const lastSeg = bestRoute[bestRoute.length - 1]
    valveOnePathYield.usd = lastSeg.dstUSD ? parseFloat(lastSeg.dstUSD) : 0.0
    valveOnePathYield.token = lastSeg.dstAmount ? parseFloat(lastSeg.dstAmount) : 0.0
  }

  // 2.3 Pre-work filtering and pruning of the single path routes for multi-path routing:
  //
  const maximumConcurrentPaths = 10
  const maximumRouteSlippage = 100.0
  const minGainToDest = 100.0 - maximumRouteSlippage
  const prunedRoutes = rg.pruneRoutes(routes, {maxRoutes: maximumConcurrentPaths, 
                                                minGainToDest})
  routeStats.mpRoutesMeetingCriteria = routes.length

  // log.debug(`Ordered Routes:\n` +
  //           `================================================================================`)
  // log.debug(prunedRoutes)

  // 2.5 Pre-work for constructing a multi-path route. Build a trade tree from the routes
  //     found in the single path router and examine the tree for duplicate pairs exceeding
  //     a low slippage--these pairs will destroy estimation and their routes should be pruned
  //     to maximize gain (while minimizing estimation error).
  //
  const mpRouteTree: rt.TradeTreeNode | undefined = rt.buildTradeTree(prunedRoutes)
  if (mpRouteTree) {
    // Prune all routes if high MGTD detected
    // rt.pruneRoutesIfHighTopLevelMGTD(mpRouteTree)
    rt.pruneRoutesIfHighMGTD(mpRouteTree)

    rt.pruneRoutesWithDuplicatePairs(mpRouteTree)
    routeStats.mpRoutesAfterRmDuplicatePathPairs = rt.getNumRoutes(mpRouteTree)
  }

  // 3. Construct a multi-path route:
  //
  let valveMultiPathYield: TradeYieldData = {
    usd: 0.0,
    token: 0.0
  }
  // Skipping update code below b/c the sp route calculations just updated these
  // pairs...
  if (mpRouteTree) {
    await rt.costTradeTree(_uniData.pairData,
                           _uniData.tokenData,
                           amount,
                           mpRouteTree,
                           false /* update pair data <-- TODO: tie to property */)

    if (_uniData.wethPairData) {
      await rt.annotateTradeTreeWithUSD(_uniData.pairData,
                                        _uniData.wethPairData,
                                        mpRouteTree,
                                        false /* update pair data */)
    }

    // Calculate the net result of the multi-route trade by summing
    // all the leaf nodes:
    //
    crawl(mpRouteTree,
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

  if (mpRouteTree) {
    routeData.setMultiPathElementsFromTree(mpRouteTree)
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
      comparisonStr = `${delta.toFixed(DELTA_PRECISION)}%`

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
      comparisonStr = `${delta.toFixed(DELTA_PRECISION)}%`

      if (!isNaN(differenceUSD)) {
        comparisonStr += ` ($${differenceUSD.toFixed(2)} USD)`
      } else if (!isNaN(difference)) {
        comparisonStr += ` (${difference.toFixed(6)} tokens)`
      }
      if (Math.abs(delta) < DELTA_ZERO_THRESHOLD) {
        comparisonStr += ', same as Uniswap V2.'
      } else if (delta > 0) {
        comparisonStr += ', more than Uniswap V2.'
      } else { // (delta < 0)
        comparisonStr += ', less than Uniswap V2.'
      }
    }
    description.push({text: comparisonStr, textStyle: 'bold'})
    
    const { routesFound, mpRoutesMeetingCriteria, mpRoutesAfterRmDuplicatePathPairs } = routeData.getRouteStats()
    let routeStatsStr: string = ''
    routeStatsStr += (routesFound !== undefined) ? `${routesFound} routes found.` : ''
    routeStatsStr += (mpRoutesMeetingCriteria !== undefined) ? ` ${mpRoutesMeetingCriteria} match criteria supplied.` : ''
    routeStatsStr += (mpRoutesAfterRmDuplicatePathPairs !== undefined) ? ` ${mpRoutesAfterRmDuplicatePathPairs} after removing dup. lower order pairs.` : ''
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
                   {text: `Block #${reportParameters.blockNumber}, Report ID ${paramsHash}`},
                   {text: `${tradeStats.length} trades between tokens analyzed.`},
                   {text: `Note: Performance compared to ${DELTA_PRECISION} decimal places of a percent.`} ],
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
        } else if (Math.abs(spDelta) > DELTA_ZERO_THRESHOLD) {
          if (spDelta < 0) {
            row = `${spDelta.toFixed(DELTA_PRECISION)}% worse, ` + row
            spWorse.push({row, src, dst, view: true})
          } else {
            row = `+${spDelta.toFixed(DELTA_PRECISION)}% better, ` + row
            spBetter.push({row, src, dst, view: true})
          }
        } else {
          /* same - can't compare equality on doubles, so threshold */
          spSame.push({row, src, dst, view: true})
        }
      }
    }
  }

  content.push({row: `${spBetter.length} - Single Path Routes Performed Better`, type: 'sub-section', collapsible: (spBetter.length > 0)})
  spBetter.forEach((row: any) => { content.push(row)})

  content.push({row: `${spWorse.length} - Single Path Routes Performed Lower`, type: 'sub-section', collapsible: (spWorse.length > 0)})
  spWorse.slice().reverse().forEach((row: any) => { content.push(row)})
  
  content.push({row: `${spSame.length} - Single Path Routes Performed Similarly`, type: 'sub-section', collapsible: (spSame.length > 0)})
  spSame.forEach((row: any) => { content.push(row)})
  
  content.push({row: `${spIncomparable.length} - Single Path Routes Couldn't Be Compared`, type: 'sub-section', collapsible: (spIncomparable.length > 0)})
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
        row += (numTokensInStr && numTokensOutStr) ?
            `, (${numTokensInStr} --> ${numTokensOutStr})` : ''

        const { mpDelta } = tradeStat
        if (isNaN(mpDelta)) {
          /* mpecial case, uni result is 0, would give delta of infinity,
            likely due to no UNI route. */
          mpIncomparable.push({row, src, dst, view: true})
        } else if (Math.abs(mpDelta) > DELTA_ZERO_THRESHOLD) {
          if (mpDelta < 0) {
            row = `${tradeStat.mpDelta.toFixed(DELTA_PRECISION)}% worse, ` + row
            mpWorse.push({row, src, dst, view: true})
          } else {
            row = `+${tradeStat.mpDelta.toFixed(DELTA_PRECISION)}% better, ` + row
            mpBetter.push({row, src, dst, view: true})
          }
        } else {
          /* same - can't compare equality on doubles, so threshold */
          mpSame.push({row, src, dst, view: true})
        } 
      }
    }
  }

  content.push({row: `${mpBetter.length} - Multi-Path Routes Performed Better`, type: 'sub-section', collapsible: (mpBetter.length > 0)})
  mpBetter.forEach((row: any) => { content.push(row)})

  content.push({row: `${mpWorse.length} - Multi-Path Routes Performed Lower`, type: 'sub-section', collapsible: (mpWorse.length > 0)})
  mpWorse.slice().reverse().forEach((row: any) => { content.push(row)})
  
  content.push({row: `${mpSame.length} - Multi-Path Routes Performed Similarly`, type: 'sub-section', collapsible: (mpSame.length > 0)})
  mpSame.forEach((row: any) => { content.push(row)})
  
  content.push({row: `${mpIncomparable.length} - Multi-Path Routes Couldn't Be Compared`, type: 'sub-section', collapsible: (mpIncomparable.length > 0)})
  mpIncomparable.forEach((row: any) => { content.push(row)})
  
  // Exceptions Section:
  //
  //////////////////////////////////////////////////////////////////////////////
  content.push({row: 'Exceptions Preventing Analysis', type: 'section'})

  content.push({row: `${uniFail.length} - Routes Uniswap V2 Did Not Find`, type: 'sub-section', collapsible: (uniFail.length > 0)})
  uniFail.forEach((row: any) => { content.push(row)})

  content.push({row: `${spFail.length} - Routes Valve Finance Did Not Find`, type: 'sub-section', collapsible: (spFail.length > 0)})
  spFail.forEach((row: any) => { content.push(row)})
  
  content.push({row: `${spCriteriaFail.length} - Routes Did Not Match Specified Criteria`, type: 'sub-section', collapsible: (spCriteriaFail.length > 0)})
  spCriteriaFail.forEach((row: any) => { content.push(row)})
  
  content.push({row: `${mpCriteriaFail.length} - Routes Did Not Match Specified Multi-Path Criteria`, type: 'sub-section', collapsible: (mpCriteriaFail.length > 0)})
  mpCriteriaFail.forEach((row: any) => { content.push(row)})
  
  content.push({row: `${spUsdcConvFail.length} - Routes Couldn't Be Evaluated From A $USD Initial Amount`, type: 'sub-section', collapsible: (spUsdcConvFail.length > 0)})
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
  const pairDataPlayground = new t.Pairs()
  pairDataPlayground.deserialize(serializedPairData)

  let _uniDataQuotable: t.UniData = {
    pairGraph: _uniData.pairGraph,
    tokenData: _uniData.tokenData,
    pairData: pairDataPlayground,               // Can modify with up-to-date quotes w/o affecting report
    wethPairData: _uniData.wethPairData
  }

  // Another lightweight copy to service the market tracker (prevents conflict with 
  // playground pairs etc.):
  //
  serializedPairData = deepCopy(_uniData.pairData.serialize())
  const pairDataTracker = new t.Pairs()
  pairDataTracker.deserialize(serializedPairData)

  let _uniDataMarketTracker: t.UniData = {
    pairGraph: _uniData.pairGraph,
    tokenData: _uniData.tokenData,
    pairData: pairDataTracker,               // Can modify with up-to-date or any block quotes w/o affecting report or playground
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

    socket.on('multipath-tracker', async(source: string,
                                       dest: string,
                                       amount: string,
                                       options?: any) => {
      // TODO: refactor -- largely a c+p of 'multipath' handler:
      const requestId = _getRequestId()
      const reqType = 'multipath-tracker'
      socket.emit(reqType, { requestId, status: 'Analyzing input parameters.' })

      log.debug(`\nMultipath Tracker Route Request: ${amount} ${source} to ${dest}` +
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
      const routeData = await _processMultiPathRouteReq(_uniDataMarketTracker,
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
                      tokenSetOptions: Object.keys(TOKEN_SET_NAMES).map((key: string) => {
                                         const value = TOKEN_SET_NAMES[key]
                                         return { key, text: value, value } }),
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
      let maxTrades = 3000
      const reportStartMs = Date.now()
      const computeTimes: number[] = []

      const requestId = _getRequestId()
      const reqType = 'report-generate'

      const {
        analysisDescription,
        blockNumber,
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
      // //  - two approaches, in memory and on disk
      // const existingReport = _reportSummaries.filter((summary: any) => summary.reportSubdir === paramsHash)
      // if (existingReport) {

      // }
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
      //  IDEAS:
      //   b) All tokens branching from a token in a pair with a token other than the 6 hub tokens:
      //   e) Tokens in pairs between $75M and $100M liquidity
      //   f) Tokens in pairs between $50M and $100M liquidity
      //   g) Tokens in pairs between $25M and $50M liquidity
      //   h) Tokens in pairs between $10M and $25M liquidity
      //
      let _tokenSet = new Set<string>()

      switch (tokenSet) {
        case TOKEN_SET_NAMES.NO_WETH_MIN_100M:
          _tokenSet = getTokensInPairs(_uniData.pairData, [c.WETH_ADDR], 100000000)
          break

        case TOKEN_SET_NAMES.NO_WETH_MIN_50M:
          _tokenSet = getTokensInPairs(_uniData.pairData, [c.WETH_ADDR], 50000000)
          break

        case TOKEN_SET_NAMES.NO_WETH_MIN_25M:
          _tokenSet = getTokensInPairs(_uniData.pairData, [c.WETH_ADDR], 25000000)
          break

        case TOKEN_SET_NAMES.NO_HUB_MIN_50M:
          _tokenSet = getTokensInPairs(_uniData.pairData, c.currentHubTokens, 50000000)
          break

        case TOKEN_SET_NAMES.NO_HUB_MIN_25M:
          _tokenSet = getTokensInPairs(_uniData.pairData, c.currentHubTokens, 25000000)
          break

        case TOKEN_SET_NAMES.UNI_DEFAULT:
        default:
          c.uniswapDefaultTokens.forEach(tokenObj => _tokenSet.add(tokenObj.address.toLowerCase()))  
          break
      }


      // 1. Construct a list of all the trades we'll be performing so that they
      //    can be randomized if we're limiting results to get more diverse token arrangments.
      //    (Randomize by sorting in order of the random value.)
      //
      type Trade = {src: string, dst: string, randomValue: number}
      const trades: Trade[] = []
      for (const src of _tokenSet) {
        if (!c.tokensNoWethPair.includes(src)) {    // Ignore these tokens as source since we can't
                                                    // convert the USD trade amount to them rn
          for (const dst of _tokenSet) {
            if (src !== dst) {
              trades.push({src, dst, randomValue: Math.random()})
            }
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
        },
        block: {
          value: -1
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


        const tradeTime = Date.now() - startMs
        computeTimes.push(tradeTime)
        log.debug(`Trade computed in ${tradeTime} ms.`)

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

      computeTimes.sort((a: number, b: number) => a - b)
      let sumComputeTime = computeTimes.reduce(
        (previousValue: number, currentValue: number) => previousValue + currentValue,
        0.0 /* initial value */)
      let avgComputeTime = (computeTimes.length > 0) ? sumComputeTime / computeTimes.length : NaN
      let minComputeTime = computeTimes[0]
      let maxComputeTime = computeTimes[computeTimes.length-1]
      log.debug (`Report generation completed in ${((Date.now() - reportStartMs)/(60*1000)).toFixed(2)} minutes.\n` +
                 `Computed ${computeTimes.length} trades:\n` +
                 `  average compute time = ${avgComputeTime} ms\n` +
                 `  min compute time     = ${minComputeTime} ms\n` +
                 `  max compute time     = ${maxComputeTime} ms\n`)
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
