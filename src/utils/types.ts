// import { TokenAmount } from '@uniswap/sdk'

import log from "loglevel"

/*
 * Types related to the Uniswap V2 Sub-graph Pairs modelled with access in O(log(n))
 * time.
 */
export interface PairToken {
  id: string
  name: string
  symbol: string
}

export interface PairLite {
  id: string
  reserve0: string
  reserve1: string
  reserveUSD: string
  token0Price: string
  token1Price: string
  updatedMs?: number
  updatedBlock?: number
}

export interface Pair {
  id: string
  reserve0: string
  reserve1: string
  reserveUSD: string
  token0: PairToken
  token0Price: string
  token1: PairToken
  token1Price: string
  updatedMs?: number
  updatedBlock?: number
}

export interface PairDict { [index: string]: Pair }

export class Pairs {
  constructor() {
    this._pairs = {}
    this._lowestBlockNumber = -1
    this._updatedSinceLBN = false   // Updated since lowest block number (tells
                                    // us if this data is not uniform wrt block number).
                                    // Not ideal since objects are not immutable
                                    // for get pairs, but good enough for now.
  }

  public addPair(pair: Pair): void {
    this._updatedSinceLBN = true
    const _pair: Pair = {
      id: pair.id.toLowerCase(),
      reserve0: pair.reserve0,
      reserve1: pair.reserve1,
      reserveUSD: pair.reserveUSD,
      token0: {
        id: pair.token0.id.toLowerCase(),
        name: pair.token0.name,
        symbol: pair.token0.symbol
      },
      token0Price: pair.token0Price,
      token1: {
        id: pair.token1.id.toLowerCase(),
        name: pair.token1.name,
        symbol: pair.token1.symbol
      },
      token1Price: pair.token1Price
    }
    this._pairs[_pair.id] = _pair
  }

  public getPair(id: string): Pair {
    return this._pairs[id]
  }

  // TODO: remove this and move to cache w/ TTL
  public updatePairs(updatedPairs: PairLite[], 
                     updateTimeMs: number,
                     updateBlockNum?: number): void {
    this._updatedSinceLBN = true
    for (const updatedPair of updatedPairs) {
      const pair = this._pairs[updatedPair.id]
      if (pair) {
        pair.reserve0 = updatedPair.reserve0
        pair.reserve1 = updatedPair.reserve1
        pair.reserveUSD = updatedPair.reserveUSD
        pair.token0Price = updatedPair.token0Price
        pair.token1Price = updatedPair.token1Price
        pair.updatedMs = updateTimeMs
        if (updateBlockNum) {
          pair.updatedBlock = updateBlockNum
        }
      } else {
        log.error(`updatePairs: ${updatedPair.id} pair not found!`)
      }
    }
  }

  public getPairIds(): string[] {
    return Object.keys(this._pairs)
  }

  public setLowestBlockNumber(lbn: number): void {
    this._lowestBlockNumber = lbn
  }

  public getLowestBlockNumber(): number {
    return this._lowestBlockNumber
  }

  public clearUpdatedSinceLowestBlockNumber(): void {
    this._updatedSinceLBN = false
  }

  /**
   *  Serialization / Deserialization methods 
   */
  public deserialize(serializedObj: any): void {
    this._pairs = serializedObj.pairs
    this._lowestBlockNumber = serializedObj.lowestBlockNumber
    this._updatedSinceLBN = false
  }

  public serialize(): any {
    return { 
      pairs: this._pairs,
      lowestBlockNumber: this._lowestBlockNumber
    }
  }
  
  /**
   * Members ...
   */
  private _pairs: PairDict
  private _lowestBlockNumber: number
  private _updatedSinceLBN: boolean
}

/*
 * Types related to the Uniswap V2 Sub-graph Tokens modelled with access in O(log(n))
 * time.
 */
export interface Token {
  decimals: string
  id: string
  name: string
  symbol: string
}

export interface TokenDict { [index: string]: Token }

export class Tokens {
  constructor() {
    this._tokens = {}
  }

  public addToken(token: Token): void {
    const _token: Token = {
      decimals: token.decimals,
      id: token.id.toLowerCase(),
      name: token.name,
      symbol: token.symbol
    }
    this._tokens[_token.id] = _token
  }

  public getToken(id: string): Token {
    return this._tokens[id]
  }

  public getSymbol(id: string): string {
    return (this._tokens[id]) ? this._tokens[id].symbol : ''
  }

  /**
   *  Serialization / Deserialization methods 
   */
  public deserialize(tokenDict: TokenDict): void {
    this._tokens = tokenDict
  }

  public serialize(): TokenDict {
    return this._tokens
  }
  
  /**
   * Members ...
   */
  private _tokens: TokenDict
}

/*
 * Types related to routes found in the graph library of this code (not to be confused with
 * Uniswap's SDK Route & Trade classes)
 * 
 * VF -> Valve Finance
 * 
 * StackedRoutes (formerly RolledRoutes):
 */
export interface VFStackedSegment {
  src: string
  dst: string
  pairIds: string[]
}
export type VFStackedRoute = VFStackedSegment[]
export type VFStackedRoutes = VFStackedRoute[]

/*
 *  UnstackedRoute (i.e. regular route with 1 pair per segment)
 */
export interface VFSegment {
  src: string
  dst: string
  pairId: string
  impact?: string
  srcAmount?: string
  dstAmount?: string
  srcUSD?: string
  dstUSD?: string
  srcSymbol?: string
  dstSymbol?: string
  gainToDest?: number
  yieldToDest?: number
  isUni?: boolean
  isBest?: boolean
}
export type VFRoute = VFSegment[]
export type VFRoutes = VFRoute[]

/*
 *  Other Misc. types
 */
// TODO: turn into a class with methods that LC Ids added etc.
export interface Constraints {
  maxDistance?: number
  ignoreTokenIds?: Array<string>
  ignorePairIds?: Array<string>
}

export interface WethPairIdDict {
  [index: string]: string
}

 // Generic model for the pair graph for now.
 //   TODO: long term if this graph lib continues to be used, flush this out in detail.
 //
export interface PairGraph {
  [index: string]: any
}

export interface UniData {
  pairGraph: any
  tokenData: Tokens
  pairData: Pairs
  wethPairData?: WethPairIdDict
}