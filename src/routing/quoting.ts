import * as ds from '../utils/debugScopes'
import * as t from '../utils/types'
import { WETH_ADDR, USDC_ADDR, NO_BLOCK_NUM } from '../utils/constants'
import { getAddress } from '@ethersproject/address'
import { getIntegerString } from '../utils/misc'
import { getUpdatedPairData } from '../graphProtocol/uniswapV2'

import { ChainId,
         Token,
         WETH,
         TokenAmount,
         Route,
         Trade,
         TradeType, 
         Pair,
         Fraction} from '@uniswap/sdk'

const log = ds.getLog('quoting')



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

/**
 *  TODO TODO TODO:
 * 
 *    1. This method should take advantage of complete routes
 *       to ensure that precision is not lost beyond 18 decimals
 *       instead of being called for a single route segment at a time.
 *        - the toExact method means we might be able to construct a
 *          trade (if another method exists) where we specify the last
 *          input.
 */
export const computeTradeEstimates = (pairData: t.Pair, 
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


const avgBlockMs = 15000    // TODO: <-- to constants/config
export const getRoutePairIdsOfAge = (allPairData: t.Pairs,
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

  // log.debug(`getRoutePairIdsOfAge: returning ${pairIds.size} older than ${ageMs} ms.`)

  return pairIds
}

export const getRoutePairIdsNotBlockNum = (allPairData: t.Pairs,
                                           blockNum: number,
                                           routes: t.VFRoutes): Set<string> =>
{
  const pairIds = new Set<string>()
  for (const route of routes) {
    for (const segment of route) {

      // Don't add the segment if it's been updated to the specified block number
      const pairData = allPairData.getPair(segment.pairId)
      if (pairData &&
          pairData.updatedBlock &&
          pairData.updatedBlock === blockNum) {
          continue
      }

      pairIds.add(segment.pairId)
    }
  }

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

export const filterToPairIdsNotBlockNum = (allPairData: t.Pairs,
                                           pairIds: Set<string>,
                                           blockNum: number): Set<string> =>
{
  const pairIdsNotBlockNum = new Set<string>()
  for (const pairId of pairIds) {
    const pairData = allPairData.getPair(pairId)
    if (pairData &&
        pairData.updatedBlock &&
        pairData.updatedBlock !== blockNum) {
      continue
    }

    pairIdsNotBlockNum.add(pairId)
  }

  return pairIdsNotBlockNum
}


/*
 * TODO: 
 *   - examine TODO's below, esp. handling of precision (we lose precision here vs. UNI b/c
 *     we convert to 18 dec. places internally instead of arbitrary)
 */
export const quoteRoutes = async (allPairData: t.Pairs,
                                 tokenData: t.Tokens,
                                 routes: t.VFRoutes,
                                 amount: string,
                                 maxImpact: number = 10.0,
                                 updatePairData: boolean = true,
                                 blockNumber: number = NO_BLOCK_NUM,
                                 cacheEstimates: boolean = true): Promise<t.VFRoutes> =>
{
  const quotedRoutes: t.VFRoutes = []
  const estimateCache: any = {}

  // Convert the specified double that is maxImpact to a fractional value with reasonable
  // precision:
  // const maxImpactFrac = new Fraction(JSBI.BigInt(Math.floor(maxImpact * 1e18)), JSBI.BigInt(1e18))

  if (blockNumber !== NO_BLOCK_NUM) {
    const start: number = Date.now()
    const pairIdsToUpdate: Set<string> = getRoutePairIdsNotBlockNum(allPairData, blockNumber, routes)
    const updatedPairs: t.PairLite[] = await getUpdatedPairData(pairIdsToUpdate, blockNumber)
    const updateTimeMs = Date.now()
    allPairData.updatePairs(updatedPairs, updateTimeMs, blockNumber)
    log.debug(`quoteRoutes: Finished updating ${pairIdsToUpdate.size} pairs to block ${blockNumber} in ${Date.now() - start} ms`)
  } else if (updatePairData) {
    /* TODO:
    *  - expand and extend this into a proper TTL based cache in Redis or other.
    *  - examine this for higher performance opportunity
    * 
    * For now, aggregate the pairIds in the route and fetch their current stats
    * in aggregate.  
    * 
    * TODO: add the block id to the lookup and put it in the updatedBlock.
    * 
    */
    const start: number = Date.now()
    const pairIdsToUpdate: Set<string> = getRoutePairIdsOfAge(allPairData, routes)
    const updatedPairs: t.PairLite[] = await getUpdatedPairData(pairIdsToUpdate)
    const updateTimeMs = Date.now()
    allPairData.updatePairs(updatedPairs, updateTimeMs)
    log.debug(`quoteRoutes: Finished updating ${pairIdsToUpdate.size} pairs in ${Date.now() - start} ms`)
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

    quotedRoutes.push(route)
  }

  // if (cacheEstimates) {
  //   log.debug(`cacheEstimates ON:\n` +
  //             `    ${routes.length} routes submitted for costing\n` +
  //             `    ${quotedRoutes.length} costed routes\n` +
  //             `    ${JSON.stringify(estStats, null, 2)}\n\n`)
  // }

  log.debug(`quoteRoutes completed in ${Date.now() - startCostMs} ms.`)

  return quotedRoutes
}