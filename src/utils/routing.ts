import * as ds from './debugScopes'
import * as t from './types'
import { WETH_ADDR, USDC_ADDR, WETH_ADDRS_LC } from './constants'
import { getUpdatedPairData } from './../graphProtocol/uniswapV2'
import { getIntegerString, getSpaces, deepCopy } from './misc'
import { ChainId,
         Token,
         WETH,
         TokenAmount,
         Route,
         Trade,
         TradeType, 
         Pair,
         Fraction} from '@uniswap/sdk'
import { getAddress } from '@ethersproject/address'
import JSBI from 'jsbi'
import { v4 as uuidv4 } from 'uuid'
import cytoscape from 'cytoscape'
import crawl from 'tree-crawl'

const log = ds.getLog('routing')

// New slightly more optimized alg.: 
//
const _routeSearch = (g: t.PairGraph, 
                     hops: number, 
                     constraints: t.Constraints,
                     route: any, 
                     rolledRoutes: t.VFStackedRoutes,
                     prevOriginAddr: string,
                     originAddr: string, 
                     destAddr: string): void => 
{
  let neighbors = g.neighbors(originAddr)
  hops++

  for (const neighbor of neighbors) {
    if (neighbor === destAddr) {
      // Optimization: rather than make this a mulitgraph, represent all pairs in a single edge and
      //               store their ids as a property of that edge.
      const _route: any = [...route, { src: originAddr, dst: neighbor, pairIds: g.edge(originAddr, neighbor).pairIds }]
      rolledRoutes.push(_route)
    } else if (constraints.maxDistance && hops < constraints.maxDistance) {
      if (neighbor === originAddr ||
          neighbor === prevOriginAddr ||    // Prevent cycle back to last origin addr (i.e. FEI TRIBE cycle of FEI > WETH > FEI > TRIBE).
                                            // We limit max hops to 3 so cycles like FEI > x > y > FEI aren't
                                            // a consideration (otherwise we'd need to expand this search's
                                            // memory of previous visits.)
          (constraints.ignoreTokenIds && constraints.ignoreTokenIds.includes(neighbor))) {
        continue
      }

      // Optimization: rather than make this a mulitgraph, represent all pairs in a single edge and
      //               store their ids as a property of that edge.
      const _route: any = [...route, { src: originAddr, dst: neighbor, pairIds: g.edge(originAddr, neighbor).pairIds }]
      _routeSearch(g, 
                   hops,
                   constraints,
                   _route,
                   rolledRoutes,
                   originAddr,
                   neighbor,
                   destAddr)
    }
  }
}

export const findRoutes = (pairGraph: t.PairGraph,
                           srcAddr: string,
                           dstAddr: string,
                           constraints?: t.Constraints,
                           verbose?: boolean): t.VFStackedRoutes =>
{
  let rolledRoutes: t.VFStackedRoutes= []

  const _defaultConstrs: t.Constraints = {
    maxDistance: 2
  }
  const _constraints: t.Constraints = {..._defaultConstrs, ...constraints}

  if (!srcAddr || !dstAddr) {
    log.error(`A source token address(${srcAddr}) and destination token ` +
              `address(${dstAddr}) are required.`)
    return rolledRoutes
  }
  const _srcAddrLC = srcAddr.toLowerCase()
  const _dstAddrLC = dstAddr.toLowerCase()

  // Special case: routing from WETH as source, reduce max hops to 1 as this starting node has 30k+
  //               neighbors and doesn't finish in reasonable time.
  if (WETH_ADDRS_LC.includes(_srcAddrLC)) {
    log.debug(`findRoutes:  detected routing from wETH, reducing max hops to 1.`)
    _constraints.maxDistance = 1
  }

  if (_srcAddrLC === _dstAddrLC) {
    log.error(`Money laundering not supported (same token routes, ${srcAddr} -> ${dstAddr}).`)
  }

  if (!pairGraph.hasNode(_srcAddrLC)) {
    log.error(`Source token address, ${srcAddr}, is not in the graph.`)
    return rolledRoutes
  }
  if (!pairGraph.hasNode(_dstAddrLC)) {
    log.error(`Destination token address, ${dstAddr}, is not in the graph.`)
    return rolledRoutes
  }

  if (_constraints.ignoreTokenIds && _constraints.ignoreTokenIds.includes(_srcAddrLC)) {
    log.error(`Source token address, ${srcAddr}, is constrained out of the route search.`)
    return rolledRoutes
  }
  if (_constraints.ignoreTokenIds && _constraints.ignoreTokenIds.includes(_srcAddrLC)) {
    log.error(`Destination token address, ${dstAddr}, is constrained out of the route search.`)
    return rolledRoutes
  }

  if (verbose) {
    log.info(`Finding routes from token ${srcAddr} to token ${dstAddr} ...`)
  }

  let hops = 0
  let route: any = []
  _routeSearch(pairGraph,
               hops,
               _constraints,
               route,
               rolledRoutes,
               '',
               _srcAddrLC,
               _dstAddrLC)

  rolledRoutes.sort((a: any, b:any) => {
    return a.length - b.length    // Ascending order by route length
  })

  return rolledRoutes
}

export const routesToString = (rolledRoutes: t.VFStackedRoutes, tokenData: t.Tokens): string => 
{
  let _routeStr: string = '\n'

  let _routeNum = 0
  for (const _route of rolledRoutes) {
    _routeStr += `Route ${++_routeNum}:\n` +
                `----------------------------------------\n`
    for (const _pair of _route) {
      let srcStr = _pair.src
      let dstStr = _pair.dst
      if (tokenData) {
        srcStr += ` (${tokenData.getSymbol(_pair.src)})`
        dstStr += ` (${tokenData.getSymbol(_pair.dst)})`
      }

      _routeStr += `  ${srcStr} --> ${dstStr}, ${_pair.pairIds.length} pairs:\n`
      for (const _pairId of _pair.pairIds) {
        _routeStr += `      ${_pairId}\n`
      }
    }
    _routeStr += '\n'
  }

  return _routeStr
}

