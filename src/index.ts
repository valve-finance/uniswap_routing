import 'dotenv/config.js'
import { Command, parse } from 'commander'
import { test, testSimpleMultipath } from './commands/test'
import { report } from './commands/report'
import { shell } from './commands/shell'
import { server } from './commands/server'
import { startSocketServer } from './commands/socketServer'

const program = new Command();

program
  .command('test')
  .description('Starts an test of the Uniswap optimizing router, fetching continous updates,' +
               ' of swap statistics, and serving Swap API requests.')
  .action(test)

program
  .command('testSimpleMultipath [amount]')
  .description('Tests a simple multipath algorithm on static data between two tokens, with an' +
                'optionally specified initial amount (default is 1000.0)')
  .action(async (amount: string) => {
    let _amount = parseFloat(amount)
    if (isNaN(_amount)) {
      amount = '1000.0'
    }
    testSimpleMultipath(amount)
  })

const MIN_LIQUIDITY = 100000
const MIN_TOKEN_RESERVES = 1000
const MAX_ROUTES = 100
program
  .command('report [minLiquidity] [minTokenReserves] [maxRoutes]')
  .description('Reports on routes found between non-hub tokens in pools ' +
               `of minLiquidity (default ${MIN_LIQUIDITY} USD) and ` +
               `minTokenReserves (default ${MIN_TOKEN_RESERVES}). ` +
               `Limits reporting to maxRoutes (default ${MAX_ROUTES}).`)
  .action(async (minLiquidity, minTokenReserves, maxRoutes) => {

    let _minLiquidity = parseFloat(minLiquidity)
    if (isNaN(_minLiquidity)) {
      _minLiquidity = MIN_LIQUIDITY
    }

    let _minTokenReserves = parseInt(minTokenReserves)
    if (isNaN(_minTokenReserves)) { 
      _minTokenReserves = MIN_TOKEN_RESERVES
    }

    let _maxRoutes = parseInt(maxRoutes)
    if (isNaN(_maxRoutes)) {
      _maxRoutes = MAX_ROUTES
    }

    await report(_minLiquidity, _minTokenReserves, _maxRoutes)
  })

program
  .command('shell')
  .description('Starts a basic shell for exploring Uniswap optimizing router results.')
  .action(shell)

const DEFAULT_PORT = '3030'
program
  .command('server [port]')
  .description('Starts a server that accepts route, status, and other requests. Default port is ' +
               `${DEFAULT_PORT} and can be overriden with the optional port argment.`)
  .action(async (port) => {
    port = port || DEFAULT_PORT
    await server(port)
  })

const DEFAULT_SOCKET_SVR_PORT = '3031'
program
  .command('socketServer [port]')
  .description('Starts a socket server that accepts route requests. Default port is ' +
               `${DEFAULT_SOCKET_SVR_PORT} that can be overriden with the optional port argment.`)
  .action(async (port) => {
    port = port || DEFAULT_SOCKET_SVR_PORT
    await startSocketServer(port)
  })

program
  .command('help', { isDefault: true })
  .action(() => {
    program.help()
  })

program.parse(process.argv)
