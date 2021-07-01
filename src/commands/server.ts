import * as ds from './../utils/debugScopes'
import * as t from './../utils/types'
import { sanitizeProperty, sanitizePropertyType } from '../utils/misc'
import * as r from './../utils/routing'
import { initUniData } from '../utils/data'

import express from 'express'
import http from 'http'
import cors from 'cors'
import helmet from 'helmet'
import requestIp from 'request-ip'

const rateLimitMem = require('./../middleware/rateLimiterMem.js')

const log = ds.getLog('server')

// HTTP Status Codes
const OK = 200
const BAD_REQUEST = 400
const INTERNAL_SERVER_ERROR = 500

export const server = async(port: string): Promise<void> => {
  log.info(`Starting Uniswap Routing Server on port ${port}...\n` +
           `(wait until 'READY' appears before issuing requests)`)

  const _settings: any = {
    maxHops: {
      description: 'The maximum number of hops allowed by the router.',
      value: 2,
      type: 'integer'
    }
  }
  let _uniData: t.UniData = await initUniData()

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
    res.status(OK).send('Welcome to Uniswap V2 Route Optimization Service.')
  })

  const MAX_HOPS = 3
  const MAX_RESULTS = 100
  app.post(/.*/, async (req:any, res:any) => {
    try {
      const _startMs = Date.now()
      const {body} = req

      if (!body.hasOwnProperty('route') && !body.hasOwnProperty('status')) {
        log.error(`Bad request. Body does not cotain 'route' or 'status' object.`)
        res.status(BAD_REQUEST).end()
      }

      const result:any = {}

      const { status } = body
      if (status) {
        result.status = 'OK'       
      }

      const { route } = body
      let statusCode = OK
      if (body) {
        const {source, dest, amount, options} = route
        // log.debug(`Request: \n` +
        //           `source: ${source} (amount: ${amount} - typeof ${typeof amount})\n` +
        //           `dest: ${dest}\n` +
        //           `options: ${JSON.stringify(options)}`)

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
            max: MAX_HOPS,
            type: 'int'
          },
          max_results: {
            value: 5,
            min: 1,
            max: MAX_RESULTS,
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
          statusCode = BAD_REQUEST
          result.error = sanitizeStr
          log.debug(sanitizeStr)
        } else {
          const constraints: t.Constraints = {
            maxDistance: _options.max_hops.value
          }
          const _stackedRoutes: t.VFStackedRoutes = await r.findRoutes(_uniData.pairGraph,
                                                                       source,
                                                                       dest,
                                                                       constraints)

          const _routes: t.VFRoutes = r.unstackRoutes(_stackedRoutes)
          // log.debug(`All routes:\n${JSON.stringify(_routes, null, 2)}`)

          const _costedRoutes: t.VFRoutes = r.costRoutes(_uniData.pairData,
                                                         _uniData.tokenData,
                                                         _routes,
                                                         amount,
                                                         _options.max_impact.value)
          
          const _legacyFmtRoutes = r.convertRoutesToLegacyFmt(_uniData.pairData,
                                                              _uniData.tokenData,
                                                              _costedRoutes)

          _legacyFmtRoutes.sort((a: any, b: any) => {
            return parseFloat(b.amountOut) - parseFloat(a.amountOut)    // Sort descending by amount of dest token received.
                                                                        // TODO: fix to handle higher precision.
          })

          result.routes = _legacyFmtRoutes.slice(0, _options.max_results.value)
        }
      }

      log.debug(`Processed request in ${Date.now() - _startMs} ms`)
      res.status(statusCode).json(result)
      log.debug(`Returned result.routes:\n${JSON.stringify(result.routes, null, 2)}`)
    } catch (error) {
      log.error(error)
      res.status(INTERNAL_SERVER_ERROR).json({error: 'Internal Server Error'})
    }
  })
 
  const _server = http.createServer(app)
  _server.listen(port, async () => {
    log.info(`Server on port ${port} READY!`)
  })
}