export const unstackRoutes = (stackedRoutes: t.VFStackedRoutes): t.VFRoutes =>
{
  let routes: t.VFRoutes= []

  for (const stackedRoute of stackedRoutes) {
    // Unstack the route by determining the number of pairs in each segment and
    // then constructing all possible routes implied by the stacked pairs of each
    // segment. For example considering the following stacked route:
    //
    //   src --> segment1 --> segment2 --> dst
    //              p1           p2
    //                           p3
    //
    // The algorithm herein 'unstacks' this route creating two routes, implied
    // by the stacked pairs:
    //
    //  src --> p1 --> p2 --> dst
    //
    //  src --> p1 --> p3 --> dst
    //
    const segmentPairCounts: number[] = []    // Count of number of pairs in each segment.
    const segmentPairIndices: number[] = []   // Indices to be used in the conversion described 
                                              // in the comment above.
    for (let idx = 0; idx < stackedRoute.length; idx++) {
      segmentPairCounts[idx] = stackedRoute[idx].pairIds.length
      segmentPairIndices[idx] = 0
    }

    while (segmentPairIndices[segmentPairIndices.length-1] < segmentPairCounts[segmentPairCounts.length-1]) {
      const route: t.VFRoute = []
      for (let segIdx = 0; segIdx < stackedRoute.length; segIdx++) {
        const stackedSegment = stackedRoute[segIdx]
        const pairIndex = segmentPairIndices[segIdx]
        const pairId = stackedSegment.pairIds[pairIndex]

        const segment: t.VFSegment = {
          src: stackedSegment.src,
          dst: stackedSegment.dst,
          pairId
        }

        route.push(segment)
      }

      routes.push(route)

      // Ingrement the pair indices for the segments.  (Basically a counter that counts to the number of
      // pairs for each segment, then incrementing the pair index of the next segment when the number of
      // pairs for the previous segment is reached.):
      //
      for (let segIdx = 0; segIdx < stackedRoute.length; segIdx++) {
        segmentPairIndices[segIdx]++
        if ((segmentPairIndices[segIdx] < segmentPairCounts[segIdx]) || (segIdx === stackedRoute.length - 1)) {
          break
        } else {
          segmentPairIndices[segIdx] = 0
        }
      }
    }
  }
  
  return routes
}

/*
 * TODO: 
 *   - examine TODO's below, esp. handling of precision (we lose precision here vs. UNI b/c
 *     we convert to 18 dec. places internally instead of arbitrary)
 */
export const costRoutes = async (allPairData: t.Pairs,
                                 tokenData: t.Tokens,
                                 routes: t.VFRoutes,
                                 amount: string,
                                 maxImpact: number = 10.0,
                                 updatePairData: boolean = true,
                                 cacheEstimates: boolean = true): Promise<t.VFRoutes> =>
{
  const costedRoutes: t.VFRoutes = []
  const estimateCache: any = {}

  // Convert the specified double that is maxImpact to a fractional value with reasonable
  // precision:
  // const maxImpactFrac = new Fraction(JSBI.BigInt(Math.floor(maxImpact * 1e18)), JSBI.BigInt(1e18))

  /* TODO:
   *  - expand and extend this into a proper TTL based cache in Redis or other.
   *  - examine this for higher performance opportunity
   * 
   * For now, aggregate the pairIds in the route and fetch their current stats
   * in aggregate.  TODO: add the block id to the lookup and put it in the 
   *                      updatedBlock.
   * 
   */
  if (updatePairData) {
    const start: number = Date.now()
    const pairIdsToUpdate: Set<string> = getAllPairsIdsOfAge(allPairData, routes)
    const updatedPairs: t.PairLite[] = await getUpdatedPairData(pairIdsToUpdate)
    const updateTimeMs = Date.now()
    allPairData.updatePairs(updatedPairs, updateTimeMs)
    log.debug(`costRoutes: Finished updating ${pairIdsToUpdate.size} pairs in ${Date.now() - start} ms`)
  }

  const startCostMs: number = Date.now()
  const estStats = {
    hits: 0,
    misses: 0,
    entries: 0
  }

  for (const route of routes) {
    let inputAmount = amount    // This is the value passed in and will be converted
                                // to an integer representation scaled by n decimal places
                                // in getIntegerString (as called by computeTradeEstimates)
    let exceededImpact = false
    let failedRoute = false

    for (const segment of route) {
      const pairData = allPairData.getPair(segment.pairId)
      let estimate: any = undefined
      try {
        if (cacheEstimates) {
          const estimateKey = `${inputAmount}-${segment.src}-${segment.pairId}`
          estimate = estimateCache[estimateKey]
          if (!estimate) {
            estStats.misses++
            estimate = computeTradeEstimates(pairData, tokenData, segment.src, inputAmount)
            
            estStats.entries++
            estimateCache[estimateKey] = estimate
          } else {
            estStats.hits++
          }
        } else {
          estimate = computeTradeEstimates(pairData, tokenData, segment.src, inputAmount)
        }
      } catch (ignoredError) {
        // log.warn(`Failed computing impact estimates for ${segment.src} --> ${segment.dst}:\n` +
        //          `${JSON.stringify(pairData, null, 2)}\n` +
        //          ignoredError)
        failedRoute = true
        break
      }
      
      // TODO: see why this next line is not working, for now, though parseFloat workaround:
      // if (estimate.trade.priceImpact.greaterThan(maxImpactFrac)) {
      if (parseFloat(estimate.trade.priceImpact.toSignificant(18)) > maxImpact) {
        exceededImpact = true
        break
      }

      // TODO: optimization - compute the cumulative impact and if that exceeds
      //       maxImpactFrac, then break.

      // Two different types at play here--Big & Currency (Currency is Big wrapped with decimal info for a token).
      // See more here:
      //    - https://github.com/Uniswap/uniswap-sdk-core/tree/main/src/entities/fractions
      //    - specifically fraction.ts and currencyAmount.ts
      //
      segment.impact = estimate.trade.priceImpact.toSignificant(18)
      segment.srcAmount = estimate.trade.inputAmount.toExact()
      segment.dstAmount = estimate.trade.outputAmount.toExact()

      // TODOs: 
      //       1. This is ugly and will lose precision, we need to either complete the TODO on the
      //       computeTradeEstimates method (estimate entire routes), or find an alternate solution
      //       to prevent precision loss.
      //
      //       2. Check assumption that slippage is multiplied into outputAmount (may need to use
      //          other methods in Uni API / JSBI etc.)
      //
      inputAmount = estimate.trade.outputAmount.toExact()
    }

    if (failedRoute) {
      // log.debug(`Route failed in estimation, not adding:\n${JSON.stringify(route, null, 2)}`)
      continue
    }

    if (exceededImpact) {
      // log.debug(`Route exceeded impact, not adding:\n${JSON.stringify(route, null, 2)}`)
      continue
    }

    costedRoutes.push(route)
  }

  // if (cacheEstimates) {
  //   log.debug(`cacheEstimates ON:\n` +
  //             `    ${routes.length} routes submitted for costing\n` +
  //             `    ${costedRoutes.length} costed routes\n` +
  //             `    ${JSON.stringify(estStats, null, 2)}\n\n`)
  // }

  log.debug(`costRoutes completed in ${Date.now() - startCostMs} ms.`)

  return costedRoutes
}

