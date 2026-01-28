import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, AppState } from 'react-native';
import MapView, { Polygon, Region } from 'react-native-maps';
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

// Pick H3 resolution based on map zoom (latitudeDelta) - even resolutions only
const getDisplayRes = (latDelta: number): number => {
  if (latDelta < 0.025) return 10;   // Street level
  if (latDelta < 0.09) return 8;    // Neighborhood
  if (latDelta < 0.5) return 6;     // City
  if (latDelta < 5) return 4;       // Region
  return 2;                          // Very zoomed out
};

// Padding in degrees to capture hexes at viewport edges (2x hex diameter)
const HEX_PADDING: Record<number, number> = {
  2: 10,      // ~1200km
  4: 0.6,     // ~44km
  6: 0.08,    // ~6km
  8: 0.012,   // ~900m
  10: 0.002,  // ~150m
};

// Get all hexes in a region at given resolution (with padding for edge hexes)
const getHexesInRegion = (region: Region, res: number): string[] => {
  const { latitude, longitude, latitudeDelta, longitudeDelta } = region;
  const pad = HEX_PADDING[res] || 0.01;
  const bounds = [
    [latitude + latitudeDelta / 2 + pad, longitude - longitudeDelta / 2 - pad],
    [latitude + latitudeDelta / 2 + pad, longitude + longitudeDelta / 2 + pad],
    [latitude - latitudeDelta / 2 - pad, longitude + longitudeDelta / 2 + pad],
    [latitude - latitudeDelta / 2 - pad, longitude - longitudeDelta / 2 - pad],
  ];
  return polyfill(bounds, res, false);
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

const THROTTLE_MS = 100;

export default function App() {
  const [visited, setVisited] = useState<string[]>(getVisited);
  const [loc, setLoc] = useState<{ latitude: number; longitude: number } | null>(null);
  const [region, setRegion] = useState<Region | null>(null);
  const [tracking, setTracking] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<string>('');

  // Refs
  const mapRef = useRef<MapView>(null);
  const lastUpdateRef = useRef<number>(0);
  const pendingRegionRef = useRef<Region | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const updateRegion = useCallback((newRegion: Region) => {
    const now = Date.now();
    const elapsed = now - lastUpdateRef.current;

    if (elapsed >= THROTTLE_MS) {
      lastUpdateRef.current = now;
      setRegion(newRegion);
    } else {
      // Schedule update for remaining time
      pendingRegionRef.current = newRegion;
      if (!timeoutRef.current) {
        timeoutRef.current = setTimeout(() => {
          if (pendingRegionRef.current) {
            lastUpdateRef.current = Date.now();
            setRegion(pendingRegionRef.current);
            pendingRegionRef.current = null;
          }
          timeoutRef.current = null;
        }, THROTTLE_MS - elapsed);
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

  // Calculate fog polygons for current viewport (merged boundaries only)
  const { fogPolygons, fogStatus } = useMemo(() => {
    if (!region) return { fogPolygons: [], fogStatus: null };

    // Don't render fog when zoomed out too far (performance + antimeridian issues)
    if (region.latitudeDelta > 20) {
      return { fogPolygons: [], fogStatus: 'Tiles hidden: please zoom in' };
    }

    const displayRes = getDisplayRes(region.latitudeDelta);
    const viewportHexes = getHexesInRegion(region, displayRes);

    // Cap hex count to prevent performance issues
    if (viewportHexes.length > 2000) {
      return { fogPolygons: [], fogStatus: `Tiles hidden: too many hexes (${viewportHexes.length})` };
    }

    const visitedSet = getVisitedAtRes(visited, displayRes);

    // Filter to only unvisited hexes (the fog)
    const unvisited = viewportHexes.filter((h3) => !visitedSet.has(h3));

    // Merge adjacent hexes into multipolygon (only outer boundaries)
    const multiPolygon = h3SetToMultiPolygon(unvisited, false);

    // Convert to react-native-maps format
    // multiPolygon is number[][][][] - array of polygons, each with loops, each with [lat,lng] points
    const polygons = multiPolygon.map((polygon, i) => ({
      key: `fog-${i}-${displayRes}`,
      coordinates: polygon[0].map(([lat, lng]) => ({ latitude: lat, longitude: lng })),
      holes: polygon.slice(1).map((hole) =>
        hole.map(([lat, lng]) => ({ latitude: lat, longitude: lng }))
      ),
    }));

    return { fogPolygons: polygons, fogStatus: null };
  }, [region, visited]);

  const centerOnLocation = async () => {
    const current = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Low, // Fast response, good enough for centering
    });
    const { latitude, longitude } = current.coords;
    mapRef.current?.animateToRegion({
      latitude,
      longitude,
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
      </MapView>
      <TouchableOpacity style={styles.locationButton} onPress={centerOnLocation}>
        <Text style={styles.locationIcon}>▲</Text>
      </TouchableOpacity>
      {fogStatus && (
        <View style={styles.fogStatusBanner}>
          <Text style={styles.fogStatusText}>{fogStatus}</Text>
        </View>
      )}
      <View style={styles.controls}>
        <Text style={styles.stats}>{visited.length} hexes explored</Text>
        <TouchableOpacity
          style={[styles.button, tracking ? styles.stopButton : null]}
          onPress={tracking ? stopTracking : startTracking}
        >
          <Text style={styles.buttonText}>{tracking ? 'Stop' : 'Start'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#1a1a2e' },
  controls: {
    position: 'absolute',
    bottom: 40,
    left: 20,
    right: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  button: {
    backgroundColor: '#4a90d9',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  stopButton: { backgroundColor: '#d94a4a' },
  locationButton: {
    position: 'absolute',
    top: 60,
    right: 20,
    backgroundColor: 'white',
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  locationIcon: {
    fontSize: 20,
    color: '#4a90d9',
    transform: [{ rotate: '30deg' }],
  },
  fogStatusBanner: {
    position: 'absolute',
    top: 60,
    left: 20,
    right: 80,
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  fogStatusText: {
    color: '#fff',
    fontSize: 13,
    textAlign: 'center',
  },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  stats: { color: '#fff', fontSize: 14, backgroundColor: 'rgba(0,0,0,0.6)', padding: 8, borderRadius: 4 },
  error: { color: '#ff6b6b', marginTop: 16, textAlign: 'center', paddingHorizontal: 20 },
});
