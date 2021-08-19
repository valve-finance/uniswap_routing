import * as ds from '../utils/debugScopes'
import * as t from '../utils/types'
import * as r from './routeGraph'
import LRUCache from 'lru-cache'

const log = ds.getLog('routeCache')

const MAX_CACHE_ENTRIES = 10000
export interface RouteOptionArg {
  forceUpdate?: boolean,
  maxAgeMs?: number,
  maxHops?: number
}

interface RouteOption {
  forceUpdate: boolean,
  maxAgeMs: number,
  maxHops: number
}

interface RouteCacheEntry {
  updatedMs: number,
  routes: t.VFRoutes
}

interface RouteCacheMap {
  oldestRouteMs: number,
  newestRouteMs: number,
  cacheMap: LRUCache<string, RouteCacheEntry>
  // cacheMap: {
  //   [index: string]: RouteCacheEntry
  // }
}

// TODO: modify this abstraction to use Redis
export class RouteCache {
  constructor(pairGraph: t.PairGraph,
              constraints?: t.Constraints)
  {
    this._routeCache = {
      oldestRouteMs: 0,
      newestRouteMs: 0,
      cacheMap: new LRUCache<string, RouteCacheEntry>(MAX_CACHE_ENTRIES)
    }

    this._routeConstraints = constraints ? constraints : { maxDistance: 3 }

    this._pairGraph = pairGraph
  }

  public async getRoutes(srcId: string,
                         dstId: string,
                         options: RouteOptionArg = {}): Promise<t.VFRoutes>
  {
    // TODO: find a better typescript pattern for methods w/ optional args etc.
    //       - right now there's two types being used to get around the can't assign
    //         to undefined mess.
    //
    const _options: RouteOption = {
      forceUpdate: options.forceUpdate !== undefined ? options.forceUpdate : false,
      maxAgeMs: options.maxAgeMs !== undefined ? options.maxAgeMs : 0,
      maxHops: options.maxHops !== undefined ? options.maxHops : 0
    }

    // Special case - bypass the cache if the specified max hops exceeds that for the
    //                cache:
    if (this._routeConstraints.maxDistance &&
        this._routeConstraints.maxDistance < _options.maxHops) {
      log.warn(`RouteCache::getRoutes:  Bypassing cache for maxhops specified ${_options.maxHops}`)
      const constraints = {...this._routeConstraints, ...{maxDistance: _options.maxHops}}
      const stackedRoutes: t.VFStackedRoutes = r.findRoutes(this._pairGraph,
                                                            srcId,
                                                            dstId,
                                                            constraints)
      const routes: t.VFRoutes = r.unstackRoutes(stackedRoutes)
      return routes
    }

    const start = Date.now()
    const key = RouteCache.getCacheKey(srcId, dstId)
    let routesEntry: RouteCacheEntry | undefined = this._routeCache.cacheMap.get(key)
    // let routesEntry: RouteCacheEntry = this._routeCache.cacheMap[key]

    if (!routesEntry ||
        _options.forceUpdate ||
        RouteCache._routesTooOld(routesEntry, _options.maxAgeMs)) {
      const stackedRoutes: t.VFStackedRoutes = r.findRoutes(this._pairGraph,
                                                            srcId,
                                                            dstId,
                                                            this._routeConstraints)
      const routes: t.VFRoutes = r.unstackRoutes(stackedRoutes)

      const newRouteEntry = {
        updatedMs: Date.now(),
        routes: routes
      }
      this._routeCache.cacheMap.set(key, newRouteEntry)
      // this._routeCache.cacheMap[key] = newRouteEntry
      routesEntry = newRouteEntry
    }

    // log.debug(`getRoutes: returned ${routesEntry.routes.length} routes in ${Date.now()-start} ms`)
    if (_options.maxHops) {
      const _filteredRoutes: t.VFRoutes = []
      for (const _route of routesEntry.routes) {
        if (_route.length <= _options.maxHops) {
          _filteredRoutes.push(_route)
        }
      }
      return _filteredRoutes
    } else {
      return routesEntry.routes
    }
  }

  public setPairGraph(pairGraph: t.PairGraph)
  {
    this._pairGraph = pairGraph
  }

  public static getCacheKey(srcId: string, dstId: string): string
  {
    return `${srcId.toLowerCase()}-${dstId.toLowerCase()}`
  }

  private static _routesTooOld(routes: RouteCacheEntry, maxAge: number): boolean
  {
    if (maxAge) {
      return (Date.now() - routes.updatedMs) > maxAge
    }

    return false
  }

  private _routeCache: RouteCacheMap
  private _routeConstraints: t.Constraints
  private _pairGraph: t.PairGraph
}