<script lang="ts">
	import { onMount } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
	import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
	import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
	import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
	import type { Star, MatchResult } from '$lib/engine/types';
	import { CONSTELLATIONS } from '$lib/data/constellations';

	let { stars, onReady = () => {} }: {
		stars: Star[];
		onReady?: () => void;
	} = $props();

	let container: HTMLDivElement;
	let tooltip: HTMLDivElement;
	let sceneRef: THREE.Scene | null = null;
	let cameraRef: THREE.PerspectiveCamera | null = null;
	let controlsRef: OrbitControls | null = null;
	let constellationGroups: THREE.Group[] = [];
	let drawAnimationIds: number[] = [];
	let starPointsRef: THREE.Points | null = null;

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

	const MAX_METEORS = 3;
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
		const speed = (0.8 + Math.random() * 1.5); // radians per second
		const lifetime = 0.3 + Math.random() * 0.5; // 0.3-0.8 seconds
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
		if (!meteorsEnabled) return;
		const delay = 5000 + Math.random() * 10000; // 5-15 seconds
		meteorTimerId = setTimeout(spawnMeteor, delay);
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
		meteorsEnabled = true;
		scheduleMeteor();
	}

	// Ambient constellation cycling
	interface AmbientConstellation {
		name: string;
		group: THREE.Group;
		label: HTMLDivElement;
		edges: { posA: THREE.Vector3; posB: THREE.Vector3 }[];
		hlPositions: THREE.Vector3[];
		startTime: number;
		phase: 'draw' | 'hold' | 'fade';
		phaseStart: number;
		animId: number | null;
	}
	let ambientConstellations: AmbientConstellation[] = [];
	let ambientQueue: number[] = [];
	let ambientTimerId: ReturnType<typeof setTimeout> | null = null;
	let ambientPaused = false;
	let labelContainer: HTMLDivElement;
	let uniformsRef: { uDim: THREE.Uniform<number>; uTime: THREE.Uniform<number>; uFovScale: THREE.Uniform<number>; uHoveredIndex: THREE.Uniform<number> } | null = null;
	const DEFAULT_FOV = 60;
	let rendererSize = new THREE.Vector2(1, 1);

	// Touch support state
	let isTouchDevice = false;
	let pinchStartDist = 0;
	let pinchStartFov = DEFAULT_FOV;

	// IAU overlay state
	let iauOverlayActive = false;
	let iauOverlayGroup: THREE.Group | null = null;
	let iauOverlayLabels: HTMLDivElement[] = [];
	let iauLabelData: { label: HTMLDivElement; centroid: THREE.Vector3 }[] = [];

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
		varying float vMag;
		varying float vColorIndex;
		varying float vHover;
		varying float vNamed;
		varying float vSeed;

		void main() {
			vMag = aMag;
			vColorIndex = aColorIndex;
			vNamed = aNamed;
			vHover = (uHoveredIndex >= 0.0 && abs(aIndex - uHoveredIndex) < 0.5) ? 1.0 : 0.0;
			// Unique per-star seed derived from index
			vSeed = aIndex * 137.035999;

			vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
			gl_Position = projectionMatrix * mvPosition;

			// Apparent size based on magnitude (logarithmic flux)
			float flux = pow(10.0, -0.4 * (aMag - (-1.46)));
			float baseSize = 4.0 + 35.0 * pow(flux, 0.3);
			// Scale up as FOV decreases (zooming in)
			float hoverScale = 1.0 + vHover * 0.6;
			gl_PointSize = baseSize * uFovScale * hoverScale;
		}
	`;

	// Fragment shader: Airy-disk-like profile with color
	const fragmentShader = `
		uniform float uDim;
		uniform float uTime;
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

			// Slightly lighter core, colored halo
			vec3 coreColor = mix(starColor, vec3(1.0), 0.3);
			vec3 finalColor = mix(starColor, coreColor, core / max(profile, 0.001));

			// Overall brightness boost for dim stars
			float brightnessBoost = 1.0 + 0.3 * smoothstep(2.0, 6.5, vMag);

			float alpha = profile * uDim * brightnessBoost;

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
			if (group.parent) sceneRef?.remove(group);
		}
		constellationGroups = [];
	}

	function prepareForConstellation() {
		if (!sceneRef) return;

		// Stop ambient constellations when showing user's result
		if (!ambientPaused) stopAmbientCycle();

		// Pause meteors during constellation display
		if (meteorsEnabled) stopMeteors();

		// Dim background stars
		if (uniformsRef) uniformsRef.uDim.value = 0.55;

		// Dim IAU overlay further when showing user constellation
		if (iauOverlayActive && iauOverlayGroup) {
			iauOverlayGroup.traverse((child) => {
				if ((child as any).material && (child as any).material.opacity !== undefined) {
					(child as any).material.opacity *= 0.12;
				}
			});
		}
	}

	function drawConstellationAnimated(result: MatchResult) {
		if (!sceneRef) return;

		const constellationGroup = new THREE.Group();
		constellationGroups.push(constellationGroup);
		sceneRef.add(constellationGroup);

		const nodeToPos = new Map<number, THREE.Vector3>();
		for (const pair of result.pairs) {
			nodeToPos.set(pair.nodeIndex, raDecToXYZ(pair.star.ra, pair.star.dec).multiplyScalar(0.999));
		}

		// Collect valid edges with positions
		const edgeData: { posA: THREE.Vector3; posB: THREE.Vector3 }[] = [];
		const connectedNodes = new Set<number>();
		for (const [nA, nB] of result.graph.edges) {
			const posA = nodeToPos.get(nA);
			const posB = nodeToPos.get(nB);
			if (!posA || !posB) continue;
			edgeData.push({ posA: posA.clone(), posB: posB.clone() });
			connectedNodes.add(nA);
			connectedNodes.add(nB);
		}

		// Collect highlighted star positions
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

		// Track which stars have been revealed (by position key)
		const revealedStars = new Set<string>();
		const starKey = (v: THREE.Vector3) => `${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`;

		const hlMat = new THREE.ShaderMaterial({
			vertexShader: `
				void main() {
					vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
					gl_Position = projectionMatrix * mvPosition;
					gl_PointSize = 12.0;
				}
			`,
			fragmentShader: `
				void main() {
					float d = length(gl_PointCoord - 0.5) * 2.0;
					if (d > 1.0) discard;
					float alpha = exp(-d * d * 4.0) * 0.9;
					vec3 color = vec3(1.0, 1.0, 1.0);
					gl_FragColor = vec4(color * alpha, alpha);
				}
			`,
			transparent: true,
			depthTest: false,
			blending: THREE.AdditiveBlending,
		});

		// Ring shader for isolated nodes (periods/dots)
		const ringMat = new THREE.ShaderMaterial({
			vertexShader: `
				void main() {
					vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
					gl_Position = projectionMatrix * mvPosition;
					gl_PointSize = 28.0;
				}
			`,
			fragmentShader: `
				void main() {
					float d = length(gl_PointCoord - 0.5) * 2.0;
					if (d > 1.0) discard;
					// Ring profile: bright at radius ~0.65, fading inward and outward
					float ring = smoothstep(0.35, 0.55, d) * smoothstep(0.95, 0.7, d);
					// Soft inner glow
					float glow = exp(-d * d * 6.0) * 0.15;
					float alpha = (ring * 0.7 + glow);
					vec3 color = vec3(1.0, 1.0, 1.0);
					gl_FragColor = vec4(color * alpha, alpha);
				}
			`,
			transparent: true,
			depthTest: false,
			blending: THREE.AdditiveBlending,
		});

		const drawDuration = 300; // ms per edge to draw
		const stagger = 60; // ms between starting each edge
		const startTime = performance.now();

		function animateDraw() {
			if (!constellationGroup) return;

			const now = performance.now();
			const elapsed = now - startTime;

			// Remove old lines/points and rebuild
			while (constellationGroup.children.length > 0) {
				constellationGroup.remove(constellationGroup.children[0]);
			}

			const linePositions: number[] = [];
			const newStarsThisFrame: THREE.Vector3[] = [];

			for (let i = 0; i < edgeData.length; i++) {
				const edgeStart = i * stagger;
				const t = Math.min(1, Math.max(0, (elapsed - edgeStart) / drawDuration));
				if (t <= 0) continue;

				const { posA, posB } = edgeData[i];

				// Interpolate endpoint for drawing effect
				const currentX = posA.x + (posB.x - posA.x) * t;
				const currentY = posA.y + (posB.y - posA.y) * t;
				const currentZ = posA.z + (posB.z - posA.z) * t;

				linePositions.push(posA.x, posA.y, posA.z, currentX, currentY, currentZ);

				// Reveal start star
				const keyA = starKey(posA);
				if (!revealedStars.has(keyA)) {
					revealedStars.add(keyA);
					newStarsThisFrame.push(posA);
				}

				// Reveal end star when edge is complete
				if (t >= 1) {
					const keyB = starKey(posB);
					if (!revealedStars.has(keyB)) {
						revealedStars.add(keyB);
						newStarsThisFrame.push(posB);
					}
				}
			}

			if (linePositions.length > 0) {
				const segGeom = new LineSegmentsGeometry();
				segGeom.setPositions(linePositions);

				// Halo pass - wider, soft glow
				const haloMat = new LineMaterial({
					color: 0xffffff,
					linewidth: 8,
					transparent: true,
					opacity: 0.1,
					depthTest: false,
					blending: THREE.AdditiveBlending,
				});
				haloMat.resolution.copy(rendererSize);
				const halo = new LineSegments2(segGeom, haloMat);
				halo.renderOrder = 1;
				constellationGroup.add(halo);

				// Core pass - thinner, brighter
				const coreMat = new LineMaterial({
					color: 0xffffff,
					linewidth: 2.5,
					transparent: true,
					opacity: 0.4,
					depthTest: false,
					blending: THREE.AdditiveBlending,
				});
				coreMat.resolution.copy(rendererSize);
				const core = new LineSegments2(segGeom, coreMat);
				core.renderOrder = 1;
				constellationGroup.add(core);
			}

			// Build highlighted stars geometry from all revealed stars
			const starPositions: number[] = [];
			for (const pos of hlPositions) {
				if (revealedStars.has(starKey(pos))) {
					starPositions.push(pos.x, pos.y, pos.z);
				}
			}

			if (starPositions.length > 0) {
				const hlGeom = new THREE.BufferGeometry();
				hlGeom.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
				const points = new THREE.Points(hlGeom, hlMat);
				points.renderOrder = 2;
				constellationGroup.add(points);
			}

			// Render rings around isolated nodes (periods/dots)
			// Staggered after edges, each fading in over drawDuration
			if (isolatedPositions.length > 0) {
				const ringPositions: number[] = [];
				for (let j = 0; j < isolatedPositions.length; j++) {
					const ringStart = (edgeData.length + j) * stagger;
					const t = Math.min(1, Math.max(0, (elapsed - ringStart) / drawDuration));
					if (t > 0) {
						ringPositions.push(isolatedPositions[j].x, isolatedPositions[j].y, isolatedPositions[j].z);
					}
				}
				if (ringPositions.length > 0) {
					const ringGeom = new THREE.BufferGeometry();
					ringGeom.setAttribute('position', new THREE.Float32BufferAttribute(ringPositions, 3));
					const ringPoints = new THREE.Points(ringGeom, ringMat);
					ringPoints.renderOrder = 2;
					constellationGroup.add(ringPoints);
				}
			}

			// Continue until all elements are fully drawn
			const totalItems = edgeData.length + isolatedPositions.length;
			const totalDuration = totalItems > 0 ? (totalItems - 1) * stagger + drawDuration : 0;
			if (elapsed < totalDuration) {
				const id = requestAnimationFrame(animateDraw);
				drawAnimationIds.push(id);
			}
		}

		const id = requestAnimationFrame(animateDraw);
		drawAnimationIds.push(id);
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
		ambientTimerId = setTimeout(() => {
			if (ambientPaused) return;
			if (ambientQueue.length === 0) shuffleQueue();
			const idx = ambientQueue.pop()!;
			spawnAmbientConstellation(resolvedConstellations[idx]);
			// Schedule the next one
			scheduleNext(3000 + Math.random() * 2000);
		}, delay);
	}

	function stopAmbientCycle() {
		ambientPaused = true;
		if (ambientTimerId !== null) {
			clearTimeout(ambientTimerId);
			ambientTimerId = null;
		}
		// Fade out all active ambient constellations
		for (const ac of ambientConstellations) {
			if (ac.animId !== null) cancelAnimationFrame(ac.animId);
			if (ac.group.parent) sceneRef?.remove(ac.group);
			ac.label.remove();
		}
		ambientConstellations = [];
	}

	function resumeAmbientCycle() {
		ambientPaused = false;
		scheduleNext(1000);
		scheduleNext(2500);
		scheduleNext(4000);
	}

	const AMBIENT_DRAW_DURATION = 400;
	const AMBIENT_STAGGER = 80;
	const AMBIENT_HOLD = 5000;
	const AMBIENT_FADE = 3000;

	function spawnAmbientConstellation(rc: ResolvedConstellation) {
		if (!sceneRef || !cameraRef || ambientPaused) return;

		const group = new THREE.Group();
		sceneRef.add(group);

		// Create label
		const label = document.createElement('div');
		label.className = 'ambient-label';
		label.textContent = rc.name;
		label.style.opacity = '0';
		labelContainer.appendChild(label);

		const ac: AmbientConstellation = {
			name: rc.name,
			group,
			label,
			edges: rc.edges,
			hlPositions: rc.hlPositions,
			startTime: performance.now(),
			phase: 'draw',
			phaseStart: performance.now(),
			animId: null,
		};

		ambientConstellations.push(ac);

		const revealedStars = new Set<string>();
		const starKey = (v: THREE.Vector3) => `${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`;

		const totalDrawTime = (rc.edges.length - 1) * AMBIENT_STAGGER + AMBIENT_DRAW_DURATION;

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
				sceneRef?.remove(group);
				label.remove();
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

			// Clear and rebuild group
			while (group.children.length > 0) group.remove(group.children[0]);

			const drawElapsed = ac.phase === 'draw' ? phaseElapsed : totalDrawTime;
			const linePositions: number[] = [];

			for (let i = 0; i < rc.edges.length; i++) {
				const edgeStart = i * AMBIENT_STAGGER;
				const t = Math.min(1, Math.max(0, (drawElapsed - edgeStart) / AMBIENT_DRAW_DURATION));
				if (t <= 0) continue;

				const { posA, posB } = rc.edges[i];
				const cx = posA.x + (posB.x - posA.x) * t;
				const cy = posA.y + (posB.y - posA.y) * t;
				const cz = posA.z + (posB.z - posA.z) * t;
				linePositions.push(posA.x, posA.y, posA.z, cx, cy, cz);

				const kA = starKey(posA);
				if (!revealedStars.has(kA)) revealedStars.add(kA);
				if (t >= 1) {
					const kB = starKey(posB);
					if (!revealedStars.has(kB)) revealedStars.add(kB);
				}
			}

			if (linePositions.length > 0) {
				const segGeom = new LineSegmentsGeometry();
				segGeom.setPositions(linePositions);

				// Halo pass - wider, soft glow
				const haloMat = new LineMaterial({
					color: 0xffffff,
					linewidth: 6,
					transparent: true,
					opacity: 0.1 * opacity,
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
					opacity: 0.32 * opacity,
					depthTest: false,
					blending: THREE.AdditiveBlending,
				});
				coreMat.resolution.copy(rendererSize);
				const core = new LineSegments2(segGeom, coreMat);
				core.renderOrder = 1;
				group.add(core);
			}

			const starPositions: number[] = [];
			for (const pos of rc.hlPositions) {
				if (revealedStars.has(starKey(pos))) {
					starPositions.push(pos.x, pos.y, pos.z);
				}
			}

			if (starPositions.length > 0) {
				const hlGeom = new THREE.BufferGeometry();
				hlGeom.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
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
					uniforms: { uOpacity: new THREE.Uniform(opacity) },
					transparent: true,
					depthTest: false,
					blending: THREE.AdditiveBlending,
				});
				const points = new THREE.Points(hlGeom, hlMat);
				points.renderOrder = 2;
				group.add(points);
			}

			// Update label position
			if (cameraRef) {
				const projected = rc.centroid.clone().project(cameraRef);
				if (projected.z < 1) {
					const rect = container.getBoundingClientRect();
					const sx = (projected.x * 0.5 + 0.5) * rect.width;
					const sy = (-projected.y * 0.5 + 0.5) * rect.height;
					label.style.left = `${sx}px`;
					label.style.top = `${sy - 30}px`;
					const labelOpacity = ac.phase === 'draw'
						? Math.max(0, (phaseElapsed - totalDrawTime * 0.5) / (totalDrawTime * 0.5))
						: ac.phase === 'hold' ? 1
						: 1 - phaseElapsed / AMBIENT_FADE;
					label.style.opacity = `${Math.max(0, labelOpacity * 0.85)}`;
				} else {
					label.style.opacity = '0';
				}
			}

			ac.animId = requestAnimationFrame(animate);
		}

		ac.animId = requestAnimationFrame(animate);
	}

	export function clearLastConstellation() {
		if (constellationGroups.length > 0) {
			const last = constellationGroups.pop()!;
			if (last.parent) sceneRef?.remove(last);
		}
		// Cancel the most recent draw animation if any
		if (drawAnimationIds.length > 0) {
			cancelAnimationFrame(drawAnimationIds.pop()!);
		}
	}

	export function toggleIAUOverlay(show: boolean) {
		if (show === iauOverlayActive) return;
		iauOverlayActive = show;

		if (show) {
			if (!sceneRef || !cameraRef) return;

			// Ensure constellations are resolved
			if (resolvedConstellations.length === 0) resolveConstellations();

			// Stop ambient cycling
			stopAmbientCycle();

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

			// Create HTML labels for each constellation
			iauLabelData = [];
			iauOverlayLabels = [];
			for (const rc of resolvedConstellations) {
				const label = document.createElement('div');
				label.className = 'iau-overlay-label';
				label.textContent = rc.name;
				label.style.opacity = '0';
				labelContainer.appendChild(label);
				iauOverlayLabels.push(label);
				iauLabelData.push({ label, centroid: rc.centroid });
			}
		} else {
			// Remove overlay
			if (iauOverlayGroup && sceneRef) {
				sceneRef.remove(iauOverlayGroup);
				iauOverlayGroup = null;
			}
			for (const label of iauOverlayLabels) {
				label.remove();
			}
			iauOverlayLabels = [];
			iauLabelData = [];

			// Resume ambient cycling if no user constellation is active
			if (constellationGroups.length === 0) {
				resumeAmbientCycle();
			}
		}
	}

	function updateIAUOverlayLabels() {
		if (!iauOverlayActive || !cameraRef || !container) return;

		const cameraDir = new THREE.Vector3();
		cameraRef.getWorldDirection(cameraDir);
		const rect = container.getBoundingClientRect();

		for (const { label, centroid } of iauLabelData) {
			const dot = centroid.dot(cameraDir);
			if (dot > 0.3) {
				const projected = centroid.clone().project(cameraRef);
				if (projected.z < 1) {
					const sx = (projected.x * 0.5 + 0.5) * rect.width;
					const sy = (-projected.y * 0.5 + 0.5) * rect.height;
					label.style.left = `${sx}px`;
					label.style.top = `${sy}px`;
					label.style.opacity = '0.6';
				} else {
					label.style.opacity = '0';
				}
			} else {
				label.style.opacity = '0';
			}
		}
	}

	export function animateToMatch(result: MatchResult) {
		if (!controlsRef || !cameraRef) return;

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

		// Tight zoom: use the larger of p90 and max-based, with minimal padding
		const fovFromP90 = THREE.MathUtils.radToDeg(representativeAngle) * 2.2 + 3;
		const fovFromMax = THREE.MathUtils.radToDeg(maxAngle) * 1.8 + 2;
		const targetFov = Math.min(80, Math.max(10, Math.max(fovFromP90, fovFromMax)));
		const target = centroidDir.clone().multiplyScalar(0.001);

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

		// Derive start direction from the actual camera look direction,
		// not just the target — after orbiting, the camera has moved off origin.
		const startPos = cameraRef.position.clone();
		const lookDir = controlsRef.target.clone().sub(startPos).normalize();
		const endDir = centroidDir.clone();
		const startUp = cameraRef.up.clone();
		const startFov = cameraRef.fov;
		const duration = 1200;
		const startTime = performance.now();

		// Use quaternion slerp to rotate the look direction so the camera
		// always takes the short arc rather than swinging through the back.
		const qStart = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), lookDir);
		const qEnd = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), endDir);
		const qSlerp = new THREE.Quaternion();
		const slerpedDir = new THREE.Vector3();
		const origin = new THREE.Vector3(0, 0, 0.0001);

		const Y_UP = new THREE.Vector3(0, 1, 0);

		function animate() {
			const elapsed = performance.now() - startTime;
			const t = Math.min(1, elapsed / duration);
			const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
			// Move camera back to origin
			cameraRef!.position.lerpVectors(startPos, origin, ease);
			qSlerp.slerpQuaternions(qStart, qEnd, ease);
			slerpedDir.set(0, 0, -1).applyQuaternion(qSlerp);
			controlsRef!.target.copy(cameraRef!.position).addScaledVector(slerpedDir, 0.001);
			cameraRef!.up.lerpVectors(startUp, localNorth, ease).normalize();
			// OrbitControls caches the up-to-Y quaternion at construction time.
			// Update it each frame so the new up vector is respected.
			(controlsRef as any)._quat.setFromUnitVectors(cameraRef!.up, Y_UP);
			(controlsRef as any)._quatInverse.copy((controlsRef as any)._quat).invert();
			cameraRef!.fov = startFov + (targetFov - startFov) * ease;
			cameraRef!.updateProjectionMatrix();
			controlsRef!.update();
			if (t < 1) {
				requestAnimationFrame(animate);
			} else {
				// Camera arrived — start drawing the constellation
				drawConstellationAnimated(result);
			}
		}
		animate();
	}

	export function resetView() {
		if (!controlsRef || !cameraRef) return;

		clearAllConstellations();
		if (uniformsRef) uniformsRef.uDim.value = 1.0;
		// Restore IAU overlay opacity if it was dimmed
		if (iauOverlayActive && iauOverlayGroup) {
			let matIdx = 0;
			const restoreOpacities = [0.07, 0.22]; // halo, core
			iauOverlayGroup.traverse((child) => {
				if ((child as any).material && (child as any).material.opacity !== undefined) {
					(child as any).material.opacity = restoreOpacities[matIdx] ?? 0.22;
					matIdx++;
				}
			});
		}

		// Only resume ambient if IAU overlay is not active
		if (!iauOverlayActive && resolvedConstellations.length > 0) resumeAmbientCycle();
		if (!meteorsEnabled) resumeMeteors();

		const startPos = cameraRef.position.clone();
		const lookDir = controlsRef.target.clone().sub(startPos).normalize();
		const endDir = new THREE.Vector3(0, 0, -1);
		const startUp = cameraRef.up.clone();
		const defaultUp = new THREE.Vector3(0, 1, 0);
		const startFov = cameraRef.fov;
		const duration = 800;
		const startTime = performance.now();

		const qStart = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), lookDir);
		const qEnd = new THREE.Quaternion(); // identity — already pointing (0,0,-1)
		const qSlerp = new THREE.Quaternion();
		const slerpedDir = new THREE.Vector3();
		const origin = new THREE.Vector3(0, 0, 0.0001);

		const Y_UP = new THREE.Vector3(0, 1, 0);

		function animate() {
			const elapsed = performance.now() - startTime;
			const t = Math.min(1, elapsed / duration);
			const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
			cameraRef!.position.lerpVectors(startPos, origin, ease);
			qSlerp.slerpQuaternions(qStart, qEnd, ease);
			slerpedDir.set(0, 0, -1).applyQuaternion(qSlerp);
			controlsRef!.target.copy(cameraRef!.position).addScaledVector(slerpedDir, 0.001);
			cameraRef!.up.lerpVectors(startUp, defaultUp, ease).normalize();
			(controlsRef as any)._quat.setFromUnitVectors(cameraRef!.up, Y_UP);
			(controlsRef as any)._quatInverse.copy((controlsRef as any)._quat).invert();
			cameraRef!.fov = startFov + (DEFAULT_FOV - startFov) * ease;
			cameraRef!.updateProjectionMatrix();
			controlsRef!.update();
			if (t < 1) requestAnimationFrame(animate);
		}
		animate();
	}

	onMount(() => {
		const scene = new THREE.Scene();
		sceneRef = scene;

		const camera = new THREE.PerspectiveCamera(
			60, container.clientWidth / container.clientHeight, 0.1, 10
		);
		camera.position.set(0, 0, 0.0001);
		cameraRef = camera;

		const renderer = new THREE.WebGLRenderer({ antialias: true });
		renderer.setSize(container.clientWidth, container.clientHeight);
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.setClearColor(0x000005);
		rendererSize.set(container.clientWidth, container.clientHeight);
		container.appendChild(renderer.domElement);

		const controls = new OrbitControls(camera, renderer.domElement);
		controls.enablePan = false;
		controls.enableZoom = false;
		controls.rotateSpeed = -0.25;
		controls.enableDamping = true;
		controls.dampingFactor = 0.08;
		controls.target.set(0, 0, -0.001);
		controls.minDistance = 0.0001;
		controls.maxDistance = 0.01;
		controls.update();
		controlsRef = controls;

		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			camera.fov = Math.max(10, Math.min(120, camera.fov + e.deltaY * 0.05));
			camera.updateProjectionMatrix();
		};
		renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

		// --- Pinch-to-zoom touch support ---
		function getTouchDistance(t1: Touch, t2: Touch): number {
			const dx = t1.clientX - t2.clientX;
			const dy = t1.clientY - t2.clientY;
			return Math.sqrt(dx * dx + dy * dy);
		}

		const onTouchStart = (e: TouchEvent) => {
			isTouchDevice = true;
			if (e.touches.length === 2) {
				pinchStartDist = getTouchDistance(e.touches[0], e.touches[1]);
				pinchStartFov = camera.fov;
			}
		};

		const onTouchMove = (e: TouchEvent) => {
			if (e.touches.length === 2) {
				e.preventDefault();
				const currentDist = getTouchDistance(e.touches[0], e.touches[1]);
				const scale = pinchStartDist / currentDist;
				camera.fov = Math.max(10, Math.min(120, pinchStartFov * scale));
				camera.updateProjectionMatrix();
			}
		};

		const onTouchEnd = (_e: TouchEvent) => {
			pinchStartDist = 0;
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

		// --- Hover-to-show star label ---
		const starInfos: { label: string; pos: THREE.Vector3; idx: number }[] = [];
		for (let i = 0; i < stars.length; i++) {
			const s = stars[i];
			starInfos.push({
				label: s.name || `HIP ${s.id}`,
				pos: raDecToXYZ(s.ra, s.dec),
				idx: i,
			});
		}

		let hoveredIdx = -1;
		const projected = new THREE.Vector3();

		const onMouseMove = (e: MouseEvent) => {
			// Suppress hover tooltips on touch devices
			if (isTouchDevice) return;

			const rect = container.getBoundingClientRect();
			const mx = e.clientX - rect.left;
			const my = e.clientY - rect.top;
			const w = rect.width;
			const h = rect.height;

			// Ensure camera matrices are current
			camera.updateMatrixWorld();

			let bestDist = Infinity;
			let bestStar: typeof starInfos[0] | null = null;

			const threshold = 40;

			for (const si of starInfos) {
				projected.copy(si.pos);
				projected.project(camera);

				if (projected.z > 1) continue;

				const sx = (projected.x * 0.5 + 0.5) * w;
				const sy = (-projected.y * 0.5 + 0.5) * h;
				const dx = sx - mx;
				const dy = sy - my;
				const dist = Math.sqrt(dx * dx + dy * dy);

				if (dist < threshold && dist < bestDist) {
					bestDist = dist;
					bestStar = si;
				}
			}

			if (bestStar && bestStar.idx !== hoveredIdx) {
				hoveredIdx = bestStar.idx;
				uniforms.uHoveredIndex.value = bestStar.idx;
				tooltip.textContent = bestStar.label;
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

		renderer.domElement.addEventListener('mousemove', onMouseMove);

		// Render loop
		let animId: number;
		const clock = new THREE.Clock();
		function render() {
			animId = requestAnimationFrame(render);
			const dt = clock.getDelta();
			uniforms.uTime.value = clock.getElapsedTime();
			// Stars grow as you zoom in (lower FOV)
			uniforms.uFovScale.value = DEFAULT_FOV / camera.fov;
			// Update shooting stars
			updateMeteors(dt);
			controls.update();
			updateIAUOverlayLabels();
			renderer.render(scene, camera);
		}
		render();

		const onResize = () => {
			camera.aspect = container.clientWidth / container.clientHeight;
			camera.updateProjectionMatrix();
			renderer.setSize(container.clientWidth, container.clientHeight);
			rendererSize.set(container.clientWidth, container.clientHeight);
		};
		window.addEventListener('resize', onResize);

		onReady();

		// Start ambient constellation cycling
		startAmbientCycle();

		return () => {
			cancelAnimationFrame(animId);
			stopAmbientCycle();
			stopMeteors();
			window.removeEventListener('resize', onResize);
			renderer.domElement.removeEventListener('wheel', onWheel);
			renderer.domElement.removeEventListener('mousemove', onMouseMove);
			renderer.domElement.removeEventListener('touchstart', onTouchStart);
			renderer.domElement.removeEventListener('touchmove', onTouchMove);
			renderer.domElement.removeEventListener('touchend', onTouchEnd);
			renderer.domElement.removeEventListener('gesturestart', onGestureStart);
			renderer.dispose();
			if (renderer.domElement.parentNode) {
				renderer.domElement.parentNode.removeChild(renderer.domElement);
			}
		};
	});
</script>

<div bind:this={container} class="star-field"></div>
<div bind:this={labelContainer} class="ambient-labels"></div>
<div bind:this={tooltip} class="star-tooltip"></div>

<style>
	.star-field {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		touch-action: none;
	}

	.ambient-labels {
		position: absolute;
		inset: 0;
		pointer-events: none;
		z-index: 1;
	}

	:global(.iau-overlay-label) {
		position: absolute;
		transform: translate(-50%, -50%);
		color: rgba(255, 255, 255, 0.9);
		font-size: 13px;
		font-weight: 300;
		letter-spacing: 4px;
		text-transform: uppercase;
		white-space: nowrap;
		pointer-events: none;
		opacity: 0;
		text-shadow: 0 0 6px rgba(0, 0, 0, 0.8), 0 0 14px rgba(0, 0, 0, 0.5), 0 0 24px rgba(100, 150, 255, 0.3);
	}

	:global(.ambient-label) {
		position: absolute;
		transform: translateX(-50%);
		color: rgba(255, 255, 255, 0.9);
		font-size: 13px;
		font-weight: 300;
		letter-spacing: 4px;
		text-transform: uppercase;
		white-space: nowrap;
		pointer-events: none;
		opacity: 0;
		transition: opacity 0.3s;
		text-shadow: 0 0 6px rgba(0, 0, 0, 0.8), 0 0 14px rgba(0, 0, 0, 0.5), 0 0 24px rgba(100, 150, 255, 0.3);
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
