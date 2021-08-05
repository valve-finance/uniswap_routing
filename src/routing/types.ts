import * as rv from "./routeVisualization"
import { TradeTreeNode } from "./routeTree"
import cytoscape from "cytoscape"

export interface TradeYieldData {
  usd: number,
  token: number
}

export class RouteData {
  constructor(sourceAddr: string = '',
              sourceSymbol: string = '',
              destAddr: string = '',
              destSymbol: string = '',
              routeOptions?: any,
              singlePathElements?: any,
              uniYield?: TradeYieldData,
              singlePathValveYield?: TradeYieldData,
              multiPathElements?: any,
              multiPathValveYield?: TradeYieldData) 
  {
    this.sourceAddr = sourceAddr
    this.sourceSymbol = sourceSymbol
    this.destAddr = destAddr
    this.destSymbol = destSymbol
    this.routeOptions = routeOptions
    this.singlePathElements = singlePathElements
    this.uniYield = uniYield
    this.singlePathValveYield = singlePathValveYield
    this.multiPathElements = multiPathElements
    this.multiPathValveYield = multiPathValveYield
  }

  public initFromSerialization(serialization: string): void {
    const objState = JSON.parse(serialization)
    let thisAsAny: any = this
    for (const key of Object.keys(objState)) {
      thisAsAny[key] = objState[key]
    }
  }

  public serialize(): string {
    return JSON.stringify(this)
  }

  public getSourceSymbol(): string {
    return this.sourceSymbol
  }

  public getDestSymbol(): string {
    return this.destSymbol
  }

  public setUniYield(tradeYield: TradeYieldData): void {
    this.uniYield = tradeYield
  }
  
  public getUniYield(): TradeYieldData | undefined {
    return this.uniYield
  }

  public setSinglePathValveYield(tradeYield: TradeYieldData): void {
    this.singlePathValveYield = tradeYield
  }
  
  public getSinglePathValveYield(): TradeYieldData | undefined {
    return this.singlePathValveYield
  }
  
  public setMultiPathValveYield(tradeYield: TradeYieldData): void {
    this.multiPathValveYield = tradeYield
  }

  public getMultiPathValveYield(): TradeYieldData | undefined {
    return this.multiPathValveYield
  }

  public setSinglePathElementsFromTree(spTradeTree: TradeTreeNode): void {
    const cyGraph: cytoscape.Core = rv.getCytoscapeGraph(spTradeTree)
    this.singlePathElements = rv.elementDataFromCytoscape(cyGraph)
  }

  public getSinglePathElements(): any {
    return this.singlePathElements
  }

  public setMultiPathElementsFromTree(mpTradeTree: TradeTreeNode): void {
    const cyGraph: cytoscape.Core = rv.getCytoscapeGraph(mpTradeTree)
    this.multiPathElements = rv.elementDataFromCytoscape(cyGraph)
  }

  public getMultiPathElements(): any {
    return this.multiPathElements
  }

  private sourceAddr: string
  private sourceSymbol: string
  private destAddr: string
  private destSymbol: string
  private routeOptions?: any
  private singlePathElements?: any
  private uniYield?: TradeYieldData
  private singlePathValveYield?: TradeYieldData
  private multiPathElements?: any
  private multiPathValveYield?: TradeYieldData
}