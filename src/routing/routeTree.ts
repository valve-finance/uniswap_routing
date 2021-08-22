import * as ds from '../utils/debugScopes'
import * as t from './../utils/types'
import { deepCopy } from '../utils/misc'
import { computeTradeEstimates, getEstimatedUSD } from './quoting'

import crawl from 'tree-crawl'
import { v4 as uuidv4 } from 'uuid'
import { routesToString } from './routeGraph'

const log = ds.getLog('routeTree')

interface TradeObj {
  proportion: number,
  inputAmount: string,
  outputAmount: string,
  impact?: string,
  inputAmountP?: string
  inputUsd?: string,
  outputUsd?: string
}

// Represents all routes from source token to dest token as a tree.
// Also allows hypothetical quotes for different amounts through all paths in the 'trades'
// annotation object.
//
export interface TradeTreeNode {
  value: {
    id: string,             // A unique identifier for rendering etc. (cytoscape / edges etc).
    address: string,        // The token address (not unique within a Trade Tree).
    isUniRoute?: boolean,   // Identifies if this token is on the official uniswap v2 route.
    isBest?: boolean,       // Identifies if this token is on the best single path route
    symbol?: string,        // The token symbol.
    amount?: string,        // The amount of the token at this particular level in the trade for 100%
                            // of funds going through this particular route.
    amountUSD?: string      // The corresponding amount in USD.
    pairId?: string,        // The pairID that gets from the parent node's token to this node.
    impact?: string,        // The impact / slippage if 100% of funds go through this route.
    // Nested Objects:
    // ---------------
    // gainToDest?: {
    //   <routeId>: <gainToDest>,
    //   ...
    // }
    gainToDest?: {                // The gain to destination, (1-slippageN)*(1-slippageM) ..., for
      [index: string]: number     // a particular route laid atop this tree structure (the route is
    }                             // denoted by the index).
    //
    // trades?: {
    //   <tradeId>: <tradeObj> 
    // }
    trades?: {                    // The trade object for a particular proportion of the trade amount
      [index: string]: TradeObj   // at this point in a multi-path trade.
    } 
  },
  parent?: TradeTreeNode,         // The parent node and source token to this token across the pair
  children: TradeTreeNode[]       // The destination token nodes to this node as the source token
}

interface TradeProportion {
  proportion?: number,
  maxGainToDest: number,
  node: TradeTreeNode
}

