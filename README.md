# Fog of War Location Tracker

A React Native app that reveals the world as you explore it, using Uber's H3 hexagonal tiling system to visualize visited locations with a "fog of war" effect.

## Executive Summary

This is a "fog of war" location tracking app that reveals areas on a map as you visit them, similar to video game exploration mechanics. It:                                           
                                                                                                                                                                                       
1. Tracks location in background - Uses Expo's TaskManager for continuous location updates                                                                                             
2. Stores visits as H3 hexagons - Converts GPS coordinates to Uber's H3 hexagonal tiles (resolution 10 ≈ 50m hexes) and stores them in SQLite                                          
3. Renders fog-of-war - Shows a blue overlay covering the map with holes cut out for visited areas                                                                                     
4. Dynamic resolution switching - Adjusts hex size (res 0-10) based on zoom level for performance                                                                                      
5. Grid-based hex caching - Divides the world into grid cells, caches computed hexes per cell to avoid repeated polyfill calculations                                                  
6. Directional prefetching - Detects pan direction and preloads hexes ahead of movement                                                                                                
7. Path replay - Displays historical paths with opacity gradient from stored location points

```
npx expo run:ios --device
npx expo run:ios --configuration Release --device 
```

## The Problem

Building a location tracking app that:
- Shows where you've been on a map
- Works smoothly at any zoom level (from street to continent view)
- Handles thousands of visited locations without performance degradation
- Runs efficiently in the background
- Provides instant visual feedback as you pan and zoom

## The Solution

### H3 Hexagonal Tiling
We use Uber's H3 system to discretize GPS coordinates into hexagonal tiles. Hexagons have better geometric properties than squares (uniform distance to neighbors, no orientation bias).

**Storage**: Locations are stored at resolution 10 (~50m hexes) for fine-grained tracking.

**Display**: Resolution dynamically adjusts from 0 to 10 based on zoom level. At continent view (res 0), hexes are ~4000km. At street view (res 10), they're ~50m.

### Grid-Based Spatial Cache

**Problem**: Computing which hexes fill a viewport using H3's `polyfill` is expensive. Doing this on every pan/zoom would be too slow.

**Solution**: We divide the world into fixed grid cells (e.g., 0.01° x 0.01° at res 10, 30° x 30° at res 0). Each cell caches its computed H3 hexes. Grid cell size is tuned so each contains ~40-60 hexes.

```
Cache key: "res:latCell:lngCell"
Example: "10:3742:8831" -> ["8a2a1072b59ffff", "8a2a1072b5bffff", ...]
```

When rendering a viewport:
1. Determine which grid cells overlap the viewport (with padding)
2. Look up or compute hexes for each cell
3. Union all cell hexes

This reduces cache misses dramatically since adjacent viewports share grid cells.

### Directional Prefetching

**Problem**: Panning the map can cause new grid cells to enter view, causing stutter during computation.

**Solution**:
1. Detect pan direction by comparing current vs previous viewport center
2. Prefetch grid cells in the direction of movement (offset by 1-2 viewport sizes)
3. Run prefetch 50ms after region change to avoid blocking render

This keeps cache warm for the likely next viewport.

### Fog Rendering Strategy

**Naive approach**: Render a polygon for each unvisited hex → 10,000+ polygons → terrible performance.

**Our approach**:
1. Render ONE polygon: a large rectangle covering the map
2. Use visited areas as "holes" in the polygon
3. Polygonize visited hexes using H3's `h3SetToMultiPolygon` (merges adjacent hexes)
4. Cap at 10,000 hexes total; hide fog if exceeded

This reduces polygon count from thousands to typically 1-20.

### Overscan Strategy

**Problem**: Panning quickly can show fog edges briefly before cache updates.

**Solution**: Compute hexes for 4x the viewport size (2x in each direction). This ensures we have hexes ready even when panning.

Background prefetch uses 6x expansion for even more headroom.

## Architecture Decisions

**SQLite for Storage**
- Two tables: `visited` (unique H3 hexes) and `locations` (raw GPS points with timestamps)
- H3 hexes are the source of truth for fog visualization
- Raw locations enable path replay and future analytics

**Background Task**
- Expo TaskManager runs a background JS context
- Records location every 10m with 60s batching
- Foreground service prevents Android from killing the process

**Throttled Region Updates**
- Debounce map region changes to 100ms
- Prevents excessive re-renders during fast panning
- Queues final position if changes arrive too quickly

**Fixed Fog Boundary**
- Large rectangle (20°-55°N, 130°W-60°W) covers typical US usage
- Alternative: compute bounds from viewport, but adds edge-case handling

**Performance Budget**
- Warn if fog computation exceeds 20ms
- Cap viewport hexes at 10,000
- Grid cache is unbounded but typically stays under 1000 cells in memory

## Cache Decisions

**Grid Cache Structure**
```javascript
Map<"res:lat:lng", string[]>
```
- Never evicted (grows unbounded)
- Assumption: users explore finite areas, cache won't exhaust memory
- Typical usage: 500-2000 grid cells cached (~5-20MB)

**Resolution-Specific Grid Sizes**
- Res 10: 0.01° cells (~1.1km at equator) → ~50 hexes/cell
- Res 5: 0.5° cells (~55km) → ~45 hexes/cell
- Res 0: 30° cells (~3300km) → ~40 hexes/cell

Tuned so cache granularity matches typical viewport panning distances.

**Cache Key Design**
Including resolution in the key means zooming creates new cache entries. This is correct because different resolutions have different hex sets for the same lat/lng region.

**Prefetch Timing**
- 50ms delay: Waits for React to commit render before prefetching
- Prevents prefetch from blocking UI during active panning
- Runs on every region change (not throttled) to maximize coverage

## Data Flow

```
GPS → H3 hex (res 10) → SQLite
                      ↓
Map viewport → Grid cells → Cache lookup/compute → H3 hexes (dynamic res)
                                                  ↓
Visited hexes → Filter → Polygonize → Fog holes → Single polygon → MapView
```

## Performance Characteristics

**Typical fog render**: 5-15ms
**Cache hit scenario**: 1-3ms
**Cache miss scenario**: 10-50ms (depending on resolution)
**Prefetch**: 5-20ms (runs in background)

**Bottlenecks**:
1. `polyfill` (mitigated by grid cache)
2. `h3SetToMultiPolygon` (mitigated by overscan + filtering to visited only)
3. React re-renders (mitigated by throttling + useMemo)
