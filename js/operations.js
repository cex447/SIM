const SPECIAL_COUNTDOWN_STATIONS = new Set(["PC", "MN", "TT", "SR"]);

export function parentCode(stop) {
  if (stop?.parent_station) return String(stop.parent_station);
  return String(stop?.stop_id || stop || "").replace(/\d+$/, "");
}

export function countdownRedThreshold(stationCode) {
  return SPECIAL_COUNTDOWN_STATIONS.has(String(stationCode || "")) ? 13 : 9;
}

export function isSpecialCountdownStation(stationCode) {
  return SPECIAL_COUNTDOWN_STATIONS.has(String(stationCode || ""));
}

export function isOriginHold(train, effectiveOrigin = null) {
  const origin = effectiveOrigin || train?.origin || null;
  return Boolean(
    origin &&
    train?.stationed &&
    String(origin) === String(train.stationed)
  );
}

/*
 * Posicionamiento es la única autoridad para decidir DÓNDE está el tren.
 * El reloj/GTFS sólo calculan el tiempo una vez fijada la estación objetivo.
 */
export function locateOperationalTarget(stops, live) {
  if (!Array.isArray(stops) || !stops.length || !live) return null;

  if (live.stationed) {
    const index = stops.findIndex(
      stop => parentCode(stop) === String(live.stationed)
    );

    if (index >= 0) {
      return {
        type: "stationed",
        targetIndex: index,
        stationIndex: index,
        final: index === stops.length - 1
      };
    }
  }

  if (live.nextStop) {
    const nextIndex = stops.findIndex(
      stop => parentCode(stop) === String(live.nextStop)
    );

    if (nextIndex >= 0) {
      return {
        type: "moving",
        targetIndex: nextIndex,
        final: nextIndex === stops.length - 1
      };
    }
  }

  return null;
}
