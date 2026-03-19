const MS_PER_DAY = 86_400_000;
const UNIX_EPOCH_JULIAN_DATE = 2_440_587.5;
const J2000_JULIAN_DATE = 2_451_545.0;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

function normalizeDegrees(angle: number): number {
	return ((angle % 360) + 360) % 360;
}

export function toJulianDate(date: Date): number {
	return date.getTime() / MS_PER_DAY + UNIX_EPOCH_JULIAN_DATE;
}

export function getGreenwichMeanSiderealTime(date: Date): number {
	const julianDate = toJulianDate(date);
	const t = (julianDate - J2000_JULIAN_DATE) / 36_525;
	const degrees =
		280.46061837 +
		360.98564736629 * (julianDate - J2000_JULIAN_DATE) +
		0.000387933 * t * t -
		(t * t * t) / 38_710_000;
	return normalizeDegrees(degrees) * DEG_TO_RAD;
}

export function getLocalSiderealTime(date: Date, longitudeDeg: number): number {
	return normalizeDegrees(getGreenwichMeanSiderealTime(date) * RAD_TO_DEG + longitudeDeg) * DEG_TO_RAD;
}

export function getZenithEquatorialCoords(date: Date, latitudeDeg: number, longitudeDeg: number) {
	return {
		ra: getLocalSiderealTime(date, longitudeDeg),
		dec: latitudeDeg * DEG_TO_RAD,
	};
}
