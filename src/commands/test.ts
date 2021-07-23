import * as ds from './../utils/debugScopes'
import * as t from './../utils/types'
import * as c from './../utils/constants'
import * as r from './../utils/routing'
import { initUniData } from '../utils/data'
import { getSpaces } from '../utils/misc'

import cytoscape from 'cytoscape'
import { v4 as uuidv4 } from 'uuid';

const graphlib = require('@dagrejs/graphlib')

const log = ds.getLog('test')

export const test = async(): Promise<void> => {
  const _uniData: t.UniData = await initUniData()

  // From: https://github.com/Uniswap/uniswap-interface/blob/03913d9c0b5124b95cff34bf2e80330b7fd8bcc1/src/constants/index.ts
  //
  // const addrSrc = '0x6B175474E89094C44Da98b954EedeAC495271d0F'    // DAI
  // const addrDst = '0xc00e94Cb662C3520282E6f5717214004A7f26888'   // COMP
  // const addrSrc = '0x4e352cf164e64adcbad318c3a1e222e9eba4ce42'  // MCB
  // const addrDst = '0x961c8c0b1aad0c0b10a51fef6a867e3091bcef17'  // DYP  (more than one)
  const addrSrc = c.tokenAddrs.AAVE
  const addrDst = c.tokenAddrs.BAL
  //
  log.info('Unconstrained Route ...')
  let _startMs = Date.now()
  let _routes: any = r.findRoutes(_uniData.pairGraph, addrSrc, addrDst)
  log.info(`Computed in ${(Date.now()-_startMs)} ms.`)

  let  _routeStr = r.routesToString(_routes, _uniData.tokenData)
  log.info(_routeStr)
 
  // Test constrained version
  log.info('Constrained Route ...')
  _startMs = Date.now()
  _routes = r.findRoutes(_uniData.pairGraph, addrSrc, addrDst, c.noHubTokenCnstr)
  log.info(`Computed in ${(Date.now()-_startMs)} ms.`)

  _routeStr = r.routesToString(_routes, _uniData.tokenData)
  log.info(_routeStr)

  process.exit(0)
}


export const testSimpleMultipath = async(amount: string = '1000.0'): Promise<void> => {
  await getMultipath(amount)

  process.exit(0)
}