// See: https://www.w3schools.com/cssref/css_colors.asp
export const PATH_COLORS: { [index: string]: string } = {
  DEFAULT: 'LightGray',       // #D3D3D3
  DEFAULT_EDGE: 'Gainsboro',  // #DCDCDC
  UNI: 'CornFlowerBlue',      // #1E90FF
  UNI_EDGE: 'LightBlue'       // $ADD8E6
}
export interface TradeTreeNode {
  value: {
    id: string,
    address: string,
    color: string,
    symbol?: string,
    amount?: string,
    amountUSD?: string
    pairId?: string,
    impact?: string,
    // Nested Objects:
    // ---------------
    // gainToDest?: { <routeId>: <gainToDest>, <routeId>: <gainToDest>, ... }
    gainToDest?: {
      [index: string]: number 
    }
    // trades?: { <tradeId>: <tradeObj> }
    trades?: any,
  },
  parent?: TradeTreeNode,
  children: TradeTreeNode[]
}

const _pruneTreeRoute = (node: TradeTreeNode, routeId: string, nodesToDelete: TradeTreeNode[]): void => {
  for (const childNode of node.children) {
    _pruneTreeRoute(childNode, routeId, nodesToDelete)
  }
  if (node.value.gainToDest && node.value.gainToDest.hasOwnProperty(routeId)) {
    delete node.value.gainToDest[routeId]

    if (Object.keys(node.value.gainToDest).length === 0) {
      nodesToDelete.push(node)
    }
  }
}

export const pruneTreeRoute = (rootNode: TradeTreeNode, routeId: string): void =>
{
  const nodesToDelete: TradeTreeNode[] = []
  _pruneTreeRoute(rootNode, routeId, nodesToDelete)

  for (const node of nodesToDelete) {
    if (node.parent && node.parent.children) {
      let nodeIndex = node.parent.children.indexOf(node)
      node.parent.children.splice(nodeIndex, 1)
      node.parent = undefined
    }
  }
}

const _getTreeRoutePath = (node: TradeTreeNode, routeId: string, path: string[]): void =>
{
  let pathNode: TradeTreeNode | undefined = undefined
  for (const childNode of node.children) {
    if (childNode.value.gainToDest) {
      const { gainToDest } = childNode.value
      if (gainToDest.hasOwnProperty(routeId)) {
        pathNode = childNode
        break
      }
    }
  }
  
  if (pathNode) {
    // Add the symbol of the incoming node as we've found a child with the specified
    // route ID:
    const symbol = (node.value.symbol) ? node.value.symbol : '<unknown>'
    path.push(symbol)

    _getTreeRoutePath(pathNode, routeId, path)
  } else if (path.length > 0) {
    // Special case, if we've added symbols and we're at the end of the path,
    // add the last symbol to show the complete path through to destination (destination
    // will have no children with routeId in gainToDest):
    const symbol = (node.value.symbol) ? node.value.symbol : '<unknown>'
    path.push(symbol)
  }
}

export const getTreeRoutePath = (rootNode: TradeTreeNode, routeId: string): string[] =>
{
  const path: string[] = []
  _getTreeRoutePath(rootNode, routeId, path)
  return path
}

export const buildTradeTree = (routes: t.VFRoutes): TradeTreeNode | undefined =>
{
  let tradeTree: TradeTreeNode | undefined = undefined

  let _eleIdCounter = 0
  for (let routeIdx = 0; routeIdx < routes.length; routeIdx++) {
    const route: t.VFRoute = routes[routeIdx]

    // Each route is a single path, so we keep track of the
    // tree node we're inserting into as we iterate:
    //
    let node: TradeTreeNode | undefined = tradeTree
    for (const seg of route) {
      // Special cases handled in predicates below:
      //    1. First time inserting into the tree, define the root.
      //    2. Inserting the first segment of a route, we
      //       have to process the src data.
      //
      if (!node) {
        tradeTree = {
          value: {
            id: _eleIdCounter.toString(),
            address: seg.src,
            symbol: seg.srcSymbol,
            amount: seg.srcAmount,
            amountUSD: seg.srcUSD,
            color: seg.isUni ? PATH_COLORS.UNI : PATH_COLORS.DEFAULT
          },
          children: []
        }
        _eleIdCounter++

        node = tradeTree
      } else if (node === tradeTree) {
        // Error condition if the addresses for the same root node mismatch!
        if (node.value.address !== seg.src) {
          throw Error(`buildTradeTree: root node does not match address ` +
                      `${node.value.address} (${node.value.symbol}) of src ` +
                      `in first segment of route.\n` +
                      `${JSON.stringify(route, null, 2)}`)
        } else {
          // Special case - we've already added a root node, but need to ensure it's
          // tagged as the uniswap route if the current route is the uniswap one.
          //   - this might make more sense using a find path op after the fact using
          //     the uni route. (TODO:)
          //
          if (seg.isUni) {
            node.value.color = PATH_COLORS.UNI
          }
        }
      }

      // Add the destination of the segment to the tree if it doesn't exist
      // already and then update the node pointer:
      //
      let dstNode: TradeTreeNode | undefined = 
        node.children.find((searchNode: TradeTreeNode) => 
                           searchNode.value.address === seg.dst)
      if (!dstNode) {
        dstNode = {
          value: {
            id: _eleIdCounter.toString(),
            address: seg.dst,
            symbol: seg.dstSymbol,
            amount: seg.dstAmount,
            amountUSD: seg.dstUSD,
            pairId: seg.pairId,
            impact: seg.impact,
            gainToDest: {},
            color: seg.isUni ? PATH_COLORS.UNI: PATH_COLORS.DEFAULT
          },
          parent: node,
          children: []
        }
        _eleIdCounter++
        node.children.push(dstNode)
      } else {
        // Special case - we've already added this node, but need to ensure it's tagged as
        // the uniswap route. Might make more sense to do this in a post build find operation
        // using the UNI route (TODO:)
        //
        if (seg.isUni) {
          dstNode.value.color = PATH_COLORS.UNI
        }
      }
      if (dstNode.value.gainToDest !== undefined) {
        dstNode.value.gainToDest[routeIdx] = (seg.gainToDest === undefined) ? 0.0 : seg.gainToDest
      }
      node = dstNode
    }
  }

  // console.log(`Trade Tree\n` +
  //             `================================================================================`)
  // crawl(tradeTree,
  //       (node, context) => {
  //         console.log(getSpaces(2* context.level) + (node ? node.value.symbol : ''))
  //       },
  //       { order: 'pre'})

  return tradeTree
}

