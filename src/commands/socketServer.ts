import * as ds from './../utils/debugScopes'
import * as t from './../utils/types'
import { sanitizeProperty, sanitizePropertyType } from '../utils/misc'
import * as r from './../utils/routing'
import * as c from './../utils/constants'
import { initUniData } from '../utils/data'
import { RouteCache } from '../routeCache'
import { getUniRouteV2 } from '../utils/uniswapSDK'
import { deepCopy } from '../utils/misc'

import express from 'express'
import http from 'http'
import cors from 'cors'
import helmet from 'helmet'
import requestIp from 'request-ip'
import socketio from 'socket.io'
import { v4 as uuidv4 } from 'uuid'
import cytoscape from 'cytoscape'
import crawl from 'tree-crawl'


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

const _processRouteReq = async(reqType: string,
                               uniData: t.UniData,
                               routeCache: RouteCache,
                               socket: socketio.Socket | undefined,
                               requestId: string,
                               source: string,
                               dest: string,
                               amount: string,
                               options: any): Promise<any> =>
{
  socket && socket.emit(reqType, { requestId, status: 'Determining routes.', })
  const _routesP: Promise<t.VFRoutes> = routeCache.getRoutes(source, dest, { maxHops: options.max_hops.value })
                                                   .catch(error => {
                                                     // TODO: signal an error in routing to the client
                                                     return []
                                                   })

  const _uniRouteP: Promise<any> = getUniRouteV2(source, dest, amount)
                                   .catch(error => { return {} })
  
  const _results = await Promise.all([_routesP, _uniRouteP])
  const _routesImmutable: t.VFRoutes = _results[0]    // <-- TODO: cleanup route cache to dc routes by default.
  const _routes = deepCopy(_routesImmutable)
  const _uniRoute: any = _results[1]

  /**
   *    Tag the official UNI route and insert it if it's not in the cach result, so that
   *    it gets costed.
   */
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

  socket && socket.emit(reqType, { requestId, status: 'Getting price quotes.', })
  const _costedRoutes: t.VFRoutes = await r.costRoutes(uniData.pairData, 
                                                       uniData.tokenData,
                                                       _routes,
                                                       amount,
                                                       options.max_impact.value,
                                                       options.update_data.value)

  _costedRoutes.sort((a: t.VFRoute, b: t.VFRoute) => {    // Sort descending by amount of destination token received
    const aLastDstAmount = a[a.length-1].dstAmount
    const bLastDstAmount = b[b.length-1].dstAmount
    const aDstAmount = aLastDstAmount ? parseFloat(aLastDstAmount) : 0.0
    const bDstAmount = bLastDstAmount ? parseFloat(bLastDstAmount) : 0.0
    return bDstAmount - aDstAmount
  })
  const _requestedCostedRoutes: t.VFRoutes = _costedRoutes.slice(0, options.max_results.value)
  if (uniData.wethPairData) {
    await r.annotateRoutesWithUSD(uniData.pairData,
                                  uniData.wethPairData,
                                  _requestedCostedRoutes,
                                  options.update_data.value)
  }

  if (options.multipath) {
    const resultObj = { requestId, routes: _requestedCostedRoutes }
    return resultObj
  } else {
    const _legacyFmtRoutes = r.convertRoutesToLegacyFmt(uniData.pairData, uniData.tokenData, _requestedCostedRoutes)
    const resultObj = { requestId, status: 'Completed request.', routes: _legacyFmtRoutes, uniRoute: _uniRoute.routeText }
    socket && socket.emit(reqType, resultObj)
    return resultObj
  }
}

