import * as ds from './../utils/debugScopes'
import * as t from './../utils/types'
import * as c from './../utils/constants'
import * as r from './../utils/routing'
import { initUniData } from '../utils/data'

const log = ds.getLog('test')

export const test = async(): Promise<void> => {
  const _uniData: t.UniData = await initUniData()

  // From: https://github.com/Uniswap/uniswap-interface/blob/03913d9c0b5124b95cff34bf2e80330b7fd8bcc1/src/constants/index.ts
  //
  // const addrSrc = '0x6B175474E89094C44Da98b954EedeAC495271d0F'    // DAI
  // const addrDst = '0xc00e94Cb662C3520282E6f5717214004A7f26888'   // COMP
  // const addrSrc = '0x4e352cf164e64adcbad318c3a1e222e9eba4ce42'  // MCB
  // const addrDst = '0x961c8c0b1aad0c0b10a51fef6a867e3091bcef17'  // DYP  (more than one)
  const addrSrc = '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9'  // AAVE
  const addrDst = '0xba100000625a3754423978a60c9317c58a424e3d'  // BAL
  //
  log.info('Unconstrained Route ...')
  let _startMs = Date.now()
  let _routes: any = await r.findRoutes(_uniData.pairGraph, addrSrc, addrDst)
  log.info(`Computed in ${(Date.now()-_startMs)} ms.`)

  let  _routeStr = r.routesToString(_routes, _uniData.tokenData)
  log.info(_routeStr)
 
  // Test constrained version
  log.info('Constrained Route ...')
  _startMs = Date.now()
  _routes = await r.findRoutes(_uniData.pairGraph, addrSrc, addrDst, c.noHubTokenCnstr)
  log.info(`Computed in ${(Date.now()-_startMs)} ms.`)

  _routeStr = r.routesToString(_routes, _uniData.tokenData)
  log.info(_routeStr)

  process.exit(0)
}