type TradeProportions = TradeProportion[]



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
            isUniRoute: seg.isUni,
            isBest: seg.isBest
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
          //
          if (seg.isUni) {
            node.value.isUniRoute = true
          }
          if (seg.isBest) {
            node.value.isBest = true
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
            isUniRoute: seg.isUni,
            isBest: seg.isBest
          },
          parent: node,
          children: []
        }
        _eleIdCounter++
        node.children.push(dstNode)
      } else {
        // Special case - we've already added this node, but need to ensure it's tagged as
        // the uniswap route.
        //
        if (seg.isUni) {
          dstNode.value.isUniRoute = true
        }
        if (seg.isBest) {
          dstNode.value.isBest = true
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
      isUniRoute: node.value.isUniRoute,
      isBest: node.value.isBest
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

export const cloneTradeTree = (root: TradeTreeNode, 
                               exact: boolean = false): TradeTreeNode =>
{
  const rootClone: TradeTreeNode = _cloneTradeTreeNode(root, exact)
  _cloneTradeTree(root, rootClone, exact)
  return rootClone 
}

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

    // TODO TODO TODO: unityGainIndex code doesn't work--will fail with 
    // insufficientInputAmountError: (need to prune tree)

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
      if (!node.value.trades) {
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
            childNode.parent.value.trades &&
            childNode.parent.value.trades.hasOwnProperty(tradeId)) {
          // TODO:
          //  - need a better solution to this for numerical precision (i.e. arbitrary
          //    integer fraction model)
          inputAmount = proportion * parseFloat(childNode.parent.value.trades[tradeId].outputAmount)
        } else {
          throw Error(`costTradeTree: expected parent tree node to have trades with tradeId ${tradeId}\n` +
                      `parent:\n${JSON.stringify(childNode.parent ? childNode.parent.value : undefined, null, 2)}`)
        }

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
        
        //    - annotate the children node trades object with
        //      the tradeId, inputAmount 
        if (!childNode.value.trades) {
          childNode.value.trades = {}
        }
        const { trades } = childNode.value
        trades[tradeId] = {
          proportion,
          inputAmount: inputAmount.toString(),
          outputAmount: estimate.trade.outputAmount.toExact(),
          impact: estimate.trade.priceImpact.toSignificant(18),
          inputAmountP: estimate.trade.inputAmount.toExact()
        }
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
              childNode.parent.value.trades &&
              childNode.parent.value.trades[tradeId]) {
            // TODO:
            //  - need a better solution to this for numerical precision (i.e. arbitrary
            //    integer fraction model)
            inputAmount = proportion * parseFloat(childNode.parent.value.trades[tradeId].outputAmount)
          } else {
            throw Error(`costTradeTree: expected parent tree node to have trades with tradeId ${tradeId}\n` +
                        `parent:\n${JSON.stringify(childNode.parent ? childNode.parent.value : undefined, null, 2)}`)
          }

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

          //    - annotate the children node trades object with
          //      the tradeId, inputAmount 
          if (!childNode.value.trades) {
            childNode.value.trades = {}
          }
          const { trades } = childNode.value
          trades[tradeId] = {
            proportion,
            inputAmount: inputAmount.toString(),
            outputAmount: estimate.trade.outputAmount.toExact(),
            impact: estimate.trade.priceImpact.toSignificant(18),
            inputAmountP: estimate.trade.inputAmount.toExact()
          }
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
                // Try to represent the exact trade object's input if possible
                const input = (trade.inputAmountP) ? trade.inputAmountP : trade.inputAmount
                trade.inputUsd = getEstimatedUSD(allPairData,
                                                 wethPairDict,
                                                 node.parent.value.address,
                                                 input)
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

export const getNumRoutes = (rootNode: TradeTreeNode): number => 
{
  const routeIds = new Set<string>()

  // The number or routes is stored in the node's gainToDest object. 
  // The root node doesn't have the gainToDest object defined--have to 
  // count routeIds in ALL direct children.
  //
  const totalRouteGTDs: any = {}
  rootNode.children.forEach((child: TradeTreeNode) => {
    if (child.value.gainToDest) {
      for (const routeId in child.value.gainToDest) {
        routeIds.add(routeId)
      }
    }
  })

  return routeIds.size
}

/**
 *  pruneRoutesWithDuplicatePairs:
 *      Walks the tree finding nodes containing a re-used pair (by pairID) to
 *      identify routes to be removed to facilitate estimation accuracy and / or
 *      reduce slippage in a multi-path trade.
 * 
 *      Different use cases include:
 *        UC1:  duplicated pair at tree nodes at different level in the tree
 *        UC2:  duplicated pair at tree nodes at same level in the tree
 * 
 *      Considerations include duplicated pair slippage (lower improves estimation
 *      accuracy and may not require removal of a route).  The routes to remove
 *      should be prioritized by gain to destination.
 * 
 * @param rootNode 
 */
export const pruneRoutesWithDuplicatePairs = (rootNode: TradeTreeNode) =>
{
  const MAX_ALLOWED_SLIPPAGE = 1.0  // Increasing this hurts estimate accuracy.

  // totalRouteGTDs:
  // ----------------------------------------
  //  Maps route# (routeId) to total gain to destination. Aids in deciding which
  //  routes to cut duplicate pairs from.  (The root node doesn't have the gainToDest
  //  object defined--have to get it directly from it's children.)
  //
  const totalRouteGTDs: any = {}
  rootNode.children.forEach((child: TradeTreeNode) => {
    if (child.value.gainToDest) {
      for (const routeId in child.value.gainToDest) {
        totalRouteGTDs[routeId] = child.value.gainToDest[routeId]
      }
    }
  })

  // pairNodeInfoMap:
  // ----------------------------------------
  //  Maps pairId to an array of routeIds that use it at the same node. For example
  //  if routes 1, 2 & 5 use pairIdX at a node and route 4 uses pairIdX at a different
  //  node (at a lower tree level or the same one but on a different branch), then
  //  pairs would look like this:
  //
  //  pairNodeInfoMap: {
  //    pairIdX: [ 
  //      { maxGTD: <number>, maxSlippage: <number>, routeIds: ['1', '2', '5'] }, level: <number>,
  //      { maxGTD: <number>, maxSlippage: <number>, routeIds: ['4'], level: <number> }
  //  }
  //
  //  The prune algorithm would then use the total gain to destination of route 4 vs.
  //  the max gain to destination of routes 1, 2 & 5 to determine which route(s) to prune.
  //  If route 4 has higher GTD then routes 1, 2 & 5 are pruned.
  //
  //    NOTE(TODO): this may not be the right choice--i.e. if the GTDs are close, you might
  //                reduce slippage more by keeping 1, 2 & 5 instead of route 4 and taking
  //                advantage of splitting the amounts downstream to reduce a high slippage
  //                there.  < TODO TODO TODO >
  //
  const pairNodeInfoMap: any = {}

  crawl(rootNode,
        (node, context) => {
          const { pairId, impact, gainToDest } = node.value
          if (pairId && gainToDest) {
            if (!pairNodeInfoMap[pairId]) {
              pairNodeInfoMap[pairId] = []
            }

            const routeIdsAtThisNode = Object.keys(gainToDest)
            let maxGTD = 0
            for (const routeId of routeIdsAtThisNode) {
              if (totalRouteGTDs[routeId] > maxGTD) {
                maxGTD = totalRouteGTDs[routeId]
              }
            }
            pairNodeInfoMap[pairId].push({ maxGTD,
                                        maxSlippage: impact, 
                                        routeIds: routeIdsAtThisNode,
                                        level: context.level})
          }
        },
        { order: 'bfs' })
  
  // TODO TODO TODO: Area for potential route optimization. This is a first guess
  //                 to optimize and improve estimation.  This wouldn't be needed
  //                 if our model handled pair slippage multiple times in a trade
  //                 quote.
  //
  // 1. Sort the pairNodeInfoMap entries by maxGTD ascending:
  //
  // 2. Populate a list of routes that must be pruned by keeping the highest GTD ones:
  //    (TODO: a lot of optimization is possible here--there may be directions we
  //           take in this simple algorithm that are sub-optimal. For instance
  //           when maxGTD for competing nodes are very close and/or we make a 
  //           decision to prune too many routes.)
  //
  const pruneRoutes = new Set<string>()
  for (const pairId in pairNodeInfoMap) {
    const pairNodeInfo = pairNodeInfoMap[pairId]
    if (pairNodeInfo.length <= 1) {
      continue
    }

    pairNodeInfo.sort((pairInfoA: any, pairInfoB: any) => {
      return pairInfoA.maxGTD - pairInfoB.maxGTD    // Ascending order
    })

    // Keep the last pairInfo out of this (it's the max GTD and shouldn't be pruned.)
    for (let pairInfoIdx = 0; pairInfoIdx < pairNodeInfo.length-1; pairInfoIdx++) {
      const pairInfo = pairNodeInfo[pairInfoIdx]
      const { maxSlippage, routeIds } = pairInfo

      if (maxSlippage > MAX_ALLOWED_SLIPPAGE) {
        for (const routeId of routeIds) {
          pruneRoutes.add(routeId)
        }
      }
    }
  }

  // log.debug(`pairNodeInfoMap\n` +
  //           '--------------------------------------------------------------------------------\n' +
  //           JSON.stringify(pairNodeInfoMap, null, 2) + '\n\n' +
  //           `pruneRoutes\n` +
  //           '--------------------------------------------------------------------------------\n' +
  //           JSON.stringify([...pruneRoutes], null, 2))

  for (const routeId of pruneRoutes) {
    pruneTreeRoute(rootNode, routeId)
  }
  return rootNode
}

export const pruneRoutesIfHighTopLevelMGTD = (rootNode: TradeTreeNode) => {
  const HIGH_MGTD = 0.99

  // totalRouteGTDs:
  // ----------------------------------------
  //  Maps route# (routeId) to total gain to destination. Aids in deciding which
  //  routes to cut duplicate pairs from.  (The root node doesn't have the gainToDest
  //  object defined--have to get it directly from it's children.)
  //
  const totalRouteGTDs: any = {}
  rootNode.children.forEach((child: TradeTreeNode) => {
    if (child.value.gainToDest) {
      for (const routeId in child.value.gainToDest) {
        totalRouteGTDs[routeId] = child.value.gainToDest[routeId]
      }
    }
  })

  const routeIds = Object.keys(totalRouteGTDs)
  let maxGTD = 0
  let maxRouteId = ''
  for (const routeId of routeIds) {
    if (totalRouteGTDs[routeId] > maxGTD) {
      maxGTD = totalRouteGTDs[routeId]
      maxRouteId = routeId
    }
  }

  if (maxGTD > HIGH_MGTD) {
    // Prune all routes but the maxRouteId
    const pruneRoutes = routeIds.filter(value => value !== maxRouteId)
    // log.debug(`Pruning: ${JSON.stringify(pruneRoutes, null , 2)}`)
    for (const routeId of pruneRoutes) {
      pruneTreeRoute(rootNode, routeId)
    }
  }
}

/**
 * pruneRoutesIfHighMGTD: Starting at the top of the tree, we identify high MGTD routes
 *                        and then add the other routes in that same node to a prune list,
 *                        pruning them at the end.
 *                        This works w/o considering above nodes etc. b/c if there are 
 *                        multiple trades in a node then up until that point, the other trades
 *                        in the node beyond the MGTD one have the same route/segments and thus
 *                        cannot outperform the high MGTD one and should be pruned.
 * 
 * @param rootNode 
 */
export const pruneRoutesIfHighMGTD = (rootNode: TradeTreeNode) => {
  const HIGH_MGTD = 0.98

  const pruningSet = new Set<string>()
  crawl(rootNode,
        (node, context) => {
          const possibleRouteIds: string[] = []

          // Figure out the maximum gtd amongst the routes through this node:
          //
          let maxRouteId: string = ''
          let maxRouteGTD = 0
          for (const child of node.children) {
            const { gainToDest } = child.value
            if (gainToDest) {
              for (const routeId in gainToDest) {
                possibleRouteIds.push(routeId)
                const routeGTD = gainToDest[routeId]
                if (routeGTD > maxRouteGTD) {
                  maxRouteGTD = routeGTD
                  maxRouteId = routeId
                }
              }
            }
          }

          // If the maximum gtd exceeds HIGH_MGTD, then prune the other routes at this node.
          //
          if (maxRouteGTD > HIGH_MGTD) {
            log.debug(`Route ${maxRouteId} at level ${context.level} exceeds high MGTD (gtd=${maxRouteGTD}).`)
            possibleRouteIds.forEach(routeId => { 
              if (routeId !== maxRouteId ) {
                pruningSet.add(routeId) 
              }
            })
          }
        },
        { order: 'bfs' })
  
  log.debug(`Pruning ${pruningSet.size} routes due to high MGTD.\n`)
  for (const routeId of pruningSet) {
    pruneTreeRoute(rootNode, routeId)
  }
}