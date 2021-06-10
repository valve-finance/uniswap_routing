import 'dotenv/config.js'
import { Command } from 'commander'
import * as ds from './utils/debugScopes'
import * as cmds from './commands'
import * as readline from 'readline'
import express from 'express'
import http from 'http'
import cors from 'cors'
import helmet from 'helmet'
import requestIp from 'request-ip'

const rateLimitMem = require('./middleware/rateLimiterMem.js')

const log = ds.getLog('index')
const program = new Command();

const initUniData = async(force=false): Promise<any> => {
  log.info('Initializing Uniswap data. Please wait (~ 1 min.) ...')

  const _rawPairData: any = await cmds.getRawPairData({ignorePersisted: force})
  const _symbolLookup: any = cmds. getSymbolLookup(_rawPairData)
  const _pairGraph: any = await cmds.constructPairGraph(_rawPairData)

  return {
    pairGraph: _pairGraph,
    numPairData: _rawPairData,
    symbolLookup: _symbolLookup
  }
}

const main = async(): Promise<void> => {
  const _uniData:any = await initUniData()

  const _startMs = Date.now()
  const _routes: any = await cmds.findRoutes(_uniData.pairGraph, 'mcb', 'dyp')
  log.info(`Computed in ${(Date.now()-_startMs)} ms.`)

  const _routeStr = cmds.routesToString(_routes)
  log.info(_routeStr)
 
  process.exit(0)
}

const _promptUser = async (query: string):Promise<string> => 
{
  const _query = '\nUNI Router > ' + query + ' '
  const rli = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  return new Promise((resolve) => {
    rli.question(_query, (answer: string) => {
      rli.close();
      resolve(answer);
    })
  })
}

const shell = async(): Promise<void> => {
  const _settings: any = {
    maxHops: {
      description: 'The maximum number of hops allowed by the router.',
      value: 2,
      type: 'integer'
    }
  }

  let _uniData:any = await initUniData()

  let command = ''
  while (command.toLowerCase() !== 'q') {
    command = await _promptUser('What would you like to do (s)wap, (r)efresh data, se(t)tings, or (q)uit?')

    switch (command.toLowerCase()) {
      case 's':
        {
          let validEntry = false
          let _payToken = ''
          while (!validEntry) {
            const payToken = await _promptUser('Swap: what token would you like to pay with?')
            _payToken = payToken.toLowerCase().trim()
            if (_uniData.symbolLookup.hasOwnProperty(_payToken)) {
              validEntry = true
            } else {
              log.info(`Invalid token specified: ${payToken}. Try again.`)
            }
          }

          validEntry = false
          let _amtPayToken = 0.0
          while (!validEntry) {
            const amtPayToken = await _promptUser(`Swap: how much ${_payToken} would you like to spend (e.g. 1.28)?`)
            try {
              _amtPayToken = parseFloat(amtPayToken)
              validEntry = true
            } catch (conversionError) {
              log.info(`Invalid amount of ${_payToken} specified: ${amtPayToken}. (Must be a number, greater than zero. No units or non-numeric characters.)`)
            }
          }

          validEntry = false
          let _buyToken = ''
          while (!validEntry) {
            const buyToken = await _promptUser('Swap: what token would you like to buy?')
            _buyToken = buyToken.toLowerCase().trim()
            if (_uniData.symbolLookup.hasOwnProperty(_buyToken)) {
              validEntry = true
            } else {
              log.info(`Invalid token specified: ${buyToken}. Try again.`)
            }
          }

          log.info(`Calculating optimal routing for swap of: ${_amtPayToken} ${_payToken.toUpperCase()} -> ${_buyToken.toUpperCase()} ...`)
          const _rolledRoutes: any = await cmds.findRoutes(_uniData.pairGraph,
                                                           _payToken,
                                                           _buyToken,
                                                           _settings["maxHops"].value)

          // const _routeStr = cmds.routesToString(_rolledRoutes)
          // log.info(_routeStr)

          // const _routeCostStr = cmds.printRouteCosts(_uniData.numPairData, _routes)
          // log.info(_routeCostStr)
          const _costedRolledRoutes = cmds.costRolledRoutes(_uniData.numPairData,
                                                            _rolledRoutes)
          
          const _unrolledRoutes = cmds.unrollCostedRolledRoutes(_costedRolledRoutes)
          log.debug(`Unrolled routes:\n${JSON.stringify(_unrolledRoutes, null, 2)}`)
        }
        break;
      
      case 'r':
        log.info('Refreshing all data ...')
        _uniData = await initUniData(true)
        break;
      
      case 't':
        {
          log.info('Settings ...')
          for (const _settingKey in _settings) {
            const _setting = _settings[_settingKey]
            const _value = await _promptUser(`Settings: enter an ${_setting.type} value for "${_settingKey}" (current value = ${_setting.value})? \n`)
            switch (_setting.type) {
              case "integer":
                const _tempInt = parseInt(_value)
                if (_tempInt <= 0) {
                  log.info(`Invalid setting specified for "${_settingKey}" (must be greater than zero).`)
                } else {
                  _setting.value = _tempInt
                }
                break;

              case "float":
                const _tempFloat= parseInt(_value)
                if (_tempFloat > 0.0) {
                  _setting.value = _tempFloat
                } else {
                  log.info(`Invalid setting specified for "${_settingKey}" (must be greater than zero).`)
                }
                break;
            
              default:  /* string etc. */
                _setting.value = _value
                break;
            }
          }
        }
        break;

      case 'q':
        log.info('Quitting ...')
        break;
    
      default:
        log.info(`Ignoring unknown command ${command}.`)
        break;
    }
  }
  
  process.exit(0)
}

