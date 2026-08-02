import assert from 'node:assert/strict';
import test from 'node:test';
import { getSunState } from '../src/sun.ts';

// Null Island — 0°N 0°E. At the equator/prime meridian the expected answers are exact:
// solar noon is ~12:00 UTC, and on an equinox the sun rises due east and sets due west.
const NULL_ISLAND = { lat: 0, lon: 0 };
const sun = (iso: string, threshold = -6) =>
  getSunState(NULL_ISLAND.lat, NULL_ISLAND.lon, threshold, new Date(iso));

const AXIAL_TILT = 23.44;
const SOLSTICE_NOON_ELEVATION = 90 - AXIAL_TILT; // ≈ 66.56°

// These two pin the azimuth datum from both sides: in December the equator's noon sun is
// due SOUTH, in June due NORTH. A stray 180° rotation passes neither.
test('December solstice noon: sun is due SOUTH, ~66.6° up', () => {
  const s = sun('2026-12-21T12:00:00Z');
  assert.ok(Math.abs(s.sunAzimuth_deg - 180) < 3, `expected ≈180 (due south), got ${s.sunAzimuth_deg}`);
  assert.ok(
    Math.abs(s.sunElevation_deg - SOLSTICE_NOON_ELEVATION) < 1,
    `expected ≈${SOLSTICE_NOON_ELEVATION}, got ${s.sunElevation_deg}`,
  );
});

test('June solstice noon: sun is due NORTH, ~66.6° up', () => {
  const s = sun('2026-06-21T12:00:00Z');
  // Due north straddles the 0/360 wrap, so measure the angular distance to 0.
  const fromNorth = Math.min(s.sunAzimuth_deg, 360 - s.sunAzimuth_deg);
  assert.ok(fromNorth < 3, `expected ≈0/360 (due north), got ${s.sunAzimuth_deg}`);
  assert.ok(
    Math.abs(s.sunElevation_deg - SOLSTICE_NOON_ELEVATION) < 1,
    `expected ≈${SOLSTICE_NOON_ELEVATION}, got ${s.sunElevation_deg}`,
  );
});

// Guards the units: a radians/degrees mix-up inflates elevation ~57×.
test('elevation is degrees, never outside [-90, 90]', () => {
  for (let hour = 0; hour < 24; hour++) {
    const s = sun(`2026-03-15T${String(hour).padStart(2, '0')}:00:00Z`);
    assert.ok(
      s.sunElevation_deg >= -90 && s.sunElevation_deg <= 90,
      `elevation out of range at ${hour}Z: ${s.sunElevation_deg} (radians/degrees mix-up?)`,
    );
    assert.ok(
      s.sunAzimuth_deg >= 0 && s.sunAzimuth_deg < 360,
      `azimuth out of range at ${hour}Z: ${s.sunAzimuth_deg}`,
    );
  }
});

test('equinox: the sun rises due EAST and sets due WEST', () => {
  const morning = sun('2026-03-20T08:00:00Z');
  const evening = sun('2026-03-20T16:00:00Z');
  assert.ok(Math.abs(morning.sunAzimuth_deg - 90) < 3, `morning expected ≈90 (east), got ${morning.sunAzimuth_deg}`);
  assert.ok(Math.abs(evening.sunAzimuth_deg - 270) < 3, `evening expected ≈270 (west), got ${evening.sunAzimuth_deg}`);
  assert.ok(morning.sunElevation_deg > 0 && evening.sunElevation_deg > 0);
});

test('the threshold moves isSunUp but never the position', () => {
  // Just below the horizon: up under a -6° threshold, down under 0°.
  const iso = '2026-03-20T18:20:00Z';
  const lenient = sun(iso, -6);
  const strict = sun(iso, 0);
  assert.equal(lenient.sunElevation_deg, strict.sunElevation_deg, 'threshold must not move the sun');
  assert.ok(lenient.sunElevation_deg < 0, `expected just below horizon, got ${lenient.sunElevation_deg}`);
  assert.equal(lenient.isSunUp, true, 'above the -6° civil-twilight threshold');
  assert.equal(strict.isSunUp, false, 'below the 0° threshold');
});

test('night is night', () => {
  const s = sun('2026-01-15T00:00:00Z');
  assert.equal(s.isSunUp, false);
  assert.ok(s.sunElevation_deg < -6, `expected well below horizon, got ${s.sunElevation_deg}`);
});

test('sunrise/sunset are unix SECONDS, sunrise before sunset', () => {
  const s = sun('2026-12-21T12:00:00Z');
  assert.equal(typeof s.sunriseAt, 'number');
  assert.equal(typeof s.sunsetAt, 'number');
  assert.ok(s.sunriseAt! < s.sunsetAt!);
  // A seconds/milliseconds slip would otherwise pass silently.
  assert.ok(s.sunriseAt! < 4_000_000_000, 'looks like milliseconds, not seconds');
  // At the equator, day length is ~12h year-round.
  const dayLengthHours = (s.sunsetAt! - s.sunriseAt!) / 3600;
  assert.ok(Math.abs(dayLengthHours - 12) < 0.5, `expected ~12h day at the equator, got ${dayLengthHours}`);
});

test('polar night yields null sunrise/sunset rather than NaN', () => {
  const s = getSunState(78.22, 15.63, -6, new Date('2026-12-21T12:00:00Z'));
  assert.equal(s.sunriseAt, null);
  assert.equal(s.sunsetAt, null);
  assert.equal(s.isSunUp, false);
});