const _cloneTradeTreeNode = (node: TradeTreeNode, exact: boolean): TradeTreeNode =>
{
    // Any types to allow for-loop based conditional assignment of cloned props below.
    //
    let clone: any = {
      value: {
        id: exact ? node.value.id : uuidv4(),
        address: node.value.address,
        color: node.value.color
      },
      children: [],
    }

    // TODO: better way using the type system/TS than listing out props / keys in arr below
    //
    const objProps = ['gainToDest', 'trades']
    const nodeAny: any = node
    for (const key of ['symbol', 'amount', 'amountUSD', 'pairId', 'impact', ...objProps]) {
      if (nodeAny.value.hasOwnProperty(key)) {
        clone.value[key] = (objProps.includes(key)) ?
          deepCopy(nodeAny.value[key]) : nodeAny.value[key]
      }
    }
    return clone
}

const _cloneTradeTree = (node: TradeTreeNode, clone: TradeTreeNode, exact: boolean): void => {
  for (const childNode of node.children) {

    const childClone: TradeTreeNode = _cloneTradeTreeNode(childNode, exact)
    childClone.parent = clone
    clone.children.push(childClone)
    _cloneTradeTree(childNode, childClone, exact)
  }
}

export const cloneTradeTree = (root: TradeTreeNode, exact: boolean = false): TradeTreeNode | undefined =>
{
  const rootClone: TradeTreeNode = _cloneTradeTreeNode(root, exact)
  _cloneTradeTree(root, rootClone, exact)
  return rootClone 
}

// Useful for visualizing in our web client
//
export const tradeTreeToCyGraph = (tradeTree: TradeTreeNode, useUuid=false): cytoscape.Core =>
{
  let _cyEleId = 0
  let uuidLookup: any = {}
  const cy: cytoscape.Core = cytoscape()
  crawl(tradeTree,
        (node, context) => {
          if (node) {
            const nodeId = node.value.id
            let cyNodeId = nodeId
            if (useUuid) {
              if (!uuidLookup.hasOwnProperty(nodeId)) {
                uuidLookup[nodeId] = uuidv4()
              }
              cyNodeId = uuidLookup[nodeId]
            }

            let isMultiPath = node.value.hasOwnProperty('trades')
            let amount = node.value.amount
            let amountUSD = node.value.amountUSD
            if (isMultiPath) {
              let trade: any = undefined
              // Get first trade
              for (const tradeKey in node.value.trades) {
                trade = node.value.trades[tradeKey]
                break;
              }
              amount = trade.outputAmount
              amountUSD = trade.outputUsd
            }

            const nodeData = {
              id: `n_${cyNodeId}`,
              address: node.value.address,
              amount,
              amountUSD,
              symbol: node.value.symbol,
              label: '',
              color: `${node.value.color}`
            }
            cy.add({ group: 'nodes', data: nodeData})

            // Special case - root node has no parents and thus no edges. Only
            // add an edge if the parent is not null (i.e. for non root node):
            //
            if (context.parent) {
              const parent = context.parent
              const impact = parseFloat(node.value.impact ? node.value.impact : '0').toFixed(3)
              // const label = `$${node.value.amountUSD},  ${impact}%`
              const label = `${impact}%`
              const color = (parent.value.color === PATH_COLORS.UNI &&
                             node.value.color === PATH_COLORS.UNI) ? 
                             PATH_COLORS.UNI_EDGE : PATH_COLORS.DEFAULT_EDGE

              let parentNodeId = parent.value.id
              let targetNodeId = node.value.id
              let edgeId = _cyEleId.toString()
              let cyParentNodeId = parentNodeId
              let cyTargetNodeId = targetNodeId
              let cyEdgeId = edgeId
              if (useUuid) {
                for (const id of [parentNodeId, targetNodeId, edgeId]) {
                  if (!uuidLookup.hasOwnProperty(id)) {
                    uuidLookup[id] = uuidv4()
                  }
                }
                cyParentNodeId = uuidLookup[parentNodeId]
                cyTargetNodeId = uuidLookup[targetNodeId]
                cyEdgeId = uuidLookup[edgeId]
              }

              const edgeData = { 
                id: `e_${cyEdgeId}`,
                label,
                source: `n_${cyParentNodeId}`,
                target: `n_${cyTargetNodeId}`,
                slippage: node.value.impact,
                gainToDest: node.value.gainToDest,
                trades: node.value.trades,
                pairId: node.value.pairId,
                hop: context.level - 1,
                color
              }
              _cyEleId++
              cy.add({ group: 'edges', data: edgeData })
            }
          }
        },
        { order: 'pre'} )

  return cy
}

const _getTradeId = (tradeIds: string[]): string => {
  let id = 0
  for (const tradeIdStr of tradeIds) {
    const tradeId = parseInt(tradeIdStr)
    if (tradeId > id) {
      id = tradeId
      id++
    }
  }
  return id.toString()
}

interface TradeProportion {
  proportion?: number,
  maxGainToDest: number,
  node: TradeTreeNode
}
type TradeProportions = TradeProportion[]

