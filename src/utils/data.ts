import * as configJson from '../config.json'
import * as uniGraphV2 from './../graphProtocol/uniswapV2'
import * as ds from './debugScopes'
import * as p from './persistence'
import * as t from './types'
import { WETH_ADDR, bogusTokens } from './constants'

import { DateTime, Interval, Duration } from 'luxon'
import { config } from 'dotenv'

const graphlib = require('@dagrejs/graphlib')

const log = ds.getLog('data')
const ALL_PAIRS_FILE = 'all_pairs_v2.json'
const ALL_TOKENS_FILE = 'all_tokens.json'
const DEAD_TOKENS_FILE = 'dead_tokens.json'
const MAX_DATA_AGE = Duration.fromObject({ days: 5 })

export const initUniData = async(force=false, buildWethPairDict=true): Promise<t.UniData> => {
  log.info('Initializing Uniswap data. Please wait (~ 1 min.) ...')

  const ignoreExpiry = (process.env.NODE_ENV !== 'production' &&
                        configJson.ignore_expired_graph_data)
  const _rawPairData: any = await getPairData({ignorePersisted: force, ignoreExpiry })
  const _allTokenData: any = await getTokenData({ignorePersisted: force, ignoreExpiry })
  const _pairGraph: any = await constructPairGraph(_rawPairData)

  const uniData: t.UniData = {
    pairGraph: _pairGraph,
    tokenData: _allTokenData,
    pairData: _rawPairData,
  }

  if (buildWethPairDict) {
    uniData.wethPairData = buildWethPairLookup(_rawPairData)
  }

  return uniData
}

/**
 * getPairData:
 * @param options 
 * @returns 
 * 
 * TODO:
 *        - Singleton / block multiple calls / make atomic b/c interacting with storage.
 */
const getPairData = async(options?: any): Promise<t.Pairs> => {
  const _defaultOpts = {
    ignorePersisted: false,
    ignoreExpiry: false,
    persist: true,
    ignoreDeadTokens: true
  }
  const _options = {..._defaultOpts, ...options}

  let _storedObj: any = undefined
  try {
    if (!_options.ignorePersisted) {
      _storedObj =  await p.retrieveObject(ALL_PAIRS_FILE)
    }
  } catch(ignoredError) {
    log.warn(`Unable to retrieve stored swap data. Fetching from Graph Protocol.`)
  }

  let _allPairs: t.Pairs | undefined = undefined
  if (_storedObj && _storedObj.hasOwnProperty('object')) {
    _allPairs = new t.Pairs()
    _allPairs.deserialize(_storedObj.object)
  }

  let _storedAgeLimitExceeded = false
  if (_storedObj && _storedObj.hasOwnProperty('timeMs')) {
    const _storedInterval = Interval.fromDateTimes(DateTime.fromMillis(_storedObj.timeMs),
                                                   DateTime.now())
    _storedAgeLimitExceeded = _storedInterval.length() > MAX_DATA_AGE.toMillis()
  }

  if (!_allPairs || 
      (!_options.ignoreExpiry && _storedAgeLimitExceeded)) {
    _allPairs = await uniGraphV2.fetchAllRawPairsV2()

    if (_options.persist) {
      await p.storeObject(ALL_PAIRS_FILE, _allPairs.serialize())
    }
  }

  if (_options.ignoreDeadTokens) {
    const _deadTokensObj = await p.retrieveObject(DEAD_TOKENS_FILE)
    const _livePairs = new t.Pairs()

    for (const _pairId of _allPairs.getPairIds()) {
      const _pair = _allPairs.getPair(_pairId)

      if (_deadTokensObj.object.hasOwnProperty(_pair.token0.id) ||
          _deadTokensObj.object.hasOwnProperty(_pair.token1.id)) {
        continue
      }

      if (bogusTokens.hasOwnProperty(_pair.token0.id) ||
          bogusTokens.hasOwnProperty(_pair.token1.id)) {
        continue
      }

      _livePairs.addPair(_pair)
    }

    const removedPairs: number = _allPairs.getPairIds().length - _livePairs.getPairIds().length
    log.info(`Ignore pairs with dead & bogus tokens removed ${removedPairs} pairs`)

    _livePairs.setLowestBlockNumber(_allPairs.getLowestBlockNumber())

    return _livePairs
  } else {
    return _allPairs
  }
}

