import 'dotenv/config.js'
import { Command, parse } from 'commander'
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
  const _allTokenData: any = await cmds.getTokenData({ignorePersisted: force})
  const _symbolAddrDict: any = cmds.getSymbolAddrDict(_rawPairData)
  const _addrSymbolDict: any = cmds.getAddrSymbolDict(_rawPairData)
  const _pairGraph: any = await cmds.constructPairGraph(_rawPairData)

  return {
    pairGraph: _pairGraph,
    tokenData: _allTokenData,
    numPairData: _rawPairData,
    symbolAddrDict: _symbolAddrDict,
    addrSymbolDict: _addrSymbolDict
  }
}

const test = async(): Promise<void> => {
  const _uniData:any = await initUniData()

  // From: https://github.com/Uniswap/uniswap-interface/blob/03913d9c0b5124b95cff34bf2e80330b7fd8bcc1/src/constants/index.ts
  //
  // const addrSrc = '0x6B175474E89094C44Da98b954EedeAC495271d0F'    // DAI
  // const addrDst = '0xc00e94Cb662C3520282E6f5717214004A7f26888'   // COMP
  const addrSrc = '0x4e352cf164e64adcbad318c3a1e222e9eba4ce42'  // MCB
  const addrDst = '0x961c8c0b1aad0c0b10a51fef6a867e3091bcef17'  // DYP  (more than one)
  //
  log.info('Unconstrained Route ...')
  let _startMs = Date.now()
  let _routes: any = await cmds.findRoutes(_uniData.pairGraph, addrSrc, addrDst)
  log.info(`Computed in ${(Date.now()-_startMs)} ms.`)

  let  _routeStr = cmds.routesToString(_routes, _uniData.addrSymbolDict)
  log.info(_routeStr)
 
  // Test constrained version
  log.info('Constrained Route ...')
  let constraints = {
    maxDistance: 3,
    ignoreTokenIds: [
      // WETH:
      "0x477b466750c31c890db3208816d60c8585be7f0e",
      "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      "0xd73d6d4c463df976399acd80ea338384e247c64b",
      // DAI:
      "0x6b175474e89094c44da98b954eedeac495271d0f",
      "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
      "0xf035f1fbdae1aedb952f904c641e7db1a2a52537",
      // USDC:
      "0x0432aac809b2c07249dbc04cc5f2337091dd6e87",
      "0x2cd68ecf48b0687c95ee6c06d33389688c3cbb8e",
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "0xacf9ea5062193181120832baf6d49f5ab992338b",
      "0xc93a59888e7e6f2849ba94acf767266299c4c415",   // <-- ?
      "0xefb9326678757522ae4711d7fb5cf321d6b664e6",   // <-- ?
      // USDT:
      "0x2f34f846f57e5e31975fa29ffcceb4d84a441abb",
      "0x409ff99dc752e53e16cde354645cfaf0410a874a",
      "0x51e1ccbea22d51c8e919e85908f6490838549ff5",
      "0x601886880af940b261fef86572e1310d2787413d",
      "0x6070c2215a18cd8efaf340166876ac9ce4d1e79b",
      "0x632f2894cb421d0b09a9ae361a5db3f0163fce2d",
      "0x682dae1bf00cbd79798c8eafc9a9fe1f1cb6befd",
      "0x69d8f39cbeb10085b787a3f30cdaaba824cc1a27",
      "0x78f825c0e8eee5661d1c6bb849a4e32d5addb746",
      "0xa06725a857f26aa18f80dfad5e4a7f7e2fec2eef",
      "0xa2065164a26ecd3775dcf22510ad1d2daef8bd2a",
      "0xb0c158fdf257d601386612d0bd15d5bd4acee7d2",
      "0xc220b5df13bc1917bb692e70a84044bd9067ccc0",
      "0xc48e6a12c97ad930d9d5320376dfd821dcd3ab04",
      "0xdac17f958d2ee523a2206206994597c13d831ec7",
      "0xef1d5af0928f19d264f2febdfeb2d950aaaed8d1",
      // COMP:
      "0xb7096f353ffc826d1e65b01bcb43d55ba8aa55e7",
      "0xc00e94cb662c3520282e6f5717214004a7f26888",
      "0xeba1b95ac453291ae3156fa183b1460cff1905f2",
      // MKR:
      "0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2",
      "0xb2a9a0f34e3140de9b9a489b33fc049102a1808e"
    ]
  }
  _startMs = Date.now()
  _routes = await cmds.findRoutes(_uniData.pairGraph, addrSrc, addrDst, constraints)
  log.info(`Computed in ${(Date.now()-_startMs)} ms.`)

  _routeStr = cmds.routesToString(_routes, _uniData.addrSymbolDict)
  log.info(_routeStr)

  process.exit(0)
}