const _getTradeProportions = (startNode: TradeTreeNode): TradeProportions => {
  const tradeProportions: TradeProportions = []

  if (startNode.children.length === 1) {
    // Special Case: 1 child
    //
    const childNode = startNode.children[0]
    let maxGainToDest = 0.0
    if (childNode.value.gainToDest) {
      for (const routeId in childNode.value.gainToDest) {
        const gainToDest = childNode.value.gainToDest[routeId]
        if (gainToDest > maxGainToDest) {
          maxGainToDest = gainToDest
        }
      }
    }

    tradeProportions.push({
      proportion: 1.0,
      maxGainToDest,
      node: startNode.children[0]
    })
  } else {
    // Generic case: > 1 children
    //
    for (const childNode of startNode.children) {
      let maxGainToDest = 0.0
      if (childNode.value.gainToDest) {
        for (const routeId in childNode.value.gainToDest) {
          const gainToDest = childNode.value.gainToDest[routeId]
          if (gainToDest > maxGainToDest) {
            maxGainToDest = gainToDest
          }
        }
      }

      tradeProportions.push({
        proportion: undefined,
        maxGainToDest,
        node: childNode
      })
    }

    // Check for special case where maxGainToDest exceeds 1.0 and route entirely
    // to this path:
    //
    let unityGainExceedIndex = -1
    let maxGainBeyondUnity = 0.0
    tradeProportions.forEach((value: TradeProportion, index: number) => {
      if (value.maxGainToDest > 1.0 && value.maxGainToDest > maxGainBeyondUnity) {
        maxGainBeyondUnity = value.maxGainToDest
        unityGainExceedIndex = index
      }
    })
    if (unityGainExceedIndex >= 0) {
      const tradeProp = tradeProportions[unityGainExceedIndex]
      log.warn(`Found trade with gain exceeding unity (${tradeProp.maxGainToDest}).\n`)
      // TODO: expand this warning (crawl the route and present the path and pair IDs)
      tradeProportions.forEach((value: TradeProportion, index: number) => {
        value.proportion = (index === unityGainExceedIndex) ? 1.0 : 0.0
      })
    } else {
      // Generic case where all gainToDest < 1.0:
      //
      //   Algorithm attenuates each gain exponentially by it's distance from unity cubed
      //   and then normalizes the attenuated values to provide a set of proportions summing
      //   to unity. This accounts for the slippage in the Uniswap V2 constant product formula
      //   but will required further tuning for optimal results as well as appropriate considerations
      //   for fixed precision arithmetic (r/n in the prototyping phase, we're working around
      //   the time required to do so using doubles).
      //
      tradeProportions.map((ele: any) => {
        // Not better on or USDC -> WETH 10M test case (needed to delegate more):
        // ele.proportion = ele.maxGainToDest * ele.maxGainToDest * ele.maxGainToDest
        // ele.proportion = ele.maxGainToDest * ele.maxGainToDest
        ele.proportion = ele.maxGainToDest * ele.maxGainToDest * ele.maxGainToDest * ele.maxGainToDest
      })
      let proportionSum = 0
      for (const ele of tradeProportions) {
        if (ele.proportion) {
          proportionSum += ele.proportion
        }
      }
      tradeProportions.map((ele: any) => {
        ele.proportion = ele.proportion / proportionSum
      })
    }
  }

  return tradeProportions
}

