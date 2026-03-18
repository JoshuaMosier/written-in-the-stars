<script lang="ts">
	import { onMount } from 'svelte';
	import * as THREE from 'three';
	import { Text } from 'troika-three-text';
	import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
	import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
	import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
	import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
	import type { Star, MatchResult } from '$lib/engine/types';
	import { CONSTELLATIONS } from '$lib/data/constellations';

	let { stars, onReady = () => {}, onVertexDrag = (_e: { constellationIndex: number; nodeIndex: number; newStar: Star }) => {}, onStarClick = (_star: Star, _screenPos: { x: number; y: number }) => {} }: {
		stars: Star[];
		onReady?: () => void;
		onVertexDrag?: (e: { constellationIndex: number; nodeIndex: number; newStar: Star }) => void;
		onStarClick?: (star: Star, screenPos: { x: number; y: number }) => void;
	} = $props();

	// Respect prefers-reduced-motion
	const reducedMotion = typeof window !== 'undefined'
		? window.matchMedia('(prefers-reduced-motion: reduce)').matches
		: false;

	let container: HTMLDivElement;
	let tooltip: HTMLDivElement;
	let sceneRef: THREE.Scene | null = null;
	let overlaySceneRef: THREE.Scene | null = null;
	let cameraRef: THREE.PerspectiveCamera | null = null;
	let overlayCameraRef: THREE.OrthographicCamera | null = null;
	let controlsRef: OrbitControls | null = null;
	let rendererRef: THREE.WebGLRenderer | null = null;
	let constellationGroups: THREE.Group[] = [];
	let ringMaterials: THREE.ShaderMaterial[] = [];
	let drawAnimationIds: number[] = [];
	let starPointsRef: THREE.Points | null = null;
	const projectedLabelPos = new THREE.Vector3();
	const overlayCameraDir = new THREE.Vector3();

	// Shared up-axis constant for OrbitControls quaternion sync
	const Y_UP = new THREE.Vector3(0, 1, 0);

	/**
	 * Sync OrbitControls' internal up-axis quaternion after changing camera.up.
	 * OrbitControls caches _quat/_quatInverse at construction time from the initial
	 * camera.up. When we animate camera.up to a new orientation, these must be
	 * updated or the controls will fight the new up vector.
	 *
	 * Uses private internals — isolate here so a Three.js upgrade only breaks one spot.
	 */
	function syncControlsUp(controls: OrbitControls, cameraUp: THREE.Vector3) {
		(controls as any)._quat.setFromUnitVectors(cameraUp, Y_UP);
		(controls as any)._quatInverse.copy((controls as any)._quat).invert();
	}

	function collectObjectResources(node: THREE.Object3D) {
		const geometries = new Set<THREE.BufferGeometry>();
		const materials = new Set<THREE.Material>();
		const texts = new Set<Text>();

		node.traverse((child) => {
			if (child instanceof Text) {
				texts.add(child);
				return;
			}

			const objectWithResources = child as THREE.Object3D & {
				geometry?: THREE.BufferGeometry;
				material?: THREE.Material | THREE.Material[];
			};

			if (objectWithResources.geometry) geometries.add(objectWithResources.geometry);

			const { material } = objectWithResources;
			if (Array.isArray(material)) {
				for (const entry of material) materials.add(entry);
			} else if (material) {
				materials.add(material);
			}
		});

		return { geometries, materials, texts };
	}

	type TroikaTextMesh = Text & {
		_baseMaterial?: THREE.Material;
		_defaultMaterial?: THREE.Material;
	};

	function disposeTextLabel(label: Text) {
		const troikaLabel = label as TroikaTextMesh;
		const baseMaterial = troikaLabel._baseMaterial ?? troikaLabel._defaultMaterial ?? null;
		label.removeFromParent();
		label.dispose();
		baseMaterial?.dispose();
	}

	function disposeObject3D(node: THREE.Object3D | null) {
		if (!node) return;

		const { geometries, materials, texts } = collectObjectResources(node);
		node.removeFromParent();

		for (const text of texts) disposeTextLabel(text);
		for (const geometry of geometries) geometry.dispose();
		for (const material of materials) material.dispose();
	}

	function clearObjectChildren(node: THREE.Object3D) {
		while (node.children.length > 0) {
			disposeObject3D(node.children[0]);
		}
	}

	interface DynamicLinePair {
		geometry: LineSegmentsGeometry;
		positions: Float32Array;
		haloMaterial: LineMaterial;
		coreMaterial: LineMaterial;
		halo: LineSegments2;
		core: LineSegments2;
	}

	function createDynamicLinePair(
		maxSegments: number,
		color: number,
		haloWidth: number,
		haloOpacity: number,
		coreWidth: number,
		coreOpacity: number,
	) {
		const positions = new Float32Array(Math.max(1, maxSegments) * 6);
		const geometry = new LineSegmentsGeometry();
		geometry.setPositions(positions);
		geometry.instanceCount = 0;

		const haloMaterial = new LineMaterial({
			color,
			linewidth: haloWidth,
			transparent: true,
			opacity: haloOpacity,
			depthTest: false,
			blending: THREE.AdditiveBlending,
		});
		haloMaterial.resolution.copy(rendererSize);

		const coreMaterial = new LineMaterial({
			color,
			linewidth: coreWidth,
			transparent: true,
			opacity: coreOpacity,
			depthTest: false,
			blending: THREE.AdditiveBlending,
		});
		coreMaterial.resolution.copy(rendererSize);

		const halo = new LineSegments2(geometry, haloMaterial);
		halo.renderOrder = 1;
		halo.visible = false;
		halo.frustumCulled = false;

		const core = new LineSegments2(geometry, coreMaterial);
		core.renderOrder = 1;
		core.visible = false;
		core.frustumCulled = false;

		return { geometry, positions, haloMaterial, coreMaterial, halo, core };
	}

	function updateDynamicLinePair(pair: DynamicLinePair, segmentCount: number) {
		pair.geometry.instanceCount = segmentCount;
		const instanceStart = pair.geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute | undefined;
		const instanceEnd = pair.geometry.attributes.instanceEnd as THREE.InterleavedBufferAttribute | undefined;
		if (instanceStart) instanceStart.data.needsUpdate = true;
		if (instanceEnd) instanceEnd.data.needsUpdate = true;
		const visible = segmentCount > 0;
		pair.halo.visible = visible;
		pair.core.visible = visible;
	}

	interface DynamicPointCloud {
		geometry: THREE.BufferGeometry;
		attribute: THREE.BufferAttribute;
		positions: Float32Array;
		points: THREE.Points;
	}

	function createDynamicPointCloud(material: THREE.Material, maxPoints: number, renderOrder: number) {
		const positions = new Float32Array(Math.max(1, maxPoints) * 3);
		const attribute = new THREE.Float32BufferAttribute(positions, 3);
		attribute.setUsage(THREE.DynamicDrawUsage);
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', attribute);
		geometry.setDrawRange(0, 0);

		const points = new THREE.Points(geometry, material);
		points.renderOrder = renderOrder;
		points.visible = false;
		points.frustumCulled = false;

		return { geometry, attribute, positions, points };
	}

	function updateDynamicPointCloud(cloud: DynamicPointCloud, pointCount: number) {
		cloud.geometry.setDrawRange(0, pointCount);
		cloud.attribute.needsUpdate = true;
		cloud.points.visible = pointCount > 0;
	}

	// --- Draggable constellation vertices ---
	let currentResults: MatchResult[] = [];
	let currentColors: string[] = [];
	let dragState: {
		active: boolean;
		constellationIndex: number;
		nodeIndex: number;
		startMouse: { x: number; y: number };
		committed: boolean; // true once mouse moves past threshold
		candidateStar: Star | null;
		dragGroup: THREE.Group | null;
	} | null = null;
	const DRAG_COMMIT_THRESHOLD = 5; // pixels before drag starts
	const VERTEX_PICK_THRESHOLD = 25; // pixels to pick a constellation vertex
	const STAR_PICK_THRESHOLD = 50;
	const STAR_HOVER_THRESHOLD = 40;
	const STAR_PICK_CELL_PX = 64;
	const STAR_PICK_MARGIN_PX = 64;
	let starPositionData: Float32Array | null = null;
	let starScreenX = new Float32Array(0);
	let starScreenY = new Float32Array(0);
	let starScreenVisible = new Uint8Array(0);
	let starGridNext = new Int32Array(0);
	let starGridHeads = new Int32Array(0);
	let starGridCols = 1;
	let starGridRows = 1;
	const starProjectionVector = new THREE.Vector3();

	function ensureStarProjectionCache(count: number, width: number, height: number) {
		if (starScreenX.length !== count) {
			starScreenX = new Float32Array(count);
			starScreenY = new Float32Array(count);
			starScreenVisible = new Uint8Array(count);
			starGridNext = new Int32Array(count);
		}

		const cols = Math.max(1, Math.ceil(width / STAR_PICK_CELL_PX));
		const rows = Math.max(1, Math.ceil(height / STAR_PICK_CELL_PX));
		if (starGridHeads.length !== cols * rows) {
			starGridHeads = new Int32Array(cols * rows);
		}
		starGridCols = cols;
		starGridRows = rows;
	}

	function updateStarProjectionCache(camera: THREE.PerspectiveCamera, width: number, height: number) {
		if (!starPositionData) return;
		const count = starPositionData.length / 3;
		ensureStarProjectionCache(count, width, height);
		starGridHeads.fill(-1);

		for (let i = 0; i < count; i++) {
			const base = i * 3;
			starProjectionVector.set(
				starPositionData[base],
				starPositionData[base + 1],
				starPositionData[base + 2]
			).project(camera);

			if (starProjectionVector.z > 1) {
				starScreenVisible[i] = 0;
				starGridNext[i] = -1;
				continue;
			}

			const sx = (starProjectionVector.x * 0.5 + 0.5) * width;
			const sy = (-starProjectionVector.y * 0.5 + 0.5) * height;

			if (!Number.isFinite(sx) || !Number.isFinite(sy)) {
				starScreenVisible[i] = 0;
				starGridNext[i] = -1;
				continue;
			}

			starScreenX[i] = sx;
			starScreenY[i] = sy;

			const inRange = sx >= -STAR_PICK_MARGIN_PX
				&& sx <= width + STAR_PICK_MARGIN_PX
				&& sy >= -STAR_PICK_MARGIN_PX
				&& sy <= height + STAR_PICK_MARGIN_PX;
			if (!inRange) {
				starScreenVisible[i] = 0;
				starGridNext[i] = -1;
				continue;
			}

			starScreenVisible[i] = 1;
			const clampedX = Math.min(Math.max(sx, 0), Math.max(0, width - 1));
			const clampedY = Math.min(Math.max(sy, 0), Math.max(0, height - 1));
			const col = Math.min(starGridCols - 1, Math.floor(clampedX / STAR_PICK_CELL_PX));
			const row = Math.min(starGridRows - 1, Math.floor(clampedY / STAR_PICK_CELL_PX));
			const bucket = row * starGridCols + col;
			starGridNext[i] = starGridHeads[bucket];
			starGridHeads[bucket] = i;
		}
	}

	// Build a spatial index for fast star lookup by screen position
	function findNearestStarToScreen(
		mx: number, my: number, camera: THREE.PerspectiveCamera,
		w: number, h: number, excludeIdx?: number, threshold = STAR_PICK_THRESHOLD
	): Star | null {
		if (!starPositionData || stars.length === 0) return null;
		if (starGridHeads.length === 0) updateStarProjectionCache(camera, w, h);

		const thresholdSq = threshold * threshold;
		let bestDistSq = thresholdSq;
		let bestStarIdx = -1;
		const minCol = Math.max(0, Math.floor((mx - threshold) / STAR_PICK_CELL_PX));
		const maxCol = Math.min(starGridCols - 1, Math.floor((mx + threshold) / STAR_PICK_CELL_PX));
		const minRow = Math.max(0, Math.floor((my - threshold) / STAR_PICK_CELL_PX));
		const maxRow = Math.min(starGridRows - 1, Math.floor((my + threshold) / STAR_PICK_CELL_PX));

		for (let row = minRow; row <= maxRow; row++) {
			for (let col = minCol; col <= maxCol; col++) {
				let starIdx = starGridHeads[row * starGridCols + col];
				while (starIdx !== -1) {
					if (starScreenVisible[starIdx]) {
						const star = stars[starIdx];
						if (excludeIdx === undefined || star.idx !== excludeIdx) {
							const dx = starScreenX[starIdx] - mx;
							const dy = starScreenY[starIdx] - my;
							const distSq = dx * dx + dy * dy;
							if (distSq < bestDistSq) {
								bestDistSq = distSq;
								bestStarIdx = starIdx;
							}
						}
					}
					starIdx = starGridNext[starIdx];
				}
			}
		}

		return bestStarIdx >= 0 ? stars[bestStarIdx] : null;
	}

	function findPickedVertex(
		mx: number, my: number, camera: THREE.PerspectiveCamera,
		w: number, h: number
	): { constellationIndex: number; nodeIndex: number; star: Star } | null {
		const projected = new THREE.Vector3();
		const thresholdSq = VERTEX_PICK_THRESHOLD * VERTEX_PICK_THRESHOLD;
		let bestDistSq = thresholdSq;
		let bestPick: { constellationIndex: number; nodeIndex: number; star: Star } | null = null;
		for (let ci = 0; ci < currentResults.length; ci++) {
			const result = currentResults[ci];
			for (const pair of result.pairs) {
				projected.copy(raDecToXYZ(pair.star.ra, pair.star.dec).multiplyScalar(0.999));
				projected.project(camera);
				if (projected.z > 1) continue;
				const sx = (projected.x * 0.5 + 0.5) * w;
				const sy = (-projected.y * 0.5 + 0.5) * h;
				const dx = sx - mx;
				const dy = sy - my;
				const distSq = dx * dx + dy * dy;
				if (distSq < bestDistSq) {
					bestDistSq = distSq;
					bestPick = { constellationIndex: ci, nodeIndex: pair.nodeIndex, star: pair.star };
				}
			}
		}
		return bestPick;
	}

	function updateDragVisual(candidateStar: Star | null) {
		if (!dragState || !sceneRef) return;

		// Remove old drag visual
		if (dragState.dragGroup) {
			disposeObject3D(dragState.dragGroup);
			dragState.dragGroup = null;
		}
		if (!candidateStar) return;

		const result = currentResults[dragState.constellationIndex];
		if (!result) return;

		const group = new THREE.Group();
		const candidatePos = raDecToXYZ(candidateStar.ra, candidateStar.dec).multiplyScalar(0.999);

		// Draw lines from candidate to neighbor vertices
		const neighbors: THREE.Vector3[] = [];
		for (const [nA, nB] of result.graph.edges) {
			let neighborIdx = -1;
			if (nA === dragState.nodeIndex) neighborIdx = nB;
			else if (nB === dragState.nodeIndex) neighborIdx = nA;
			if (neighborIdx < 0) continue;
			const neighborPair = result.pairs.find(p => p.nodeIndex === neighborIdx);
			if (neighborPair) {
				neighbors.push(raDecToXYZ(neighborPair.star.ra, neighborPair.star.dec).multiplyScalar(0.999));
			}
		}

		if (neighbors.length > 0) {
			const linePositions: number[] = [];
			for (const nPos of neighbors) {
				linePositions.push(candidatePos.x, candidatePos.y, candidatePos.z, nPos.x, nPos.y, nPos.z);
			}
			const segGeom = new LineSegmentsGeometry();
			segGeom.setPositions(linePositions);

			const previewMat = new LineMaterial({
				color: 0xffd700,
				linewidth: 3,
				transparent: true,
				opacity: 0.35,
				depthTest: false,
				blending: THREE.AdditiveBlending,
				dashed: true,
				dashSize: 0.003,
				gapSize: 0.003,
			});
			previewMat.resolution.copy(rendererSize);
			const previewLines = new LineSegments2(segGeom, previewMat);
			previewLines.computeLineDistances();
			previewLines.renderOrder = 3;
			group.add(previewLines);
		}

		// Highlight candidate star with a bright dot
		const hlGeom = new THREE.BufferGeometry();
		hlGeom.setAttribute('position', new THREE.Float32BufferAttribute([candidatePos.x, candidatePos.y, candidatePos.z], 3));
		const hlMat = new THREE.ShaderMaterial({
			vertexShader: `
				void main() {
					vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
					gl_Position = projectionMatrix * mvPosition;
					gl_PointSize = 18.0;
				}
			`,
			fragmentShader: `
				void main() {
					float d = length(gl_PointCoord - 0.5) * 2.0;
					if (d > 1.0) discard;
					float alpha = exp(-d * d * 3.0) * 0.95;
					vec3 color = vec3(1.0, 0.84, 0.0);
					gl_FragColor = vec4(color * alpha, alpha);
				}
			`,
			transparent: true,
			depthTest: false,
			blending: THREE.AdditiveBlending,
		});
		const hlPoints = new THREE.Points(hlGeom, hlMat);
		hlPoints.renderOrder = 4;
		group.add(hlPoints);

		sceneRef.add(group);
		dragState.dragGroup = group;
	}

	// --- Named star labels ---
	let starLabelsActive = false;
	let starLabelData: { label: Text; pos: THREE.Vector3; mag: number }[] = [];
	const STAR_LABEL_MAG_LIMIT = 4.0; // Only label stars brighter than this

	// --- Coordinate grid (RA/Dec) ---
	let coordGridActive = $state(false);
	let coordGridGroup: THREE.Group | null = null;
	let coordGridLabels: Text[] = [];
	let cameraHeading = $state({ ra: '', dec: '' });

	// --- Shooting stars (meteors) ---
	interface Meteor {
		head: THREE.Vector3;       // current head position on unit sphere
		axis: THREE.Vector3;       // rotation axis (cross product of start pos and direction)
		speed: number;             // radians per second
		lifetime: number;          // total lifetime in seconds
		elapsed: number;           // time elapsed
		brightness: number;        // 0-1 peak brightness
		trailLength: number;       // angular trail length in radians
		mesh: THREE.Line;
	}

	const MAX_METEORS = 10;
	const METEOR_TRAIL_POINTS = 20;
	let activeMeteors: Meteor[] = [];
	let meteorTimerId: ReturnType<typeof setTimeout> | null = null;
	let meteorsEnabled = true;
	let meteorGroup: THREE.Group | null = null;

	function spawnMeteor() {
		if (!meteorsEnabled || !sceneRef || !cameraRef || activeMeteors.length >= MAX_METEORS) {
			scheduleMeteor();
			return;
		}

		// Camera forward direction
		const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(cameraRef.quaternion).normalize();

		// Random point in visible hemisphere (dot with camera forward > 0.1)
		let startPos: THREE.Vector3;
		let attempts = 0;
		do {
			startPos = new THREE.Vector3(
				Math.random() * 2 - 1,
				Math.random() * 2 - 1,
				Math.random() * 2 - 1
			).normalize();
			attempts++;
		} while (startPos.dot(camForward) < 0.1 && attempts < 20);

		if (startPos.dot(camForward) < 0.1) {
			scheduleMeteor();
			return;
		}

		// Random tangent direction on the sphere surface
		const randomDir = new THREE.Vector3(
			Math.random() * 2 - 1,
			Math.random() * 2 - 1,
			Math.random() * 2 - 1
		).normalize();
		// Project onto tangent plane and normalize
		const tangent = randomDir.sub(startPos.clone().multiplyScalar(randomDir.dot(startPos))).normalize();

		// Rotation axis: cross product of start position and tangent
		const axis = new THREE.Vector3().crossVectors(startPos, tangent).normalize();

		// Meteor properties — most are faint, occasional bright ones
		const isBright = Math.random() < 0.2;
		const brightness = isBright ? 0.6 + Math.random() * 0.4 : 0.15 + Math.random() * 0.25;
		const speed = (0.27 + Math.random() * 0.5); // radians per second (3x slower)
		const lifetime = 0.9 + Math.random() * 1.5; // 0.9-2.4 seconds (3x longer)
		const trailLength = 0.03 + Math.random() * 0.04; // angular trail length

		// Create trail geometry with vertex colors for fading
		const positions = new Float32Array(METEOR_TRAIL_POINTS * 3);
		const colors = new Float32Array(METEOR_TRAIL_POINTS * 4);

		const geom = new THREE.BufferGeometry();
		geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
		geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));

		const mat = new THREE.LineBasicMaterial({
			vertexColors: true,
			transparent: true,
			depthTest: false,
			blending: THREE.AdditiveBlending,
		});

		const line = new THREE.Line(geom, mat);
		line.renderOrder = 3;
		meteorGroup!.add(line);

		const meteor: Meteor = {
			head: startPos.clone(),
			axis,
			speed,
			lifetime,
			elapsed: 0,
			brightness,
			trailLength,
			mesh: line,
		};

		activeMeteors.push(meteor);
		scheduleMeteor();
	}

	function scheduleMeteor() {
		if (!meteorsEnabled || meteorTimerId !== null) return;
		const delay = 200 + Math.random() * 400; // ~200-600ms
		meteorTimerId = setTimeout(() => {
			meteorTimerId = null;
			spawnMeteor();
		}, delay);
	}

	function updateMeteors(dt: number) {
		for (let i = activeMeteors.length - 1; i >= 0; i--) {
			const m = activeMeteors[i];
			m.elapsed += dt;

			if (m.elapsed >= m.lifetime) {
				// Remove expired meteor
				meteorGroup?.remove(m.mesh);
				m.mesh.geometry.dispose();
				(m.mesh.material as THREE.Material).dispose();
				activeMeteors.splice(i, 1);
				continue;
			}

			const progress = m.elapsed / m.lifetime;
			const headAngle = m.elapsed * m.speed;

			// Fade: ramp up quickly, then fade out
			const fadeMult = progress < 0.15
				? progress / 0.15
				: 1.0 - Math.pow((progress - 0.15) / 0.85, 0.6);

			const posAttr = m.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
			const colAttr = m.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;

			for (let p = 0; p < METEOR_TRAIL_POINTS; p++) {
				const t = p / (METEOR_TRAIL_POINTS - 1); // 0 = tail, 1 = head
				const angle = headAngle - m.trailLength * (1 - t);

				// Rotate start position around axis by angle (great circle arc)
				const point = m.head.clone().applyAxisAngle(m.axis, angle);

				posAttr.setXYZ(p, point.x * 0.998, point.y * 0.998, point.z * 0.998);

				// Color: blue-white tint, fading along trail
				const trailFade = Math.pow(t, 2.0); // quadratic fade from tail to head
				const alpha = trailFade * fadeMult * m.brightness;
				// Slight blue-white: (0.85, 0.9, 1.0)
				colAttr.setXYZW(p, 0.85 * alpha, 0.9 * alpha, 1.0 * alpha, alpha);
			}

			posAttr.needsUpdate = true;
			colAttr.needsUpdate = true;
		}
	}

	function stopMeteors() {
		meteorsEnabled = false;
		if (meteorTimerId !== null) {
			clearTimeout(meteorTimerId);
			meteorTimerId = null;
		}
		// Remove active meteors
		for (const m of activeMeteors) {
			meteorGroup?.remove(m.mesh);
			m.mesh.geometry.dispose();
			(m.mesh.material as THREE.Material).dispose();
		}
		activeMeteors = [];
	}

	function resumeMeteors() {
		if (meteorsEnabled) return;
		meteorsEnabled = true;
		scheduleMeteor();
	}

	// --- Comets with shuttlecock-shaped ice trails ---
	// Single triangle-strip mesh per comet — no separate head spheres.
	// The head is just the brightest, narrowest point of the strip.
	interface CometDustParticle {
		pos: THREE.Vector3;       // current position on sphere
		drift: THREE.Vector3;     // velocity (tangent to sphere)
		life: number;             // remaining life (seconds)
		maxLife: number;          // initial life
	}

	interface Comet {
		startPos: THREE.Vector3;   // initial position on unit sphere
		axis: THREE.Vector3;       // great-circle rotation axis
		speed: number;
		lifetime: number;
		elapsed: number;
		brightness: number;
		trailLength: number;
		color: THREE.Color;
		mesh: THREE.Mesh;
		size: number;
		perpAxis: THREE.Vector3;
		// Dust particle system
		dustPoints: THREE.Points;
		dustParticles: CometDustParticle[];
		dustSpawnTimer: number;
	}

	const MAX_COMETS = 4;
	const COMET_SPINE = 48;
	const MAX_DUST_PER_COMET = 40;
	let activeComets: Comet[] = [];
	let cometTimerId: ReturnType<typeof setTimeout> | null = null;
	let cometsEnabled = true;
	let cometGroup: THREE.Group | null = null;

	const COMET_COLORS = [
		new THREE.Color(0.5, 0.7, 1.0),    // bright blue
		new THREE.Color(0.3, 0.9, 1.0),    // vivid cyan
		new THREE.Color(0.9, 0.3, 1.0),    // magenta-violet
		new THREE.Color(0.6, 0.4, 1.0),    // blue-purple
		new THREE.Color(0.2, 1.0, 0.5),    // vivid emerald
		new THREE.Color(0.3, 1.0, 0.9),    // bright teal
		new THREE.Color(1.0, 0.3, 0.8),    // hot pink
	];

	function spawnComet() {
		if (!cometsEnabled || !sceneRef || !cameraRef || activeComets.length >= MAX_COMETS) {
			scheduleComet();
			return;
		}

		const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(cameraRef.quaternion).normalize();

		let startPos: THREE.Vector3;
		let attempts = 0;
		do {
			startPos = new THREE.Vector3(
				Math.random() * 2 - 1,
				Math.random() * 2 - 1,
				Math.random() * 2 - 1
			).normalize();
			attempts++;
		} while (startPos.dot(camForward) < 0.1 && attempts < 20);

		if (startPos.dot(camForward) < 0.1) {
			scheduleComet();
			return;
		}

		const randomDir = new THREE.Vector3(
			Math.random() * 2 - 1,
			Math.random() * 2 - 1,
			Math.random() * 2 - 1
		).normalize();
		const tangent = randomDir.sub(startPos.clone().multiplyScalar(randomDir.dot(startPos))).normalize();
		const axis = new THREE.Vector3().crossVectors(startPos, tangent).normalize();

		// perpAxis must be perpendicular to the travel direction AND lie on the sphere.
		// tangent is our travel direction on the sphere; startPos is the radial.
		// So perpAxis = tangent × startPos gives us the lateral spread direction.
		const perpAxis = new THREE.Vector3().crossVectors(tangent, startPos).normalize();

		const color = COMET_COLORS[Math.floor(Math.random() * COMET_COLORS.length)];
		const brightness = 0.5 + Math.random() * 0.4;
		const speed = 0.02 + Math.random() * 0.06;
		const lifetime = 5 + Math.random() * 5;
		const trailLength = 0.03 + Math.random() * 0.05;
		const size = 0.6 + Math.random() * 1.2;

		// Build triangle strip geometry
		const vertCount = COMET_SPINE * 2;
		const positions = new Float32Array(vertCount * 3);
		const colors = new Float32Array(vertCount * 4);
		const indexCount = (COMET_SPINE - 1) * 6;
		const indices = new Uint16Array(indexCount);
		for (let i = 0; i < COMET_SPINE - 1; i++) {
			const base = i * 6;
			const v = i * 2;
			indices[base]     = v;
			indices[base + 1] = v + 1;
			indices[base + 2] = v + 2;
			indices[base + 3] = v + 1;
			indices[base + 4] = v + 3;
			indices[base + 5] = v + 2;
		}

		const geom = new THREE.BufferGeometry();
		geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
		geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
		geom.setIndex(new THREE.BufferAttribute(indices, 1));

		const mat = new THREE.MeshBasicMaterial({
			vertexColors: true,
			transparent: true,
			depthTest: false,
			blending: THREE.AdditiveBlending,
			side: THREE.DoubleSide,
		});
		const mesh = new THREE.Mesh(geom, mat);
		mesh.frustumCulled = false;
		mesh.renderOrder = 3;
		cometGroup!.add(mesh);

		// Dust particle system — scattered particles trailing behind the comet
		const dustPositions = new Float32Array(MAX_DUST_PER_COMET * 3);
		const dustColors = new Float32Array(MAX_DUST_PER_COMET * 4);
		const dustGeom = new THREE.BufferGeometry();
		dustGeom.setAttribute('position', new THREE.Float32BufferAttribute(dustPositions, 3));
		dustGeom.setAttribute('color', new THREE.Float32BufferAttribute(dustColors, 4));
		const dustMat = new THREE.PointsMaterial({
			size: 1.5,
			sizeAttenuation: false,
			vertexColors: true,
			transparent: true,
			depthTest: false,
			blending: THREE.AdditiveBlending,
		});
		const dustPoints = new THREE.Points(dustGeom, dustMat);
		dustPoints.frustumCulled = false;
		dustPoints.renderOrder = 2;
		cometGroup!.add(dustPoints);

		activeComets.push({
			startPos: startPos.clone(),
			axis, speed, lifetime, elapsed: 0,
			brightness, trailLength, color,
			mesh, size, perpAxis,
			dustPoints, dustParticles: [], dustSpawnTimer: 0,
		});
		scheduleComet();
	}

	function scheduleComet() {
		if (!cometsEnabled || cometTimerId !== null) return;
		const delay = 2000 + Math.random() * 4000;
		cometTimerId = setTimeout(() => {
			cometTimerId = null;
			spawnComet();
		}, delay);
	}

	const _cometPt = new THREE.Vector3();
	const _cometPp = new THREE.Vector3();

	function updateComets(dt: number) {
		for (let i = activeComets.length - 1; i >= 0; i--) {
			const c = activeComets[i];
			c.elapsed += dt;

			if (c.elapsed >= c.lifetime) {
				cometGroup?.remove(c.mesh);
				c.mesh.geometry.dispose();
				(c.mesh.material as THREE.Material).dispose();
				cometGroup?.remove(c.dustPoints);
				c.dustPoints.geometry.dispose();
				(c.dustPoints.material as THREE.Material).dispose();
				activeComets.splice(i, 1);
				continue;
			}

			const progress = c.elapsed / c.lifetime;
			const headAngle = c.elapsed * c.speed;

			// Fade in over first 8%, fade out over last 15%
			const fadeMult = progress < 0.08
				? progress / 0.08
				: progress > 0.85
					? 1.0 - (progress - 0.85) / 0.15
					: 1.0;

			const posAttr = c.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
			const colAttr = c.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;

			// Narrow tail width — more like a line than a ribbon
			const maxHalfWidth = 0.003 * c.size;

			for (let p = 0; p < COMET_SPINE; p++) {
				// t: 0 = tail tip, 1 = head
				const t = p / (COMET_SPINE - 1);
				const angle = headAngle - c.trailLength * (1 - t);

				// Spine point on the great circle
				_cometPt.copy(c.startPos).applyAxisAngle(c.axis, angle).multiplyScalar(0.997);

				// Width: narrow throughout, slightly wider near middle, pinched at both ends
				const widthT = 1.0 - t; // 0 at head, 1 at tail
				const taper = Math.sin(t * Math.PI); // 0 at both ends, 1 in middle
				const headPinch = Math.pow(1.0 - t, 0.3); // stays wide, narrows at head
				const halfWidth = maxHalfWidth * taper * headPinch;

				// Perpendicular offset (rotate perpAxis along the great circle)
				_cometPp.copy(c.perpAxis).applyAxisAngle(c.axis, angle);

				const li = p * 2;
				posAttr.setXYZ(li,
					_cometPt.x + _cometPp.x * halfWidth,
					_cometPt.y + _cometPp.y * halfWidth,
					_cometPt.z + _cometPp.z * halfWidth
				);
				posAttr.setXYZ(li + 1,
					_cometPt.x - _cometPp.x * halfWidth,
					_cometPt.y - _cometPp.y * halfWidth,
					_cometPt.z - _cometPp.z * halfWidth
				);

				// Nucleus: very bright tight white point at head
				const nucleusGlow = Math.pow(t, 8.0);    // very concentrated at head tip
				// Coma: softer glow just behind nucleus
				const comaGlow = Math.pow(t, 3.0) * 0.4;
				// Ion tail: colored, transparent, fading toward tip
				const tipCutoff = Math.pow(Math.min(1, p / 3), 2.0);
				const tailAlpha = Math.pow(t, 0.8) * tipCutoff * 0.25;

				const fm = fadeMult * c.brightness;

				// Nucleus is white, coma is tinted, tail is saturated color
				const nr = nucleusGlow * fm * 0.8;  // white nucleus
				const tr = c.color.r * tailAlpha * fm;  // colored tail
				const comr = (c.color.r * 0.5 + 0.5) * comaGlow * fm;  // tinted coma

				const ng = nucleusGlow * fm * 0.8;
				const tg = c.color.g * tailAlpha * fm;
				const comg = (c.color.g * 0.5 + 0.5) * comaGlow * fm;

				const nb = nucleusGlow * fm * 0.8;
				const tb = c.color.b * tailAlpha * fm;
				const comb = (c.color.b * 0.5 + 0.5) * comaGlow * fm;

				const cr = nr + comr + tr;
				const cg = ng + comg + tg;
				const cb = nb + comb + tb;
				const totalAlpha = (nucleusGlow * 0.9 + comaGlow + tailAlpha) * fm;

				colAttr.setXYZW(li, cr, cg, cb, totalAlpha);
				colAttr.setXYZW(li + 1, cr, cg, cb, totalAlpha);
			}

			posAttr.needsUpdate = true;
			colAttr.needsUpdate = true;

			// --- Dust particles ---
			// Spawn new dust particles at the comet head
			c.dustSpawnTimer += dt;
			const spawnInterval = 0.06; // ~16 particles/sec
			while (c.dustSpawnTimer >= spawnInterval && c.dustParticles.length < MAX_DUST_PER_COMET) {
				c.dustSpawnTimer -= spawnInterval;
				// Current head position
				const headPos = c.startPos.clone().applyAxisAngle(c.axis, headAngle).normalize();
				// Tangent at head (direction of travel)
				const headTangent = new THREE.Vector3().crossVectors(c.axis, headPos).normalize();
				// Perpendicular on sphere
				const headPerp = new THREE.Vector3().crossVectors(headTangent, headPos).normalize();
				// Drift: opposite travel direction + random lateral spread
				const driftSpeed = 0.003 + Math.random() * 0.005;
				const lateralSpread = (Math.random() - 0.5) * 0.006;
				const drift = headTangent.multiplyScalar(-driftSpeed).add(headPerp.multiplyScalar(lateralSpread));
				const life = 1.5 + Math.random() * 2.5;
				c.dustParticles.push({
					pos: headPos.multiplyScalar(0.996),
					drift,
					life,
					maxLife: life,
				});
			}

			// Update dust particles
			const dustPosAttr = c.dustPoints.geometry.getAttribute('position') as THREE.BufferAttribute;
			const dustColAttr = c.dustPoints.geometry.getAttribute('color') as THREE.BufferAttribute;

			for (let d = c.dustParticles.length - 1; d >= 0; d--) {
				const dp = c.dustParticles[d];
				dp.life -= dt;
				if (dp.life <= 0) {
					c.dustParticles.splice(d, 1);
					continue;
				}
				// Move particle and re-project onto sphere surface
				dp.pos.add(_cometPt.copy(dp.drift).multiplyScalar(dt));
				dp.pos.normalize().multiplyScalar(0.996);
			}

			// Write dust particle positions and colors into buffers
			for (let d = 0; d < MAX_DUST_PER_COMET; d++) {
				if (d < c.dustParticles.length) {
					const dp = c.dustParticles[d];
					const alpha = (dp.life / dp.maxLife) * 0.3 * fadeMult * c.brightness;
					dustPosAttr.setXYZ(d, dp.pos.x, dp.pos.y, dp.pos.z);
					dustColAttr.setXYZW(d,
						c.color.r * 0.6 + 0.4,  // slightly pale tint
						c.color.g * 0.6 + 0.4,
						c.color.b * 0.6 + 0.4,
						alpha
					);
				} else {
					// Hide unused particles
					dustPosAttr.setXYZ(d, 0, 0, 0);
					dustColAttr.setXYZW(d, 0, 0, 0, 0);
				}
			}
			dustPosAttr.needsUpdate = true;
			dustColAttr.needsUpdate = true;
		}
	}

	function stopComets() {
		cometsEnabled = false;
		if (cometTimerId !== null) {
			clearTimeout(cometTimerId);
			cometTimerId = null;
		}
		for (const c of activeComets) {
			cometGroup?.remove(c.mesh);
			c.mesh.geometry.dispose();
			(c.mesh.material as THREE.Material).dispose();
			cometGroup?.remove(c.dustPoints);
			c.dustPoints.geometry.dispose();
			(c.dustPoints.material as THREE.Material).dispose();
		}
		activeComets = [];
	}

	function resumeComets() {
		if (cometsEnabled) return;
		cometsEnabled = true;
		scheduleComet();
	}

	// Ambient constellation cycling
	interface AmbientConstellation {
		name: string;
		group: THREE.Group;
		label: Text;
		edges: { posA: THREE.Vector3; posB: THREE.Vector3 }[];
		hlPositions: THREE.Vector3[];
		centroid: THREE.Vector3;
		startTime: number;
		phase: 'draw' | 'hold' | 'fade';
		phaseStart: number;
		totalDrawTime: number;
		animId: number | null;
	}
	let ambientConstellations: AmbientConstellation[] = [];
	let ambientQueue: number[] = [];
	let ambientTimerIds = new Set<ReturnType<typeof setTimeout>>();
	let ambientPaused = false;
	type StarUniforms = {
		uDim: THREE.Uniform<number>;
		uTime: THREE.Uniform<number>;
		uFovScale: THREE.Uniform<number>;
		uHoveredIndex: THREE.Uniform<number>;
		uBrightness: THREE.Uniform<number>;
		uMonochrome: THREE.Uniform<number>;
		uShowSun: THREE.Uniform<number>;
	};

	let uniformsRef: StarUniforms | null = null;
	const DEFAULT_FOV = 90;
	const GLOBE_DISTANCE = 3.0;
	// Fixed FOV that frames the full sphere with some breathing room at GLOBE_DISTANCE
	// Use a wider FOV on mobile (portrait) so the globe doesn't feel cramped
	const GLOBE_FOV_DESKTOP = 40;
	const GLOBE_FOV_MOBILE = 55;
	function getGlobeFov() {
		return (typeof window !== 'undefined' && window.innerWidth <= 480)
			? GLOBE_FOV_MOBILE : GLOBE_FOV_DESKTOP;
	}

	let rendererSize = new THREE.Vector2(1, 1);
	let globeViewActive = false;

	// --- Globe view transition ---
	let globeTransitionId: number | null = null;
	let globeTransitionActive = false;
	let globeTransitionFovOverride = false;
	let globeTransitionRestore: { enableRotate: boolean } | null = null;
	let overlayLabelGlobeViewActive = false;
	let overlayLabelTransitionOpacity = 1;
	let cameraAnimationId: number | null = null;
	let cameraAnimationToken = 0;

	// --- Auto-rotate (landing page drift) ---
	let autoRotateActive = !reducedMotion;

	// Touch support state
	let pinchStartDist = 0;
	let pinchStartFov = DEFAULT_FOV;

	type ConstellationDisplayMode = 'ambient' | 'all' | 'none';

	// IAU overlay / ambient display mode
	let constellationDisplayMode: ConstellationDisplayMode = 'ambient';
	let iauOverlayGroup: THREE.Group | null = null;
	let iauLabelData: { label: Text; centroid: THREE.Vector3 }[] = [];

	const LABEL_FONT_SIZE = 13;
	const LABEL_LETTER_SPACING = 0.12;
	const LABEL_OUTLINE_COLOR = 0x05070d;
	const LABEL_OUTLINE_WIDTH = '8%';
	const LABEL_OUTLINE_BLUR = '35%';
	const AMBIENT_LABEL_OFFSET = 30;

	function createOverlayLabel(text: string): Text {
		const label = new Text();
		label.text = text.toUpperCase();
		label.anchorX = 'center';
		label.anchorY = 'middle';
		label.fontSize = LABEL_FONT_SIZE;
		label.letterSpacing = LABEL_LETTER_SPACING;
		label.color = 0xffffff;
		label.fillOpacity = 0;
		label.outlineColor = LABEL_OUTLINE_COLOR;
		label.outlineWidth = LABEL_OUTLINE_WIDTH;
		label.outlineBlur = LABEL_OUTLINE_BLUR;
		label.outlineOpacity = 0;
		label.sdfGlyphSize = 128;
		label.frustumCulled = false;
		label.renderOrder = 10;
		label.position.z = 0;
		overlaySceneRef?.add(label);
		label.sync();
		return label;
	}

	function disposeOverlayLabel(label: Text) {
		disposeTextLabel(label);
	}

	function setOverlayLabelOpacity(label: Text, opacity: number) {
		const clamped = Math.max(0, Math.min(1, opacity));
		label.visible = clamped > 0.001;
		label.fillOpacity = clamped;
		label.outlineOpacity = Math.min(1, clamped * 0.95);
	}

	function updateOverlayLabelPosition(label: Text, worldPos: THREE.Vector3, offsetY: number) {
		if (!cameraRef || !container) return false;
		const width = container.clientWidth;
		const height = container.clientHeight;
		projectedLabelPos.copy(worldPos).project(cameraRef);
		if (projectedLabelPos.z >= 1) return false;

		const sx = (projectedLabelPos.x * 0.5 + 0.5) * width;
		const sy = (-projectedLabelPos.y * 0.5 + 0.5) * height;
		label.position.set(sx - width * 0.5, height * 0.5 - sy + offsetY, 0);
		return true;
	}

	function updateOverlayLabels(now: number) {
		if (!cameraRef || !container) return;

		cameraRef.getWorldDirection(overlayCameraDir);
		// In globe mode the camera looks inward, so flip the direction
		// so that dot-product visibility checks still work the same way.
		if (overlayLabelGlobeViewActive) overlayCameraDir.negate();
		const transitionOpacity = overlayLabelTransitionOpacity;

		for (const ac of ambientConstellations) {
			const phaseElapsed = now - ac.phaseStart;
			const labelOpacity = ac.phase === 'draw'
				? Math.max(0, (phaseElapsed - ac.totalDrawTime * 0.5) / (ac.totalDrawTime * 0.5))
				: ac.phase === 'hold' ? 1
				: 1 - phaseElapsed / AMBIENT_FADE;

			if (updateOverlayLabelPosition(ac.label, ac.centroid, AMBIENT_LABEL_OFFSET)) {
				setOverlayLabelOpacity(ac.label, labelOpacity * 0.85 * transitionOpacity);
			} else {
				setOverlayLabelOpacity(ac.label, 0);
			}
		}

		if (iauOverlayGroup) {
			for (const { label, centroid } of iauLabelData) {
				const dot = centroid.dot(overlayCameraDir);
				if (dot <= 0.2) {
					setOverlayLabelOpacity(label, 0);
					continue;
				}

				if (updateOverlayLabelPosition(label, centroid, 0)) {
					const fade = Math.min(1, (dot - 0.2) / 0.3);
					setOverlayLabelOpacity(label, fade * 0.6 * transitionOpacity);
				} else {
					setOverlayLabelOpacity(label, 0);
				}
			}
		}

		if (starLabelsActive) {
			for (const sl of starLabelData) {
				const dot = sl.pos.dot(overlayCameraDir);
				if (dot <= 0.15) {
					setOverlayLabelOpacity(sl.label, 0);
					continue;
				}
				if (updateOverlayLabelPosition(sl.label, sl.pos, -14)) {
					// Brighter stars (lower mag) get more opaque labels
					const magFade = Math.max(0.3, 1 - sl.mag / STAR_LABEL_MAG_LIMIT);
					const angleFade = Math.min(1, (dot - 0.15) / 0.3);
					setOverlayLabelOpacity(sl.label, angleFade * magFade * 0.75 * transitionOpacity);
				} else {
					setOverlayLabelOpacity(sl.label, 0);
				}
			}
		}

		if (coordGridActive) {
			for (const label of coordGridLabels) {
				const worldPos = (label as any)._gridWorldPos as THREE.Vector3;
				if (!worldPos) continue;
				const dot = worldPos.dot(overlayCameraDir);
				if (dot <= 0.1) {
					setOverlayLabelOpacity(label, 0);
					continue;
				}
				if (updateOverlayLabelPosition(label, worldPos, 0)) {
					const fade = Math.min(1, (dot - 0.1) / 0.3);
					setOverlayLabelOpacity(label, fade * 0.4 * transitionOpacity);
				} else {
					setOverlayLabelOpacity(label, 0);
				}
			}
		}

		// Star highlight label
		if (starHighlightLabel && (starHighlightLabel as any)._hlWorldPos) {
			const worldPos = (starHighlightLabel as any)._hlWorldPos as THREE.Vector3;
			if (updateOverlayLabelPosition(starHighlightLabel, worldPos, -20)) {
				setOverlayLabelOpacity(starHighlightLabel, 0.9 * transitionOpacity);
			} else {
				setOverlayLabelOpacity(starHighlightLabel, 0);
			}
		}

		// Temp constellation label
		if (tempConstellationLabel && (tempConstellationLabel as any)._tcCentroid) {
			const centroid = (tempConstellationLabel as any)._tcCentroid as THREE.Vector3;
			const dot = centroid.dot(overlayCameraDir);
			if (dot > 0.2 && updateOverlayLabelPosition(tempConstellationLabel, centroid, 0)) {
				setOverlayLabelOpacity(tempConstellationLabel, 0.7 * transitionOpacity);
			} else {
				setOverlayLabelOpacity(tempConstellationLabel, 0);
			}
		}
	}

	// Convert B-V color index to RGB using Ballesteros' formula (2012)
	// Maps stellar temperature to perceptually accurate color
	function bvToRGB(bv: number): [number, number, number] {
		// Clamp B-V to valid range
		bv = Math.max(-0.4, Math.min(2.0, bv));

		// Temperature from B-V (Ballesteros 2012)
		const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));

		// Planckian locus approximation to CIE xy, then to sRGB
		let r: number, g: number, b: number;

		// Red channel
		if (t >= 6600) {
			r = 1.29293618606 * Math.pow(t / 100 - 60, -0.1332047592);
		} else {
			r = 1.0;
		}

		// Green channel
		if (t >= 6600) {
			g = 1.12989086089 * Math.pow(t / 100 - 60, -0.0755148492);
		} else {
			g = 0.39008157876 * Math.log(t / 100) - 0.63184144378;
		}

		// Blue channel
		if (t >= 19000) {
			b = 1.0;
		} else if (t >= 2000) {
			b = 0.54320678911 * Math.log(t / 100 - 10) - 1.19625408914;
		} else {
			b = 0.0;
		}

		return [
			Math.max(0, Math.min(1, r)),
			Math.max(0, Math.min(1, g)),
			Math.max(0, Math.min(1, b))
		];
	}

	function raDecToXYZ(ra: number, dec: number): THREE.Vector3 {
		return new THREE.Vector3(
			Math.cos(dec) * Math.cos(ra),
			Math.sin(dec),
			-Math.cos(dec) * Math.sin(ra)
		);
	}

	// Vertex shader: pass star data to fragment shader
	const vertexShader = `
		attribute float aMag;
		attribute float aColorIndex;
		attribute float aIndex;
		attribute float aNamed;
		uniform float uFovScale;
		uniform float uHoveredIndex;
		uniform float uBrightness;
		varying float vMag;
		varying float vColorIndex;
		varying float vHover;
		varying float vNamed;
		varying float vSeed;

		uniform float uShowSun;

		void main() {
			vMag = aMag;
			vColorIndex = aColorIndex;
			vNamed = aNamed;
			vHover = (uHoveredIndex >= 0.0 && abs(aIndex - uHoveredIndex) < 0.5) ? 1.0 : 0.0;
			// Unique per-star seed derived from index
			vSeed = aIndex * 137.035999;

			vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
			gl_Position = projectionMatrix * mvPosition;

			// Hide the Sun when toggled off (only the Sun has mag < -10)
			if (aMag < -10.0 && uShowSun < 0.5) {
				gl_PointSize = 0.0;
				return;
			}

			// Apparent size based on magnitude (logarithmic flux)
			float flux = pow(10.0, -0.4 * (aMag - (-1.46)));
			float baseSize = 4.0 + 35.0 * pow(flux, 0.3);
			// Scale up as FOV decreases (zooming in)
			float hoverScale = 1.0 + vHover * 0.6;
			gl_PointSize = baseSize * uFovScale * hoverScale * uBrightness;
		}
	`;

	// Fragment shader: Airy-disk-like profile with color
	const fragmentShader = `
		uniform float uDim;
		uniform float uTime;
		uniform float uMonochrome;
		uniform float uBrightness;
		varying float vMag;
		varying float vColorIndex;
		varying float vHover;
		varying float vNamed;
		varying float vSeed;

		// B-V color index to RGB (Ballesteros 2012 approximation)
		// Exaggerated saturation for visual punch
		vec3 bvToColor(float bv) {
			bv = clamp(bv, -0.4, 2.0);
			float t = 4600.0 * (1.0 / (0.92 * bv + 1.7) + 1.0 / (0.92 * bv + 0.62));

			float r, g, b;

			if (t >= 6600.0) {
				r = 1.29293618606 * pow(t / 100.0 - 60.0, -0.1332047592);
			} else {
				r = 1.0;
			}

			if (t >= 6600.0) {
				g = 1.12989086089 * pow(t / 100.0 - 60.0, -0.0755148492);
			} else {
				g = 0.39008157876 * log(t / 100.0) - 0.63184144378;
			}

			if (t >= 19000.0) {
				b = 1.0;
			} else if (t >= 2000.0) {
				b = 0.54320678911 * log(t / 100.0 - 10.0) - 1.19625408914;
			} else {
				b = 0.0;
			}

			vec3 color = clamp(vec3(r, g, b), 0.0, 1.0);

			// Boost saturation: pull away from white
			vec3 gray = vec3(dot(color, vec3(0.299, 0.587, 0.114)));
			color = mix(gray, color, 2.2); // 2.2x saturation boost
			return clamp(color, 0.0, 1.0);
		}

		void main() {
			vec2 uv = gl_PointCoord - 0.5;
			float dist = length(uv);

			if (dist > 0.5) discard;

			float d = dist * 2.0;

			// Multi-layer radial profile
			float core = exp(-d * d * 8.0);
			float halo = exp(-d * d * 2.5) * 0.4;

			float flux = pow(10.0, -0.4 * (vMag - (-1.46)));
			float outerGlow = exp(-d * d * 1.0) * 0.12 * smoothstep(0.0, 0.4, pow(flux, 0.3));

			float profile = core + halo + outerGlow;

			// Star color from B-V index
			vec3 starColor = bvToColor(vColorIndex);
			starColor = mix(starColor, vec3(1.0), uMonochrome);

			// Slightly lighter core, colored halo
			vec3 coreColor = mix(starColor, vec3(1.0), 0.3);
			vec3 finalColor = mix(starColor, coreColor, core / max(profile, 0.001));

			// Overall brightness boost for dim stars
			float brightnessBoost = 1.0 + 0.3 * smoothstep(2.0, 6.5, vMag);

			float alpha = profile * uDim * brightnessBoost * uBrightness;

			// Hover: brighten the star while keeping its color
			alpha *= 1.0 + vHover * 1.2;
			finalColor = mix(finalColor, vec3(1.0), vHover * 0.1);

			// Scintillation
			if (vNamed > 0.5) {
				// Named stars: 20% multi-frequency twinkle
				float shimmer = 0.80
					+ 0.10 * (sin(uTime * 1.3 + vSeed) * 0.5 + 0.5)
					+ 0.06 * (sin(uTime * 3.1 + vSeed * 0.7) * 0.5 + 0.5)
					+ 0.04 * (sin(uTime * 6.7 + vSeed * 1.3) * 0.5 + 0.5);
				alpha *= shimmer;
			} else {
				// All other stars: 15% scintillation
				float seed = gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233;
				float rate = 2.0 + vMag * 0.5;
				alpha *= 0.85 + 0.15 * sin(uTime * rate + seed);
			}

			gl_FragColor = vec4(finalColor * alpha, alpha);
		}
	`;

	function clearAllConstellations() {
		for (const id of drawAnimationIds) {
			cancelAnimationFrame(id);
		}
		drawAnimationIds = [];
		for (const group of constellationGroups) {
			disposeObject3D(group);
		}
		constellationGroups = [];
		ringMaterials = [];
		currentResults = [];
		currentColors = [];
	}

	function prepareForConstellation() {
		if (!sceneRef) return;

		// Stop auto-rotate so the view stays locked on the constellation
		if (autoRotateActive) toggleAutoRotate(false);

		// Stop ambient constellations when showing user's result
		if (!ambientPaused) stopAmbientCycle();

		// Pause meteors and comets during constellation display
		if (meteorsEnabled) stopMeteors();
		if (cometsEnabled) stopComets();

		// Dim background stars
		if (uniformsRef) uniformsRef.uDim.value = 0.55;

		// Dim IAU overlay further when showing user constellation
		if (iauOverlayGroup) {
			iauOverlayGroup.traverse((child) => {
				if ((child as any).material && (child as any).material.opacity !== undefined) {
					(child as any).material.opacity *= 0.12;
				}
			});
		}
	}

	function drawConstellationAnimated(result: MatchResult, fast = false, color?: string) {
		if (!sceneRef) return;

		const constellationGroup = new THREE.Group();
		constellationGroups.push(constellationGroup);
		sceneRef.add(constellationGroup);

		const tColor = new THREE.Color(color || '#ffffff');
		const colorHex = tColor.getHex();
		// ShaderMaterial doesn't include colorspace_fragment, so use sRGB values directly
		const srgb = tColor.clone().convertLinearToSRGB();
		const cr = srgb.r, cg = srgb.g, cb = srgb.b;

		const nodeToPos = new Map<number, THREE.Vector3>();
		for (const pair of result.pairs) {
			nodeToPos.set(pair.nodeIndex, raDecToXYZ(pair.star.ra, pair.star.dec).multiplyScalar(0.999));
		}

		// Collect valid edges with positions
		const edgeData: { posA: THREE.Vector3; posB: THREE.Vector3; keyA: string; keyB: string }[] = [];
		const connectedNodes = new Set<number>();
		const starKey = (v: THREE.Vector3) => `${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`;
		for (const [nA, nB] of result.graph.edges) {
			const posA = nodeToPos.get(nA);
			const posB = nodeToPos.get(nB);
			if (!posA || !posB) continue;
			edgeData.push({
				posA: posA.clone(),
				posB: posB.clone(),
				keyA: starKey(posA),
				keyB: starKey(posB),
			});
			connectedNodes.add(nA);
			connectedNodes.add(nB);
		}

		// Collect highlighted star positions for all nodes (connected + isolated).
		// Isolated nodes also get bright dots so they match connected-node styling;
		// the ring overlay renders on top via the dedicated isolated-node cloud.
		const hlPositions: THREE.Vector3[] = [];
		for (const pair of result.pairs) {
			const pos = nodeToPos.get(pair.nodeIndex);
			if (pos) hlPositions.push(pos.clone());
		}

		// Find isolated nodes (no edges) — e.g. periods/dots
		const isolatedPositions: THREE.Vector3[] = [];
		for (const pair of result.pairs) {
			if (!connectedNodes.has(pair.nodeIndex)) {
				const pos = nodeToPos.get(pair.nodeIndex);
				if (pos) isolatedPositions.push(pos.clone());
			}
		}

		const revealedStars = new Set<string>();
		const hlKeys = hlPositions.map(starKey);

		const hlMat = new THREE.ShaderMaterial({
			uniforms: { uColor: { value: new THREE.Vector3(cr, cg, cb) } },
			vertexShader: `
				void main() {
					vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
					gl_Position = projectionMatrix * mvPosition;
					gl_PointSize = 12.0;
				}
			`,
			fragmentShader: `
				uniform vec3 uColor;
				void main() {
					float d = length(gl_PointCoord - 0.5) * 2.0;
					if (d > 1.0) discard;
					float alpha = exp(-d * d * 4.0) * 0.9;
					gl_FragColor = vec4(uColor * alpha, alpha);
				}
			`,
			transparent: true,
			depthTest: false,
			blending: THREE.AdditiveBlending,
		});

		// Ring shader for isolated nodes (periods/dots)
		const ringMat = new THREE.ShaderMaterial({
			uniforms: {
				uColor: { value: new THREE.Vector3(cr, cg, cb) },
				uFovScale: { value: 1.0 },
			},
			vertexShader: `
				uniform float uFovScale;
				void main() {
					vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
					gl_Position = projectionMatrix * mvPosition;
					gl_PointSize = 18.0 * uFovScale;
				}
			`,
			fragmentShader: `
				uniform vec3 uColor;
				void main() {
					float d = length(gl_PointCoord - 0.5) * 2.0;
					if (d > 1.0) discard;
					// Ring profile: bright at radius ~0.65, fading inward and outward
					float ring = smoothstep(0.35, 0.55, d) * smoothstep(0.95, 0.7, d);
					// Soft inner glow
					float glow = exp(-d * d * 6.0) * 0.15;
					float alpha = (ring * 0.7 + glow);
					gl_FragColor = vec4(uColor * alpha, alpha);
				}
			`,
			transparent: true,
			depthTest: false,
			blending: THREE.AdditiveBlending,
		});

		const linePair = edgeData.length > 0
			? createDynamicLinePair(edgeData.length, colorHex, 8, 0.1, 2.5, 0.4)
			: null;
		if (linePair) {
			constellationGroup.add(linePair.halo);
			constellationGroup.add(linePair.core);
		}

		let starPoints: THREE.Points | null = null;
		if (hlPositions.length > 0) {
			starPoints = new THREE.Points(new THREE.BufferGeometry(), hlMat);
			starPoints.renderOrder = 2;
			starPoints.visible = false;
			starPoints.frustumCulled = false;
			constellationGroup.add(starPoints);
		}

		let ringPoints: THREE.Points | null = null;
		if (isolatedPositions.length > 0) {
			ringMaterials.push(ringMat);
			ringPoints = new THREE.Points(new THREE.BufferGeometry(), ringMat);
			ringPoints.renderOrder = 2;
			ringPoints.visible = false;
			ringPoints.frustumCulled = false;
			constellationGroup.add(ringPoints);
		}

		const drawDuration = fast ? 80 : 300; // ms per edge to draw
		const stagger = fast ? 15 : 60; // ms between starting each edge
		const startTime = performance.now();
		const totalItems = edgeData.length + isolatedPositions.length;
		const totalDuration = totalItems > 0 ? (totalItems - 1) * stagger + drawDuration : 0;
		let animId: number | null = null;

		function releaseTrackedAnimationId() {
			if (animId === null) return;
			const idx = drawAnimationIds.indexOf(animId);
			if (idx !== -1) drawAnimationIds.splice(idx, 1);
			animId = null;
		}

		function animateDraw() {
			releaseTrackedAnimationId();
			if (!constellationGroup.parent) return;

			const now = performance.now();
			const elapsed = now - startTime;
			let activeLineCount = 0;

			for (let i = 0; i < edgeData.length; i++) {
				const edgeStart = i * stagger;
				const t = Math.min(1, Math.max(0, (elapsed - edgeStart) / drawDuration));
				if (t <= 0) continue;

				const { posA, posB, keyA, keyB } = edgeData[i];

				// Interpolate endpoint for drawing effect
				const currentX = posA.x + (posB.x - posA.x) * t;
				const currentY = posA.y + (posB.y - posA.y) * t;
				const currentZ = posA.z + (posB.z - posA.z) * t;

				if (linePair) {
					const base = activeLineCount * 6;
					linePair.positions[base] = posA.x;
					linePair.positions[base + 1] = posA.y;
					linePair.positions[base + 2] = posA.z;
					linePair.positions[base + 3] = currentX;
					linePair.positions[base + 4] = currentY;
					linePair.positions[base + 5] = currentZ;
				}
				activeLineCount++;

				// Reveal start star
				if (!revealedStars.has(keyA)) {
					revealedStars.add(keyA);
				}

				// Reveal end star when edge is complete
				if (t >= 1) {
					if (!revealedStars.has(keyB)) {
						revealedStars.add(keyB);
					}
				}
			}

			if (linePair) updateDynamicLinePair(linePair, activeLineCount);

			if (starPoints) {
				let starCount = 0;
				for (let i = 0; i < hlPositions.length; i++) {
					if (revealedStars.has(hlKeys[i])) starCount++;
				}
				if (starCount > 0) {
					const starPositions = new Float32Array(starCount * 3);
					let writeIndex = 0;
					for (let i = 0; i < hlPositions.length; i++) {
						if (!revealedStars.has(hlKeys[i])) continue;
						const pos = hlPositions[i];
						const base = writeIndex * 3;
						starPositions[base] = pos.x;
						starPositions[base + 1] = pos.y;
						starPositions[base + 2] = pos.z;
						writeIndex++;
					}
					const nextGeometry = new THREE.BufferGeometry();
					nextGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
					const prevGeometry = starPoints.geometry as THREE.BufferGeometry;
					starPoints.geometry = nextGeometry;
					prevGeometry.dispose();
					starPoints.visible = true;
				} else {
					starPoints.visible = false;
				}
			}

			if (ringPoints) {
				let ringCount = 0;
				for (let j = 0; j < isolatedPositions.length; j++) {
					const ringStart = (edgeData.length + j) * stagger;
					const t = Math.min(1, Math.max(0, (elapsed - ringStart) / drawDuration));
					if (t <= 0) continue;
					ringCount++;
				}
				if (ringCount > 0) {
					const ringPositions = new Float32Array(ringCount * 3);
					for (let j = 0; j < ringCount; j++) {
						const pos = isolatedPositions[j];
						const base = j * 3;
						ringPositions[base] = pos.x;
						ringPositions[base + 1] = pos.y;
						ringPositions[base + 2] = pos.z;
					}
					const nextGeometry = new THREE.BufferGeometry();
					nextGeometry.setAttribute('position', new THREE.Float32BufferAttribute(ringPositions, 3));
					const prevGeometry = ringPoints.geometry as THREE.BufferGeometry;
					ringPoints.geometry = nextGeometry;
					prevGeometry.dispose();
					ringPoints.visible = true;
				} else {
					ringPoints.visible = false;
				}
			}

			if (elapsed < totalDuration && constellationGroup.parent) {
				animId = requestAnimationFrame(animateDraw);
				drawAnimationIds.push(animId);
			}
		}

		animId = requestAnimationFrame(animateDraw);
		drawAnimationIds.push(animId);
	}

	function drawConstellationInstant(result: MatchResult, color?: string) {
		if (!sceneRef) return;

		const constellationGroup = new THREE.Group();
		constellationGroups.push(constellationGroup);
		sceneRef.add(constellationGroup);

		const tColor = new THREE.Color(color || '#ffffff');
		const colorHex = tColor.getHex();
		// ShaderMaterial doesn't include colorspace_fragment, so use sRGB values directly
		const srgb = tColor.clone().convertLinearToSRGB();
		const cr = srgb.r, cg = srgb.g, cb = srgb.b;

		const nodeToPos = new Map<number, THREE.Vector3>();
		for (const pair of result.pairs) {
			nodeToPos.set(pair.nodeIndex, raDecToXYZ(pair.star.ra, pair.star.dec).multiplyScalar(0.999));
		}

		const linePositions: number[] = [];
		const connectedNodes = new Set<number>();
		for (const [nA, nB] of result.graph.edges) {
			const posA = nodeToPos.get(nA);
			const posB = nodeToPos.get(nB);
			if (!posA || !posB) continue;
			linePositions.push(posA.x, posA.y, posA.z, posB.x, posB.y, posB.z);
			connectedNodes.add(nA);
			connectedNodes.add(nB);
		}

		if (linePositions.length > 0) {
			const segGeom = new LineSegmentsGeometry();
			segGeom.setPositions(linePositions);

			const haloMat = new LineMaterial({
				color: colorHex,
				linewidth: 8,
				transparent: true,
				opacity: 0.1,
				depthTest: false,
				blending: THREE.AdditiveBlending,
			});
			haloMat.resolution.copy(rendererSize);
			constellationGroup.add(new LineSegments2(segGeom, haloMat));

			const coreMat = new LineMaterial({
				color: colorHex,
				linewidth: 2.5,
				transparent: true,
				opacity: 0.4,
				depthTest: false,
				blending: THREE.AdditiveBlending,
			});
			coreMat.resolution.copy(rendererSize);
			constellationGroup.add(new LineSegments2(segGeom, coreMat));
		}

		const hlPositions: number[] = [];
		for (const pair of result.pairs) {
			const pos = nodeToPos.get(pair.nodeIndex);
			if (pos) hlPositions.push(pos.x, pos.y, pos.z);
		}

		if (hlPositions.length > 0) {
			const hlMat = new THREE.ShaderMaterial({
				uniforms: { uColor: { value: new THREE.Vector3(cr, cg, cb) } },
				vertexShader: `void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = 12.0; }`,
				fragmentShader: `uniform vec3 uColor; void main() { float d = length(gl_PointCoord - 0.5) * 2.0; if (d > 1.0) discard; float alpha = exp(-d * d * 4.0) * 0.9; gl_FragColor = vec4(uColor * alpha, alpha); }`,
				transparent: true,
				depthTest: false,
				blending: THREE.AdditiveBlending,
			});
			const hlGeom = new THREE.BufferGeometry();
			hlGeom.setAttribute('position', new THREE.Float32BufferAttribute(hlPositions, 3));
			const points = new THREE.Points(hlGeom, hlMat);
			points.renderOrder = 2;
			constellationGroup.add(points);
		}

		// Rings for isolated nodes
		const isoPositions: number[] = [];
		for (const pair of result.pairs) {
			if (!connectedNodes.has(pair.nodeIndex)) {
				const pos = nodeToPos.get(pair.nodeIndex);
				if (pos) isoPositions.push(pos.x, pos.y, pos.z);
			}
		}
		if (isoPositions.length > 0) {
			const ringMat = new THREE.ShaderMaterial({
				uniforms: {
					uColor: { value: new THREE.Vector3(cr, cg, cb) },
					uFovScale: { value: 1.0 },
				},
				vertexShader: `uniform float uFovScale; void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = 18.0 * uFovScale; }`,
				fragmentShader: `uniform vec3 uColor; void main() { float d = length(gl_PointCoord - 0.5) * 2.0; if (d > 1.0) discard; float ring = smoothstep(0.35, 0.55, d) * smoothstep(0.95, 0.7, d); float glow = exp(-d * d * 6.0) * 0.15; float alpha = ring * 0.7 + glow; gl_FragColor = vec4(uColor * alpha, alpha); }`,
				transparent: true,
				depthTest: false,
				blending: THREE.AdditiveBlending,
			});
			ringMaterials.push(ringMat);
			const ringGeom = new THREE.BufferGeometry();
			ringGeom.setAttribute('position', new THREE.Float32BufferAttribute(isoPositions, 3));
			const ringPoints = new THREE.Points(ringGeom, ringMat);
			ringPoints.renderOrder = 2;
			constellationGroup.add(ringPoints);
		}
	}

	function focusConstellationInstant(allResults: MatchResult[], focusIndex: number, colors?: string[]) {
		if (!controlsRef || !cameraRef) return;

		const result = allResults[focusIndex];
		if (!result) return;
		cancelGlobeTransition();
		cancelCameraAnimation();

		let cx = 0, cy = 0, cz = 0;
		const positions: THREE.Vector3[] = [];
		for (const pair of result.pairs) {
			const pos = raDecToXYZ(pair.star.ra, pair.star.dec);
			positions.push(pos);
			cx += pos.x;
			cy += pos.y;
			cz += pos.z;
		}
		if (positions.length === 0) return;

		const len = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
		const centroidDir = new THREE.Vector3(cx / len, cy / len, cz / len);
		const centroidRa = Math.atan2(-centroidDir.z, centroidDir.x);
		const centroidDec = Math.asin(Math.max(-1, Math.min(1, centroidDir.y)));
		const localNorth = new THREE.Vector3(
			-Math.sin(centroidDec) * Math.cos(centroidRa),
			Math.cos(centroidDec),
			Math.sin(centroidDec) * Math.sin(centroidRa)
		).normalize();

		let targetFov: number;
		if (globeViewActive) {
			targetFov = getGlobeFov();
		} else {
			const testCam = new THREE.PerspectiveCamera(60, cameraRef.aspect, 0.1, 10);
			testCam.position.set(0, 0, 0.0001);
			testCam.up.copy(localNorth);
			testCam.lookAt(centroidDir.clone().multiplyScalar(10));
			const fitMargin = 0.7;
			const maxFov = cameraRef.aspect < 0.8 ? 120 : 80;
			let lo = 5, hi = maxFov + 10;
			for (let i = 0; i < 16; i++) {
				const mid = (lo + hi) / 2;
				testCam.fov = mid;
				testCam.updateProjectionMatrix();
				let fits = true;
				for (const pos of positions) {
					const ndc = pos.clone().project(testCam);
					if (Math.abs(ndc.x) > fitMargin || Math.abs(ndc.y) > fitMargin) {
						fits = false;
						break;
					}
				}
				if (fits) hi = mid; else lo = mid;
			}
			targetFov = Math.min(maxFov, Math.max(15, hi));
		}

		prepareForConstellation();
		clearAllConstellations();
		currentResults = [...allResults];
		currentColors = colors ? [...colors] : allResults.map(() => '#ffffff');
		for (let i = 0; i < allResults.length; i++) {
			drawConstellationInstant(allResults[i], currentColors[i]);
		}

		if (globeViewActive) {
			cameraRef.position.copy(centroidDir.clone().negate().multiplyScalar(GLOBE_DISTANCE));
			controlsRef.target.set(0, 0, 0);
		} else {
			cameraRef.position.set(0, 0, 0.0001);
			controlsRef.target.copy(cameraRef.position).addScaledVector(centroidDir, 0.001);
		}
		cameraRef.up.copy(localNorth);
		syncControlsUp(controlsRef, cameraRef.up);
		cameraRef.fov = targetFov;
		cameraRef.updateProjectionMatrix();
		controlsRef.update();
	}

	export function refocusConstellation(allResults: MatchResult[], focusIndex: number, colors?: string[]) {
		if (reducedMotion) {
			focusConstellationInstant(allResults, focusIndex, colors);
			return;
		}

		clearAllConstellations();
		currentResults = [...allResults];
		currentColors = colors ? [...colors] : allResults.map(() => '#ffffff');
		// Instantly draw all non-focused constellations
		for (let i = 0; i < allResults.length; i++) {
			if (i !== focusIndex) drawConstellationInstant(allResults[i], currentColors[i]);
		}
		// Animate camera to focused one (fast replay)
		animateToMatch(allResults[focusIndex], true, currentColors[focusIndex]);
	}

	/** Redraw all constellations instantly without camera animation (used after vertex drag) */
	export function redrawConstellations(allResults: MatchResult[], colors?: string[]) {
		clearAllConstellations();
		currentResults = [...allResults];
		currentColors = colors ? [...colors] : allResults.map(() => '#ffffff');
		for (let i = 0; i < allResults.length; i++) {
			drawConstellationInstant(allResults[i], currentColors[i]);
		}
	}

	/** Smooth pan to focused constellation, then draw it animated; others stay instant */
	export function panToConstellation(allResults: MatchResult[], focusIndex: number, colors?: string[]) {
		if (!controlsRef || !cameraRef) return;
		cancelGlobeTransition();
		cancelCameraAnimation();

		// Reduced motion: jump instantly
		if (reducedMotion) {
			focusConstellationInstant(allResults, focusIndex, colors);
			return;
		}

		// Redraw everything instantly first (non-focused stay, focused will be redrawn animated on arrival)
		clearAllConstellations();
		currentResults = [...allResults];
		currentColors = colors ? [...colors] : allResults.map(() => '#ffffff');
		for (let i = 0; i < allResults.length; i++) {
			if (i !== focusIndex) drawConstellationInstant(allResults[i], currentColors[i]);
		}

		const result = allResults[focusIndex];
		let cx = 0, cy = 0, cz = 0;
		const positions: THREE.Vector3[] = [];
		for (const pair of result.pairs) {
			const pos = raDecToXYZ(pair.star.ra, pair.star.dec);
			positions.push(pos);
			cx += pos.x; cy += pos.y; cz += pos.z;
		}
		const len = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
		const centroidDir = new THREE.Vector3(cx / len, cy / len, cz / len);

		const centroidRa = Math.atan2(-centroidDir.z, centroidDir.x);
		const centroidDec = Math.asin(Math.max(-1, Math.min(1, centroidDir.y)));
		const localNorth = new THREE.Vector3(
			-Math.sin(centroidDec) * Math.cos(centroidRa),
			Math.cos(centroidDec),
			Math.sin(centroidDec) * Math.sin(centroidRa)
		).normalize();

		let targetFov: number;
		const globeCamDir = centroidDir.clone().negate();
		if (globeViewActive) {
			targetFov = getGlobeFov();
		} else {
			const testCam = new THREE.PerspectiveCamera(60, cameraRef.aspect, 0.1, 10);
			testCam.position.set(0, 0, 0.0001);
			testCam.up.copy(localNorth);
			testCam.lookAt(centroidDir.clone().multiplyScalar(10));
			const fitMargin = 0.7;
			const maxFov = cameraRef.aspect < 0.8 ? 120 : 80;
			let lo = 5, hi = maxFov + 10;
			for (let i = 0; i < 16; i++) {
				const mid = (lo + hi) / 2;
				testCam.fov = mid;
				testCam.updateProjectionMatrix();
				let fits = true;
				for (const pos of positions) {
					const ndc = pos.clone().project(testCam);
					if (Math.abs(ndc.x) > fitMargin || Math.abs(ndc.y) > fitMargin) {
						fits = false;
						break;
					}
				}
				if (fits) hi = mid; else lo = mid;
			}
			targetFov = Math.min(maxFov, Math.max(15, hi));
		}

		const startPos = cameraRef.position.clone();
		const startUp = cameraRef.up.clone();
		// Never zoom in tighter than what's already fitting
		const startFov = Math.max(cameraRef.fov, targetFov);

		if (globeViewActive) {
			const endPos = globeCamDir.clone().multiplyScalar(GLOBE_DISTANCE);
			const startDir = startPos.clone().normalize();
			const angularDist = Math.acos(Math.min(1, Math.max(-1, startDir.dot(globeCamDir))));
			const duration = 300 + 500 * Math.min(1, angularDist / Math.PI);
			const startTime = performance.now();

			const qStart = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), startDir);
			const qEnd = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), globeCamDir);
			const qSlerp = new THREE.Quaternion();
			const slerpedDir = new THREE.Vector3();

			runCameraAnimation(() => {
				if (!cameraRef || !controlsRef) return false;
				const elapsed = performance.now() - startTime;
				const t = Math.min(1, elapsed / duration);
				const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
				qSlerp.slerpQuaternions(qStart, qEnd, ease);
				slerpedDir.set(0, 0, 1).applyQuaternion(qSlerp);
				cameraRef.position.copy(slerpedDir.clone().multiplyScalar(GLOBE_DISTANCE));
				controlsRef.target.set(0, 0, 0);
				cameraRef.up.lerpVectors(startUp, localNorth, ease).normalize();
				syncControlsUp(controlsRef, cameraRef.up);
				cameraRef.fov = startFov + (targetFov - startFov) * ease;
				cameraRef.updateProjectionMatrix();
				controlsRef.update();
				if (t < 1) return true;
				drawConstellationAnimated(result, true, currentColors[focusIndex]);
				return false;
			});
			return;
		}

		const lookDir = controlsRef.target.clone().sub(startPos).normalize();
		const endDir = centroidDir.clone();
		const angularDist = Math.acos(Math.min(1, Math.max(-1, lookDir.dot(endDir))));
		const duration = 300 + 500 * Math.min(1, angularDist / Math.PI);
		const startTime = performance.now();

		const qStart = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), lookDir);
		const qEnd = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), endDir);
		const qSlerp = new THREE.Quaternion();
		const slerpedDir = new THREE.Vector3();
		const origin = new THREE.Vector3(0, 0, 0.0001);

		runCameraAnimation(() => {
			if (!cameraRef || !controlsRef) return false;
			const elapsed = performance.now() - startTime;
			const t = Math.min(1, elapsed / duration);
			const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
			cameraRef.position.lerpVectors(startPos, origin, ease);
			qSlerp.slerpQuaternions(qStart, qEnd, ease);
			slerpedDir.set(0, 0, -1).applyQuaternion(qSlerp);
			controlsRef.target.copy(cameraRef.position).addScaledVector(slerpedDir, 0.001);
			cameraRef.up.lerpVectors(startUp, localNorth, ease).normalize();
			syncControlsUp(controlsRef, cameraRef.up);
			cameraRef.fov = startFov + (targetFov - startFov) * ease;
			cameraRef.updateProjectionMatrix();
			controlsRef.update();
			if (t < 1) return true;
			// Camera arrived — draw the focused constellation with animation
			drawConstellationAnimated(result, true, currentColors[focusIndex]);
			return false;
		});
	}

	// --- Ambient constellation cycling ---

	interface ResolvedConstellation {
		name: string;
		edges: { posA: THREE.Vector3; posB: THREE.Vector3 }[];
		hlPositions: THREE.Vector3[];
		centroid: THREE.Vector3;
	}

	let resolvedConstellations: ResolvedConstellation[] = [];

	function resolveConstellations() {
		if (resolvedConstellations.length > 0) return;

		const hipToStar = new Map<number, Star>();
		for (const s of stars) {
			if (s.hip) hipToStar.set(s.hip, s);
		}

		for (const def of CONSTELLATIONS) {
			const edges: { posA: THREE.Vector3; posB: THREE.Vector3 }[] = [];
			const posSet = new Map<number, THREE.Vector3>();

			for (const [hip1, hip2] of def.lines) {
				const sA = hipToStar.get(hip1);
				const sB = hipToStar.get(hip2);
				if (!sA || !sB) continue;

				const posA = raDecToXYZ(sA.ra, sA.dec);
				const posB = raDecToXYZ(sB.ra, sB.dec);
				edges.push({ posA, posB });

				if (!posSet.has(hip1)) posSet.set(hip1, posA);
				if (!posSet.has(hip2)) posSet.set(hip2, posB);
			}

			if (edges.length === 0) continue;

			const hlPositions = Array.from(posSet.values());
			const centroid = new THREE.Vector3();
			for (const p of hlPositions) centroid.add(p);
			centroid.normalize();

			resolvedConstellations.push({ name: def.name, edges, hlPositions, centroid });
		}
	}

	function shuffleQueue() {
		ambientQueue = resolvedConstellations.map((_, i) => i);
		// Fisher-Yates shuffle
		for (let i = ambientQueue.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[ambientQueue[i], ambientQueue[j]] = [ambientQueue[j], ambientQueue[i]];
		}
	}

	function startAmbientCycle() {
		ambientPaused = false;
		for (const timerId of ambientTimerIds) {
			clearTimeout(timerId);
		}
		ambientTimerIds.clear();
		resolveConstellations();
		if (resolvedConstellations.length === 0) return;
		shuffleQueue();

		// Start first few with stagger
		scheduleNext(500);
		scheduleNext(2000);
		scheduleNext(3500);
		scheduleNext(5000);
	}

	function scheduleNext(delay: number) {
		if (ambientPaused) return;
		const timerId = setTimeout(() => {
			ambientTimerIds.delete(timerId);
			if (ambientPaused) return;
			if (ambientQueue.length === 0) shuffleQueue();
			const idx = ambientQueue.pop()!;
			spawnAmbientConstellation(resolvedConstellations[idx]);
			// Schedule the next one
			scheduleNext(3000 + Math.random() * 2000);
		}, delay);
		ambientTimerIds.add(timerId);
	}

	function stopAmbientCycle() {
		ambientPaused = true;
		for (const timerId of ambientTimerIds) {
			clearTimeout(timerId);
		}
		ambientTimerIds.clear();
		// Fade out all active ambient constellations
		for (const ac of ambientConstellations) {
			if (ac.animId !== null) cancelAnimationFrame(ac.animId);
			disposeObject3D(ac.group);
			disposeOverlayLabel(ac.label);
		}
		ambientConstellations = [];
	}

	function clearIAUOverlay() {
		if (iauOverlayGroup && sceneRef) {
			disposeObject3D(iauOverlayGroup);
			iauOverlayGroup = null;
		}
		for (const { label } of iauLabelData) {
			disposeOverlayLabel(label);
		}
		iauLabelData = [];
	}

	function showIAUOverlay() {
		if (iauOverlayGroup || !sceneRef || !cameraRef) return;

		// Ensure constellations are resolved
		if (resolvedConstellations.length === 0) resolveConstellations();

		// Build a single batched LineSegments geometry for all 88 constellations
		const group = new THREE.Group();
		const allPositions: number[] = [];

		for (const rc of resolvedConstellations) {
			for (const { posA, posB } of rc.edges) {
				allPositions.push(posA.x, posA.y, posA.z, posB.x, posB.y, posB.z);
			}
		}

		if (allPositions.length > 0) {
			const segGeom = new LineSegmentsGeometry();
			segGeom.setPositions(allPositions);

			// Halo pass - wider, soft glow (matches ambient constellation style)
			const haloMat = new LineMaterial({
				color: 0xffffff,
				linewidth: 6,
				transparent: true,
				opacity: 0.07,
				depthTest: false,
				blending: THREE.AdditiveBlending,
			});
			haloMat.resolution.copy(rendererSize);
			const halo = new LineSegments2(segGeom, haloMat);
			halo.renderOrder = 1;
			group.add(halo);

			// Core pass - thinner, brighter
			const coreMat = new LineMaterial({
				color: 0xffffff,
				linewidth: 2,
				transparent: true,
				opacity: 0.22,
				depthTest: false,
				blending: THREE.AdditiveBlending,
			});
			coreMat.resolution.copy(rendererSize);
			const core = new LineSegments2(segGeom, coreMat);
			core.renderOrder = 1;
			group.add(core);
		}

		sceneRef.add(group);
		iauOverlayGroup = group;

		// If user constellations are already active, dim the IAU overlay
		if (constellationGroups.length > 0) {
			iauOverlayGroup.traverse((child) => {
				if ((child as any).material && (child as any).material.opacity !== undefined) {
					(child as any).material.opacity *= 0.12;
				}
			});
		}

		iauLabelData = [];
		for (const rc of resolvedConstellations) {
			iauLabelData.push({ label: createOverlayLabel(rc.name), centroid: rc.centroid });
		}
	}

	function syncConstellationDisplayMode(mode: ConstellationDisplayMode) {
		constellationDisplayMode = mode;

		if (mode === 'all') {
			stopAmbientCycle();
			showIAUOverlay();
			return;
		}

		clearIAUOverlay();

		if (mode === 'ambient' && constellationGroups.length === 0) {
			startAmbientCycle();
			return;
		}

		stopAmbientCycle();
	}

	const AMBIENT_DRAW_DURATION = 400;
	const AMBIENT_STAGGER = 80;
	const AMBIENT_HOLD = 5000;
	const AMBIENT_FADE = 3000;

	function spawnAmbientConstellation(rc: ResolvedConstellation) {
		if (!sceneRef || !cameraRef || ambientPaused) return;

		const group = new THREE.Group();
		sceneRef.add(group);

		const totalDrawTime = (rc.edges.length - 1) * AMBIENT_STAGGER + AMBIENT_DRAW_DURATION;

		const ac: AmbientConstellation = {
			name: rc.name,
			group,
			label: createOverlayLabel(rc.name),
			edges: rc.edges,
			hlPositions: rc.hlPositions,
			centroid: rc.centroid,
			startTime: performance.now(),
			phase: 'draw',
			phaseStart: performance.now(),
			totalDrawTime,
			animId: null,
		};

		ambientConstellations.push(ac);

		const revealedStars = new Set<string>();
		const starKey = (v: THREE.Vector3) => `${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`;
		const edgeData = rc.edges.map(({ posA, posB }) => ({
			posA,
			posB,
			keyA: starKey(posA),
			keyB: starKey(posB),
		}));
		const hlKeys = rc.hlPositions.map(starKey);

		const linePair = edgeData.length > 0
			? createDynamicLinePair(edgeData.length, 0xffffff, 6, 0.1, 2, 0.32)
			: null;
		if (linePair) {
			group.add(linePair.halo);
			group.add(linePair.core);
		}

		const hlMat = new THREE.ShaderMaterial({
			vertexShader: `
				void main() {
					vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
					gl_Position = projectionMatrix * mvPosition;
					gl_PointSize = 8.0;
				}
			`,
			fragmentShader: `
				uniform float uOpacity;
				void main() {
					float d = length(gl_PointCoord - 0.5) * 2.0;
					if (d > 1.0) discard;
					float alpha = exp(-d * d * 4.0) * 0.6 * uOpacity;
					vec3 color = vec3(1.0, 1.0, 1.0);
					gl_FragColor = vec4(color * alpha, alpha);
				}
			`,
			uniforms: { uOpacity: new THREE.Uniform(0) },
			transparent: true,
			depthTest: false,
			blending: THREE.AdditiveBlending,
		});
		let starPoints: THREE.Points | null = null;
		if (rc.hlPositions.length > 0) {
			starPoints = new THREE.Points(new THREE.BufferGeometry(), hlMat);
			starPoints.renderOrder = 2;
			starPoints.visible = false;
			starPoints.frustumCulled = false;
			group.add(starPoints);
		}

		function animate() {
			if (ambientPaused || !group.parent) return;

			const now = performance.now();
			const phaseElapsed = now - ac.phaseStart;

			// Phase transitions
			if (ac.phase === 'draw' && phaseElapsed >= totalDrawTime) {
				ac.phase = 'hold';
				ac.phaseStart = now;
			} else if (ac.phase === 'hold' && phaseElapsed >= AMBIENT_HOLD) {
				ac.phase = 'fade';
				ac.phaseStart = now;
			} else if (ac.phase === 'fade' && phaseElapsed >= AMBIENT_FADE) {
				// Remove
				disposeObject3D(group);
				disposeOverlayLabel(ac.label);
				ambientConstellations = ambientConstellations.filter(a => a !== ac);
				return;
			}

			// Compute overall opacity
			let opacity = 1.0;
			if (ac.phase === 'draw') {
				opacity = Math.min(1, phaseElapsed / 500);
			} else if (ac.phase === 'fade') {
				opacity = 1 - phaseElapsed / AMBIENT_FADE;
			}

			const drawElapsed = ac.phase === 'draw' ? phaseElapsed : totalDrawTime;
			let activeLineCount = 0;

			for (let i = 0; i < edgeData.length; i++) {
				const edgeStart = i * AMBIENT_STAGGER;
				const t = Math.min(1, Math.max(0, (drawElapsed - edgeStart) / AMBIENT_DRAW_DURATION));
				if (t <= 0) continue;

				const { posA, posB, keyA, keyB } = edgeData[i];
				const cx = posA.x + (posB.x - posA.x) * t;
				const cy = posA.y + (posB.y - posA.y) * t;
				const cz = posA.z + (posB.z - posA.z) * t;
				if (linePair) {
					const base = activeLineCount * 6;
					linePair.positions[base] = posA.x;
					linePair.positions[base + 1] = posA.y;
					linePair.positions[base + 2] = posA.z;
					linePair.positions[base + 3] = cx;
					linePair.positions[base + 4] = cy;
					linePair.positions[base + 5] = cz;
				}
				activeLineCount++;

				if (!revealedStars.has(keyA)) revealedStars.add(keyA);
				if (t >= 1) {
					if (!revealedStars.has(keyB)) revealedStars.add(keyB);
				}
			}

			if (linePair) {
				linePair.haloMaterial.opacity = 0.1 * opacity;
				linePair.coreMaterial.opacity = 0.32 * opacity;
				updateDynamicLinePair(linePair, activeLineCount);
			}

			if (starPoints) {
				let starCount = 0;
				for (let i = 0; i < rc.hlPositions.length; i++) {
					if (revealedStars.has(hlKeys[i])) starCount++;
				}
				(hlMat.uniforms.uOpacity as THREE.Uniform<number>).value = opacity;
				if (starCount > 0) {
					const starPositions = new Float32Array(starCount * 3);
					let writeIndex = 0;
					for (let i = 0; i < rc.hlPositions.length; i++) {
						if (!revealedStars.has(hlKeys[i])) continue;
						const pos = rc.hlPositions[i];
						const base = writeIndex * 3;
						starPositions[base] = pos.x;
						starPositions[base + 1] = pos.y;
						starPositions[base + 2] = pos.z;
						writeIndex++;
					}
					const nextGeometry = new THREE.BufferGeometry();
					nextGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
					const prevGeometry = starPoints.geometry as THREE.BufferGeometry;
					starPoints.geometry = nextGeometry;
					prevGeometry.dispose();
					starPoints.visible = true;
				} else {
					starPoints.visible = false;
				}
			}

			ac.animId = requestAnimationFrame(animate);
		}

		ac.animId = requestAnimationFrame(animate);
	}

	export function clearLastConstellation() {
		if (constellationGroups.length > 0) {
			const last = constellationGroups.pop()!;
			disposeObject3D(last);
		}
		// Cancel the most recent draw animation if any
		if (drawAnimationIds.length > 0) {
			cancelAnimationFrame(drawAnimationIds.pop()!);
		}
	}

	export function setConstellationDisplayMode(mode: ConstellationDisplayMode) {
		syncConstellationDisplayMode(mode);
	}

	export function animateToMatch(result: MatchResult, fast = false, color?: string) {
		if (!controlsRef || !cameraRef) return;
		cancelGlobeTransition();
		cancelCameraAnimation();

		// Track this result if not already tracked (single-add case)
		if (!currentResults.includes(result)) {
			currentResults.push(result);
			currentColors.push(color || '#ffffff');
		}

		// Reduced motion: skip camera animation, draw instantly
		if (reducedMotion) {
			focusConstellationInstant(currentResults, currentResults.indexOf(result), currentColors);
			return;
		}

		prepareForConstellation();

		let cx = 0, cy = 0, cz = 0;
		const positions: THREE.Vector3[] = [];
		for (const pair of result.pairs) {
			const pos = raDecToXYZ(pair.star.ra, pair.star.dec);
			positions.push(pos);
			cx += pos.x; cy += pos.y; cz += pos.z;
		}
		const len = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
		const centroidDir = new THREE.Vector3(cx / len, cy / len, cz / len);

		// Compute angular extent using the 90th percentile angle to avoid
		// a single outlier star pulling the FOV too wide
		const angles: number[] = [];
		for (const pos of positions) {
			angles.push(Math.acos(Math.min(1, pos.dot(centroidDir))));
		}
		angles.sort((a, b) => a - b);
		const p90Index = Math.min(angles.length - 1, Math.floor(angles.length * 0.9));
		const representativeAngle = angles[p90Index];
		// Also keep the true max so we don't clip anything
		const maxAngle = angles[angles.length - 1];

		// Compute local "north" (declination-increasing) direction at centroid.
		// This is the tangent vector d(raDecToXYZ)/d(dec) at the centroid's
		// RA/Dec, so text aligned with Dec appears upright on screen.
		const centroidRa = Math.atan2(-centroidDir.z, centroidDir.x);
		const centroidDec = Math.asin(Math.max(-1, Math.min(1, centroidDir.y)));
		const localNorth = new THREE.Vector3(
			-Math.sin(centroidDec) * Math.cos(centroidRa),
			Math.cos(centroidDec),
			Math.sin(centroidDec) * Math.sin(centroidRa)
		).normalize();

		let targetFov: number;
		const globeCamDir = centroidDir.clone().negate();
		if (globeViewActive) {
			targetFov = getGlobeFov();
		} else {
			const testCam = new THREE.PerspectiveCamera(60, cameraRef.aspect, 0.1, 10);
			testCam.position.set(0, 0, 0.0001);
			testCam.up.copy(localNorth);
			testCam.lookAt(centroidDir.clone().multiplyScalar(10));
			const fitMargin = 0.7; // stars must land within ±70% of NDC

			// Allow higher max FOV on portrait viewports to fit wide constellations
			const maxFov = cameraRef.aspect < 0.8 ? 120 : 80;
			let lo = 5, hi = maxFov + 10;
			for (let i = 0; i < 16; i++) {
				const mid = (lo + hi) / 2;
				testCam.fov = mid;
				testCam.updateProjectionMatrix();
				let fits = true;
				for (const pos of positions) {
					const ndc = pos.clone().project(testCam);
					if (Math.abs(ndc.x) > fitMargin || Math.abs(ndc.y) > fitMargin) {
						fits = false;
						break;
					}
				}
				if (fits) hi = mid; else lo = mid;
			}
			targetFov = Math.min(maxFov, Math.max(15, hi));
		}

		// Derive start direction from the actual camera look direction,
		// not just the target — after orbiting, the camera has moved off origin.
		const startPos = cameraRef.position.clone();
		const startUp = cameraRef.up.clone();
		const startFov = cameraRef.fov;

		if (globeViewActive) {
			const endPos = globeCamDir.clone().multiplyScalar(GLOBE_DISTANCE);
			const startDir = startPos.clone().normalize();
			const angularDist = Math.acos(Math.min(1, Math.max(-1, startDir.dot(globeCamDir))));
			const baseDuration = fast ? 800 : 1200;
			const minDuration = fast ? 300 : 400;
			const duration = minDuration + (baseDuration - minDuration) * Math.min(1, angularDist / Math.PI);
			const startTime = performance.now();

			const qStart = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), startDir);
			const qEnd = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), globeCamDir);
			const qSlerp = new THREE.Quaternion();
			const slerpedDir = new THREE.Vector3();

			runCameraAnimation(() => {
				if (!cameraRef || !controlsRef) return false;
				const elapsed = performance.now() - startTime;
				const t = Math.min(1, elapsed / duration);
				const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
				qSlerp.slerpQuaternions(qStart, qEnd, ease);
				slerpedDir.set(0, 0, 1).applyQuaternion(qSlerp);
				cameraRef.position.copy(slerpedDir.clone().multiplyScalar(GLOBE_DISTANCE));
				controlsRef.target.set(0, 0, 0);
				cameraRef.up.lerpVectors(startUp, localNorth, ease).normalize();
				syncControlsUp(controlsRef, cameraRef.up);
				cameraRef.fov = startFov + (targetFov - startFov) * ease;
				cameraRef.updateProjectionMatrix();
				controlsRef.update();
				if (t < 1) return true;
				drawConstellationAnimated(result, fast, color);
				return false;
			});
			return;
		}

		const lookDir = controlsRef.target.clone().sub(startPos).normalize();
		const endDir = centroidDir.clone();
		// Scale camera pan duration by angular distance (0° → minimum, 180° → full)
		const angularDist = Math.acos(Math.min(1, Math.max(-1, lookDir.dot(endDir))));
		const baseDuration = fast ? 800 : 1200;
		const minDuration = fast ? 300 : 400;
		const duration = minDuration + (baseDuration - minDuration) * Math.min(1, angularDist / Math.PI);
		const startTime = performance.now();

		// Use quaternion slerp to rotate the look direction so the camera
		// always takes the short arc rather than swinging through the back.
		const qStart = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), lookDir);
		const qEnd = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), endDir);
		const qSlerp = new THREE.Quaternion();
		const slerpedDir = new THREE.Vector3();
		const origin = new THREE.Vector3(0, 0, 0.0001);

		runCameraAnimation(() => {
			if (!cameraRef || !controlsRef) return false;
			const elapsed = performance.now() - startTime;
			const t = Math.min(1, elapsed / duration);
			const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
			// Move camera back to origin
			cameraRef.position.lerpVectors(startPos, origin, ease);
			qSlerp.slerpQuaternions(qStart, qEnd, ease);
			slerpedDir.set(0, 0, -1).applyQuaternion(qSlerp);
			controlsRef.target.copy(cameraRef.position).addScaledVector(slerpedDir, 0.001);
			cameraRef.up.lerpVectors(startUp, localNorth, ease).normalize();
			// OrbitControls caches the up-to-Y quaternion at construction time.
			// Update it each frame so the new up vector is respected.
			syncControlsUp(controlsRef, cameraRef.up);
			cameraRef.fov = startFov + (targetFov - startFov) * ease;
			cameraRef.updateProjectionMatrix();
			controlsRef.update();
			if (t < 1) return true;
			// Camera arrived — start drawing the constellation
			drawConstellationAnimated(result, fast, color);
			return false;
		});
	}

	export function resetView() {
		if (!controlsRef || !cameraRef) return;
		cancelGlobeTransition();
		cancelCameraAnimation();

		clearAllConstellations();
		if (uniformsRef) uniformsRef.uDim.value = 1.0;
		// Restore IAU overlay opacity if it was dimmed
		if (iauOverlayGroup) {
			let matIdx = 0;
			const restoreOpacities = [0.07, 0.22]; // halo, core
			iauOverlayGroup.traverse((child) => {
				if ((child as any).material && (child as any).material.opacity !== undefined) {
					(child as any).material.opacity = restoreOpacities[matIdx] ?? 0.22;
					matIdx++;
				}
			});
		}

		if (constellationDisplayMode === 'ambient' && resolvedConstellations.length > 0) {
			startAmbientCycle();
		}
		if (!meteorsEnabled) resumeMeteors();
		if (!cometsEnabled) resumeComets();

		const startPos = cameraRef.position.clone();
		const defaultTilt = 15 * Math.PI / 180;
		const endDir = new THREE.Vector3(0, -Math.sin(defaultTilt), -Math.cos(defaultTilt));
		const startUp = cameraRef.up.clone();
		const defaultUp = new THREE.Vector3(0, 1, 0);
		const startFov = cameraRef.fov;
		const duration = 800;
		const startTime = performance.now();

		if (globeViewActive) {
			const endPos = endDir.clone().negate().multiplyScalar(GLOBE_DISTANCE);
			const startDir = startPos.clone().normalize();
			const endDirNorm = endPos.clone().normalize();

			const qStart = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), startDir);
			const qEnd = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), endDirNorm);
			const qSlerp = new THREE.Quaternion();
			const slerpedDir = new THREE.Vector3();
			const startDist = startPos.length() || GLOBE_DISTANCE;

			runCameraAnimation(() => {
				if (!cameraRef || !controlsRef) return false;
				const elapsed = performance.now() - startTime;
				const t = Math.min(1, elapsed / duration);
				const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
				qSlerp.slerpQuaternions(qStart, qEnd, ease);
				slerpedDir.set(0, 0, 1).applyQuaternion(qSlerp);
				const dist = startDist + (GLOBE_DISTANCE - startDist) * ease;
				cameraRef.position.copy(slerpedDir.multiplyScalar(dist));
				controlsRef.target.set(0, 0, 0);
				cameraRef.up.lerpVectors(startUp, defaultUp, ease).normalize();
				syncControlsUp(controlsRef, cameraRef.up);
				cameraRef.fov = startFov + (getGlobeFov() - startFov) * ease;
				cameraRef.updateProjectionMatrix();
				controlsRef.update();
				return t < 1;
			});
			return;
		}

		const lookDir = controlsRef.target.clone().sub(startPos).normalize();
		const qStart = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), lookDir);
		const qEnd = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), endDir);
		const qSlerp = new THREE.Quaternion();
		const slerpedDir = new THREE.Vector3();
		const origin = new THREE.Vector3(0, 0, 0.0001);

		runCameraAnimation(() => {
			if (!cameraRef || !controlsRef) return false;
			const elapsed = performance.now() - startTime;
			const t = Math.min(1, elapsed / duration);
			const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
			cameraRef.position.lerpVectors(startPos, origin, ease);
			qSlerp.slerpQuaternions(qStart, qEnd, ease);
			slerpedDir.set(0, 0, -1).applyQuaternion(qSlerp);
			controlsRef.target.copy(cameraRef.position).addScaledVector(slerpedDir, 0.001);
			cameraRef.up.lerpVectors(startUp, defaultUp, ease).normalize();
			syncControlsUp(controlsRef, cameraRef.up);
			cameraRef.fov = startFov + (DEFAULT_FOV - startFov) * ease;
			cameraRef.updateProjectionMatrix();
			controlsRef.update();
			return t < 1;
		});
	}

	export function toggleAutoRotate(on: boolean) {
		autoRotateActive = on;
		if (controlsRef) controlsRef.autoRotate = on;
	}

	export function toggleStarLabels(show: boolean) {
		if (show === starLabelsActive) return;
		starLabelsActive = show;

		if (show) {
			// Create labels for named stars brighter than the limit
			for (const s of stars) {
				if (!s.name || s.mag > STAR_LABEL_MAG_LIMIT) continue;
				if (s.mag < -10 && uniformsRef && uniformsRef.uShowSun.value < 0.5) continue;
				const pos = raDecToXYZ(s.ra, s.dec);
				const label = new Text();
				label.text = s.name;
				label.anchorX = 'center';
				label.anchorY = 'middle';
				label.fontSize = 10;
				label.letterSpacing = 0.08;
				label.color = 0xddeeff;
				label.fillOpacity = 0;
				label.outlineColor = LABEL_OUTLINE_COLOR;
				label.outlineWidth = '8%';
				label.outlineBlur = '35%';
				label.outlineOpacity = 0;
				label.sdfGlyphSize = 64;
				label.frustumCulled = false;
				label.renderOrder = 10;
				label.position.z = 0;
				overlaySceneRef?.add(label);
				label.sync();
				starLabelData.push({ label, pos, mag: s.mag });
			}
		} else {
			for (const sl of starLabelData) {
				disposeOverlayLabel(sl.label);
			}
			starLabelData = [];
		}
	}

	export function toggleCoordinateGrid(show: boolean) {
		if (show === coordGridActive) return;
		coordGridActive = show;

		if (show) {
			if (!sceneRef) return;
			const group = new THREE.Group();
			const SPHERE_R = 1.0;
			const SEGMENTS = 120;

			// RA lines (every 1h = 15°) — great circles from pole to pole
			for (let h = 0; h < 24; h += 1) {
				const ra = (h / 24) * Math.PI * 2;
				const points: number[] = [];
				for (let i = 0; i <= SEGMENTS; i++) {
					const dec = -Math.PI / 2 + (Math.PI * i) / SEGMENTS;
					const x = Math.cos(dec) * Math.cos(ra) * SPHERE_R;
					const y = Math.sin(dec) * SPHERE_R;
					const z = -Math.cos(dec) * Math.sin(ra) * SPHERE_R;
					points.push(x, y, z);
				}
				const lineGeom = new THREE.BufferGeometry();
				lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
				const lineMat = new THREE.LineBasicMaterial({
					color: 0x4488cc,
					transparent: true,
					opacity: 0.12,
					depthTest: false,
					blending: THREE.AdditiveBlending,
				});
				const line = new THREE.Line(lineGeom, lineMat);
				line.renderOrder = 0;
				group.add(line);

				// RA label at equator
				const labelPos = raDecToXYZ(ra, 0);
				const label = new Text();
				label.text = `${h}h`;
				label.anchorX = 'center';
				label.anchorY = 'middle';
				label.fontSize = 11;
				label.letterSpacing = 0.05;
				label.color = 0x4488cc;
				label.fillOpacity = 0;
				label.outlineColor = LABEL_OUTLINE_COLOR;
				label.outlineWidth = '10%';
				label.outlineBlur = '40%';
				label.outlineOpacity = 0;
				label.sdfGlyphSize = 64;
				label.frustumCulled = false;
				label.renderOrder = 10;
				label.position.z = 0;
				(label as any)._gridWorldPos = labelPos;
				overlaySceneRef?.add(label);
				label.sync();
				coordGridLabels.push(label);
			}

			// Dec lines (every 15°, skip poles) — small circles at constant declination
			for (let d = -75; d <= 75; d += 15) {
				if (d === 0) continue; // we'll draw the equator separately
				const dec = (d * Math.PI) / 180;
				const points: number[] = [];
				for (let i = 0; i <= SEGMENTS; i++) {
					const ra = (i / SEGMENTS) * Math.PI * 2;
					const x = Math.cos(dec) * Math.cos(ra) * SPHERE_R;
					const y = Math.sin(dec) * SPHERE_R;
					const z = -Math.cos(dec) * Math.sin(ra) * SPHERE_R;
					points.push(x, y, z);
				}
				const lineGeom = new THREE.BufferGeometry();
				lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
				const lineMat = new THREE.LineBasicMaterial({
					color: 0x4488cc,
					transparent: true,
					opacity: 0.1,
					depthTest: false,
					blending: THREE.AdditiveBlending,
				});
				const line = new THREE.Line(lineGeom, lineMat);
				line.renderOrder = 0;
				group.add(line);

				// Dec label
				const labelPos = raDecToXYZ(0, dec);
				const label = new Text();
				label.text = `${d > 0 ? '+' : ''}${d}°`;
				label.anchorX = 'center';
				label.anchorY = 'middle';
				label.fontSize = 11;
				label.letterSpacing = 0.05;
				label.color = 0x4488cc;
				label.fillOpacity = 0;
				label.outlineColor = LABEL_OUTLINE_COLOR;
				label.outlineWidth = '10%';
				label.outlineBlur = '40%';
				label.outlineOpacity = 0;
				label.sdfGlyphSize = 64;
				label.frustumCulled = false;
				label.renderOrder = 10;
				label.position.z = 0;
				(label as any)._gridWorldPos = labelPos;
				overlaySceneRef?.add(label);
				label.sync();
				coordGridLabels.push(label);
			}

			// Celestial equator — brighter
			{
				const points: number[] = [];
				for (let i = 0; i <= SEGMENTS; i++) {
					const ra = (i / SEGMENTS) * Math.PI * 2;
					const x = Math.cos(ra) * SPHERE_R;
					const y = 0;
					const z = -Math.sin(ra) * SPHERE_R;
					points.push(x, y, z);
				}
				const lineGeom = new THREE.BufferGeometry();
				lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
				const lineMat = new THREE.LineBasicMaterial({
					color: 0x6699dd,
					transparent: true,
					opacity: 0.2,
					depthTest: false,
					blending: THREE.AdditiveBlending,
				});
				const line = new THREE.Line(lineGeom, lineMat);
				line.renderOrder = 0;
				group.add(line);

				// 0° label on equator
				const labelPos = raDecToXYZ(0, 0);
				const label = new Text();
				label.text = '0°';
				label.anchorX = 'center';
				label.anchorY = 'middle';
				label.fontSize = 11;
				label.letterSpacing = 0.05;
				label.color = 0x6699dd;
				label.fillOpacity = 0;
				label.outlineColor = LABEL_OUTLINE_COLOR;
				label.outlineWidth = '10%';
				label.outlineBlur = '40%';
				label.outlineOpacity = 0;
				label.sdfGlyphSize = 64;
				label.frustumCulled = false;
				label.renderOrder = 10;
				label.position.z = 0;
				(label as any)._gridWorldPos = labelPos;
				overlaySceneRef?.add(label);
				label.sync();
				coordGridLabels.push(label);
			}

			sceneRef.add(group);
			coordGridGroup = group;
		} else {
			if (coordGridGroup && sceneRef) {
				disposeObject3D(coordGridGroup);
				coordGridGroup = null;
			}
			for (const label of coordGridLabels) {
				disposeOverlayLabel(label);
			}
			coordGridLabels = [];
		}
	}

	export function toggleShootingStars(on: boolean) {
		if (on) {
			resumeMeteors();
			resumeComets();
		} else {
			stopMeteors();
			stopComets();
		}
	}

	export function setBrightness(value: number) {
		if (uniformsRef) uniformsRef.uBrightness.value = value;
	}

	function getViewFovScale(position: THREE.Vector3, fov: number, globeView: boolean) {
		if (globeView) {
			const distance = position.length();
			return distance > 0.0001 ? GLOBE_DISTANCE / distance * 0.4 : 0.4;
		}
		return DEFAULT_FOV / fov;
	}

	function easeInOutQuad(t: number) {
		return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
	}

	function applyViewInteractionState(globeView: boolean) {
		if (!controlsRef) return;
		controlsRef.enableZoom = false;

		if (globeView) {
			controlsRef.minDistance = 1.5;
			controlsRef.maxDistance = 6.0;
			controlsRef.rotateSpeed = Math.abs(controlsRef.rotateSpeed);
			controlsRef.autoRotateSpeed = -Math.abs(controlsRef.autoRotateSpeed);
			return;
		}

		controlsRef.minDistance = 0.0001;
		controlsRef.maxDistance = 0.01;
		controlsRef.rotateSpeed = -Math.abs(controlsRef.rotateSpeed);
		controlsRef.autoRotateSpeed = Math.abs(controlsRef.autoRotateSpeed);
	}

	function resetControlsMotion(controls: OrbitControls) {
		(controls as any)._sphericalDelta.set(0, 0, 0);
		(controls as any)._panOffset.set(0, 0, 0);
		(controls as any)._scale = 1;
	}

	function cancelCameraAnimation() {
		if (cameraAnimationId !== null) {
			cancelAnimationFrame(cameraAnimationId);
			cameraAnimationId = null;
		}
		cameraAnimationToken++;
	}

	function runCameraAnimation(step: () => boolean) {
		cancelCameraAnimation();
		const token = cameraAnimationToken;

		const animate = () => {
			if (token !== cameraAnimationToken) return;
			const keepGoing = step();
			if (token !== cameraAnimationToken) return;
			if (keepGoing) {
				cameraAnimationId = requestAnimationFrame(animate);
			} else {
				cameraAnimationId = null;
			}
		};

		animate();
	}

	function cancelGlobeTransition() {
		if (globeTransitionId !== null) {
			cancelAnimationFrame(globeTransitionId);
			globeTransitionId = null;
		}
		globeTransitionActive = false;
		globeTransitionFovOverride = false;
		overlayLabelGlobeViewActive = globeViewActive;
		overlayLabelTransitionOpacity = 1;
		if (!controlsRef) {
			globeTransitionRestore = null;
			return;
		}
		controlsRef.enabled = true;
		controlsRef.enableRotate = globeTransitionRestore?.enableRotate ?? controlsRef.enableRotate;
		controlsRef.autoRotate = autoRotateActive;
		globeTransitionRestore = null;
	}

	function applyCameraFrame(
		position: THREE.Vector3,
		target: THREE.Vector3,
		up: THREE.Vector3,
		fov: number,
		fovScale: number
	) {
		if (!cameraRef || !controlsRef) return;
		cameraRef.position.copy(position);
		controlsRef.target.copy(target);
		cameraRef.up.copy(up);
		cameraRef.fov = fov;
		cameraRef.updateProjectionMatrix();
		if (uniformsRef) uniformsRef.uFovScale.value = fovScale;
		cameraRef.lookAt(target);
		cameraRef.updateMatrixWorld();
	}

	function getCurrentViewDirection() {
		if (!cameraRef || !controlsRef) return new THREE.Vector3(0, 0, -1);

		const viewDir = controlsRef.target.clone().sub(cameraRef.position);
		if (viewDir.lengthSq() > 1e-8) return viewDir.normalize();
		if (cameraRef.position.lengthSq() > 1e-8) return cameraRef.position.clone().normalize().negate();
		return new THREE.Vector3(0, 0, -1);
	}

	function getCurrentFrameFovScale(position: THREE.Vector3, fov: number) {
		if (uniformsRef) return uniformsRef.uFovScale.value;
		return getViewFovScale(position, fov, position.length() > 0.1);
	}

	function finalizeGlobeTransition(
		on: boolean,
		position: THREE.Vector3,
		target: THREE.Vector3,
		up: THREE.Vector3,
		fov: number,
		fovScale: number,
		enableRotate: boolean
	) {
		if (!controlsRef || !cameraRef) return;

		applyCameraFrame(position, target, up, fov, fovScale);
		globeViewActive = on;
		overlayLabelGlobeViewActive = on;
		overlayLabelTransitionOpacity = 1;
		applyViewInteractionState(on);
		syncControlsUp(controlsRef, cameraRef.up);
		resetControlsMotion(controlsRef);
		controlsRef.enableRotate = enableRotate;
		controlsRef.autoRotate = false;
		controlsRef.enabled = true;
		globeTransitionFovOverride = false;
		globeTransitionActive = false;
		controlsRef.update();
		controlsRef.autoRotate = autoRotateActive;
		globeTransitionId = null;
		globeTransitionRestore = null;
	}

	export function setMonochrome(on: boolean) {
		if (uniformsRef) uniformsRef.uMonochrome.value = on ? 1.0 : 0.0;
	}

	export function toggleSun(show: boolean) {
		if (uniformsRef) uniformsRef.uShowSun.value = show ? 1.0 : 0.0;
	}

	export function toggleGlobeView(on: boolean, immediate = false) {
		if (!controlsRef || !cameraRef) return;
		if (on === globeViewActive && !globeTransitionActive) return;
		cancelCameraAnimation();
		cancelGlobeTransition();

		const enableRotate = globeTransitionRestore?.enableRotate ?? controlsRef.enableRotate;
		const viewDir = getCurrentViewDirection();
		const endPos = on
			? viewDir.clone().negate().multiplyScalar(GLOBE_DISTANCE)
			: new THREE.Vector3(0, 0, 0.0001);
		const endTarget = on
			? new THREE.Vector3(0, 0, 0)
			: endPos.clone().addScaledVector(viewDir, 0.001);
		const endUp = cameraRef.up.clone();
		const endFov = on ? getGlobeFov() : DEFAULT_FOV;
		const endFovScale = getViewFovScale(endPos, endFov, on);

		if (immediate || reducedMotion) {
			finalizeGlobeTransition(on, endPos, endTarget, endUp, endFov, endFovScale, enableRotate);
			return;
		}

		if (!globeTransitionRestore) {
			globeTransitionRestore = { enableRotate: controlsRef.enableRotate };
		}

		globeTransitionActive = true;
		controlsRef.autoRotate = false;
		controlsRef.enabled = false;
		resetControlsMotion(controlsRef);
		globeTransitionFovOverride = true;

		const startTime = performance.now();
		const duration = 2000;
		const labelFadeOutEnd = 0.16;
		const labelFadeInStart = 0.84;
		const startPos = cameraRef.position.clone();
		const startTarget = controlsRef.target.clone();
		const startUp = cameraRef.up.clone();
		const startFov = cameraRef.fov;
		const startFovScale = getCurrentFrameFovScale(startPos, startFov);
		const startLabelOpacity = overlayLabelTransitionOpacity;
		const startLabelGlobeView = overlayLabelGlobeViewActive;
		const framePos = new THREE.Vector3();
		const frameTarget = new THREE.Vector3();

		function animate() {
			const t = Math.min(1, (performance.now() - startTime) / duration);
			const ease = easeInOutQuad(t);
			framePos.lerpVectors(startPos, endPos, ease);
			frameTarget.lerpVectors(startTarget, endTarget, ease);
			const fov = startFov + (endFov - startFov) * ease;
			const fovScale = startFovScale + (endFovScale - startFovScale) * ease;
			applyCameraFrame(framePos, frameTarget, startUp, fov, fovScale);
			if (t < labelFadeOutEnd) {
				const fadeOut = easeInOutQuad(t / labelFadeOutEnd);
				overlayLabelGlobeViewActive = startLabelGlobeView;
				overlayLabelTransitionOpacity = startLabelOpacity * (1 - fadeOut);
			} else if (t < labelFadeInStart) {
				overlayLabelGlobeViewActive = on;
				overlayLabelTransitionOpacity = 0;
			} else {
				const fadeIn = easeInOutQuad((t - labelFadeInStart) / (1 - labelFadeInStart));
				overlayLabelGlobeViewActive = on;
				overlayLabelTransitionOpacity = fadeIn;
			}

			if (t < 1) {
				globeTransitionId = requestAnimationFrame(animate);
				return;
			}

			finalizeGlobeTransition(on, endPos, endTarget, endUp, endFov, endFovScale, enableRotate);
		}

		globeTransitionId = requestAnimationFrame(animate);
	}

	// --- Star highlight (large label + ring) for search/click ---
	let starHighlightGroup: THREE.Group | null = null;
	let starHighlightRingMat: THREE.ShaderMaterial | null = null;
	let starHighlightLabel: Text | null = null;

	export function highlightStar(star: Star) {
		clearStarHighlight();
		if (!sceneRef || !overlaySceneRef) return;

		const pos = raDecToXYZ(star.ra, star.dec).multiplyScalar(0.999);
		const group = new THREE.Group();

		// Ring effect around the star
		const ringGeom = new THREE.BufferGeometry();
		ringGeom.setAttribute('position', new THREE.Float32BufferAttribute([pos.x, pos.y, pos.z], 3));
		const ringMat = new THREE.ShaderMaterial({
			uniforms: { uFovScale: { value: 1.0 } },
			vertexShader: `
				uniform float uFovScale;
				void main() {
					vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
					gl_Position = projectionMatrix * mvPosition;
					gl_PointSize = 18.0 * uFovScale;
				}
			`,
			fragmentShader: `
				void main() {
					float d = length(gl_PointCoord - 0.5) * 2.0;
					float ring = smoothstep(0.6, 0.7, d) * smoothstep(1.0, 0.85, d);
					float glow = exp(-d * d * 2.0) * 0.15;
					float alpha = ring * 0.7 + glow;
					vec3 color = vec3(1.0, 0.84, 0.0);
					gl_FragColor = vec4(color * alpha, alpha);
				}
			`,
			transparent: true,
			depthTest: false,
			blending: THREE.AdditiveBlending,
		});
		starHighlightRingMat = ringMat;
		const ringPoints = new THREE.Points(ringGeom, ringMat);
		ringPoints.renderOrder = 5;
		group.add(ringPoints);

		sceneRef.add(group);
		starHighlightGroup = group;

		// Large label in overlay scene
		const label = new Text();
		label.text = (star.name || `HIP ${star.hip || star.id}`).toUpperCase();
		label.anchorX = 'center';
		label.anchorY = 'bottom';
		label.fontSize = 14;
		label.letterSpacing = 0.08;
		label.color = 0xffd700;
		label.fillOpacity = 0.9;
		label.outlineColor = 0x000000;
		label.outlineWidth = '10%';
		label.outlineBlur = '25%';
		label.outlineOpacity = 0.8;
		label.sdfGlyphSize = 128;
		label.frustumCulled = false;
		label.renderOrder = 12;
		label.position.z = 0;
		(label as any)._hlWorldPos = raDecToXYZ(star.ra, star.dec);
		overlaySceneRef.add(label);
		label.sync();
		starHighlightLabel = label;
	}

	export function clearStarHighlight() {
		if (starHighlightGroup && sceneRef) {
			disposeObject3D(starHighlightGroup);
			starHighlightGroup = null;
			starHighlightRingMat = null;
		}
		if (starHighlightLabel) {
			disposeOverlayLabel(starHighlightLabel);
			starHighlightLabel = null;
		}
	}

	// --- Temporary IAU constellation display (for search) ---
	let tempConstellationGroup: THREE.Group | null = null;
	let tempConstellationLabel: Text | null = null;

	export function drawTempConstellation(constellationName: string) {
		clearTempConstellation();
		if (!sceneRef || !overlaySceneRef) return;

		if (resolvedConstellations.length === 0) resolveConstellations();
		const rc = resolvedConstellations.find(c => c.name === constellationName);
		if (!rc) return;

		const group = new THREE.Group();
		const positions: number[] = [];
		for (const { posA, posB } of rc.edges) {
			positions.push(posA.x, posA.y, posA.z, posB.x, posB.y, posB.z);
		}

		if (positions.length > 0) {
			const segGeom = new LineSegmentsGeometry();
			segGeom.setPositions(positions);

			const haloMat = new LineMaterial({
				color: 0xffffff,
				linewidth: 6,
				transparent: true,
				opacity: 0.12,
				depthTest: false,
				blending: THREE.AdditiveBlending,
			});
			haloMat.resolution.copy(rendererSize);
			const halo = new LineSegments2(segGeom, haloMat);
			halo.renderOrder = 1;
			group.add(halo);

			const coreMat = new LineMaterial({
				color: 0xffffff,
				linewidth: 2,
				transparent: true,
				opacity: 0.35,
				depthTest: false,
				blending: THREE.AdditiveBlending,
			});
			coreMat.resolution.copy(rendererSize);
			const core = new LineSegments2(segGeom, coreMat);
			core.renderOrder = 1;
			group.add(core);
		}

		sceneRef.add(group);
		tempConstellationGroup = group;

		// Label at centroid
		const label = createOverlayLabel(rc.name);
		(label as any)._tcCentroid = rc.centroid.clone();
		setOverlayLabelOpacity(label, 0.7);
		tempConstellationLabel = label;
	}

	export function clearTempConstellation() {
		if (tempConstellationGroup && sceneRef) {
			disposeObject3D(tempConstellationGroup);
			tempConstellationGroup = null;
		}
		if (tempConstellationLabel) {
			disposeOverlayLabel(tempConstellationLabel);
			tempConstellationLabel = null;
		}
	}

	// --- Pan camera to RA/Dec position ---
	export function panToRaDec(ra: number, dec: number, fov?: number) {
		if (!controlsRef || !cameraRef) return;
		cancelGlobeTransition();
		cancelCameraAnimation();

		const targetDir = raDecToXYZ(ra, dec);
		const localNorth = new THREE.Vector3(
			-Math.sin(dec) * Math.cos(ra),
			Math.cos(dec),
			Math.sin(dec) * Math.sin(ra)
		).normalize();

		const targetFov = globeViewActive ? getGlobeFov() : (fov ?? Math.min(60, cameraRef.fov));

		if (globeViewActive) {
			const camDist = GLOBE_DISTANCE;
			const globeCamDir = targetDir.clone().negate();
			const endPos = globeCamDir.clone().multiplyScalar(camDist);

			if (reducedMotion) {
				cameraRef.position.copy(endPos);
				controlsRef.target.set(0, 0, 0);
				cameraRef.up.copy(localNorth);
				syncControlsUp(controlsRef, cameraRef.up);
				cameraRef.fov = targetFov;
				cameraRef.updateProjectionMatrix();
				controlsRef.update();
				return;
			}

			const startPos = cameraRef.position.clone();
			const startUp = cameraRef.up.clone();
			const startFov = cameraRef.fov;
			const startDir = startPos.clone().normalize();
			const angularDist = Math.acos(Math.min(1, Math.max(-1, startDir.dot(globeCamDir))));
			const duration = 300 + 500 * Math.min(1, angularDist / Math.PI);
			const startTime = performance.now();

			const qStart = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), startDir);
			const qEnd = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), globeCamDir);
			const qSlerp = new THREE.Quaternion();
			const slerpedDir = new THREE.Vector3();

			runCameraAnimation(() => {
				if (!cameraRef || !controlsRef) return false;
				const elapsed = performance.now() - startTime;
				const t = Math.min(1, elapsed / duration);
				const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
				qSlerp.slerpQuaternions(qStart, qEnd, ease);
				slerpedDir.set(0, 0, 1).applyQuaternion(qSlerp);
				cameraRef.position.copy(slerpedDir.multiplyScalar(camDist));
				controlsRef.target.set(0, 0, 0);
				cameraRef.up.lerpVectors(startUp, localNorth, ease).normalize();
				syncControlsUp(controlsRef, cameraRef.up);
				cameraRef.fov = startFov + (targetFov - startFov) * ease;
				cameraRef.updateProjectionMatrix();
				controlsRef.update();
				return t < 1;
			});
			return;
		}

		// Reduced motion: jump instantly
		if (reducedMotion) {
			cameraRef.position.set(0, 0, 0.0001);
			controlsRef.target.copy(cameraRef.position).addScaledVector(targetDir, 0.001);
			cameraRef.up.copy(localNorth);
			syncControlsUp(controlsRef, cameraRef.up);
			cameraRef.fov = targetFov;
			cameraRef.updateProjectionMatrix();
			controlsRef.update();
			return;
		}

		const startPos = cameraRef.position.clone();
		const lookDir = controlsRef.target.clone().sub(startPos).normalize();
		const startUp = cameraRef.up.clone();
		const startFov = cameraRef.fov;
		const angularDist = Math.acos(Math.min(1, Math.max(-1, lookDir.dot(targetDir))));
		const duration = 300 + 500 * Math.min(1, angularDist / Math.PI);
		const startTime = performance.now();

		const qStart = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), lookDir);
		const qEnd = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), targetDir);
		const qSlerp = new THREE.Quaternion();
		const slerpedDir = new THREE.Vector3();
		const origin = new THREE.Vector3(0, 0, 0.0001);

		runCameraAnimation(() => {
			if (!cameraRef || !controlsRef) return false;
			const elapsed = performance.now() - startTime;
			const t = Math.min(1, elapsed / duration);
			const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
			cameraRef.position.lerpVectors(startPos, origin, ease);
			qSlerp.slerpQuaternions(qStart, qEnd, ease);
			slerpedDir.set(0, 0, -1).applyQuaternion(qSlerp);
			controlsRef.target.copy(cameraRef.position).addScaledVector(slerpedDir, 0.001);
			cameraRef.up.lerpVectors(startUp, localNorth, ease).normalize();
			syncControlsUp(controlsRef, cameraRef.up);
			cameraRef.fov = startFov + (targetFov - startFov) * ease;
			cameraRef.updateProjectionMatrix();
			controlsRef.update();
			return t < 1;
		});
	}

	// --- Pan to IAU constellation centroid with FOV fitting ---
	export function panToIAUConstellation(constellationName: string) {
		if (!controlsRef || !cameraRef) return;

		if (resolvedConstellations.length === 0) resolveConstellations();
		const rc = resolvedConstellations.find(c => c.name === constellationName);
		if (!rc) return;

		const centroidDir = rc.centroid.clone();
		const centroidRa = Math.atan2(-centroidDir.z, centroidDir.x);
		const centroidDec = Math.asin(Math.max(-1, Math.min(1, centroidDir.y)));
		const localNorth = new THREE.Vector3(
			-Math.sin(centroidDec) * Math.cos(centroidRa),
			Math.cos(centroidDec),
			Math.sin(centroidDec) * Math.sin(centroidRa)
		).normalize();

		let targetFov: number;
		if (globeViewActive) {
			targetFov = getGlobeFov();
		} else {
			const testCam = new THREE.PerspectiveCamera(60, cameraRef.aspect, 0.1, 10);
			testCam.position.set(0, 0, 0.0001);
			testCam.up.copy(localNorth);
			testCam.lookAt(centroidDir.clone().multiplyScalar(10));
			const fitMargin = 0.85;
			const maxFov = cameraRef.aspect < 0.8 ? 110 : 80;
			let lo = 5, hi = maxFov + 10;
			for (let i = 0; i < 16; i++) {
				const mid = (lo + hi) / 2;
				testCam.fov = mid;
				testCam.updateProjectionMatrix();
				let fits = true;
				for (const pos of rc.hlPositions) {
					const ndc = pos.clone().project(testCam);
					if (Math.abs(ndc.x) > fitMargin || Math.abs(ndc.y) > fitMargin) { fits = false; break; }
				}
				if (fits) hi = mid; else lo = mid;
			}
			targetFov = Math.min(maxFov, Math.max(15, hi));
		}

		panToRaDec(centroidRa, centroidDec, targetFov);
	}

	export function captureImage(): Promise<Blob> {
		return new Promise((resolve, reject) => {
			if (!container || !sceneRef || !overlaySceneRef || !cameraRef || !overlayCameraRef) {
				return reject(new Error('Scene not ready'));
			}

			const width = container.clientWidth;
			const height = container.clientHeight;
			const pixelRatio = rendererRef?.getPixelRatio() ?? Math.min(window.devicePixelRatio, 2);
			const captureRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
			captureRenderer.getContext().drawingBufferColorSpace = 'srgb';
			captureRenderer.autoClear = false;
			captureRenderer.setPixelRatio(pixelRatio);
			captureRenderer.setSize(width, height, false);
			captureRenderer.setClearColor(0x000005);

			cameraRef.updateMatrixWorld();
			overlayCameraRef.updateMatrixWorld();
			updateOverlayLabels(performance.now());
			captureRenderer.clear();
			captureRenderer.render(sceneRef, cameraRef);
			captureRenderer.clearDepth();
			captureRenderer.render(overlaySceneRef, overlayCameraRef);

			captureRenderer.domElement.toBlob((blob) => {
				captureRenderer.dispose();
				captureRenderer.forceContextLoss();
				if (blob) resolve(blob);
				else reject(new Error('Failed to capture image'));
			}, 'image/png');
		});
	}

	onMount(() => {
		const scene = new THREE.Scene();
		sceneRef = scene;
		const overlayScene = new THREE.Scene();
		overlaySceneRef = overlayScene;

		const camera = new THREE.PerspectiveCamera(
			DEFAULT_FOV, container.clientWidth / container.clientHeight, 0.1, 10
		);
		camera.position.set(0, 0, 0.0001);
		cameraRef = camera;
		const overlayCamera = new THREE.OrthographicCamera(
			-container.clientWidth / 2,
			container.clientWidth / 2,
			container.clientHeight / 2,
			-container.clientHeight / 2,
			0.1,
			10
		);
		overlayCamera.position.z = 1;
		overlayCameraRef = overlayCamera;

		const renderer = new THREE.WebGLRenderer({ antialias: true });
		renderer.getContext().drawingBufferColorSpace = 'srgb';
		renderer.autoClear = false;
		renderer.setSize(container.clientWidth, container.clientHeight);
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.setClearColor(0x000005);
		rendererRef = renderer;
		rendererSize.set(container.clientWidth, container.clientHeight);
		container.appendChild(renderer.domElement);

		const controls = new OrbitControls(camera, renderer.domElement);
		controls.enablePan = false;
		controls.enableZoom = false;
		controls.rotateSpeed = -0.25;
		controls.enableDamping = true;
		controls.dampingFactor = 0.08;
		controls.autoRotate = autoRotateActive;
		controls.autoRotateSpeed = 0.15;
		// Defer left-button orbit until the pointer clears the click threshold.
		controls.mouseButtons.LEFT = -1 as THREE.MOUSE;
		// Defer one-finger orbit until the touch clears the click threshold.
		controls.touches.ONE = -1 as THREE.TOUCH;

		// Scale rotation speed based on viewport and FOV so dragging feels
		// consistent across screen sizes and zoom levels
		function updateRotateSpeed() {
			const baseFov = DEFAULT_FOV;
			const fovScale = camera.fov / baseFov;
			const sizeScale = Math.min(container.clientWidth, container.clientHeight) / 800;
			const sign = globeViewActive ? 1 : -1;
			controls.rotateSpeed = sign * 0.25 * fovScale / sizeScale;
		}
		updateRotateSpeed();
		// Tilt default view 15° below the equator for a better sense of the sphere
		const tiltRad = 15 * Math.PI / 180;
		controls.target.set(0, -Math.sin(tiltRad) * 0.001, -Math.cos(tiltRad) * 0.001);
		controls.minDistance = 0.0001;
		controls.maxDistance = 0.01;
		controls.update();
		controlsRef = controls;
		const controlsInternal = controls as OrbitControls & {
			_handleMouseDownRotate: (event: { clientX: number; clientY: number }) => void;
			_handleMouseMoveRotate: (event: { clientX: number; clientY: number }) => void;
			_handleTouchStartRotate: (event: { pointerId?: number; pageX: number; pageY: number }) => void;
			_handleTouchMoveRotate: (event: { pointerId?: number; pageX: number; pageY: number }) => void;
		};

		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			if (globeTransitionActive) return;
			if (globeViewActive) {
				// Zoom by changing camera distance
				const dist = camera.position.length();
				const newDist = Math.max(1.5, Math.min(6.0, dist + e.deltaY * 0.003));
				camera.position.normalize().multiplyScalar(newDist);
			} else {
				camera.fov = Math.max(10, Math.min(120, camera.fov + e.deltaY * 0.05));
				camera.updateProjectionMatrix();
				updateRotateSpeed();
			}
		};
		renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

		// --- Pinch-to-zoom touch support ---
		let isPinching = false;
		let pinchStartCamDist = GLOBE_DISTANCE;
		let pinchResumeAutoRotate = false;

		function getTouchDistance(t1: Touch, t2: Touch): number {
			const dx = t1.clientX - t2.clientX;
			const dy = t1.clientY - t2.clientY;
			return Math.sqrt(dx * dx + dy * dy);
		}

		const onTouchStart = (e: TouchEvent) => {
			if (globeTransitionActive) return;
			if (e.touches.length === 2) {
				isPinching = true;
				clickStart = null;
				cleanupOrbitDrag();
				pinchResumeAutoRotate = controls.autoRotate;
				controls.autoRotate = false;
				pinchStartDist = getTouchDistance(e.touches[0], e.touches[1]);
				pinchStartFov = camera.fov;
				pinchStartCamDist = camera.position.length();
			}
		};

		const onTouchMove = (e: TouchEvent) => {
			if (globeTransitionActive) {
				e.preventDefault();
				return;
			}
			if (e.touches.length === 2 && isPinching) {
				e.preventDefault();
				const currentDist = getTouchDistance(e.touches[0], e.touches[1]);
				const scale = pinchStartDist / currentDist;
				if (globeViewActive) {
					const newDist = Math.max(1.5, Math.min(6.0, pinchStartCamDist * scale));
					camera.position.normalize().multiplyScalar(newDist);
				} else {
					camera.fov = Math.max(10, Math.min(120, pinchStartFov * scale));
					camera.updateProjectionMatrix();
					updateRotateSpeed();
				}
			}
		};

		const onTouchEnd = (e: TouchEvent) => {
			if (globeTransitionActive) return;
			if (e.touches.length < 2) {
				isPinching = false;
				pinchStartDist = 0;
				if (e.touches.length === 0) {
					controls.autoRotate = pinchResumeAutoRotate;
					pinchResumeAutoRotate = false;
				}
			}
		};

		renderer.domElement.addEventListener('touchstart', onTouchStart, { passive: true });
		renderer.domElement.addEventListener('touchmove', onTouchMove, { passive: false });
		renderer.domElement.addEventListener('touchend', onTouchEnd, { passive: true });

		// Prevent iOS Safari pinch-to-zoom on the page
		const onGestureStart = (e: Event) => { e.preventDefault(); };
		renderer.domElement.addEventListener('gesturestart', onGestureStart, { passive: false } as any);

		// --- Build star geometry with custom attributes ---
		const count = stars.length;
		const positions = new Float32Array(count * 3);
		const magnitudes = new Float32Array(count);
		const colorIndices = new Float32Array(count);

		const named = new Float32Array(count);

		for (let i = 0; i < count; i++) {
			const s = stars[i];
			const pos = raDecToXYZ(s.ra, s.dec);
			positions[i * 3] = pos.x;
			positions[i * 3 + 1] = pos.y;
			positions[i * 3 + 2] = pos.z;
			magnitudes[i] = s.mag;
			colorIndices[i] = s.ci ?? 0.62; // Default to solar-type if missing
			named[i] = s.name ? 1.0 : 0.0;
		}

		const indices = new Float32Array(count);
		for (let i = 0; i < count; i++) indices[i] = i;

		const starGeom = new THREE.BufferGeometry();
		starGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
		starGeom.setAttribute('aMag', new THREE.Float32BufferAttribute(magnitudes, 1));
		starGeom.setAttribute('aColorIndex', new THREE.Float32BufferAttribute(colorIndices, 1));
		starGeom.setAttribute('aIndex', new THREE.Float32BufferAttribute(indices, 1));
		starGeom.setAttribute('aNamed', new THREE.Float32BufferAttribute(named, 1));

		const uniforms = {
			uDim: new THREE.Uniform(1.0),
			uTime: new THREE.Uniform(0.0),
			uFovScale: new THREE.Uniform(1.0),
			uHoveredIndex: new THREE.Uniform(-1.0),
			uBrightness: new THREE.Uniform(1.0),
			uMonochrome: new THREE.Uniform(0.0),
			uShowSun: new THREE.Uniform(0.0),
		};
		uniformsRef = uniforms;

		const starMat = new THREE.ShaderMaterial({
			vertexShader,
			fragmentShader,
			uniforms,
			transparent: true,
			depthTest: false,
			blending: THREE.AdditiveBlending,
		});

		const starPoints = new THREE.Points(starGeom, starMat);
		starPointsRef = starPoints;
		scene.add(starPoints);

		// --- Meteor (shooting star) group ---
		const mGroup = new THREE.Group();
		meteorGroup = mGroup;
		scene.add(mGroup);
		scheduleMeteor();

		// --- Comet group ---
		const cGroup = new THREE.Group();
		cometGroup = cGroup;
		scene.add(cGroup);
		scheduleComet();

		starPositionData = positions;
		updateStarProjectionCache(camera, container.clientWidth, container.clientHeight);

		let hoveredIdx = -1;

		// --- Vertex drag handlers (mouse + touch) ---
		let longPressTimer: ReturnType<typeof setTimeout> | null = null;
		const LONG_PRESS_MS = 400;
		const CLICK_THRESHOLD = 8; // max px movement to count as click
		const CLICK_MAX_MS = 300; // max duration
		let orbitDragState: {
			pointerId: number;
			pointerType: 'mouse' | 'touch';
			startMouse: { x: number; y: number };
			startPage: { x: number; y: number };
			committed: boolean;
			resumeAutoRotate: boolean;
		} | null = null;

		function commitDrag() {
			if (!dragState || dragState.committed) return;
			dragState.committed = true;
			controls.enabled = false;
			hoveredIdx = -1;
			uniforms.uHoveredIndex.value = -1.0;
			tooltip.style.opacity = '0';
			container.style.cursor = 'grabbing';
		}

		function cancelLongPress() {
			if (longPressTimer) {
				clearTimeout(longPressTimer);
				longPressTimer = null;
			}
		}

		function cleanupDrag() {
			cancelLongPress();
			if (dragState?.dragGroup && sceneRef) {
				disposeObject3D(dragState.dragGroup);
			}
			dragState = null;
			controls.enabled = true;
			container.style.cursor = '';
		}

		function cleanupOrbitDrag() {
			if (!orbitDragState) return;
			if (orbitDragState.committed) {
				controls.autoRotate = orbitDragState.resumeAutoRotate;
				clickStart = null;
			}
			orbitDragState = null;
			if (!dragState) {
				container.style.cursor = '';
			}
		}

		const onDragPointerDown = (e: PointerEvent) => {
			if (e.button !== 0 || currentResults.length === 0 || globeTransitionActive) return;
			const rect = container.getBoundingClientRect();
			const mx = e.clientX - rect.left;
			const my = e.clientY - rect.top;
			camera.updateMatrixWorld();
			const pick = findPickedVertex(mx, my, camera, rect.width, rect.height);
			if (pick) {
				dragState = {
					active: true,
					constellationIndex: pick.constellationIndex,
					nodeIndex: pick.nodeIndex,
					startMouse: { x: e.clientX, y: e.clientY },
					committed: false,
					candidateStar: null,
					dragGroup: null,
				};

				// For touch: start long-press timer to commit drag
				if (e.pointerType === 'touch') {
					longPressTimer = setTimeout(() => {
						longPressTimer = null;
						if (dragState && !dragState.committed) {
							commitDrag();
							// Show initial snap candidate at the press location
							const r = container.getBoundingClientRect();
							const candidate = findNearestStarToScreen(
								mx, my, camera, r.width, r.height
							);
							if (dragState) {
								dragState.candidateStar = candidate;
								updateDragVisual(candidate);
							}
						}
					}, LONG_PRESS_MS);
				}
			}
		};

		const onDragPointerMove = (e: PointerEvent) => {
			if (orbitDragState?.pointerId === e.pointerId && !dragState) {
				const dx = e.clientX - orbitDragState.startMouse.x;
				const dy = e.clientY - orbitDragState.startMouse.y;
				const dist = Math.sqrt(dx * dx + dy * dy);

				if (!orbitDragState.committed) {
					if (dist < CLICK_THRESHOLD) return;
					orbitDragState.committed = true;
					orbitDragState.resumeAutoRotate = controls.autoRotate;
					controls.autoRotate = false;
					hoveredIdx = -1;
					uniforms.uHoveredIndex.value = -1.0;
					tooltip.style.opacity = '0';
					container.style.cursor = 'grabbing';
					if (orbitDragState.pointerType === 'touch') {
						controlsInternal._handleTouchStartRotate({
							pointerId: orbitDragState.pointerId,
							pageX: orbitDragState.startPage.x,
							pageY: orbitDragState.startPage.y,
						});
					} else {
						controlsInternal._handleMouseDownRotate({
							clientX: orbitDragState.startMouse.x,
							clientY: orbitDragState.startMouse.y,
						});
					}
				}

				if (orbitDragState.pointerType === 'touch') {
					if (isPinching) return;
					controlsInternal._handleTouchMoveRotate({
						pointerId: e.pointerId,
						pageX: e.pageX,
						pageY: e.pageY,
					});
				} else {
					controlsInternal._handleMouseMoveRotate(e);
				}
				controls.update();
				return;
			}

			if (!dragState || !dragState.active) return;
			const dx = e.clientX - dragState.startMouse.x;
			const dy = e.clientY - dragState.startMouse.y;
			const dist = Math.sqrt(dx * dx + dy * dy);

			if (!dragState.committed) {
				if (e.pointerType === 'touch') {
					// For touch: if finger moves too far before long-press fires, cancel
					if (dist > 10) {
						cancelLongPress();
						dragState = null;
					}
					return;
				}
				// For mouse: commit after small movement
				if (dist < DRAG_COMMIT_THRESHOLD) return;
				commitDrag();
			}

			const rect = container.getBoundingClientRect();
			const mx = e.clientX - rect.left;
			const my = e.clientY - rect.top;
			camera.updateMatrixWorld();

			// Find nearest star to snap to (including the original)
			const candidate = findNearestStarToScreen(mx, my, camera, rect.width, rect.height);

			dragState.candidateStar = candidate;
			updateDragVisual(candidate);

			// Show tooltip for candidate
			if (candidate) {
				const label = candidate.name || `HIP ${candidate.id}`;
				tooltip.textContent = label;
				tooltip.style.opacity = '1';
				tooltip.style.left = `${e.clientX + 14}px`;
				tooltip.style.top = `${e.clientY + 14}px`;
			} else {
				tooltip.style.opacity = '0';
			}
		};

		const onDragPointerUp = (e: PointerEvent) => {
			cancelLongPress();
			if (orbitDragState?.pointerId === e.pointerId) {
				cleanupOrbitDrag();
			}
			if (!dragState || !dragState.active) return;

			if (dragState.committed && dragState.candidateStar) {
				const { constellationIndex, nodeIndex, candidateStar } = dragState;
				cleanupDrag();
				tooltip.style.opacity = '0';
				onVertexDrag({ constellationIndex, nodeIndex, newStar: candidateStar });
			} else {
				cleanupDrag();
			}
		};

		// --- Star click detection (distinct from drag and orbit) ---
		let clickStart: { x: number; y: number; time: number } | null = null;

		const onStarPointerDown = (e: PointerEvent) => {
			if (e.button !== 0) return;
			if (globeTransitionActive) return;
			clickStart = { x: e.clientX, y: e.clientY, time: performance.now() };
			if (!dragState) {
				orbitDragState = {
					pointerId: e.pointerId,
					pointerType: e.pointerType === 'touch' ? 'touch' : 'mouse',
					startMouse: { x: e.clientX, y: e.clientY },
					startPage: { x: e.pageX, y: e.pageY },
					committed: false,
					resumeAutoRotate: controls.autoRotate,
				};
			}
		};

		const onStarPointerUp = (e: PointerEvent) => {
			if (!clickStart) return;
			// If a vertex drag was active, skip star click
			if (dragState) { clickStart = null; return; }

			const dx = e.clientX - clickStart.x;
			const dy = e.clientY - clickStart.y;
			const dist = Math.sqrt(dx * dx + dy * dy);
			const elapsed = performance.now() - clickStart.time;
			clickStart = null;

			if (dist > CLICK_THRESHOLD || elapsed > CLICK_MAX_MS) return;

			const rect = container.getBoundingClientRect();
			const mx = e.clientX - rect.left;
			const my = e.clientY - rect.top;
			camera.updateMatrixWorld();

			const star = findNearestStarToScreen(mx, my, camera, rect.width, rect.height);
			if (star) {
				onStarClick(star, { x: e.clientX, y: e.clientY });
			}
		};

		renderer.domElement.addEventListener('pointerdown', onDragPointerDown);
		renderer.domElement.addEventListener('pointerdown', onStarPointerDown);
		renderer.domElement.addEventListener('pointermove', onDragPointerMove);
		renderer.domElement.addEventListener('pointerup', onDragPointerUp);
		renderer.domElement.addEventListener('pointerup', onStarPointerUp);

		const onMouseMove = (e: PointerEvent) => {
			// Suppress hover tooltips on touch/pen devices
			if (e.pointerType !== 'mouse') return;
			// Suppress hover during vertex drag
			if (dragState?.committed || orbitDragState?.committed) return;

			const rect = container.getBoundingClientRect();
			const mx = e.clientX - rect.left;
			const my = e.clientY - rect.top;
			const w = rect.width;
			const h = rect.height;

			// Ensure camera matrices are current
			camera.updateMatrixWorld();
			const bestStar = findNearestStarToScreen(mx, my, camera, w, h, undefined, STAR_HOVER_THRESHOLD);

			// Check if hovering over a constellation vertex — show grab cursor
			if (currentResults.length > 0) {
				const pick = findPickedVertex(mx, my, camera, w, h);
				if (pick && !dragState) {
					container.style.cursor = 'grab';
				} else if (!dragState) {
					container.style.cursor = '';
				}
			}

			if (bestStar && bestStar.idx !== hoveredIdx) {
				hoveredIdx = bestStar.idx;
				uniforms.uHoveredIndex.value = bestStar.idx;
				tooltip.textContent = bestStar.name || `HIP ${bestStar.id}`;
				tooltip.style.opacity = '1';
			} else if (!bestStar && hoveredIdx >= 0) {
				hoveredIdx = -1;
				uniforms.uHoveredIndex.value = -1.0;
				tooltip.style.opacity = '0';
			}

			if (bestStar) {
				tooltip.style.left = `${e.clientX + 14}px`;
				tooltip.style.top = `${e.clientY + 14}px`;
			}
		};

		renderer.domElement.addEventListener('pointermove', onMouseMove);

		const onPointerLeave = () => {
			if (hoveredIdx >= 0) {
				hoveredIdx = -1;
				uniforms.uHoveredIndex.value = -1.0;
				tooltip.style.opacity = '0';
			}
		};
		renderer.domElement.addEventListener('pointerleave', onPointerLeave);

		// Render loop
		let animId: number;
		const clock = new THREE.Clock();
		function render() {
			animId = requestAnimationFrame(render);
			const dt = clock.getDelta();
			const elapsedTime = clock.getElapsedTime();
			uniforms.uTime.value = elapsedTime;
			// Stars grow as you zoom in (lower FOV or closer distance in globe mode)
			// Globe view transitions manage their own fovScale
			if (!globeTransitionFovOverride) {
				if (globeViewActive) {
					// Only scale by distance — ignore FOV since it's fixed for framing
					uniforms.uFovScale.value = GLOBE_DISTANCE / camera.position.length() * 0.4;
				} else {
					uniforms.uFovScale.value = DEFAULT_FOV / camera.fov;
				}
			}
			// Sync ring materials — clamp so rings stay readable in globe view
			const ringFovScale = Math.max(uniforms.uFovScale.value, 0.7);
			for (const mat of ringMaterials) mat.uniforms.uFovScale.value = ringFovScale;
			if (starHighlightRingMat) starHighlightRingMat.uniforms.uFovScale.value = ringFovScale;

			// Update camera heading readout when grid is active
			if (coordGridActive) {
				const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
				// In globe mode the camera faces inward; show the far-side sky direction
				if (globeViewActive) dir.negate();
				const dec = Math.asin(Math.max(-1, Math.min(1, dir.y)));
				let ra = Math.atan2(-dir.z, dir.x);
				if (ra < 0) ra += Math.PI * 2;
				// Format RA as Xh Xm
				const raHours = (ra / (Math.PI * 2)) * 24;
				const raH = Math.floor(raHours);
				const raM = Math.floor((raHours - raH) * 60);
				// Format Dec as ±X° X′
				const decDeg = (dec * 180) / Math.PI;
				const decSign = decDeg >= 0 ? '+' : '\u2212';
				const decAbs = Math.abs(decDeg);
				const decD = Math.floor(decAbs);
				const decMn = Math.floor((decAbs - decD) * 60);
				cameraHeading = {
					ra: `${raH}h ${String(raM).padStart(2, '0')}m`,
					dec: `${decSign}${decD}\u00b0 ${String(decMn).padStart(2, '0')}\u2032`,
				};
			}
			// Update shooting stars and comets
			updateMeteors(dt);
			updateComets(dt);
			if (!globeTransitionFovOverride) {
				controls.update();
			} else {
				camera.updateMatrixWorld();
			}
			updateStarProjectionCache(camera, container.clientWidth, container.clientHeight);
			updateOverlayLabels(performance.now());
			renderer.clear();
			renderer.render(scene, camera);
			if (overlaySceneRef && overlayCameraRef) {
				renderer.clearDepth();
				renderer.render(overlaySceneRef, overlayCameraRef);
			}
		}
		render();

		function applyMobileViewOffset() {
			const w = container.clientWidth;
			const h = container.clientHeight;
			if (w <= 480) {
				// Shift the view upward by 8% of the viewport height
				const offsetY = Math.round(h * 0.08);
				camera.setViewOffset(w, h, 0, offsetY, w, h);
			} else {
				camera.clearViewOffset();
			}
		}

		const onResize = () => {
			camera.aspect = container.clientWidth / container.clientHeight;
			applyMobileViewOffset();
			camera.updateProjectionMatrix();
			if (overlayCameraRef) {
				overlayCameraRef.left = -container.clientWidth / 2;
				overlayCameraRef.right = container.clientWidth / 2;
				overlayCameraRef.top = container.clientHeight / 2;
				overlayCameraRef.bottom = -container.clientHeight / 2;
				overlayCameraRef.updateProjectionMatrix();
			}
			renderer.setSize(container.clientWidth, container.clientHeight);
			rendererSize.set(container.clientWidth, container.clientHeight);
			updateRotateSpeed();
			updateStarProjectionCache(camera, container.clientWidth, container.clientHeight);
		};
		applyMobileViewOffset();
		camera.updateProjectionMatrix();
		window.addEventListener('resize', onResize);

		// Handle WebGL context loss
		const onContextLost = (e: Event) => {
			e.preventDefault();
			cancelAnimationFrame(animId);
			cancelCameraAnimation();
			cancelGlobeTransition();
			stopAmbientCycle();
			stopMeteors();
			stopComets();
		};
		const onContextRestored = () => {
			render();
			if (constellationDisplayMode === 'all') {
				clearIAUOverlay();
				showIAUOverlay();
			} else if (constellationDisplayMode === 'ambient' && constellationGroups.length === 0) {
				startAmbientCycle();
			}
			scheduleMeteor();
			scheduleComet();
		};
		renderer.domElement.addEventListener('webglcontextlost', onContextLost);
		renderer.domElement.addEventListener('webglcontextrestored', onContextRestored);

		onReady();

		// Start ambient constellation cycling
		if (constellationDisplayMode === 'ambient') startAmbientCycle();

		return () => {
			cancelAnimationFrame(animId);
			cancelCameraAnimation();
			cancelGlobeTransition();
			stopAmbientCycle();
			clearAllConstellations();
			clearStarHighlight();
			clearTempConstellation();
			for (const { label } of iauLabelData) {
				disposeOverlayLabel(label);
			}
			iauLabelData = [];
			for (const sl of starLabelData) {
				disposeOverlayLabel(sl.label);
			}
			starLabelData = [];
			for (const label of coordGridLabels) {
				disposeOverlayLabel(label);
			}
			coordGridLabels = [];
			stopMeteors();
			stopComets();
			window.removeEventListener('resize', onResize);
			renderer.domElement.removeEventListener('wheel', onWheel);
			renderer.domElement.removeEventListener('pointermove', onMouseMove);
			renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
			renderer.domElement.removeEventListener('pointerdown', onDragPointerDown);
			renderer.domElement.removeEventListener('pointerdown', onStarPointerDown);
			renderer.domElement.removeEventListener('pointermove', onDragPointerMove);
			renderer.domElement.removeEventListener('pointerup', onDragPointerUp);
			renderer.domElement.removeEventListener('pointerup', onStarPointerUp);
			renderer.domElement.removeEventListener('touchstart', onTouchStart);
			renderer.domElement.removeEventListener('touchmove', onTouchMove);
			renderer.domElement.removeEventListener('touchend', onTouchEnd);
			renderer.domElement.removeEventListener('gesturestart', onGestureStart);
			renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
			renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
			controls.dispose();
			clearObjectChildren(scene);
			clearObjectChildren(overlayScene);
			renderer.dispose();
			if (renderer.domElement.parentNode) {
				renderer.domElement.parentNode.removeChild(renderer.domElement);
			}
			sceneRef = null;
			overlaySceneRef = null;
			cameraRef = null;
			overlayCameraRef = null;
			controlsRef = null;
			rendererRef = null;
			starPointsRef = null;
			starPositionData = null;
			starScreenX = new Float32Array(0);
			starScreenY = new Float32Array(0);
			starScreenVisible = new Uint8Array(0);
			starGridNext = new Int32Array(0);
			starGridHeads = new Int32Array(0);
			meteorGroup = null;
			cometGroup = null;
			coordGridGroup = null;
			iauOverlayGroup = null;
			starHighlightGroup = null;
			tempConstellationGroup = null;
		};
	});
