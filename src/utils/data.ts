import { DateTime, Interval, Duration } from 'luxon'
import * as uniGraphV2 from './../graphProtocol/uniswapV2'
import * as ds from './debugScopes'
import * as p from './persistence'
import * as t from './types'

const graphlib = require('@dagrejs/graphlib')

const log = ds.getLog('data')
const ALL_PAIRS_FILE = 'all_pairs_v2.json'
const ALL_TOKENS_FILE = 'all_tokens.json'
const MAX_DATA_AGE = Duration.fromObject({ days: 5 })

export const initUniData = async(force=false): Promise<t.UniData> => {
  log.info('Initializing Uniswap data. Please wait (~ 1 min.) ...')

  const _rawPairData: any = await getPairData({ignorePersisted: force})
  const _allTokenData: any = await getTokenData({ignorePersisted: force})
  const _pairGraph: any = await constructPairGraph(_rawPairData)

  return {
    pairGraph: _pairGraph,
    tokenData: _allTokenData,
    pairData: _rawPairData
  }
}

/**
 * getPairData:
 * @param options 
 * @returns 
 * 
 * TODO:
 *        - Singleton / block multiple calls / make atomic b/c interacting with storage.
 */
export const getPairData = async(options?: any): Promise<t.Pairs> => {
  const _defaultOpts = {
    ignorePersisted: false,
    persist: true
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

  if (!_allPairs || _storedAgeLimitExceeded) {
    _allPairs = await uniGraphV2.fetchAllRawPairsV2()

    if (_options.persist) {
      await p.storeObject(ALL_PAIRS_FILE, _allPairs.serialize())
    }
  }

  return _allPairs
}

export const getTokenData = async(options?: any): Promise<t.Tokens> => {
  const _defaultOpts = {
    ignorePersisted: false,
    persist: true
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

  if (!_allTokens || _storedAgeLimitExceeded) {
    _allTokens = await uniGraphV2.fetchAllTokensV2()

    if (_options.persist) {
      await p.storeObject(ALL_TOKENS_FILE, _allTokens.serialize())
    }
  }

  return _allTokens
}

export const constructPairGraph = async(allPairData: t.Pairs): Promise<t.PairGraph> =>
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