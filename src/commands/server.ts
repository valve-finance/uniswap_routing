import * as ds from './../utils/debugScopes'
import * as t from './../utils/types'
import * as cmds from './../commands'

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
  let _uniData: t.UniData = await cmds.initUniData()

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
  const MAX_RESULTS = 10
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
      if (body) {
        // TODO: sanity check on route object
        const {source, dest, amount, options} = route
        // TODO: support amount and options
        let maxHops = 3
        let maxResults = 5
        let maxImpact = 25.0
        log.debug(options)
        if (options) {
          if (options.hasOwnProperty('max_hops')) {
            maxHops = (options.max_hops > 0 && options.max_hops <= MAX_HOPS) ? 
              options.max_hops : maxHops
          }
          if (options.hasOwnProperty('max_results')) {
            maxResults = (options.max_results > 0 && options.max_results <= MAX_RESULTS) ? 
              options.max_results : maxResults
          }
          if (options.hasOwnProperty('max_impact')) {
            maxImpact = (options.max_impact > 0.0 && options.max_impact < 100.0) ?
              options.max_impact : maxImpact
          }
        }
        log.debug(`maxHops: ${maxHops}, maxResults: ${maxResults}`)
        const constraints: t.Constraints = {
          maxDistance: maxHops
        }
        const _rolledRoutes: any = await cmds.findRoutes(_uniData.pairGraph,
                                                         source,
                                                         dest,
                                                         constraints)
        const _costedRolledRoutes = cmds.costRolledRoutes(_uniData.pairData,
                                                          _uniData.tokenData,
                                                          amount,
                                                          _rolledRoutes)
        const _unrolledRoutes = cmds.unrollCostedRolledRoutes(_costedRolledRoutes, maxImpact)

        result.routes = _unrolledRoutes.slice(0, maxResults)
      }

      log.debug(`Processed request in ${Date.now() - _startMs} ms`)
      // log.debug(`result:\n${JSON.stringify(result, null, 2)}`)
      res.status(OK).json(result)
    } catch (error) {
      log.error(error)
    }
  })
 
  const _server = http.createServer(app)
  _server.listen(port, async () => {
    log.info(`Server on port ${port} READY!`)
  })
}