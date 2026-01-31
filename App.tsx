import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, AppState, Platform } from 'react-native';
import MapView, { Polygon, Polyline, Region } from 'react-native-maps';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as SQLite from 'expo-sqlite';
import { geoToH3, h3ToParent, polyfill, h3SetToMultiPolygon } from '@six33/h3-reactnative';

const TASK_NAME = 'VVANDER_LOCATION';
const STORAGE_RES = 10; // Store at res 10 (~50m hexes)

const db = SQLite.openDatabaseSync('vvander.db');
db.execSync('CREATE TABLE IF NOT EXISTS visited (h3 TEXT PRIMARY KEY)');
db.execSync(`CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL
)`);

const getVisited = (): string[] =>
  db.getAllSync<{ h3: string }>('SELECT h3 FROM visited').map((r) => r.h3);

const addVisited = (h3: string) =>
  db.runSync('INSERT OR IGNORE INTO visited (h3) VALUES (?)', [h3]);

const addLocation = (timestamp: number, latitude: number, longitude: number) =>
  db.runSync('INSERT INTO locations (timestamp, latitude, longitude) VALUES (?, ?, ?)', [timestamp, latitude, longitude]);

type LocationPoint = { timestamp: number; latitude: number; longitude: number };

const getLocationsByTimeRange = (startTime: number, endTime: number): LocationPoint[] =>
  db.getAllSync<LocationPoint>(
    'SELECT timestamp, latitude, longitude FROM locations WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC',
    [startTime, endTime]
  );

// Background task - runs in separate JS context
TaskManager.defineTask(TASK_NAME, async ({ data, error }) => {
  if (error || !data) return;
  const { locations } = data as { locations: Location.LocationObject[] };
  for (const loc of locations) {
    const h3 = geoToH3(loc.coords.latitude, loc.coords.longitude, STORAGE_RES);
    addVisited(h3);
    addLocation(loc.timestamp, loc.coords.latitude, loc.coords.longitude);
  }
});

const getDisplayRes = (latDelta: number): number => {
  if (latDelta < 0.04) return 10;
  if (latDelta < 0.1) return 9;
  if (latDelta < 0.3) return 8;
  if (latDelta < 0.9) return 7;
  if (latDelta < 2) return 6;
  if (latDelta < 4) return 5;
  if (latDelta < 10) return 4;
  if (latDelta < 22) return 3;
  if (latDelta < 50) return 2;
  if (latDelta < 90) return 1;
  return 0;
};

const HEX_PADDING: Record<number, number> = {
  0: 50, 1: 20, 2: 8, 3: 3, 4: 1.2, 5: 0.45, 6: 0.17, 7: 0.065, 8: 0.025, 9: 0.01, 10: 0.004,
};

// Grid cells tuned for ~40-60 hexes each
const GRID_CELL_SIZE: Record<number, number> = {
  0: 30, 1: 10, 2: 5, 3: 2, 4: 1, 5: 0.5, 6: 0.2, 7: 0.1, 8: 0.05, 9: 0.02, 10: 0.01,
};

const hexGridCache = new Map<string, string[]>();

const getGridCellBounds = (latCell: number, lngCell: number, cellSize: number): number[][] => {
  const minLat = latCell * cellSize;
  const maxLat = (latCell + 1) * cellSize;
  const minLng = lngCell * cellSize;
  const maxLng = (lngCell + 1) * cellSize;
  return [[maxLat, minLng], [maxLat, maxLng], [minLat, maxLng], [minLat, minLng]];
};

const computeGridCellHexes = (latCell: number, lngCell: number, res: number): string[] => {
  const cellSize = GRID_CELL_SIZE[res] || 0.1;
  return polyfill(getGridCellBounds(latCell, lngCell, cellSize), res, false);
};

const getGridCellsForRegion = (region: Region, res: number, expansionMultiplier = 1): { latCell: number; lngCell: number }[] => {
  const { latitude, longitude, latitudeDelta, longitudeDelta } = region;
  const pad = HEX_PADDING[res] || 0.01;
  const cellSize = GRID_CELL_SIZE[res] || 0.1;

  const latHalf = (latitudeDelta * expansionMultiplier) / 2;
  const lngHalf = (longitudeDelta * expansionMultiplier) / 2;

  const minLatCell = Math.floor((latitude - latHalf - pad) / cellSize);
  const maxLatCell = Math.floor((latitude + latHalf + pad) / cellSize);
  const minLngCell = Math.floor((longitude - lngHalf - pad) / cellSize);
  const maxLngCell = Math.floor((longitude + lngHalf + pad) / cellSize);

  const cells: { latCell: number; lngCell: number }[] = [];
  for (let lat = minLatCell; lat <= maxLatCell; lat++) {
    for (let lng = minLngCell; lng <= maxLngCell; lng++) {
      cells.push({ latCell: lat, lngCell: lng });
    }
  }
  return cells;
};