const nonHubRoutes = async(minLiquidityUSD=10000, maxRoutes=100): Promise<void> => {
  const _uniData:any = await initUniData()
  
  const constraints = {
    maxDistance: 3,
    ignoreTokenIds: [
      // WETH:
      "0x477b466750c31c890db3208816d60c8585be7f0e",
      "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      "0xd73d6d4c463df976399acd80ea338384e247c64b",
      // DAI:
      "0x6b175474e89094c44da98b954eedeac495271d0f",
      "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
      "0xf035f1fbdae1aedb952f904c641e7db1a2a52537",
      // USDC:
      "0x0432aac809b2c07249dbc04cc5f2337091dd6e87",
      "0x2cd68ecf48b0687c95ee6c06d33389688c3cbb8e",
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "0xacf9ea5062193181120832baf6d49f5ab992338b",
      "0xc93a59888e7e6f2849ba94acf767266299c4c415",   // <-- ?
      "0xefb9326678757522ae4711d7fb5cf321d6b664e6",   // <-- ?
      // USDT:
      "0x2f34f846f57e5e31975fa29ffcceb4d84a441abb",
      "0x409ff99dc752e53e16cde354645cfaf0410a874a",
      "0x51e1ccbea22d51c8e919e85908f6490838549ff5",
      "0x601886880af940b261fef86572e1310d2787413d",
      "0x6070c2215a18cd8efaf340166876ac9ce4d1e79b",
      "0x632f2894cb421d0b09a9ae361a5db3f0163fce2d",
      "0x682dae1bf00cbd79798c8eafc9a9fe1f1cb6befd",
      "0x69d8f39cbeb10085b787a3f30cdaaba824cc1a27",
      "0x78f825c0e8eee5661d1c6bb849a4e32d5addb746",
      "0xa06725a857f26aa18f80dfad5e4a7f7e2fec2eef",
      "0xa2065164a26ecd3775dcf22510ad1d2daef8bd2a",
      "0xb0c158fdf257d601386612d0bd15d5bd4acee7d2",
      "0xc220b5df13bc1917bb692e70a84044bd9067ccc0",
      "0xc48e6a12c97ad930d9d5320376dfd821dcd3ab04",
      "0xdac17f958d2ee523a2206206994597c13d831ec7",
      "0xef1d5af0928f19d264f2febdfeb2d950aaaed8d1",
      // COMP:
      "0xb7096f353ffc826d1e65b01bcb43d55ba8aa55e7",
      "0xc00e94cb662c3520282e6f5717214004a7f26888",
      "0xeba1b95ac453291ae3156fa183b1460cff1905f2",
      // MKR:
      "0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2",
      "0xb2a9a0f34e3140de9b9a489b33fc049102a1808e"
    ]
  }

  // 1. Gather all pairs with USD liquidity greater than <X> USD
  // 2. Remove pairs containing any of the hub token ids
  // 3. Create a unique list of the remaining token ids
  const filteredPairs = []
  const filteredTokenIds = new Set<string>()
  for (const pairData of _uniData.numPairData.pairs) {
    if (constraints.ignoreTokenIds.includes(pairData.token0.id.toLowerCase()) ||
        constraints.ignoreTokenIds.includes(pairData.token1.id.toLowerCase())) {
      continue
    }

    const reserveUSD = parseFloat(pairData.reserveUSD)    // TODO: big number(scaled) or big decimal
    if (reserveUSD < minLiquidityUSD) {
      continue
    }
    const _pairDataCopy = JSON.parse(JSON.stringify(pairData))    // TODO: needed? If so, better quality deep copy.
    _pairDataCopy.reserveUSDFloat = reserveUSD
    filteredPairs.push(_pairDataCopy)

    filteredTokenIds.add(pairData.token0.id.toLowerCase())
    filteredTokenIds.add(pairData.token1.id.toLowerCase())
  }

  log.info(`Found ${filteredTokenIds.size} unique tokens in pools with more than ${minLiquidityUSD} USD ` +
           `that are not hub tokens (WETH, DAI, USDC, USDT, COMP, MKR).`)

  log.info(`Searching for routes between them that aren't through hub tokens with ${constraints.maxDistance} hops or less.`)

  // 4. For each token id in the unique list, try to compute a route to each other token id
  //      - O(n^2)
  const routeResults: any = {}
  let routeAttemptCount = 0
  let routeTimeSumMS = 0
  for (const srcTokenId of filteredTokenIds) {
    for (const dstTokenId of filteredTokenIds) {
      if (srcTokenId === dstTokenId) {
        continue
      }
      const srcTokenIdLC = srcTokenId.toLowerCase()
      const dstTokenIdLC = dstTokenId.toLowerCase()

      const resultKey = `${srcTokenIdLC}-${dstTokenIdLC}`
      if (!routeResults.hasOwnProperty(resultKey)) {
        const startMS = Date.now()
        const _routes = await cmds.findRoutes(_uniData.pairGraph, srcTokenIdLC, dstTokenIdLC, constraints)
        const durationMS = Date.now() - startMS
        routeTimeSumMS += durationMS
        routeAttemptCount++

        if (_routes.length) {
          log.info(`(${durationMS} ms): Found routes from ${srcTokenIdLC} to ${dstTokenIdLC}.`)
          routeResults[resultKey] = _routes
        } else {
          log.info(`(${durationMS} ms): No routes from ${srcTokenIdLC} to ${dstTokenIdLC}.`)
        }
      }
    }
  }
  log.info(`Attempted to find ${routeAttemptCount} routes in ${routeTimeSumMS} ms (average = ${routeTimeSumMS/routeAttemptCount}).`)
  log.info(`Succeeded ${Object.keys(routeResults).length} times.`)

  // 5. Report on the top <Y> routes based on liquidity
  //      - Sort by the highest minimum liquidity of the route
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
          let _payTokenSymbol = ''
          while (!validEntry) {
            const payToken = await _promptUser('Swap: what token would you like to pay with (enter a token ID)?')
            _payToken = payToken.toLowerCase().trim()
            _payTokenSymbol = _uniData.addrSymbolDict[_payToken]
            if (_payTokenSymbol) {
              validEntry = true
              log.info(`Paying with ${_payTokenSymbol} (${_payToken})`)
            } else {
              log.info(`Invalid token specified: ${payToken}. Try again.`)
            }
          }

          validEntry = false
          let _amtPayToken = 0.0
          while (!validEntry) {
            const amtPayToken = await _promptUser(`Swap: how much ${_payTokenSymbol} (${_payToken}) would you like to spend (e.g. 1.28)?`)
            try {
              _amtPayToken = parseFloat(amtPayToken)
              validEntry = true
            } catch (conversionError) {
              log.info(`Invalid amount of ${_payTokenSymbol} (${_payToken}) specified: ${amtPayToken}. (Must be a number, greater than zero. No units or non-numeric characters.)`)
            }
          }

          validEntry = false
          let _buyToken = ''
          let _buyTokenSymbol = ''
          while (!validEntry) {
            const buyToken = await _promptUser('Swap: what token would you like to buy (enter a token ID)?')
            _buyToken = buyToken.toLowerCase().trim()
            const _buyTokenSymbol = _uniData.addrSymbolDict[_buyToken]
            if (_buyTokenSymbol) {
              validEntry = true
              log.info(`Buying ${_buyTokenSymbol} (${_buyToken})`)
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
  .command('test')
  .description('Starts an test of the Uniswap optimizing router, fetching continous updates,' +
               ' of swap statistics, and serving Swap API requests.')
  .action(test)

const MIN_LIQUIDITY = 100000
program
  .command('reportNonHub [minLiquidity]')
  .description('Reports on routes found between non-hub tokens in pools of a certain liquidity ($10k).')
  .action(async (minLiquidity) => {
    try {
      if (minLiquidity) {
        minLiquidity = parseFloat(minLiquidity)
      } else {
        minLiquidity = MIN_LIQUIDITY
      }
    } catch (ignoredErr) {
      minLiquidity = MIN_LIQUIDITY
    }

    await nonHubRoutes(minLiquidity)
  })

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
  .command('help', { isDefault: true })
  .action(() => {
    program.help()
  })

program.parse(process.argv)