export const getMultipath = async(amount: string, numTopRoutes: number = 10): Promise<any> => {
  const _uniData: t.UniData = await initUniData()
  const _constraints: t.Constraints = c.deprecatedTokenCnstr
  const sellToken = c.tokenAddrs.COMP
  const buyToken = c.tokenAddrs.DAI
  const _sroutes: t.VFStackedRoutes = r.findRoutes(_uniData.pairGraph,
                                                   sellToken,
                                                   buyToken,
                                                   _constraints)
  const _routes: t.VFRoutes = r.unstackRoutes(_sroutes)

  const _costedRoutes: t.VFRoutes = await r.costRoutes(_uniData.pairData,
                                                       _uniData.tokenData,
                                                       _routes,
                                                       amount,
                                                       50.0,  /* maxImpact */
                                                       false /* updatePairData */)
  

  // Now sort the costed routes by the destination amounts and present the top 5:
  //
  _costedRoutes.sort((routeA: t.VFRoute, routeB: t.VFRoute) => {
    const lastSegA: t.VFSegment = routeA[routeA.length - 1]
    const lastSegB: t.VFSegment = routeB[routeB.length - 1]
    const resultA: number = lastSegA.dstAmount ? parseFloat(lastSegA.dstAmount) : 0
    const resultB: number = lastSegB.dstAmount ? parseFloat(lastSegB.dstAmount) : 0
    return resultB - resultA
  })
  const _topRoutes = _costedRoutes.slice(0, numTopRoutes)
  r.annotateRoutesWithSymbols(_uniData.tokenData, _topRoutes)
  log.info(`\nTop Original Routes (Input amount: ${amount})\n` +
           '--------------------------------------------------------------------------------')
  for (const route of _topRoutes) {
    const lastSeg: t.VFSegment = route[route.length - 1]
    const result: number = lastSeg.dstAmount ? parseFloat(lastSeg.dstAmount) : 0
    let routeStr = ''
    for (let segIdx = 0; segIdx < route.length; segIdx++) {
      routeStr += route[segIdx].srcSymbol + ' > '
      if (segIdx === route.length - 1) {
        routeStr += route[segIdx].dstSymbol
      }
    }
    log.info(`  ${result}\t(${routeStr})`)
  }
  log.info('\n\n')



  /*******************************************************************************
   * Algorithm 1: Simple Equal Split
   *******************************************************************************/

  // Now split the trade equally among the top 5 routes and re-cost it:
  //
  // if (_topRoutes.length >= 0) {
  //   let newStartAmount = `${parseFloat(amount) / _topRoutes.length}`
  //   let _scrubbedTopRoutes: t.VFRoutes = []
  //   for (const _route of _topRoutes) {
  //     let _scrubbedRoute: t.VFRoute = []
  //     for (const _seg of _route) {
  //       let _scrubbedSeg: t.VFSegment = {
  //         src: _seg.src,
  //         dst: _seg.dst,
  //         pairId: _seg.pairId
  //       }
  //       _scrubbedRoute.push(_scrubbedSeg)
  //     }
  //     _scrubbedTopRoutes.push(_scrubbedRoute)
  //   }

  //   const _newCostedRoutes: t.VFRoutes = await r.costRoutes(_uniData.pairData,
  //                                                           _uniData.tokenData,
  //                                                           _scrubbedTopRoutes,
  //                                                           newStartAmount,
  //                                                           50.0 /* maxImpact */,
  //                                                           false /* updatePairData */)
                                                            
  //   r.annotateRoutesWithSymbols(_uniData.tokenData, _newCostedRoutes)

  //   log.info('\nSplit Route\n' +
  //           '--------------------------------------------------------------------------------\n\n' +
  //           'SUM:\n')

  //   let sum: number = 0.0
  //   for (const route of _newCostedRoutes) {
  //     const lastSeg: t.VFSegment = route[route.length - 1]
  //     const result: number = lastSeg.dstAmount ? parseFloat(lastSeg.dstAmount) : 0
  //     sum += result
  //     let routeStr = ''
  //     for (let segIdx = 0; segIdx < route.length; segIdx++) {
  //       routeStr += route[segIdx].srcSymbol + ' > '
  //       if (segIdx === route.length - 1) {
  //         routeStr += route[segIdx].dstSymbol
  //       }
  //     }
  //     log.info(`  ${result}\t(${routeStr}, input=${newStartAmount})`)
  //   }
  //   log.info('  --------------------')
  //   log.info(`  ${sum}\n\n`) 
  // }



  /*******************************************************************************
   * Algorithm 2: Simple Proportional Split
   *******************************************************************************/
  // Now split the trade equally among the top 5 routes and re-cost it:
  //
  // if (_topRoutes.length >= 0) {
  //   const numPaths = _topRoutes.length

  //   // Determine the proportion of amounts to apply for each route:
  //   //
  //   const resultAmounts: number[] = []
  //   for (const route of _topRoutes) {
  //     const lastSeg: t.VFSegment = route[route.length - 1]
  //     const result: number = lastSeg.dstAmount ? parseFloat(lastSeg.dstAmount) : 0
  //     resultAmounts.push(result)
  //   }
  //   const total = resultAmounts.reduce((accumulator: number, currentValue: number) => accumulator + currentValue)
  //   if (total > 0.0) {
  //     const proportions: number[] = resultAmounts.map((resAmt: number) => resAmt / total)
  //     const newStartAmounts: string[] = proportions.map((proportion: number) => `${proportion * parseFloat(amount)}`)

  //     // Get a scrubbed route object to work with ...
  //     //
  //     let _scrubbedTopRoutes: t.VFRoutes = []
  //     for (const _route of _topRoutes) {
  //       let _scrubbedRoute: t.VFRoute = []
  //       for (const _seg of _route) {
  //         let _scrubbedSeg: t.VFSegment = {
  //           src: _seg.src,
  //           dst: _seg.dst,
  //           pairId: _seg.pairId
  //         }
  //         _scrubbedRoute.push(_scrubbedSeg)
  //       }
  //       _scrubbedTopRoutes.push(_scrubbedRoute)
  //     }

  //     let _newCostedRoutes: t.VFRoutes = []
  //     let index: number = 0
  //     for (const route of _scrubbedTopRoutes) {
  //       const costedRoutes: t.VFRoutes = await r.costRoutes(_uniData.pairData,
  //                                                               _uniData.tokenData,
  //                                                               [route],
  //                                                               newStartAmounts[index],
  //                                                               50.0 /* maxImpact */,
  //                                                               false /* updatePairData */)
  //       index++
  //       _newCostedRoutes.push(costedRoutes[0])    // There should only be one here now
  //                                                 // TODO: sanity checks etc.
  //     }

  //     r.annotateRoutesWithSymbols(_uniData.tokenData, _newCostedRoutes)

  //     log.info('\nProportional Split Route\n' +
  //             '--------------------------------------------------------------------------------\n\n' +
  //             'SUM:\n')

  //     let sum: number = 0.0
  //     for (let routeIdx = 0; routeIdx < _newCostedRoutes.length; routeIdx++) {
  //       const route: t.VFRoute = _newCostedRoutes[routeIdx]
  //       const lastSeg: t.VFSegment = route[route.length - 1]
  //       const result: number = lastSeg.dstAmount ? parseFloat(lastSeg.dstAmount) : 0
  //       sum += result
  //       let routeStr = ''
  //       for (let segIdx = 0; segIdx < route.length; segIdx++) {
  //         routeStr += route[segIdx].srcSymbol + ' > '
  //         if (segIdx === route.length - 1) {
  //           routeStr += route[segIdx].dstSymbol
  //         }
  //       }
  //       log.info(`  ${result}\t(${routeStr}, input=${newStartAmounts[routeIdx]})`)
  //     }
  //     log.info('  --------------------')
  //     log.info(`  ${sum}\n\n`)
  //   }
  //  }


  /*******************************************************************************
   * Algorithm 3: Construct a trade graph from the top yielding trades 
   *              and then starting at the source navigate out and share
   *              segments where possible.
   *              Enhancement: add normalized yield in USD/ETH to edges
   * 
   *              TODO:
   *                - Switch to cytograph lib.
   *                - Figure out the proper graph algs for doing this.
   *                - May not need cytograph even installed for this.
   * 
   *******************************************************************************/
  if (_topRoutes.length >= 0) {
    const subg: t.PairGraph = new graphlib.Graph({directed: true,
                                                  multigraph: false,
                                                  compound: false})
    const cy: cytoscape.Core = cytoscape()

    if (_uniData.wethPairData) {
      await r.annotateRoutesWithUSD(_uniData.pairData,
                                    _uniData.wethPairData,
                                    _topRoutes,
                                    false   /* update pair data */)
    }
    r.annotateRoutesWithSymbols(_uniData.tokenData, _topRoutes)

    // Construct the trade graph from the top trades, annotating edges with trade
    // information to make splitting / multipath decisions:
    //
    const TOLERANCE = 0.00001
    for (const route of _topRoutes) {
      for (let segIdx = 0; segIdx < route.length; segIdx++) {
        const seg = route[segIdx]
        const hop = segIdx + 1
        // const existingEdgeObj = subg.edge(seg.src, seg.dst)
        // if (existingEdgeObj) {
        //   if (!seg.dstUSD) {
        //     continue
        //   }
        //   if ((parseFloat(seg.dstUSD) - parseFloat(existingEdgeObj.dstUSD)) > TOLERANCE) {
        //     log.warn(`Algorithm 3 segment collision with mismatched USD amounts.`)
        //   }
        // }

        const edgeObj: any = {
          pairId: seg.pairId,
          impact: seg.impact,
          dstUSD: seg.dstUSD 
        }
        subg.setEdge(seg.src, seg.dst, edgeObj)
        subg.setNode(seg.src, seg.srcSymbol)
        subg.setNode(seg.dst, seg.dstSymbol)

        // Construct a trade tree--very different from the typical pair tree b/c it
        // represents the traversal of the pair tree:
        //
        const srcGraphId = `${seg.src}_${hop-1}`
        if (cy.nodes(`#${srcGraphId}`).length === 0) {
          cy.add({group: 'nodes', data: { id: srcGraphId, 
                                          addr: seg.src,
                                          label: seg.srcSymbol } })
        }

        const dstGraphId = (seg.dst !== buyToken) ? `${seg.dst}_${hop}` : _getLastId(buyToken)
        if (cy.nodes(`#${dstGraphId}`).length === 0) {
          cy.add({group: 'nodes', data: { id: dstGraphId, 
                                          addr: seg.src,
                                          label: seg.dstSymbol } })
        }

        if (cy.edges(`[source = "${srcGraphId}"][target = "${dstGraphId}"]`).length === 0) {
          cy.add({ group: 'edges', data: { id: _getEdgeId(seg.pairId),
                                          source: srcGraphId,
                                          target: dstGraphId,
                                          label: `$${seg.dstUSD},  ${parseFloat(seg.impact ? seg.impact : '0').toFixed(3)}%`,
                                          pairId: seg.pairId,
                                          dstUsd: seg.dstUSD,
                                          slippage: seg.impact,
                                          hop }})
        }

        // const eles: any = []
        // if (cy.nodes(`#${seg.src}`).length === 0) {   // Only add the node once
        //   eles.push({ group: 'nodes', data: { id: seg.src, label: seg.srcSymbol } })
        // }
        // if (cy.nodes(`#${seg.dst}`).length === 0) {   // Only add the node once
        //   eles.push({ group: 'nodes', data: { id: seg.dst, label: seg.dstSymbol } })
        // }
        // if (cy.edges(`[pairId = "${seg.pairId}"][hop = ${hop}]`).length === 0)
        // eles.push({ group: 'edges', data: { id: _getEdgeId(seg.pairId),
        //                                     source: seg.src,
        //                                     target: seg.dst,
        //                                     label: seg.dstUSD,
        //                                     pairId: seg.pairId,
        //                                     hop
        //                                   }})
        // cy.add(eles)
      }
    }

    _dumpGraph(subg, sellToken.toLowerCase())

    // log.debug(`cy.elements.jsons()\n` +
    //           `--------------------------------------------------------------------------------\n` +
    //           `${JSON.stringify(cy.elements().jsons(), null, 2)}\n\n`)
    // // log.debug(`cy.edges()\n` +
    //           `--------------------------------------------------------------------------------\n` +
    //           `${JSON.stringify(cy.edges(), null, 2)}\n\n`)

    // Need to clean up the graph structure into something that can be costed and
    // provides sufficient decision making power for costing decisions:
    //
    const elements = cy.elements().jsons()
    const eleDatas = elements.map((ele: any) => { return { data: ele.data } })
    log.debug(`eleDatas\n` +
              `--------------------------------------------------------------------------------\n` +
              `${JSON.stringify(eleDatas, null, 2)}\n\n`)
    return eleDatas
  }
}

