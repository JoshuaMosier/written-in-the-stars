/// <reference types="@sveltejs/kit" />

declare module 'troika-three-text' {
	import type { ColorRepresentation, Material, Mesh } from 'three';

	export class Text extends Mesh {
		text: string;
		anchorX: number | string;
		anchorY: number | string;
		font: string | null;
		fontSize: number;
		fontWeight: number | string;
		fontStyle: string;
		letterSpacing: number;
		lineHeight: number | string;
		maxWidth: number;
		overflowWrap: string;
		textAlign: string;
		textIndent: number;
		whiteSpace: string;
		material: Material | null;
		color: ColorRepresentation | null;
		outlineWidth: number | string;
		outlineColor: ColorRepresentation;
		outlineOpacity: number;
		outlineBlur: number | string;
		fillOpacity: number;
		depthOffset: number;
		sdfGlyphSize: number | null;
		sync(callback?: () => void): void;
		dispose(): void;
	}
}
