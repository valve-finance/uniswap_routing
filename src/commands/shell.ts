import * as ds from './../utils/debugScopes'
import * as t from './../utils/types'
import * as cmds from './../commands'

import * as readline from 'readline'

const log = ds.getLog('shell')

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

export const shell = async(): Promise<void> => {
  const _settings: any = {
    maxHops: {
      description: 'The maximum number of hops allowed by the router.',
      value: 2,
      type: 'integer'
    }
  }

  let _uniData: t.UniData = await cmds.initUniData()

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
            _payTokenSymbol = _uniData.tokenData.getSymbol(_payToken)
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
            const _buyTokenSymbol = _uniData.tokenData.getSymbol(_buyToken)
            if (_buyTokenSymbol) {
              validEntry = true
              log.info(`Buying ${_buyTokenSymbol} (${_buyToken})`)
            } else {
              log.info(`Invalid token specified: ${buyToken}. Try again.`)
            }
          }

          log.info(`Calculating routes for swap of: ${_amtPayToken} ${_payToken} -> ${_buyToken} ...`)
          const constraints: t.Constraints = {
            maxDistance: _settings["maxHops"].value
          }
          const _rolledRoutes: any = await cmds.findRoutes(_uniData.pairGraph,
                                                           _payToken,
                                                           _buyToken,
                                                           constraints)

          // const _routeStr = cmds.routesToString(_rolledRoutes)
          // log.info(_routeStr)

          // const _routeCostStr = cmds.printRouteCosts(_uniData.pairData, _uniData.tokenData, _routes, _amtPayToken.toString())
          // log.info(_routeCostStr)
          const _costedRolledRoutes = cmds.costRolledRoutes(_uniData.pairData,
                                                            _uniData.tokenData,
                                                            _amtPayToken.toString(),
                                                            _rolledRoutes)
          
          const _unrolledRoutes = cmds.unrollCostedRolledRoutes(_costedRolledRoutes)
          log.info(`Unrolled routes:\n${JSON.stringify(_unrolledRoutes, null, 2)}`)
        }
        break;
      
      case 'r':
        log.info('Refreshing all data ...')
        _uniData = await cmds.initUniData(true)
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

