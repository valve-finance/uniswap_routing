import 'dotenv/config.js'
import { Command } from 'commander'
import * as ds from './utils/debugScopes'
import * as cmds from './commands'
import * as readline from 'readline'

const log = ds.getLog('index')
const program = new Command();

const initUniData = async(): Promise<any> => {
  log.info('Initializing Uniswap data. Please wait (~ 1 min.) ...')

  const _rawPairData: any = await cmds.getRawPairData()
  const _symbolLookup: any = cmds. getSymbolLookup(_rawPairData)
  // let _symbolIdLookup: any = cmds.getSymbolIdLookup(_rawPairData)
  // let _idSymbolLookup: any = cmds.getIdSymbolLookup(_rawPairData)
  const _numPairData: any = await cmds.convertRawToNumericPairData(_rawPairData, {sort: false})
  // const _numPairData = _rawPairData
  // log.info(`Uniswap V2 Data\n` +
  //          `raw: ${_rawPairData.pairs.length} pairs, ${Object.keys(_symbolIdLookup).length} symbols, ${Object.keys(_idSymbolLookup).length} ids\n` +
  //          `num: ${_numPairData.pairs.length} pairs, ${Object.keys(_symbolIdLookup).length} symbols, ${Object.keys(_idSymbolLookup).length} ids\n`) 

  const _pairGraph: any = await cmds.constructPairGraph(_numPairData)

  return {
    pairGraph: _pairGraph,
    numPairData: _numPairData,
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
      value: 3,
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
          const _routes: any = await cmds.findRoutes(_uniData.pairGraph,
                                                     _payToken,
                                                     _buyToken,
                                                     _settings["maxHops"].value)

          const _routeStr = cmds.routesToString(_routes)
          log.info(_routeStr)
        }
        break;
      
      case 'r':
        log.info('Refreshing all data ...')
        _uniData = await initUniData()
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
