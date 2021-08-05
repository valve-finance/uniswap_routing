import * as ds from './../utils/debugScopes'
import * as t from './../utils/types'
import { sanitizeProperty, sanitizePropertyType } from '../utils/misc'
import * as rg from '../routing/routeGraph'
import * as rt from '../routing/routeTree'
import * as rv from '../routing/routeVisualization'
import * as c from './../utils/constants'
import { getEstimatedTokensFromUSD } from '../routing/quoting'
import { initUniData } from '../utils/data'
import { RouteCache } from '../routing/routeCache'
import { getUniRouteV2 } from '../utils/uniswapSDK'
import { deepCopy } from '../utils/misc'
import { quoteRoutes } from '../routing/quoting'

import express from 'express'
import http from 'http'
import cors from 'cors'
import helmet from 'helmet'
import requestIp from 'request-ip'
import socketio from 'socket.io'
import { v4 as uuidv4 } from 'uuid'
import cytoscape from 'cytoscape'
import crawl from 'tree-crawl'
import { RouteData, TradeYieldData } from '../routing/types'


// TODO: back with Redis instead of mem
const rateLimitMem = require('./../middleware/rateLimiterMem.js')

const log = ds.getLog('socketServer')


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
  const _routesP: Promise<t.VFRoutes> = routeCache.getRoutes(source, dest, { maxHops: options.max_hops.value })
                                                   .catch(error => {
                                                     // TODO: signal an error in routing to the client
                                                     return []
                                                   })

  const _uniRouteP: Promise<any> = getUniRouteV2(source, dest, amount)
                                   .catch(error => { return {} })
  
  const _results = await Promise.all([_routesP, _uniRouteP])
  const _routes: t.VFRoutes = deepCopy(_results[0])    // <-- TODO: cleanup route 
                                                       //           cache to dc routes by default.
  const _uniRoute: any = _results[1]

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

        // TODO TODO: To check our work w/ quotes, compare the value of
        //            _uniRoute.expectedConvertQuote to the amount in the 
        //            last seg if data updates are turned on
        break
      }
    }

    if (!foundUniRoute) {
      log.warn(`Uni route not in results, building and adding.`)
      try {
        const newRoute: t.VFRoute = []
        for (let idx = 0; idx < _uniRoute.routePath.length-1; idx++) {
          const src = _uniRoute.routePath[idx].toLowerCase()
          const dst = _uniRoute.routePath[idx].toLowerCase()

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
  const _requestedQuotedRoutes: t.VFRoutes = _quotedRoutes.slice(0, options.max_results.value)
  if (uniData.wethPairData) {
    await rg.annotateRoutesWithUSD(uniData.pairData,
                                  uniData.wethPairData,
                                  _requestedQuotedRoutes,
                                  options.update_data.value)
  }

  return { routes: _requestedQuotedRoutes, uniRoute: _uniRoute.routeText }
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
  const { routes } = await _processRouteReq(_uniData,
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
  // TODO: look at re-enabling this:
  // const filteredRoutes = rg.removeRoutesWithLowerOrderPairs(prunedRoutes, _options)
  const filteredRoutes = prunedRoutes
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
    // all the leave nodes:
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
  if (routesTree) {
    routeData.setSinglePathElementsFromTree(routesTree)
    routeData.setUniYield(uniYield)
    routeData.setSinglePathValveYield(valveOnePathYield)
  }

  if (costedMultirouteTree) {
    routeData.setMultiPathElementsFromTree(costedMultirouteTree)
    routeData.setMultiPathValveYield(valveMultiPathYield)
  }

  return routeData

}

const _routeDataToPages = (routeData: RouteData): any => 
{
  let pages: any = []
  const uniYield = routeData.getUniYield()

  const spYield = routeData.getSinglePathValveYield()
  const spElements = routeData.getSinglePathElements()
  if (uniYield && spYield && spElements) {
    const delta = (uniYield.usd > 0) ?
      100 * (spYield.usd - uniYield.usd) / (uniYield.usd) : 0.0
    const deltaStr = `(difference: ${delta > 0 ? '+' : ''}${delta.toFixed(3)}% UNI)`

    pages.push({
      title: 'Individual Routes',
      description: [{text: `Uniswap route output $${uniYield.usd} USD.`},
                    {text: `Valve best route $${spYield.usd} USD ${deltaStr}.`, textStyle: 'bold'}],
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
    const delta = (uniYield.usd > 0) ?
      100 * (mpYield.usd - uniYield.usd) / (uniYield.usd) : 0.0
    const deltaStr = `(difference: ${delta > 0 ? '+' : ''}${delta.toFixed(3)}% UNI)`

    pages.push({
      title: `Multi-Path Route`,
      description: [{text: `Valve multi route output $${mpYield.usd.toFixed(2)} USD ${deltaStr}`},
                    {text: `Yield difference: ${delta > 0 ? '+' : ''}$${(mpYield.usd - uniYield.usd).toFixed(2)}`, textStyle: 'bold'}],
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
  
  //  TODO: 
  //        - Look at rate limiting socket requests/commands too.
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
  // TODO: Workaround for now--on long requests the socket ping times out on 
  //       the client side b/c this process is busy (usually on a 4 hop route).
  //       When time permits introduce reconnect and a job manager so a client
  //       can disconnect and retrieve the job status on reconnect:
  //        - turned off until doing long hop work
  // const THREE_MIN_IN_MS = 5 * 60 * 1000
  const socketServer = new socketio.Server(server, { 
                                             cors: corsObj
                                            //  pingTimeout: THREE_MIN_IN_MS
                                           })

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

      // TODO: refactor with serverg.ts equivalent code
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
        const routeReqObj = await _processRouteReq(_uniData, _routeCache, source, dest, amount, _options)
        const legacyFmtRoutes = rg.convertRoutesToLegacyFmt(_uniData.pairData, _uniData.tokenData, routeReqObj.routes)
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

      if (!isNaN(parseFloat(usdAmount)) && _uniData.wethPairData) {
        tokens = getEstimatedTokensFromUSD(_uniData.pairData,
                                           _uniData.wethPairData,
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

      // TODO: refactor with serverg.ts equivalent code or ditch serverg.ts
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
      const routeData = await _processMultiPathRouteReq(_uniData,
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
                      existingAnalysisOptions: [],
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

    socket.on('report-generate', async (reportParameters: any) => {
      // Training Wheels:
      let maxTrades = 25


      const requestId = _getRequestId()
      const reqType = 'report-generate'

      const {
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
    
      // 1. Get the set of tokens that we're trading:
      //    TODO - for now we'll just use the 100M case, but we need to expand this properly
      //
      const _tokenSet: Set<string> = new Set<string>()
      const _minPairLiquidity = 100000000
      // TODO: pair data return an iterator to the pairs:
      for (const pairId of _uniData.pairData.getPairIds()) {
        const pair = _uniData.pairData.getPair(pairId)
        const usd = parseFloat(pair.reserveUSD)
        if (usd > _minPairLiquidity) {
          _tokenSet.add(pair.token0.id.toLowerCase())
          _tokenSet.add(pair.token1.id.toLowerCase())
        }
      }
      log.debug(`Found ${_tokenSet.size} tokens in pairs with > $${_minPairLiquidity} USD liquidity.`)


      // 2. For each token, construct a trade to each other token. Set the
      //    amount to token amount USD.
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

      const pages = []
      let tradeCount = 0
      const tokenArr = [..._tokenSet]
      for (let srcIdx = 0; 
           (srcIdx < _tokenSet.size && tradeCount < maxTrades);
           srcIdx++) {
        for (let dstIdx = 0;
             (dstIdx < _tokenSet.size && tradeCount < maxTrades);
             dstIdx++) {
          if (srcIdx === dstIdx) {
            continue
          }

          tradeCount++
          log.debug(`Processing trade ${tradeCount} of ${maxTrades}.`)
          const src = tokenArr[srcIdx]
          const dst = tokenArr[dstIdx]
          if (!_uniData.wethPairData) {
            continue
          }
          const amountSrc = getEstimatedTokensFromUSD(_uniData.pairData,
                                                      _uniData.wethPairData,
                                                      src,
                                                      tradeAmount)

          log.debug(`Trade:\n` +
                    `    source =  ${_uniData.tokenData.getSymbol(src.toLowerCase())}\n` +
                    `    dest =    ${_uniData.tokenData.getSymbol(dst.toLowerCase())}\n` +
                    `    amount =  ${amountSrc} (USD: $${tradeAmount})\n` +
                    `    options = ${JSON.stringify(options, null, 2)}\n`)

          const routeData = await _processMultiPathRouteReq(_uniData,
                                                            _routeCache,
                                                            src,
                                                            dst,
                                                            amountSrc,
                                                            options)

          const tradePages = _routeDataToPages(routeData)
          log.debug(`trade pages length = ${tradePages.length}`)
          if (tradePages.length <= 0) {
            tradeCount--
            continue
          }

          for (const page of tradePages) {
            pages.push(page)
          }
        }
      }

      let titlePage = {
        title: 'Report Summary',
        description: `TBD ...`,
        content: [''],
        elements: []
      }
      titlePage.content.push('Single Route Data')
      titlePage.content.push('========================================')
      for (const page of pages)  {
        if (page && page.trade && !page.trade.isMultiroute && page.trade.delta !== undefined) {
          const { delta } = page.trade
          const deltaStr = `${delta >= 0 ? '+' : ''}${delta.toFixed(3)}%`
          titlePage.content.push(`${deltaStr}  ${page.trade.srcSymbol} -> ${page.trade.dstSymbol} ($${page.trade.valve.usd} USD)`)
        }
      }
      titlePage.content.push('')
      titlePage.content.push('Multi-Route Data')
      titlePage.content.push('========================================')
      for (const page of pages)  {
        if (page && page.trade && page.trade.isMultiroute && page.trade.delta !== undefined) {
          const { delta } = page.trade
          const deltaStr = `${delta >= 0 ? '+' : ''}${delta.toFixed(3)}%`
          titlePage.content.push(`${deltaStr}  ${page.trade.srcSymbol} -> ${page.trade.dstSymbol} ($${page.trade.valve.usd} USD)`)
        }
      }
      pages.unshift(titlePage)

      socket.emit(reqType, {
        requestId,
        pages
      })
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