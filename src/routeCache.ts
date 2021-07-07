import * as ds from './utils/debugScopes'
import * as t from './utils/types'
import * as r from './utils/routing'

const log = ds.getLog('routeCache')


export interface RouteOption {
  forceUpdate: boolean,
  maxAgeMs: number
}

interface RouteCacheEntry {
  updatedMs: number,
  routes: t.VFRoutes
}

interface RouteCacheMap {
  oldestRouteMs: number,
  newestRouteMs: number,
  cacheMap: {
    [index: string]: RouteCacheEntry
  }
}

// TODO: modify this abstraction to use Redis
export class RouteCache {
  constructor(pairGraph: t.PairGraph)
  {
    this._routeCache = {
      oldestRouteMs: 0,
      newestRouteMs: 0,
      cacheMap: {}
    }

    this._routeConstraints = {
      maxDistance: 3
    }

    this._pairGraph = pairGraph
  }

  public async getRoutes(srcId: string,
                         dstId: string,
                         options?: RouteOption): Promise<t.VFRoutes>
  {
    const defaultRCOptions: RouteOption = {
      forceUpdate: false,
      maxAgeMs: 0
    }
    const _options = {...defaultRCOptions, ...options}

    const start = Date.now()
    const key = RouteCache.getCacheKey(srcId, dstId)
    let routesEntry: RouteCacheEntry = this._routeCache.cacheMap[key]

    if (!routesEntry ||
        _options.forceUpdate ||
        RouteCache._routesTooOld(routesEntry, _options.maxAgeMs)) {
      const stackedRoutes: t.VFStackedRoutes = await r.findRoutes(this._pairGraph,
                                                                  srcId,
                                                                  dstId,
                                                                  this._routeConstraints)
      const routes: t.VFRoutes = r.unstackRoutes(stackedRoutes)

      const newRouteEntry = {
        updatedMs: Date.now(),
        routes: routes
      }
      this._routeCache.cacheMap[key] = newRouteEntry
      routesEntry = newRouteEntry
    }

    // log.debug(`getRoutes: returned ${routesEntry.routes.length} routes in ${Date.now()-start} ms`)
    return routesEntry.routes
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