// TODO:
//    1. Finite precision effects w/ doubles used below (arb integers and fraction model)
//    2. Update pair data
//
export const costTradeTree = async(allPairData: t.Pairs,
                                   tokenData: t.Tokens,
                                   amount: string,
                                   rootNode: TradeTreeNode,
                                   updatePairData: boolean = true):Promise<void> =>
{
  // TODO - TODO: handle updatePairData

  // Generate a schedule of functions to visit for costing (can't use async/await with
  // crawl unfortunately.)
  //
  // bfsVisitSchedule:
  // {
  //   <level>: [ <TradeTreeNode>, <TradeTreeNode>, ...]
  //   ...
  // }
  let lastLevel = 0
  const bfsVisitSchedule: { [index: string]: TradeTreeNode[] } = {}
  crawl(rootNode,
        (node, context) => {
          if (!bfsVisitSchedule.hasOwnProperty(context.level)) {
            bfsVisitSchedule[context.level] = []
            if (context.level > lastLevel) {
              lastLevel = context.level
            }
          }
          bfsVisitSchedule[context.level].push(node)
        },
        { order: 'bfs'})
  
  let tradeId: string | undefined = undefined
  for (const level in bfsVisitSchedule) {
    const nodesAtLevel = bfsVisitSchedule[level]

    if (level === '1') {
      // Special Case:  1st level
      //
      if (nodesAtLevel.length !== 1) {
        throw Error(`costTradeTree: expected one node at level 1 (root), found ${nodesAtLevel.length}.`)
      }

      //    - annotate the root node trades object with the 
      //      tradeId, inputAmount, outputAmount:
      //
      const node = nodesAtLevel[0]
      if (!node.value.hasOwnProperty('trades')) {
        node.value.trades = {}
      }
      const { trades } = node.value
      tradeId = _getTradeId(Object.keys(trades))
      trades[tradeId] = {
        inputAmount: amount,
        outputAmount: amount,
        proportion: 1.0
      }
    
      //    - determine the split to route the trade between
      //      multiple children
      //
      const tradeProportions: TradeProportions = _getTradeProportions(node)

      for (const tradeProp of tradeProportions) {
        const childNode = tradeProp.node
        const proportion = (tradeProp.proportion === undefined) ? 0 : tradeProp.proportion

        // The input amount to all children is the output amount of their parent node:
        let inputAmount = 0.0
        if (childNode.parent && 
            childNode.parent.value.hasOwnProperty('trades') &&
            childNode.parent.value.trades.hasOwnProperty(tradeId)) {
          // TODO:
          //  - need a better solution to this for numerical precision (i.e. arbitrary
          //    integer fraction model)
          inputAmount = proportion * parseFloat(childNode.parent.value.trades[tradeId].outputAmount)
        } else {
          throw Error(`costTradeTree: expected parent tree node to have trades with tradeId ${tradeId}\n` +
                      `parent:\n${JSON.stringify(childNode.parent ? childNode.parent.value : undefined, null, 2)}`)
        }

        //    - annotate the children node trades object with
        //      the tradeId, inputAmount 
        if (!childNode.value.hasOwnProperty('trades')) {
          childNode.value.trades = {}
        }
        const { trades } = childNode.value
        
        if (!trades.hasOwnProperty(tradeId)) {
          trades[tradeId] = {}
        }
        const trade = trades[tradeId]
        trade.proportion = proportion
        trade.inputAmount = inputAmount

        //    - perform costing and annotate the children node trades with
        //      the outputAmount 
        const pairId = childNode.value.pairId
        if (!pairId) {
          throw Error(`costTradeTree: pair not specified on tree node.\n` +
                      `${JSON.stringify(childNode.value, null, 2)}`)
        }
        const pairData = allPairData.getPair(pairId)
        let estimate: any = undefined
        try {
          estimate = computeTradeEstimates(
            pairData, tokenData, childNode.parent.value.address, inputAmount.toString())
        } catch (estimateError) {
          throw new Error(`costTradeTree: failed cost estimate.\n` +
                          `node: ${JSON.stringify(childNode.value, null, 2)}\n` +
                          `parent: ${JSON.stringify(childNode.parent.value, null, 2)}\n` +
                          `${estimateError}`)
        }

        trade.impact = estimate.trade.priceImpact.toSignificant(18)
        trade.inputAmountP = estimate.trade.inputAmount.toExact()
        trade.outputAmount = estimate.trade.outputAmount.toExact()
      }
    } else if (level === lastLevel.toString()) {
      // Special Case (the best kind):  last level, do nothing
      //
    } else {
      for (const node of nodesAtLevel) {
        // A close replica of the previous conditional branch <-- TODO: refactor
        //
        //    - determine the split to route the trade between
        //      multiple children
        //
        const tradeProportions: TradeProportions = _getTradeProportions(node)

        for (const tradeProp of tradeProportions) {
          const childNode = tradeProp.node
          const proportion = (tradeProp.proportion === undefined) ? 0 : tradeProp.proportion

          // The input amount to all children is the output amount of their parent node:
          let inputAmount = 0.0
          if (tradeId !== undefined &&
              childNode.parent && 
              childNode.parent.value.hasOwnProperty('trades') &&
              childNode.parent.value.trades.hasOwnProperty(tradeId)) {
            // TODO:
            //  - need a better solution to this for numerical precision (i.e. arbitrary
            //    integer fraction model)
            inputAmount = proportion * parseFloat(childNode.parent.value.trades[tradeId].outputAmount)
          } else {
            throw Error(`costTradeTree: expected parent tree node to have trades with tradeId ${tradeId}\n` +
                        `parent:\n${JSON.stringify(childNode.parent ? childNode.parent.value : undefined, null, 2)}`)
          }

          //    - annotate the children node trades object with
          //      the tradeId, inputAmount 
          if (!childNode.value.hasOwnProperty('trades')) {
            childNode.value.trades = {}
          }
          const { trades } = childNode.value
          
          if (!trades.hasOwnProperty(tradeId)) {
            trades[tradeId] = {}
          }
          const trade = trades[tradeId]
          trade.proportion = proportion
          trade.inputAmount = inputAmount

          //    - perform costing and annotate the children node trades with
          //      the outputAmount 
          const pairId = childNode.value.pairId
          if (!pairId) {
            throw Error(`costTradeTree: pair not specified on tree node.\n` +
                        `${JSON.stringify(childNode.value, null, 2)}`)
          }
          const pairData = allPairData.getPair(pairId)
          let estimate: any = undefined
          try {
            estimate = computeTradeEstimates(
              pairData, tokenData, childNode.parent.value.address, inputAmount.toString())
          } catch (estimateError) {
            throw new Error(`costTradeTree: failed cost estimate.\n` +
                            `node: ${JSON.stringify(childNode.value, null, 2)}\n` +
                            `parent: ${JSON.stringify(childNode.parent.value, null, 2)}\n` +
                            `${estimateError}`)
          }

          trade.impact = estimate.trade.priceImpact.toSignificant(18)
          trade.inputAmountP = estimate.trade.inputAmount.toExact()
          trade.outputAmount = estimate.trade.outputAmount.toExact()
        }
      }
    }
  }
}

export const annotateTradeTreeWithUSD = async (allPairData: t.Pairs,
                                               wethPairDict: t.WethPairIdDict,
                                               rootNode: TradeTreeNode,
                                               updatePairData: boolean=true): Promise<void> =>
{
  // TODO - TODO: handle updatePairData
  crawl(rootNode,
        (node, context) => {
          if (node.value.trades) {
            for (const tradeId in node.value.trades) {
              const trade = node.value.trades[tradeId]
              if (node.parent) {
                trade.inputUsd = getEstimatedUSD(allPairData,
                                                 wethPairDict,
                                                 node.parent.value.address,
                                                 trade.inputAmountP)
              }
              trade.outputUsd = getEstimatedUSD(allPairData,
                                                wethPairDict,
                                                node.value.address,
                                                trade.outputAmount)
            }
          }
        },
        { order: 'bfs' })
}

export const elementDataFromCytoscape = (cyGraph: cytoscape.Core): any =>
{
  const elements = cyGraph.elements().jsons()
  const eleDatas = elements.map((ele: any) => { return { data: ele.data } })

  return eleDatas
}

/**
 * To compute a token amount's approx USD value:
 * 
 *  TokenAmountUSD = TokenAmount * Weth/Token * USDC/Weth
 * 
 * This method builds a lookup that lets you get the pair IDs needed to compute this:
 * {
 *    wethId: string,
 *    wethTokenPairId: string,
 *    wethUsdtPairId: string
 * }
 */
