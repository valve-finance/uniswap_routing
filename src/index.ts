import 'dotenv/config.js'
import { Command } from 'commander'
import * as ds from './utils/debugScopes'
import * as cmds from './commands'

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

program
  .command('main', { isDefault: true })
  .description('Starts an instance of the Uniswap optimizing router, fetching continous updates,' +
               ' of swap statistics, and serving Swap API requests.')
  .action(main)

program
  .command('help')
  .action(() => {
    program.help()
  })

program.parse(process.argv)