const _processMultirouteReq = async(reqType: string,
                                    uniData: t.UniData,
                                    routeCache: RouteCache,
                                    socket: socketio.Socket | undefined,
                                    requestId: string,
                                    source: string,
                                    dest: string,
                                    amount: string,
                                    options: any): Promise<any> => 
{
  const resultObj = await _processRouteReq(reqType, uniData, routeCache, socket, requestId, source, dest, amount, options)

  r.annotateRoutesWithGainToDest(resultObj.routes)

  /**
   * TODO: before converting routes to a trading tree, filter them based on a minimum gain to dest criteria.
   */

  /**
   *  The route analysis object allows us to quickly filter out routes that offer no splitting benefits as well as
   *  filtering out routes that have high impact pairs further downstream (a later hop) that would impact trade estimates.
   * 
   *  Route Analysis Object:
   *  {
   *    routes: {
   *      <id>: {
   *        route: <route obj>,
   *        yieldPct: <percentage>,
   *      }
   *    },
   *    pairs: {
   *      <pairId>: {
   *        <hop>: [
   *          { id: <route id>,
   *            impact: <percentage>
   *          }
   *          ...
   *        ],
   *        ...
   *      }
   *    }
   *  }
   */
  // let _routeIdCounter = 0
  // const routeAnalysis: any = {
  //   routes: {},
  //   pairs: {}
  // }
  // const MIN_YIELD_PCT = 20.0
  // for (const route of resultObj.routes) {
  //   const firstSeg: t.VFSegment = route[0]
  //   const lastSeg: t.VFSegment = route[route.length - 1]
  //   let yieldPct: number = (firstSeg.srcUSD && lastSeg.dstUSD) ? 
  //     100.0 * (parseFloat(lastSeg.dstUSD) / parseFloat(firstSeg.srcUSD)) : 0.0
  //   if (yieldPct < MIN_YIELD_PCT) {
  //     continue
  //   }
    
  //   const routeId = _routeIdCounter++
  //   routeAnalysis.routes[routeId] = {
  //     route,
  //     yieldPct
  //   }

  //   let hopIdx = 0
  //   for (const seg of route) {
  //     hopIdx++
  //     const { pairId, impact } = seg
  //     if (!routeAnalysis.pairs.hasOwnProperty(pairId)) {
  //       routeAnalysis.pairs[pairId] = {}
  //     }
  //     if (!routeAnalysis.pairs[pairId].hasOwnProperty(hopIdx)) {
  //       routeAnalysis.pairs[pairId][hopIdx] = []
  //     }
  //     routeAnalysis.pairs[pairId][hopIdx].push({
  //       id: routeId,
  //       impact: parseFloat(impact)
  //     })
  //   }
  // }
  // console.log(`Route analysis:\n` +
  //             `================================================================================\n` +
  //             `${JSON.stringify(routeAnalysis, null, 2)}`)
  
  // /* Now remove routes that re-use pairs with slippage above a threshold, n, in later route hops.
  //  * i.e. If route 1 uses pair X in the first hop and route 2 uses pair X in the second hop, exclude
  //  *      route 2.
  //  * TODO: this could easily be done with a crawl of the tree and populating a dictionary (realized this
  //  *       after writing the working code below) for later pruning of routes.
  //  */
  // const MAX_SLIPPAGE = 2.0    // Impact
  // const excludeRoutes: string[] = []
  // for (const pairId in routeAnalysis.pairs) {
  //   const pairData = routeAnalysis.pairs[pairId]

  //   // Exclude pairs that are never in more than one hop.
  //   //
  //   if (Object.keys(pairData).length <= 1) {
  //     continue
  //   }

  //   let firstHop = true
  //   let maxSlippage = 0.0
  //   for (let hopIdx = 0; hopIdx <= options.max_hops.value; hopIdx++) {
  //     const pairHopData = pairData[hopIdx]
  //     if (!pairHopData) {
  //       continue
  //     }
  //     // log.debug(`Examining pair:\n${JSON.stringify(pairHopData, null, 2)}`)

  //     for (const pairSegmentData of pairHopData) {
  //       if (pairSegmentData.impact > maxSlippage) {
  //         maxSlippage = pairSegmentData.impact
  //       }
  //     }

  //     // Don't remove the pair if it's in the first hop we've found using this pair in any of the routes:
  //     //
  //     if (firstHop) {
  //       //    - TODO: special case, pairs in the same hop but with different impacts (implies that they are different
  //       //            paths).
  //       //
  //       firstHop = false
  //       continue
  //     }

  //     // Remove routes that feature a pair further down the route that is used earlier and exceeds our
  //     // slippage threshold:
  //     //
  //     if (maxSlippage > MAX_SLIPPAGE) {
  //       for (const pairSegmentData of pairHopData) {
  //         excludeRoutes.push(pairSegmentData.id)
  //       }
  //     }
  //   }
  // }
  // log.debug(`Removing ${excludeRoutes.length} routes due to high-slippage pairs re-used downstream.\n`)
  // const filteredRoutes: t.VFRoutes = []
  // for (const routeId in routeAnalysis.routes) {
  //   if (excludeRoutes.includes(routeId)) {
  //     continue
  //   }
  //   filteredRoutes.push(routeAnalysis.routes[routeId].route)
  // }


  // r.annotateRoutesWithSymbols(uniData.tokenData, filteredRoutes)
  // const tradeTree: r.TradeTreeNode | undefined = r.buildTradeTree(filteredRoutes)


  r.annotateRoutesWithSymbols(uniData.tokenData, resultObj.routes)
  const tradeTree: r.TradeTreeNode | undefined = r.buildTradeTree(resultObj.routes)
  const pruneTradeTree: r.TradeTreeNode | undefined = (tradeTree) ? r.cloneTradeTree(tradeTree) : undefined
  // const pruneTradeTree: r.TradeTreeNode | undefined = r.buildTradeTree(resultObj.routes) 


  // Prune the trade tree copy to only contain the top n routes:
  //
  const n = 10
  let numRoutes = n
  if (pruneTradeTree && pruneTradeTree.children) {
    const routes: any = []
    for (const child of pruneTradeTree.children) {
      const { gainToDest } = child.value
      if (gainToDest) {
        for (const key in gainToDest) {
          routes.push( { routeId: key, totalGain: gainToDest[key] })
        }
      }
    }
    routes.sort((a: any, b: any) => { return b.totalGain - a.totalGain })   // Descending sort

    const topRoutes: any = routes.splice(0, n)   // don't remove -- mutates routes for prune
    numRoutes = topRoutes.length
    for (const pruneRoute of routes) {
      const { routeId, totalGain } = pruneRoute
      r.pruneTreeRoute(pruneTradeTree, routeId)
    }

    // log.debug(`Post prune pruneTradeTree:\n` +
    //           `--------------------------------------------------------------------------------\n`)
    // let treeStr = ''
    // let lastLevel: number | undefined = undefined
    // crawl(pruneTradeTree, 
    //       (node, context) => {
    //         if (lastLevel !== context.level) {
    //           treeStr += '\n'
    //           lastLevel = context.level
    //           treeStr += `(${lastLevel}): `
    //         }
    //         treeStr += `${(node.value.symbol ? node.value.symbol : '')}, `
    //       },
    //       { order: 'bfs'})
    // log.debug(treeStr)
  }

  let sum: any= {}
  const costedTradeTree: r.TradeTreeNode | undefined = (pruneTradeTree) ? 
      r.cloneTradeTree(pruneTradeTree) : undefined
  if (costedTradeTree) {
    await r.costTradeTree(uniData.pairData,
                          uniData.tokenData,
                          amount,
                          costedTradeTree,
                          false /* update pair data */)
    
    if (uniData.wethPairData) {
      await r.annotateTradeTreeWithUSD(uniData.pairData,
                                      uniData.wethPairData,
                                      costedTradeTree,
                                      false /* update pair data */)
    }
    // Calculate the total quickly
    crawl(costedTradeTree,
          (node, context) => {
            if (node.children.length === 0) {
              if (node.value.trades) {
                for (const tradeId in node.value.trades) {
                  if (!sum.hasOwnProperty(tradeId)) {
                    sum[tradeId] = 0
                  }
                  const trade = node.value.trades[tradeId]
                  if (trade.outputUsd) {
                    sum[tradeId] += parseFloat(trade.outputUsd)
                  }
                }
              }
            }
          },
          { order: 'pre' })
  }

  let pages: any = []
  const useUuid = true
  if (tradeTree) { 
    const cyGraph: cytoscape.Core = r.tradeTreeToCyGraph(tradeTree, useUuid)
    pages.push({
      description: 'Individual Routes Meeting Specified Criteria',
      elements: r.elementDataFromCytoscape(cyGraph)
    })
  }
  if (pruneTradeTree) {
    const cyGraphCopy: cytoscape.Core = r.tradeTreeToCyGraph(pruneTradeTree, useUuid)
    pages.push({
      description: `Top ${numRoutes} Routes`,
      elements: r.elementDataFromCytoscape(cyGraphCopy)
    })
  }
  if (costedTradeTree) {
    const cyGraphCopy: cytoscape.Core = r.tradeTreeToCyGraph(costedTradeTree, useUuid)
    pages.push({
      description: `Multi-Path Route, Returns: $${Object.values(sum).join(', ')}`,
      elements: r.elementDataFromCytoscape(cyGraphCopy)
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

      // TODO: refactor with server.ts equivalent code
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
        await _processRouteReq(reqType, _uniData, _routeCache, socket, requestId, source, dest, amount, _options)
      }

      log.debug(`Processed request in ${Date.now() - _startMs} ms`)
    })

    socket.on('usdTokenQuote', (source: string, usdAmount: string) => {
      let tokens = ''

      if (!isNaN(parseFloat(usdAmount)) && _uniData.wethPairData) {
        tokens = r.getEstimatedTokensFromUSD(_uniData.pairData,
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

      // TODO: refactor with server.ts equivalent code
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
      
      _options.multipath = true
      _options.max_results.value = 100

      const pages = await _processMultirouteReq(reqType,
                                                _uniData,
                                                _routeCache,
                                                socket,
                                                requestId,
                                                source,
                                                dest,
                                                amount,
                                                _options)

      socket.emit('multipath', {
        requestId,
        pages
      })
      log.debug(`Processed request in ${Date.now() - _startMs} ms`)
    })

    // TODO: Refactor and clean this up.
    //
    // For now this code will:
    //   1. Find all pairs with > X USD liquidity.
    //   2. Compute trade performance of UNI default vs. multiroute
    //      of trades of 0.1 * X USD between those tokens.
    //
    socket.on('report', (minPairLiquidity=100000000) => {
      const tokenSet: Set<string> = new Set<string>()

      // TODO: pair data return an iterator to the pairs:
      for (const pairId of _uniData.pairData.getPairIds()) {
        const pair = _uniData.pairData.getPair(pairId)
        const usd = parseFloat(pair.reserveUSD)
        if (usd > minPairLiquidity) {
          tokenSet.add(pair.token0.id.toLowerCase())
          tokenSet.add(pair.token1.id.toLowerCase())
        }
      }

      log.debug(`Found ${tokenSet.size} tokens in pairs with > $${minPairLiquidity} USD liquidity.`)
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