export const getEstimatedUSD = (allPairData: t.Pairs,
                                wethPairDict: t.WethPairIdDict,
                                tokenId: string,
                                tokenAmount: string): string =>
{
  let wethPerToken: string = '1'    // Assume input token ID is for WETH

  if (tokenId !== WETH_ADDR) {
    const wethPairId: string = wethPairDict[tokenId] 
    if (!wethPairId) {
      log.warn(`getEstimatedUSD: no WETH pair for ${tokenId}.`)
      return ''
    }
    const wethPair: t.Pair = allPairData.getPair(wethPairId)
    wethPerToken = (wethPair.token0.id === WETH_ADDR) ? wethPair.token0Price : wethPair.token1Price
  } 

  const usdcWethPairId: string = wethPairDict[USDC_ADDR]
  const usdcWethPair: t.Pair = allPairData.getPair(usdcWethPairId)
  const usdcPerWeth: string = (usdcWethPair.token0.id === USDC_ADDR) ?
                              usdcWethPair.token0Price : usdcWethPair.token1Price

  try {
    const amountUSD: number = parseFloat(tokenAmount) * parseFloat(wethPerToken) * parseFloat(usdcPerWeth)
    // log.debug(`getEstimateUSD (${tokenId}):\n` +
    //           `  ${tokenAmount} * ${wethPerToken} * ${usdcPerWeth} = \n` +
    //           `    ${amountUSD.toFixed(2)}`)
    return amountUSD.toFixed(2)
  } catch (ignoredError) {
    log.warn(`getEstimatedUSD failed, ignoring.\n${ignoredError}`)
  }
  return ''
}

/**
 * To compute the amount of a token for a given amount of USD:
 * 
 *  TokenAmount = usdAmount * Token/Weth * Weth/USDC
 * 
 * This method builds a lookup that lets you get the pair IDs needed to compute this:
 * {
 *    wethId: string,
 *    wethTokenPairId: string,
 *    wethUsdtPairId: string
 * }
 */
export const getEstimatedTokensFromUSD = (allPairData: t.Pairs,
                                          wethPairDict: t.WethPairIdDict,
                                          tokenId: string,
                                          usdAmount: string): string =>
{
  let tokenPerWeth: string = '1'    // Assume input token ID is for WETH

  if (tokenId !== WETH_ADDR) {
    const wethPairId: string = wethPairDict[tokenId] 
    if (!wethPairId) {
      log.warn(`getEstimatedUSD: no WETH pair for ${tokenId}.`)
      return ''
    }
    const wethPair: t.Pair = allPairData.getPair(wethPairId)
    tokenPerWeth = (wethPair.token0.id === WETH_ADDR) ? wethPair.token1Price : wethPair.token0Price 
  } 

  const usdcWethPairId: string = wethPairDict[USDC_ADDR]
  const usdcWethPair: t.Pair = allPairData.getPair(usdcWethPairId)
  const wethPerUsdc: string = (usdcWethPair.token0.id === USDC_ADDR) ?
                              usdcWethPair.token1Price : usdcWethPair.token0Price

  try {
    const tokenAmount: number = parseFloat(usdAmount) * parseFloat(tokenPerWeth) * parseFloat(wethPerUsdc)
    // log.debug(`getEstimateUSD (${tokenId}):\n` +
    //           `  ${usdAmount} * ${tokenPerWeth} * ${usdcPerWeth} = \n` +
    //           `    ${tokenAmount.toFixed(2)}`)
    return tokenAmount.toFixed(2)
  } catch (ignoredError) {
    log.warn(`getEstimatedUSD failed, ignoring.\n${ignoredError}`)
  }

  return ''
}

export const annotateRoutesWithUSD = async (allPairData: t.Pairs,
                                            wethPairDict: t.WethPairIdDict,
                                            routes: t.VFRoutes,
                                            updatePairData: boolean=true): Promise<void> => {
  if (updatePairData) {
    const start: number = Date.now()
    // Get all the <token>:WETH pair IDs, get the WETH/USDC pair ID
    //
    const pairIdsUSD: Set<string> = new Set<string>()
    for (const route of routes) {
      for (const seg of route) {
        if (seg.src !== WETH_ADDR) {
          pairIdsUSD.add(wethPairDict[seg.src])
        }

        if (seg.dst !== WETH_ADDR) {
          pairIdsUSD.add(wethPairDict[seg.dst])
        }
      }
    }
    pairIdsUSD.add(wethPairDict[USDC_ADDR])

    const pairIdsToUpdate = filterToPairIdsOfAge(allPairData, pairIdsUSD)
    const updatedPairs: t.PairLite[] = await getUpdatedPairData(pairIdsToUpdate)
    const updateTimeMs = Date.now()
    allPairData.updatePairs(updatedPairs, updateTimeMs)
    log.debug(`annotateRoutesWithUSD: Finished updating ${pairIdsToUpdate.size} pairs in ${Date.now() - start} ms`)
  }

  for (const route of routes) {
    for (const segment of route) {
      if (segment.srcAmount) {
        segment.srcUSD = getEstimatedUSD(allPairData, wethPairDict, segment.src, segment.srcAmount)
      }
      if (segment.dstAmount) {
        segment.dstUSD = getEstimatedUSD(allPairData, wethPairDict, segment.dst, segment.dstAmount)
      }
    }
  }
}

export const annotateRoutesWithSymbols = (tokenData: t.Tokens, 
                                          routes: t.VFRoutes,
                                          includeIdLast4: boolean = false): void => {
  for (const route of routes) {
    for (const seg of route) {
      seg.srcSymbol = tokenData.getSymbol(seg.src)
      seg.dstSymbol = tokenData.getSymbol(seg.dst)
      if (includeIdLast4) {
        seg.srcSymbol += ` (${seg.src.substr(seg.src.length-1-4, 4)})`
        seg.dstSymbol += ` (${seg.dst.substr(seg.dst.length-1-4, 4)})`
      }
    }
  }
}

export const annotateRoutesWithGainToDest = (routes: t.VFRoutes): void => {
  /**
   * Annotate routes with their gain at each segment to final destination.  The gain of one segment to the
   * the destination is (1 - impact).  The gain through two segments to the destination is (1 - impact_seg1) * (1 - impact_seg2).
   * If you take the amount in to the trade and multiply it by the gain, you know how much you'll receive at
   * the completion of the transaction.  The gain to destination is useful in understanding if a multi-segment path
   * is better than an adjacent path.
   */
  for (const route of routes) {
    let gainToDest: undefined | number = undefined
    for (let segIdx = route.length - 1; segIdx >= 0; segIdx--) {
      const seg: t.VFSegment = route[segIdx]
      const impact = (seg.impact === undefined) ? 0.0 : (parseFloat(seg.impact) / 100.0)
      const gain = 1.0 - impact
      gainToDest = (gainToDest === undefined) ? gain : gainToDest * gain
      seg.gainToDest = gainToDest
    }
  }
}