</script>

<div bind:this={container} class="star-field" role="img" aria-label="Interactive 3D star field. Drag to rotate, scroll to zoom."></div>
<div bind:this={tooltip} class="star-tooltip" role="tooltip" aria-hidden="true"></div>

{#if coordGridActive}
	<div class="camera-heading" aria-live="polite">
		<span class="heading-label">RA</span> <span class="heading-value">{cameraHeading.ra}</span>
		<span class="heading-sep"></span>
		<span class="heading-label">Dec</span> <span class="heading-value">{cameraHeading.dec}</span>
	</div>
{/if}

<style>
	.star-field {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		touch-action: none;
	}

	.camera-heading {
		position: fixed;
		top: 16px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 100;
		pointer-events: none;
		font-family: monospace;
		font-size: 13px;
		letter-spacing: 0.5px;
		color: rgba(255, 255, 255, 0.5);
		background: rgba(0, 0, 0, 0.7);
		padding: 6px 12px;
		border-radius: 6px;
		border: 1px solid rgba(68, 136, 204, 0.2);
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.heading-label {
		color: rgba(68, 136, 204, 0.6);
		font-size: 11px;
	}

	.heading-value {
		color: rgba(200, 220, 255, 0.7);
	}

	.heading-sep {
		width: 1px;
		height: 12px;
		background: rgba(255, 255, 255, 0.15);
		margin: 0 2px;
	}

	@media (max-width: 480px) {
		.camera-heading {
			display: none;
		}
	}

	.star-tooltip {
		position: fixed;
		pointer-events: none;
		z-index: 100;
		color: #fff;
		font-size: 12px;
		letter-spacing: 1px;
		font-family: inherit;
		opacity: 0;
		transition: opacity 0.15s;
		white-space: nowrap;
		background: rgba(0, 0, 0, 0.6);
		padding: 4px 8px;
		border-radius: 4px;
		text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
	}
</style>
