import * as rv from "./routeVisualization"
import { TradeTreeNode } from "./routeTree"
import cytoscape from "cytoscape"

export interface TradeYieldData {
  usd: number,
  token: number
}

export class RouteStats {
  constructor() {
    this.routesFound = 0
    this.routesMeetingCriteria = 0
    this.uniRouteFound = false
    this.uniError = ''
    this.vfiError = ''
    this.mpRoutesMeetingCriteria = 0
    this.mpRoutesAfterRmDupLowerOrderPair = 0
  }

  // public - b/c getter/setter laziness
  public routesFound: number
  public routesMeetingCriteria: number
  public uniRouteFound: boolean
  public uniError: string
  public vfiError: string
  public mpRoutesMeetingCriteria: number
  public mpRoutesAfterRmDupLowerOrderPair: number
}

// A lighter weight version of RouteData to construct reports
// and reduce memory load on larger jobs.
export class TradeStats {
  constructor(routeData: RouteData) {
    this.src = routeData.getSourceAddr()
    this.dst = routeData.getDestAddr()
    this.srcSymbol = routeData.getSourceSymbol()
    this.dstSymbol = routeData.getDestSymbol()
    this.inputAmount = routeData.getInputAmount()
    this.uniYield = routeData.getUniYield()
    this.spYield = routeData.getSinglePathValveYield()
    this.mpYield = routeData.getMultiPathValveYield()
    this.routeStats = routeData.getRouteStats()

    const { uniYield, spYield, mpYield } = this
    if (uniYield && spYield) {
      this.spDelta = (uniYield.token > 0) ?  100 * (spYield.token - uniYield.token) / uniYield.token : NaN 
    }
    if (uniYield && mpYield) {
      this.mpDelta = (uniYield.token > 0) ?  100 * (mpYield.token - uniYield.token) / uniYield.token : NaN 
    }
  }

  // public - b/c getter/setter laziness
  public src: string
  public dst: string
  public srcSymbol: string
  public dstSymbol: string
  public inputAmount: number
  public uniYield?: TradeYieldData
  public spYield?: TradeYieldData
  public mpYield?: TradeYieldData
  public routeStats: RouteStats
  public spDelta?: number
  public mpDelta?: number
}

export class RouteData {
  constructor(sourceAddr: string = '',
              sourceSymbol: string = '',
              destAddr: string = '',
              destSymbol: string = '',
              routeOptions?: any,
              singlePathElements?: any,
              inputAmount?: number,
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
    this.inputAmount = inputAmount
    this.uniYield = uniYield
    this.singlePathValveYield = singlePathValveYield
    this.multiPathElements = multiPathElements
    this.multiPathValveYield = multiPathValveYield
    this.routeStats = new RouteStats()
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
  
  public getSourceAddr(): string {
    return this.sourceAddr
  }

  public getDestAddr(): string {
    return this.destAddr
  }

  public setInputAmount(amount: number): void {
    this.inputAmount = amount
  }

  public getInputAmount(): number {
    return (this.inputAmount === undefined) ? NaN : this.inputAmount
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

  public getDifferenceSinglePath(inUsd: boolean = false): number {
    const { uniYield, singlePathValveYield } = this

    if (inUsd && uniYield && singlePathValveYield && uniYield.token > 0) {
      return singlePathValveYield.usd - uniYield.usd
    } else if (uniYield && singlePathValveYield && uniYield.token > 0) {
      return singlePathValveYield.token - uniYield.token
    }

    return NaN
  }
  
  public getDifferenceMultiPath(inUsd: boolean = false): number {
    const { uniYield, multiPathValveYield } = this

    if (inUsd && uniYield && multiPathValveYield && uniYield.token > 0) {
      return multiPathValveYield.usd - uniYield.usd
    } else if (uniYield && multiPathValveYield && uniYield.token > 0) {
      return multiPathValveYield.token - uniYield.token
    }

    return NaN
  }

  public getPercentDifferenceSinglePath(): number {
    const { uniYield, singlePathValveYield } = this

    if (uniYield && singlePathValveYield && uniYield.token > 0) {
      return 100 * (singlePathValveYield.token - uniYield.token) / (uniYield.token)
    }

    return NaN
  }
  
  public getPercentDifferenceMultiPath(): number {
    const { uniYield, multiPathValveYield } = this

    if (uniYield && multiPathValveYield && uniYield.token > 0) {
      return 100 * (multiPathValveYield.token - uniYield.token) / (uniYield.token)
    }

    return NaN
  }

  public setRouteStats(routeStats: RouteStats): void {
    this.routeStats = routeStats
  }
  
  public getRouteStats(): RouteStats {
    return this.routeStats
  }

  private sourceAddr: string
  private sourceSymbol: string
  private destAddr: string
  private destSymbol: string
  private routeOptions?: any
  private singlePathElements?: any
  private inputAmount?: number
  private uniYield?: TradeYieldData
  private singlePathValveYield?: TradeYieldData
  private multiPathElements?: any
  private multiPathValveYield?: TradeYieldData
  private routeStats: RouteStats
}