// Issues:
//   - doesn't work if there are cycles possible
//
const MAX_DUMP_HOPS = 10
const _dumpGraph = (graph: t.PairGraph,
                    start: string,
                    visited: string[] = [],
                    amountUSD: string = '',
                    hops: number = 0): void => 
{
  const amtStr = (amountUSD) ? ` ($${amountUSD})` : ''
  log.info(`${getSpaces(hops * 3)}${graph.node(start)}${amtStr}`)
  const _visited: string[] = [...visited]   // Detect cycles for this particular path
                                            // and prevent them.
  _visited.push(start)

  if (hops < MAX_DUMP_HOPS) {
    let successors = graph.successors(start)
    hops++
    for (const successor of successors) {
      if (!visited.includes(successor)) {
        const edgeObj = graph.edge(start, successor)
        _dumpGraph(graph, successor, _visited, edgeObj.dstUSD, hops)
      }
    }
  }
}


/*
 * ID to allow directional edges for pair IDs along with lookup
 * from ID to pairID. 
 */
let _edgeMap: { [index:string]: string } = {}
const _getEdgeId = (pairId: string): string => 
{
  let id = uuidv4()
  _edgeMap[id] = pairId
  return id
}

/*
 * ID for last node in route to allow tree creation.
 *
 */
let _lastNodeMap: { [index:string]: string } = {}
const _getLastId = (addr: string): string => 
{
  let id = uuidv4()
  _lastNodeMap[id] = addr
  return id
}