const prefetchInDirection = (region: Region, res: number, direction: { lat: number; lng: number }) => {
  const offsetRegion: Region = {
    latitude: region.latitude + direction.lat * region.latitudeDelta,
    longitude: region.longitude + direction.lng * region.longitudeDelta,
    latitudeDelta: region.latitudeDelta * 2,
    longitudeDelta: region.longitudeDelta * 2,
  };
  return getHexesFromGridCache(offsetRegion, res);
};

const getHexesFromGridCache = (region: Region, res: number, expansionMultiplier = 1) => {
  const cells = getGridCellsForRegion(region, res, expansionMultiplier);
  const allHexes = new Set<string>();
  let cacheHits = 0, cacheMisses = 0;

  for (const { latCell, lngCell } of cells) {
    const key = `${res}:${latCell}:${lngCell}`;
    let cellHexes = hexGridCache.get(key);

    if (cellHexes) {
      cacheHits++;
    } else {
      cacheMisses++;
      cellHexes = computeGridCellHexes(latCell, lngCell, res);
      hexGridCache.set(key, cellHexes);
    }

    cellHexes.forEach(h3 => allHexes.add(h3));
  }

  return { hexes: Array.from(allHexes), cacheHits, cacheMisses };
};

// Convert visited hexes to a Set at display resolution
const getVisitedAtRes = (visited: string[], displayRes: number): Set<string> => {
  const set = new Set<string>();
  for (const h3 of visited) {
    if (displayRes >= STORAGE_RES) {
      set.add(h3);
    } else {
      set.add(h3ToParent(h3, displayRes));
    }
  }
  return set;
};

// Convert H3 coords to closed lat/lng ring, removing consecutive duplicates
function toClosedLatLngRing(coords: number[][]) {
  const out: { latitude: number; longitude: number }[] = [];
  let prevLat = NaN, prevLng = NaN;

  for (const [lat, lng] of coords) {
    if (lat === prevLat && lng === prevLng) continue;
    out.push({ latitude: lat, longitude: lng });
    prevLat = lat;
    prevLng = lng;
  }

  if (out.length > 0) {
    const first = out[0], last = out[out.length - 1];
    if (first.latitude !== last.latitude || first.longitude !== last.longitude) {
      out.push({ ...first });
    }
  }

  return out;
}

const THROTTLE_MS = 100;
const HEX_OVERSCAN = 2; // Compute hexes for 4x viewport to reduce cache misses when panning
const PREFETCH_EXPANSION = 2; // Prefetch 6x viewport for even more headroom

const logPerf = (totalMs: number, res: number, hexes: number, visited: number, hits: number, misses: number, cacheMs: number, visitedMs: number, mergeMs: number) => {
  if (totalMs > 20) {
    console.warn(
      `[FOG] ${totalMs.toFixed(0)}ms | res=${res}, hexes=${hexes}${visited > 0 ? `, visitedInView=${visited}` : ''}, ` +
      `cells=${hits}hit/${misses}miss | cache=${cacheMs.toFixed(0)}ms, visited=${visitedMs.toFixed(0)}ms, merge=${mergeMs.toFixed(0)}ms`
    );
  }
};

