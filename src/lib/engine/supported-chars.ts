function rangeChars(from: string, to: string): string[] {
	const start = from.charCodeAt(0);
	const end = to.charCodeAt(0);
	return Array.from({ length: end - start + 1 }, (_, i) => String.fromCharCode(start + i));
}

export const SUPPORTED_CHARACTERS = [
	' ',
	'!',
	'"',
	'#',
	'$',
	'%',
	'&',
	"'",
	'(',
	')',
	'*',
	'+',
	',',
	'-',
	'.',
	'/',
	...rangeChars('0', '9'),
	':',
	';',
	'<',
	'=',
	'>',
	'?',
	'@',
	...rangeChars('A', 'Z'),
	...rangeChars('a', 'z'),
] as const;

export const SUPPORTED_CHARS = new Set<string>(SUPPORTED_CHARACTERS);
