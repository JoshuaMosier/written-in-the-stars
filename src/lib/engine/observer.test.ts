import { describe, expect, it } from 'vitest';

import { getGreenwichMeanSiderealTime, getLocalSiderealTime, getZenithEquatorialCoords } from './observer';

const DEG_TO_RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;

function normalizeRadians(angle: number): number {
	return ((angle % TWO_PI) + TWO_PI) % TWO_PI;
}

describe('observer helpers', () => {
	it('matches the J2000 Greenwich sidereal reference angle', () => {
		const gmst = getGreenwichMeanSiderealTime(new Date('2000-01-01T12:00:00.000Z'));
		const expected = 280.46061837 * DEG_TO_RAD;

		expect(gmst).toBeCloseTo(expected, 8);
	});

	it('shifts local sidereal time by longitude', () => {
		const date = new Date('2026-03-18T00:00:00.000Z');
		const greenwich = getLocalSiderealTime(date, 0);
		const eastThirty = getLocalSiderealTime(date, 30);
		const difference = normalizeRadians(eastThirty - greenwich);

		expect(difference).toBeCloseTo(30 * DEG_TO_RAD, 8);
	});

	it('uses local sidereal time and latitude for the zenith equatorial coordinates', () => {
		const date = new Date('2026-03-18T05:30:00.000Z');
		const latitude = 40.7128;
		const longitude = -74.006;
		const zenith = getZenithEquatorialCoords(date, latitude, longitude);

		expect(zenith.ra).toBeCloseTo(getLocalSiderealTime(date, longitude), 8);
		expect(zenith.dec).toBeCloseTo(latitude * DEG_TO_RAD, 8);
	});
});