// HTTP Status Codes
const OK = 200
const BAD_REQUEST = 400
const INTERNAL_SERVER_ERROR = 500

const server = async(port: string): Promise<void> => {
  log.info(`Starting Uniswap Routing Server on port ${port}...\n` +
           `(wait until 'READY' appears before issuing requests)`)

  const _settings: any = {
    maxHops: {
      description: 'The maximum number of hops allowed by the router.',
      value: 2,
      type: 'integer'
    }
  }
  let _uniData:any = await initUniData()

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
    // TODO: return a message with a link to the API docs for post requests
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
        }
        log.debug(`maxHops: ${maxHops}, maxResults: ${maxResults}`)
        const _rolledRoutes: any = await cmds.findRoutes(_uniData.pairGraph,
                                                         source,
                                                         dest,
                                                         maxHops)
        const _costedRolledRoutes = cmds.costRolledRoutes(_uniData.numPairData,
                                                          _rolledRoutes)
        const _unrolledRoutes = cmds.unrollCostedRolledRoutes(_costedRolledRoutes)

        result.routes = _unrolledRoutes.slice(0, maxResults) // Return the 1st 5 ele
                                                    // TODO: make this a setting
      }

      log.debug(`Processed request in ${Date.now() - _startMs} ms`)
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

process.on('SIGINT', async():Promise<void> => {
  log.info('Exiting')
  // TODO: consider doing this more elegantly (like with tie in to running
  //       process components).
  process.exit(0)
})

program
  .command('main', { isDefault: true })
  .description('Starts an instance of the Uniswap optimizing router, fetching continous updates,' +
               ' of swap statistics, and serving Swap API requests.')
  .action(main)

program
  .command('shell')
  .description('Starts a basic shell for exploring Uniswap optimizing router results.')
  .action(shell)

const DEFAULT_PORT = '3030'
program
  .command('server [port]')
  .description('Starts a server that accepts route, status, and other requests. Default port is ' +
               '3030 and can be overriden with the optional port argment.')
  .action(async (port) => {
    port = port || DEFAULT_PORT
    await server(port)
  })

program
  .command('help')
  .action(() => {
    program.help()
  })

program.parse(process.argv)