export default function App() {
  const [visited, setVisited] = useState<string[]>(getVisited);
  const [loc, setLoc] = useState<{ latitude: number; longitude: number } | null>(null);
  const [region, setRegion] = useState<Region | null>(null);
  const [tracking, setTracking] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<string>('');

  // Path overlay state - set time range to show path (null = no path)
  const [pathTimeRange, setPathTimeRange] = useState<{ start: number; end: number } | null>(null);

  // Refs
  const mapRef = useRef<MapView>(null);
  const lastUpdateRef = useRef<number>(0);
  const pendingRegionRef = useRef<Region | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const prevRegionRef = useRef<Region | null>(null);

  const updateRegion = useCallback((newRegion: Region) => {
    const now = Date.now();
    if (now - lastUpdateRef.current >= THROTTLE_MS) {
      lastUpdateRef.current = now;
      setRegion(newRegion);
    } else {
      pendingRegionRef.current = newRegion;
      if (!timeoutRef.current) {
        timeoutRef.current = setTimeout(() => {
          if (pendingRegionRef.current) {
            lastUpdateRef.current = Date.now();
            setRegion(pendingRegionRef.current);
            pendingRegionRef.current = null;
          }
          timeoutRef.current = null;
        }, THROTTLE_MS - (now - lastUpdateRef.current));
      }
    }
  }, []);

  const refreshVisited = useCallback(() => setVisited(getVisited()), []);

  // Reload visited hexes when app returns to foreground
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshVisited();
    });
    return () => sub.remove();
  }, [refreshVisited]);

  // Check if already tracking on mount
  useEffect(() => {
    Location.hasStartedLocationUpdatesAsync(TASK_NAME).then(setTracking);
  }, []);

  const startTracking = async () => {
    const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
    if (fgStatus !== 'granted') {
      setPermissionStatus('Need foreground permission');
      return;
    }

    const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
    if (bgStatus !== 'granted') {
      setPermissionStatus('Need "Always" location permission for background tracking');
      return;
    }

    const initial = await Location.getCurrentPositionAsync({});
    const { latitude, longitude } = initial.coords;
    setLoc({ latitude, longitude });
    setRegion({ latitude, longitude, latitudeDelta: 0.01, longitudeDelta: 0.01 });

    const h3 = geoToH3(latitude, longitude, STORAGE_RES);
    addVisited(h3);
    refreshVisited();

    await Location.startLocationUpdatesAsync(TASK_NAME, {
      accuracy: Location.Accuracy.Balanced,
      distanceInterval: 10,
      deferredUpdatesInterval: 60000,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'vvander',
        notificationBody: 'Exploring the world...',
        killServiceOnDestroy: false,
      },
    });
    setTracking(true);
    setPermissionStatus('');
  };

  const stopTracking = async () => {
    await Location.stopLocationUpdatesAsync(TASK_NAME);
    setTracking(false);
  };

  const { fogPolygons, fogStatus, displayRes } = useMemo(() => {
    if (!region) return { fogPolygons: [], fogStatus: null, displayRes: null };

    const startTime = performance.now();
    const displayRes = getDisplayRes(region.latitudeDelta);

    const t1 = performance.now();
    const { hexes: viewportHexes, cacheHits, cacheMisses } = getHexesFromGridCache(region, displayRes, HEX_OVERSCAN);
    const cacheTime = performance.now() - t1;

    if (viewportHexes.length > 10_000) {
      return { fogPolygons: [], fogStatus: `Tiles hidden: too many hexes (${viewportHexes.length})`, displayRes };
    }

    const t2 = performance.now();
    const visitedSet = getVisitedAtRes(visited, displayRes);
    const visitedTime = performance.now() - t2;

    const visitedNearViewport = viewportHexes.filter(h => visitedSet.has(h));

    // Fixed fog boundary (covers typical US usage)
    const fogOuterRing = [
      { latitude: 20, longitude: -130 }, { latitude: 55, longitude: -130 },
      { latitude: 55, longitude: -60 }, { latitude: 20, longitude: -60 },
      { latitude: 20, longitude: -130 },
    ];

    if (visitedNearViewport.length === 0) {
      logPerf(performance.now() - startTime, displayRes, viewportHexes.length, 0, cacheHits, cacheMisses, cacheTime, visitedTime, 0);
      return {
        fogPolygons: [{ key: `fog-viewport-${displayRes}`, coordinates: fogOuterRing, holes: [] }],
        fogStatus: null,
        displayRes,
      };
    }

    if (visitedNearViewport.length === viewportHexes.length) {
      return { fogPolygons: [], fogStatus: null, displayRes };
    }

    const t3 = performance.now();
    const visitedMulti = h3SetToMultiPolygon(visitedNearViewport, false);
    const multiPolyTime = performance.now() - t3;

    const holes = visitedMulti
      .map(poly => toClosedLatLngRing(poly[0]))
      .filter(ring => ring.length >= 4);

    logPerf(performance.now() - startTime, displayRes, viewportHexes.length, visitedNearViewport.length, cacheHits, cacheMisses, cacheTime, visitedTime, multiPolyTime);

    return {
      fogPolygons: [{ key: `fog-viewport-${displayRes}`, coordinates: fogOuterRing, holes }],
      fogStatus: null,
      displayRes,
    };
  }, [region, visited]);

  useEffect(() => {
    if (!region) return;
    const displayRes = getDisplayRes(region.latitudeDelta);
    const prevRegion = prevRegionRef.current;

    const direction = { lat: 0, lng: 0 };
    if (prevRegion) {
      const threshold = region.latitudeDelta * 0.1;
      const latDelta = region.latitude - prevRegion.latitude;
      const lngDelta = region.longitude - prevRegion.longitude;
      if (Math.abs(latDelta) > threshold) direction.lat = latDelta > 0 ? 1 : -1;
      if (Math.abs(lngDelta) > threshold) direction.lng = lngDelta > 0 ? 1 : -1;
    }
    prevRegionRef.current = region;

    const timer = setTimeout(() => {
      const t0 = performance.now();
      const { cacheHits: h1, cacheMisses: m1 } = getHexesFromGridCache(region, displayRes, PREFETCH_EXPANSION);
      let totalHits = h1, totalMisses = m1;

      if (direction.lat !== 0 || direction.lng !== 0) {
        const { cacheHits: h2, cacheMisses: m2 } = prefetchInDirection(region, displayRes, direction);
        totalHits += h2;
        totalMisses += m2;
      }

      if (totalMisses > 0) {
        const dirStr = direction.lat || direction.lng ? ` dir=(${direction.lat},${direction.lng})` : '';
        console.log(`[PREFETCH] ${(performance.now() - t0).toFixed(0)}ms | res=${displayRes}, cells=${totalHits}hit/${totalMisses}miss${dirStr}`);
      }
    }, 50);

    return () => clearTimeout(timer);
  }, [region]);

  const pathSegments = useMemo(() => {
    if (!pathTimeRange) return [];
    const points = getLocationsByTimeRange(pathTimeRange.start, pathTimeRange.end);
    if (points.length < 2) return [];

    const segments: { coordinates: { latitude: number; longitude: number }[]; opacity: number }[] = [];
    const step = Math.max(1, Math.floor((points.length - 1) / Math.min(points.length - 1, 50)));

    for (let i = 0; i < points.length - 1; i += step) {
      const endIdx = Math.min(i + step, points.length - 1);
      const opacity = Math.pow(i / (points.length - 1), 0.5) * 0.9 + 0.1;
      const coordinates = points.slice(i, endIdx + 1).map(p => ({ latitude: p.latitude, longitude: p.longitude }));
      segments.push({ coordinates, opacity });
    }

    return segments;
  }, [pathTimeRange]);

  // Date picker state
  const [showDatePicker, setShowDatePicker] = useState<'start' | 'end' | null>(null);

  const togglePathOverlay = () => {
    const now = Date.now();
    setPathTimeRange(pathTimeRange ? null : { start: now - 86400000, end: now });
  };

  const handleDateChange = (event: DateTimePickerEvent, selectedDate?: Date) => {
    if (Platform.OS === 'android') setShowDatePicker(null);
    if (event.type === 'set' && selectedDate && pathTimeRange && showDatePicker) {
      setPathTimeRange({ ...pathTimeRange, [showDatePicker]: selectedDate.getTime() });
    }
  };

  const formatDate = (timestamp: number) =>
    new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const formatDuration = (startMs: number, endMs: number) => {
    const hours = Math.floor((endMs - startMs) / 3600000);
    const minutes = Math.floor(((endMs - startMs) % 3600000) / 60000);
    return hours > 0 ? (minutes > 0 ? `${hours}h ${minutes}min` : `${hours}h`) : `${minutes}min`;
  };

  const centerOnLocation = async () => {
    const { coords } = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low });
    mapRef.current?.animateToRegion({
      latitude: coords.latitude,
      longitude: coords.longitude,
      latitudeDelta: 0.01,
      longitudeDelta: 0.01,
    }, 300);
  };

  if (!loc) {
    return (
      <View style={styles.center}>
        <TouchableOpacity style={styles.button} onPress={startTracking}>
          <Text style={styles.buttonText}>Start Exploring</Text>
        </TouchableOpacity>
        {permissionStatus ? <Text style={styles.error}>{permissionStatus}</Text> : null}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.container}
        initialRegion={{ ...loc, latitudeDelta: 0.01, longitudeDelta: 0.01 }}
        onRegionChange={updateRegion}
        onRegionChangeComplete={updateRegion}
        showsUserLocation
        pitchEnabled={true}
        rotateEnabled={true}
        mapType={region && region.latitudeDelta > 5 ? 'hybridFlyover' : 'standard'}
      >
        {fogPolygons.map(({ key, coordinates, holes }) => (
          <Polygon
            key={key}
            coordinates={coordinates}
            holes={holes}
            fillColor="rgba(95,157,245,0.7)"
            strokeColor="#5F9DF5"
            strokeWidth={1}
          />
        ))}
        {pathSegments.map((segment, i) => (
          <Polyline
            key={`path-${i}`}
            coordinates={segment.coordinates}
            strokeColor={`rgba(255,0,0,${segment.opacity})`}
            strokeWidth={4}
          />
        ))}
      </MapView>
      {fogStatus && (
        <View style={styles.fogStatusBanner}>
          <Text style={styles.fogStatusText}>{fogStatus}</Text>
        </View>
      )}
      <View style={styles.controls}>
        <View style={styles.leftControls}>
          {showDatePicker && pathTimeRange && (
            <View style={styles.datePickerContainer}>
              <DateTimePicker
                value={new Date(showDatePicker === 'start' ? pathTimeRange.start : pathTimeRange.end)}
                mode="datetime"
                display={Platform.OS === 'ios' ? 'compact' : 'default'}
                onChange={handleDateChange}
                onTouchCancel={() => setShowDatePicker(null)}
              />
            </View>
          )}
          {pathTimeRange && (
            <TouchableOpacity style={styles.dateButton} onPress={() => setShowDatePicker('start')}>
              <Text style={styles.dateButtonText}>
                {formatDate(pathTimeRange.start)} • {formatDuration(pathTimeRange.start, pathTimeRange.end)}
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.pathButton, pathTimeRange ? styles.pathButtonActive : null]}
            onPress={togglePathOverlay}
          >
            <Text style={styles.pathButtonText}>{pathTimeRange ? 'Hide Path' : 'Show Path'}</Text>
          </TouchableOpacity>
          <Text style={styles.stats}>{visited.length} hexes explored{displayRes !== null ? ` • res ${displayRes}` : ''}</Text>
        </View>
        <View style={styles.rightControls}>
          <TouchableOpacity style={styles.locationButton} onPress={centerOnLocation}>
            <Text style={styles.locationIcon}>▲</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={tracking ? styles.pauseButton : styles.playButton}
            onPress={tracking ? stopTracking : startTracking}
          >
            <Text style={tracking ? styles.pauseIcon : styles.playIcon}>{tracking ? '❚❚' : '▶'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const circleButton = {
  width: 44,
  height: 44,
  borderRadius: 22,
  justifyContent: 'center' as const,
  alignItems: 'center' as const,
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.25,
  shadowRadius: 4,
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'rgba(95,157,245,1)' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#1a1a2e' },
  controls: { position: 'absolute', bottom: 40, left: 20, right: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  button: { backgroundColor: '#4a90d9', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 },
  leftControls: { alignItems: 'flex-start', gap: 8 },
  rightControls: { alignItems: 'center', gap: 10 },
  playButton: { ...circleButton, backgroundColor: '#4a90d9' },
  pauseButton: { ...circleButton, backgroundColor: 'white' },
  locationButton: { ...circleButton, backgroundColor: 'white' },
  playIcon: { fontSize: 16, color: '#fff' },
  pauseIcon: { fontSize: 14, color: '#4a90d9' },
  locationIcon: { fontSize: 20, color: '#4a90d9', transform: [{ rotate: '30deg' }] },
  pathButton: { backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 4 },
  pathButtonActive: { backgroundColor: 'rgba(255,0,0,0.7)' },
  pathButtonText: { color: '#fff', fontSize: 12 },
  datePickerContainer: { backgroundColor: 'rgba(255,255,255,0.95)', borderRadius: 8, padding: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 4 },
  dateButton: { backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 4 },
  dateButtonText: { color: '#fff', fontSize: 11 },
  fogStatusBanner: { position: 'absolute', top: 60, left: 20, right: 20, backgroundColor: 'rgba(0,0,0,0.7)', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8 },
  fogStatusText: { color: '#fff', fontSize: 13, textAlign: 'center' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  stats: { color: '#fff', fontSize: 14, backgroundColor: 'rgba(0,0,0,0.6)', padding: 8, borderRadius: 4 },
  error: { color: '#ff6b6b', marginTop: 16, textAlign: 'center', paddingHorizontal: 20 },
});
