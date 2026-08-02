import { getPosition, getTimes } from 'suncalc';

/**
 * Solar position in the horizontal (alt-az) system, named to match Home Assistant's
 * `sun.sun`: azimuth is degrees clockwise from true north, elevation degrees above the
 * horizon. suncalc 2.x already reports both in these units.
 */
export interface SunState {
  sunAzimuth_deg: number;
  sunElevation_deg: number;
  isSunUp: boolean;
  /** Unix seconds; null in polar day/night where the event doesn't occur. */
  sunriseAt: number | null;
  sunsetAt: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const unixOrNull = (d: Date | null): number | null =>
  d instanceof Date && !isNaN(d.getTime()) ? Math.floor(d.getTime() / 1000) : null;

export function getSunState(
  latitude: number,
  longitude: number,
  elevationThreshold_deg: number,
  now: Date = new Date(),
): SunState {
  const position = getPosition(now, latitude, longitude);
  const times = getTimes(now, latitude, longitude);
  const sunElevation_deg = position.altitude;

  return {
    sunAzimuth_deg: round2(((position.azimuth % 360) + 360) % 360),
    sunElevation_deg: round2(sunElevation_deg),
    isSunUp: sunElevation_deg > elevationThreshold_deg,
    sunriseAt: unixOrNull(times.sunrise),
    sunsetAt: unixOrNull(times.sunset),
  };
}
