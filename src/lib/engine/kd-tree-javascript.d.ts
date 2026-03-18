declare module 'kd-tree-javascript' {
	export class kdTree<T> {
		constructor(points: T[], distance: (a: T, b: T) => number, dimensions: string[]);
		nearest(point: T, count: number): [T, number][];
		insert(point: T): void;
		remove(point: T): void;
	}
}
