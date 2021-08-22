import { TradeTreeNode } from './routeTree'

import cytoscape from 'cytoscape'
import crawl from 'tree-crawl'
import { v4 as uuidv4 } from 'uuid'



// See: https://www.w3schools.com/cssref/css_colors.asp
export const PATH_COLORS: { [index: string]: string } = {
  DEFAULT_NODE: 'LightGray',          // #D3D3D3
  UNI_NODE: 'CornFlowerBlue',         // #1E90FF
  MULTIP_LEAF_NODE: 'DarkSeaGreen',   // #8FBC8F
  DEFAULT_EDGE: 'Gainsboro',          // #DCDCDC
  UNI_EDGE: 'LightBlue'               // $ADD8E6
}

// See: https://js.cytoscape.org/#style/node-body
export const NODE_SHAPES: { [index: string]: string } = {
  DEFAULT: 'ellipse',
  VALVE_SP: 'star'
}

/**
 * getCytoscapeGraph: Constructs a Cytoscape representation of a TradeTree (n-ary Tree
 *                    representing possible pathways from a source token to a
 *                    destination token).
 * 
 * @param tradeTree 
 * @param useUuid 
 * @returns 
 */
export const getCytoscapeGraph = (tradeTree: TradeTreeNode, 
                                  useUuid=true): cytoscape.Core =>
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
            let nodeColor = node.value.isUniRoute ?
                            PATH_COLORS.UNI_NODE : PATH_COLORS.DEFAULT_NODE
            let nodeShape = node.value.isBest ?
                            NODE_SHAPES.VALVE_SP : NODE_SHAPES.DEFAULT
            if (isMultiPath) {
              let trade: any = undefined
              // Get first trade
              for (const tradeKey in node.value.trades) {
                trade = node.value.trades[tradeKey]
                break;
              }
              amount = trade.outputAmount
              amountUSD = trade.outputUsd
              nodeColor = (node.children.length > 0) ?
                          PATH_COLORS.DEFAULT_NODE : PATH_COLORS.MULTIP_LEAF_NODE
            }

            const nodeData = {
              id: `n_${cyNodeId}`,
              address: node.value.address,
              amount,
              amountUSD,
              symbol: node.value.symbol,
              label: '',
              color: nodeColor,
              shape: nodeShape
            }
            cy.add({ group: 'nodes', data: nodeData})

            // Special case - root node has no parents and thus no incoming edges. Only
            // add an incoming edge if the parent is not null (i.e. for non root node):
            //
            if (context.parent) {
              const parent = context.parent
              const impact = parseFloat(node.value.impact ? node.value.impact : '0').toFixed(3)
              // const label = `$${node.value.amountUSD},  ${impact}%`
              const label = `${impact}%`
              const color = (parent.value.isUniRoute &&
                             node.value.isUniRoute &&
                             !isMultiPath) ?
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

export const elementDataFromCytoscape = (cyGraph: cytoscape.Core): any =>
{
  const elements = cyGraph.elements().jsons()
  const eleDatas = elements.map((ele: any) => { return { data: ele.data } })

  return eleDatas
}