const getTokenData = async(options?: any): Promise<t.Tokens> => {
  const _defaultOpts = {
    ignorePersisted: false,
    ignoreExpiry: false,
    persist: true,
    ignoreDeadTokens: true
  }
  const _options = {..._defaultOpts, ...options}

  let _storedObj: any = undefined
  try {
    if (!_options.ignorePersisted) {
      _storedObj =  await p.retrieveObject(ALL_TOKENS_FILE)
    }
  } catch(ignoredError) {
    log.warn(`Unable to retrieve stored token data. Fetching from Graph Protocol.`)
  }

  let _allTokens: t.Tokens | undefined = undefined
  if (_storedObj && _storedObj.hasOwnProperty('object')) {
    _allTokens = new t.Tokens()
    _allTokens.deserialize(_storedObj.object)
  }

  let _storedAgeLimitExceeded = false
  if (_storedObj && _storedObj.hasOwnProperty('timeMs')) {
    const _storedInterval = Interval.fromDateTimes(DateTime.fromMillis(_storedObj.timeMs),
                                                   DateTime.now())
    _storedAgeLimitExceeded = _storedInterval.length() > MAX_DATA_AGE.toMillis()
  }

  if (!_allTokens ||
      (!_options.ignoreExpiry && _storedAgeLimitExceeded)) {
    _allTokens = await uniGraphV2.fetchAllTokensV2()

    if (_options.persist) {
      await p.storeObject(ALL_TOKENS_FILE, _allTokens.serialize())
    }
  }

  if (_options.ignoreDeadTokens) {
    const _deadTokensObj = await p.retrieveObject(DEAD_TOKENS_FILE)
    const _liveTokens = new t.Tokens()

    for (const _tokenId of _allTokens.getTokenIds()) {
      if (_deadTokensObj.object.hasOwnProperty(_tokenId)) {
        continue
      }

      _liveTokens.addToken(_allTokens.getToken(_tokenId))
    }

    const removedTokens: number = _allTokens.getTokenIds().length - _liveTokens.getTokenIds().length
    log.info(`Ignore dead tokens removed ${removedTokens} tokens`)

    return _liveTokens 
  } else {
    return _allTokens
  }
}

const constructPairGraph = async(allPairData: t.Pairs): Promise<t.PairGraph> =>
{
  const _g: t.PairGraph = new graphlib.Graph({directed: false,
                                              multigraph: false,   // Explain optimization here (attach array of pair ids for traversal speed)
                                              compound: false})
  
  let maxEdges = 1
  let maxEdgePair = ''
  for (const pairId of allPairData.getPairIds()) {
    const pair = allPairData.getPair(pairId)
    const { token0, token1 } = pair
    let edges = _g.edge(token0.id, token1.id)

    // Duplicate edges were only happening when graph vertices are symbols. There
    // are no duplicate pairs connecting by token IDs:
    if (edges) {
      log.warn(`Existing Edge Found:\n` +
               `${token0.id} (${token0.symbol}) <---> ${token1.id} (${token1.symbol})`)

      edges = {
        pairIds: [...edges.pairIds, pairId]
      }

      if (edges.pairIds.length > maxEdges) {
        maxEdges = edges.pairIds.length
        maxEdgePair = `${token0.id} (${token0.symbol}) <---> ${token1.id} (${token1.symbol})`
      }
    } else {
      edges = {
        pairIds: [pairId]
      }
    }
    _g.setEdge(token0.id, token1.id, edges)   // <-- pairID set for label and edge
                                              // !!! Needed for multigraph
  }

  const edges = _g.edges()
  const numRawEdges = edges.length
  let numMappedEdges = 0
  for (const edge of edges) {
    numMappedEdges += _g.edge(edge).pairIds.length
  }
  log.info(`Constructed graph containing:\n` +
           `    ${_g.nodes().length} tokens\n` +
           `    ${numRawEdges} edges\n` +
           `    ${numMappedEdges} pairs\n` +
           `    ${maxEdgePair} (${maxEdges} connecting edges)\n`)

  await p.storeObject('Graph_Data.json', _g)
  return _g
}

/**
 * buildWethPairLookup:  Builds a dictionary that allows token-WETH pairs to be found using
 *                       token addr.
 * 
 * @param allPairData 
 * @returns 
 */
const buildWethPairLookup = (allPairData: t.Pairs): t.WethPairIdDict => {
  const wethPairLookup: t.WethPairIdDict = {}

  for (const pairId of allPairData.getPairIds()) {
    const pair = allPairData.getPair(pairId)
    const { token0, token1 } = pair

    if (token0.id === WETH_ADDR) {
      wethPairLookup[token1.id] = pairId
    } else if (token1.id === WETH_ADDR) {
      wethPairLookup[token0.id] = pairId
    }
  }

  return wethPairLookup
}