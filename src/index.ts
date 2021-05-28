import 'dotenv/config.js'
import { Command } from 'commander'
import * as ds from './utils/debugScopes'
import * as cmds from './commands'
import * as readline from 'readline'

const log = ds.getLog('index')
const program = new Command();

const main = async(): Promise<void> => {
  const _rawPairData: any = await cmds.getRawPairData()
  const _numPairData: any = await cmds.convertRawToNumericPairData(_rawPairData, 
                                                                   {sort: false})
  const _pairGraph: any = await cmds.constructPairGraph(_numPairData)

  
  const startMs = Date.now()
  const _routes: any = await cmds.findRoutes(_pairGraph, 'mcb', 'dyp')  // link, aave
  log.info(`Computed in ${(Date.now()-startMs)} ms.`)

  // const _mostLiquid100Pairs: any = _numPairData.pairs.slice(0, 100)
  // for (let i = 0; i < _mostLiquid100Pairs.length; i++) {
  //   const pair = _mostLiquid100Pairs[i]
  //   log.info(`${pair.token0.symbol}/${pair.token1.symbol}:  ${pair.reserveUSD}`)
  // }
 
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
  let _rawPairData: any = await cmds.getRawPairData()
  let _uniqueSymbols: Set<string> = cmds.getUniqueSymbols(_rawPairData)
  let _numPairData: any = await cmds.convertRawToNumericPairData(_rawPairData, 
                                                                   {sort: false})
  let _pairGraph: any = await cmds.constructPairGraph(_numPairData)

  let command = ''
  while (command.toLowerCase() !== 'q') {
    command = await _promptUser('What would you like to do (s)wap, (r)efresh data, (q)uit?')

    switch (command.toLowerCase()) {
      case 's':
        {
          let validEntry = false
          let _payToken = ''
          while (!validEntry) {
            const payToken = await _promptUser('Swap: what token would you like to pay with?')
            _payToken = payToken.toLowerCase().trim()
            if (_uniqueSymbols.has(_payToken)) {
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
              log.info(`Invalide amount of ${_payToken} specified: ${amtPayToken}. (Must be a number, greater than zero. No units or non-numeric characters.)`)
            }
          }

          validEntry = false
          let _buyToken = ''
          while (!validEntry) {
            const buyToken = await _promptUser('Swap: what token would you like to buy?')
            _buyToken = buyToken.toLowerCase().trim()
            if (_uniqueSymbols.has(_buyToken)) {
              validEntry = true
            } else {
              log.info(`Invalid token specified: ${buyToken}. Try again.`)
            }
          }

          log.info(`Calculating optimal routing for swap of: ${_amtPayToken} ${_payToken.toUpperCase()} -> ${_buyToken.toUpperCase()} ...`)
          const _routes: any = await cmds.findRoutes(_pairGraph,
                                                     _payToken,
                                                     _buyToken,
                                                     3 /* max hops */)
        }
        break;
      
      case 'r':
        log.info('Refreshing all data ...')
        _rawPairData = await cmds.getRawPairData({ignorePersisted: true})
        _numPairData = await cmds.convertRawToNumericPairData(_rawPairData, {sort: false})
        _pairGraph = await cmds.constructPairGraph(_numPairData)
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

program
  .command('main', { isDefault: true })
  .description('Starts an instance of the Uniswap optimizing router, fetching continous updates,' +
               ' of swap statistics, and serving Swap API requests.')
  .action(main)

program
  .command('shell')
  .description('Starts a basic shell for exploring Uniswap optimizing router results.')
  .action(shell)

program
  .command('help')
  .action(() => {
    program.help()
  })

program.parse(process.argv)
