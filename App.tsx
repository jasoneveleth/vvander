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

// Pick H3 resolution based on map zoom (latitudeDelta)
// Each H3 res step is ~2.6x larger, thresholds tuned for smaller hex appearance at cutover
const getDisplayRes = (latDelta: number): number => {
  if (latDelta < 0.04) return 10;
  if (latDelta < 0.08) return 9;
  if (latDelta < 0.2) return 8;
  if (latDelta < 0.5) return 7;
  if (latDelta < 1.3) return 6;
  if (latDelta < 3.4) return 5;
  if (latDelta < 9) return 4;
  if (latDelta < 23) return 3;
  if (latDelta < 45) return 2;
  if (latDelta < 60) return 1;
  return 0;
};

// Padding in degrees to capture hexes at viewport edges
const HEX_PADDING: Record<number, number> = {
  0: 50,       // ~4000km
  1: 20,       // ~1500km
  2: 8,        // ~600km
  3: 3,        // ~230km
  4: 1.2,      // ~90km
  5: 0.45,     // ~35km
  6: 0.17,     // ~13km
  7: 0.065,    // ~5km
  8: 0.025,    // ~2km
  9: 0.01,     // ~750m
  10: 0.004,   // ~300m
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

  // Path overlay state - set time range to show path (null = no path)
  const [pathTimeRange, setPathTimeRange] = useState<{ start: number; end: number } | null>(null);

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
  const { fogPolygons, fogStatus, displayRes } = useMemo(() => {
    if (!region) return { fogPolygons: [], fogStatus: null, displayRes: null };

    const displayRes = getDisplayRes(region.latitudeDelta);
    const viewportHexes = getHexesInRegion(region, displayRes);

    // Cap hex count to prevent performance issues
    if (viewportHexes.length > 2000) {
      return { fogPolygons: [], fogStatus: `Tiles hidden: too many hexes (${viewportHexes.length})`, displayRes };
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

    return { fogPolygons: polygons, fogStatus: null, displayRes };
  }, [region, visited]);

  // Compute path segments with opacity gradient
  const pathSegments = useMemo(() => {
    if (!pathTimeRange) return [];

    const points = getLocationsByTimeRange(pathTimeRange.start, pathTimeRange.end);
    if (points.length < 2) return [];

    // Create segments with increasing opacity
    const segments: { coordinates: { latitude: number; longitude: number }[]; opacity: number }[] = [];
    const numSegments = Math.min(points.length - 1, 50); // Cap segments for performance
    const step = Math.max(1, Math.floor((points.length - 1) / numSegments));

    for (let i = 0; i < points.length - 1; i += step) {
      const endIdx = Math.min(i + step, points.length - 1);
      const progress = i / (points.length - 1); // 0 to 1
      // Ease-in opacity: starts slow, accelerates
      const opacity = Math.pow(progress, 0.5) * 0.9 + 0.1; // 0.1 to 1.0

      const segmentCoords = [];
      for (let j = i; j <= endIdx; j++) {
        segmentCoords.push({ latitude: points[j].latitude, longitude: points[j].longitude });
      }
      segments.push({ coordinates: segmentCoords, opacity });
    }

    return segments;
  }, [pathTimeRange]);

  // Date picker state
  const [showDatePicker, setShowDatePicker] = useState<'start' | 'end' | null>(null);

  const togglePathOverlay = () => {
    if (pathTimeRange) {
      setPathTimeRange(null);
    } else {
      // Show last 24 hours by default
      const now = Date.now();
      setPathTimeRange({ start: now - 24 * 60 * 60 * 1000, end: now });
    }
  };

  const handleDateChange = (event: DateTimePickerEvent, selectedDate?: Date) => {
    if (Platform.OS === 'android') {
      setShowDatePicker(null);
    }
    if (event.type === 'set' && selectedDate && pathTimeRange) {
      const newTime = selectedDate.getTime();
      if (showDatePicker === 'start') {
        setPathTimeRange({ ...pathTimeRange, start: newTime });
      } else if (showDatePicker === 'end') {
        setPathTimeRange({ ...pathTimeRange, end: newTime });
      }
    }
    if (Platform.OS === 'ios') {
      // iOS picker stays open, dismiss on any interaction
    }
  };

  const formatDate = (timestamp: number) => {
    const d = new Date(timestamp);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const formatDuration = (startMs: number, endMs: number) => {
    const diffMs = endMs - startMs;
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 0 && minutes > 0) return `${hours}h ${minutes}min`;
    if (hours > 0) return `${hours}h`;
    return `${minutes}min`;
  };

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
  leftControls: {
    alignItems: 'flex-start',
    gap: 8,
  },
  rightControls: {
    alignItems: 'center',
    gap: 10,
  },
  playButton: {
    backgroundColor: '#4a90d9',
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
  pauseButton: {
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
  playIcon: {
    fontSize: 16,
    color: '#fff',
  },
  pauseIcon: {
    fontSize: 14,
    color: '#4a90d9',
  },
  pathButton: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
  },
  pathButtonActive: {
    backgroundColor: 'rgba(255,0,0,0.7)',
  },
  pathButtonText: {
    color: '#fff',
    fontSize: 12,
  },
  datePickerContainer: {
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 8,
    padding: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  dateButton: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
  },
  dateButtonText: {
    color: '#fff',
    fontSize: 11,
  },
  locationButton: {
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
    right: 20,
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