export const convertRoutesToLegacyFmt = (allPairData: t.Pairs, tokenData: t.Tokens, routes: t.VFRoutes): any => {
  const legacyRoutesFmt: any = []
  for (const route of routes) {
    let remainingImpactPercent = 1
    const numSwaps = route.length
    let routeStr = ''
    let routeIdStr = ''
    let srcData: any = {}
    let dstData: any = {}
    let amountIn: string | undefined = ''
    let amountOut: string | undefined = ''
    const orderedSwaps = []

    for (let segIdx = 0; segIdx < route.length; segIdx++) {
      const segment = route[segIdx]

      const pairData = allPairData.getPair(segment.pairId)
      const { token0, token1 } = pairData

      const swap: any = {
        src: segment.src,
        dst: segment.dst,
        id: segment.pairId,
        impact: segment.impact,
        amountIn: segment.srcAmount,
        amountOut: segment.dstAmount,
        amountInUSD: segment.srcUSD,
        amountOutUSD: segment.dstUSD,
        token0,
        token1
      }

      orderedSwaps.push(swap)

      if (segment.impact !== undefined) {
        remainingImpactPercent = remainingImpactPercent * (1 - parseFloat(segment.impact)/100)
      }

      if (segIdx === 0) {
        routeStr += `${tokenData.getSymbol(segment.src)} > ${tokenData.getSymbol(segment.dst)}`
        routeIdStr += `${segment.src} > ${segment.dst}`
      } else {
        routeStr += ` > ${tokenData.getSymbol(segment.dst)}`
        routeIdStr += ` > ${segment.dst}`
      }

      if (segIdx === 0) {
        srcData = tokenData.getToken(segment.src)
        amountIn = segment.srcAmount
      }
      if (segIdx === route.length - 1) {
        dstData = tokenData.getToken(segment.dst)
        amountOut = segment.dstAmount
      }
    }
    
    const legacyRoute: any = {
      totalImpact: (1 - remainingImpactPercent) * 100,
      numSwaps,
      routeStr,
      routeIdStr,
      srcData,
      dstData,
      amountIn,
      amountOut,
      orderedSwaps
    }

    legacyRoutesFmt.push(legacyRoute)
  }

  return legacyRoutesFmt
}

/**
 *  TODO TODO TODO:
 * 
 *    1. This method should take advantage of complete routes
 *       to ensure that precision is not lost beyond 18 decimals
 *       instead of being called for a single route segment at a time.
 *        - the toExact method means we might be able to construct a
 *          trade (if another method exists) where we specify the last
 *          input.
 * 
 *    2. If 1 is not yet completed, a more resolute way of passing in
 *       an input value is desireable.
 */
const computeTradeEstimates = (pairData: t.Pair, 
                               tokenData: t.Tokens,
                               srcAddrLC:string,
                               amount: string): any => 
{
  // 1. Get token0 & token1 decimals
  //
  const token0 = tokenData.getToken(pairData.token0.id)
  const token1 = tokenData.getToken(pairData.token1.id)
  if (!token0) {
    throw new Error(`Unable to find token data for token id ${pairData.token0.id}.`)
  }
  if (!token1) {
    throw new Error(`Unable to find token data for token id ${pairData.token1.id}.`)
  }
  const token0Decimals = parseInt(token0.decimals)
  const token1Decimals = parseInt(token1.decimals)

  // 2. Construct token objects (except WETH special case)
  //
  const token0UniObj = (token0.symbol === 'WETH') ?
    WETH[ChainId.MAINNET] :
    new Token(ChainId.MAINNET,
              getAddress(token0.id),   // Use Ethers to get checksummed address
              token0Decimals,
              token0.symbol,
              token0.name)

  const token1UniObj = (token1.symbol === 'WETH') ?
    WETH[ChainId.MAINNET] :
    new Token(ChainId.MAINNET,
              getAddress(token1.id),   // Use Ethers to get checksummed address
              token1Decimals,
              token1.symbol,
              token1.name)

  // 4. Construct pair object after moving amounts correct number of
  //    decimal places (lookup from tokens in graph)
  //
  const reserve0IntStr = getIntegerString(pairData.reserve0, token0Decimals)
  const reserve1IntStr = getIntegerString(pairData.reserve1, token1Decimals)
  const _pair = new Pair( new TokenAmount(token0UniObj, reserve0IntStr),
                          new TokenAmount(token1UniObj, reserve1IntStr) )

  // 5. Construct the route & trade objects to determine the price impact.
  //
  const _srcToken = (srcAddrLC === token0.id) ?
      { obj: token0UniObj, decimals: token0Decimals } :
      { obj: token1UniObj, decimals: token1Decimals }

  const _route = new Route([_pair], _srcToken.obj)
  const _tradeAmount = new TokenAmount(_srcToken.obj, getIntegerString(amount, _srcToken.decimals))
  const _trade = new Trade(_route, _tradeAmount, TradeType.EXACT_INPUT)
  
  return {
    route: _route,
    trade: _trade
  }
}

const avgBlockMs = 15000
export const getAllPairsIdsOfAge = (allPairData: t.Pairs,
                                    routes: t.VFRoutes,
                                    ageMs: number = 1 * avgBlockMs): Set<string> =>
{
  const now = Date.now()

  const pairIds = new Set<string>()
  for (const route of routes) {
    for (const segment of route) {

      // Don't add the segment if it's been updated within ageMs
      const pairData = allPairData.getPair(segment.pairId)
      if (pairData &&
          pairData.updatedMs &&
          ((now - pairData.updatedMs) < ageMs)) {
          continue
      }

      pairIds.add(segment.pairId)
    }
  }

  // log.debug(`getAllPairsIdsOfAge: returning ${pairIds.size} older than ${ageMs} ms.`)

  return pairIds
}

// TODO: merge / unify w/ above
export const filterToPairIdsOfAge = (allPairData: t.Pairs,
                                     pairIds: Set<string>,
                                     ageMs: number = 1 * avgBlockMs): Set<string> =>
{
  const now = Date.now()
  const pairIdsOfAge = new Set<string>()
  for (const pairId of pairIds) {
    const pairData = allPairData.getPair(pairId)
    if (pairData &&
        pairData.updatedMs &&
        ((now - pairData.updatedMs) < ageMs)) {
      continue
    }

    pairIdsOfAge.add(pairId)
  }

  return pairIdsOfAge
}