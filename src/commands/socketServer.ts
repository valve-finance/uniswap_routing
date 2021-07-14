import * as ds from './../utils/debugScopes'
import * as t from './../utils/types'
import { sanitizeProperty, sanitizePropertyType } from '../utils/misc'
import * as r from './../utils/routing'
import * as c from './../utils/constants'
import { initUniData } from '../utils/data'
import { RouteCache } from '../routeCache'
import { getUniRouteV2 } from '../utils/uniswapSDK'

import express from 'express'
import http from 'http'
import cors from 'cors'
import helmet from 'helmet'
import requestIp from 'request-ip'
import socketio from 'socket.io'
import { parse } from 'commander'

// TODO: back with Redis instead of mem
const rateLimitMem = require('./../middleware/rateLimiterMem.js')

const log = ds.getLog('socketServer')


// Placeholder until we get bull / redis in
let _jobId = 0
const _getRequestId = (): string => {
  return `${_jobId++}`
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
  const socketServer = new socketio.Server(server, {
    cors: {
      origin: ["http://localhost:3000",
               "http://playground.valve.finance.s3-website-us-west-2.amazonaws.com"],
      methods: ["GET", "POST"]
    }
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
      socket.emit('route', {
        requestId,
        status: 'Analyzing input parameters.'
      })


      // TODO: refactor with server.ts equivalent code
      log.debug(`\nRoute Request: ${amount} ${source} to ${dest}` +
                `\n  options: ${JSON.stringify(options, null, 0)}\n`)
      
      const _startMs = Date.now()
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
            }

            if (isNaN(value)) {
              sanitizeStr += `options.${property} cannot be parsed from a string to a ${propertyParams.type}.\n`
              continue
            }

            if (value > propertyParams.max || value < propertyParams.min) {
              sanitizeStr += `options.${property} must be parsable from a string to a ${propertyParams.type} ` +
                              `between ${propertyParams.min} and ${propertyParams.max}, inclusive.\n`
              continue
            }

            _options[property].value = value
          }
        }
      }

      if (sanitizeStr !== '') {
        log.debug(sanitizeStr)
        socket.emit('route', {
          requestId,
          status: 'Error, input parameters are incorrect.',
          error: sanitizeStr
        })
      } else {
        socket.emit('route', {
          requestId,
          status: 'Determining routes.',
        })

        const _routes = await _routeCache.getRoutes(source, dest)

        // TODO: consider pushing the filtering below into the routeCache
        const _filteredRoutes: t.VFRoutes = []
        for (const _route of _routes) {
          if (_route.length <= _options.max_hops.value) {
            _filteredRoutes.push(_route)
          }
        }

        socket.emit('route', {
          requestId,
          status: 'Getting price quotes.',
        })
        const _costedRoutesP: Promise<t.VFRoutes> = r.costRoutes(_uniData.pairData,
                                                                _uniData.tokenData,
                                                                _filteredRoutes,
                                                                amount,
                                                                _options.max_impact.value)
                                                    .catch(error => {
                                                      // TODO: signal an error in routing to the client
                                                      return []
                                                    })
        
        const _uniRouteP: Promise<string> = getUniRouteV2(source, dest, amount)
                                            .catch(error => { return '' })

        const results = await Promise.all([_costedRoutesP, _uniRouteP])
        const _costedRoutes: t.VFRoutes = results[0]
        const _uniRoute: string = results[1]

        _costedRoutes.sort((a: t.VFRoute, b: t.VFRoute) => {    // Sort descending by amount of destination token received
          const aLastDstAmount = a[a.length-1].dstAmount
          const bLastDstAmount = b[b.length-1].dstAmount
          const aDstAmount = aLastDstAmount ? parseFloat(aLastDstAmount) : 0.0
          const bDstAmount = bLastDstAmount ? parseFloat(bLastDstAmount) : 0.0
          return bDstAmount - aDstAmount
        })
        // log.debug(`Costed routes:\n${JSON.stringify(_costedRoutes, null, 2)}`)

        const _requestedCostedRoutes: t.VFRoutes = _costedRoutes.slice(0, _options.max_results.value)
        // log.debug(`Requested Costed routes:\n${JSON.stringify(_requestedCostedRoutes, null, 2)}`)



        if (_uniData.wethPairData) {
          r.annotateRoutesWithUSD(_uniData.pairData, _uniData.wethPairData, _requestedCostedRoutes)
        }

        const _legacyFmtRoutes = r.convertRoutesToLegacyFmt(_uniData.pairData,
                                                            _uniData.tokenData,
                                                            _requestedCostedRoutes)

        // _legacyFmtRoutes.sort((a: any, b: any) => {
        //   return parseFloat(b.amountOut) - parseFloat(a.amountOut)    // Sort descending by amount of dest token received.
        //                                                               // TODO: fix to handle higher precision.
        // })

        // const routes = _legacyFmtRoutes.slice(0, _options.max_results.value)
        socket.emit('route', {
          requestId,
          status: 'Completed request.',
          routes: _legacyFmtRoutes,
          uniRoute: _uniRoute
        })
      }

      log.debug(`Processed request in ${Date.now() - _startMs} ms`)
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
