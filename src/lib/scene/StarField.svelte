<script lang="ts">
	import { onMount } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
	import type { Star, MatchResult } from '$lib/engine/types';

	let { stars, matchResult = $bindable(null), onReady = () => {} }: {
		stars: Star[];
		matchResult: MatchResult | null;
		onReady?: () => void;
	} = $props();

	let container: HTMLDivElement;
	let tooltip: HTMLDivElement;
	let sceneRef: THREE.Scene | null = null;
	let cameraRef: THREE.PerspectiveCamera | null = null;
	let controlsRef: OrbitControls | null = null;
	let constellationGroup: THREE.Group | null = null;
	let starPointsRef: THREE.Points | null = null;
	let uniformsRef: { uDim: THREE.Uniform<number>; uTime: THREE.Uniform<number>; uFovScale: THREE.Uniform<number>; uHoveredIndex: THREE.Uniform<number> } | null = null;
	const DEFAULT_FOV = 60;

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
		uniform float uFovScale;
		uniform float uHoveredIndex;
		varying float vMag;
		varying float vColorIndex;
		varying float vHover;

		void main() {
			vMag = aMag;
			vColorIndex = aColorIndex;
			vHover = (uHoveredIndex >= 0.0 && abs(aIndex - uHoveredIndex) < 0.5) ? 1.0 : 0.0;

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

			// Subtle scintillation for bright stars
			if (vMag < 3.0) {
				float rate = 2.0 + vMag * 0.5;
				float seed = gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233;
				alpha *= 0.92 + 0.08 * sin(uTime * rate + seed);
			}

			gl_FragColor = vec4(finalColor * alpha, alpha);
		}
	`;

	function updateConstellation(result: MatchResult | null) {
		if (!sceneRef) return;

		// Remove old
		if (constellationGroup) {
			sceneRef.remove(constellationGroup);
			constellationGroup = null;
		}

		if (!result) {
			if (uniformsRef) uniformsRef.uDim.value = 1.0;
			return;
		}

		constellationGroup = new THREE.Group();

		const nodeToPos = new Map<number, THREE.Vector3>();
		for (const pair of result.pairs) {
			nodeToPos.set(pair.nodeIndex, raDecToXYZ(pair.star.ra, pair.star.dec).multiplyScalar(0.999));
		}

		// Constellation lines - thin, elegant
		const linePositions: number[] = [];
		for (const [nA, nB] of result.graph.edges) {
			const posA = nodeToPos.get(nA);
			const posB = nodeToPos.get(nB);
			if (!posA || !posB) continue;
			linePositions.push(posA.x, posA.y, posA.z, posB.x, posB.y, posB.z);
		}

		if (linePositions.length > 0) {
			const lineGeom = new THREE.BufferGeometry();
			lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
			const lineMat = new THREE.LineBasicMaterial({
				color: 0x88bbff,
				transparent: true,
				opacity: 0.35,
				depthTest: false,
			});
			const lines = new THREE.LineSegments(lineGeom, lineMat);
			lines.renderOrder = 1;
			constellationGroup.add(lines);
		}

		// Highlighted star points - circular glow shader
		const hlPositions: number[] = [];
		for (const pair of result.pairs) {
			const pos = nodeToPos.get(pair.nodeIndex);
			if (pos) hlPositions.push(pos.x, pos.y, pos.z);
		}

		if (hlPositions.length > 0) {
			const hlGeom = new THREE.BufferGeometry();
			hlGeom.setAttribute('position', new THREE.Float32BufferAttribute(hlPositions, 3));
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
						vec3 color = vec3(0.85, 0.92, 1.0);
						gl_FragColor = vec4(color * alpha, alpha);
					}
				`,
				transparent: true,
				depthTest: false,
				blending: THREE.AdditiveBlending,
			});
			const points = new THREE.Points(hlGeom, hlMat);
			points.renderOrder = 2;
			constellationGroup.add(points);
		}

		sceneRef.add(constellationGroup);

		// Dim background stars (keep them visible)
		if (uniformsRef) uniformsRef.uDim.value = 0.55;
	}

	export function animateToMatch(result: MatchResult) {
		if (!controlsRef || !cameraRef) return;

		let cx = 0, cy = 0, cz = 0;
		const positions: THREE.Vector3[] = [];
		for (const pair of result.pairs) {
			const pos = raDecToXYZ(pair.star.ra, pair.star.dec);
			positions.push(pos);
			cx += pos.x; cy += pos.y; cz += pos.z;
		}
		const len = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
		const centroidDir = new THREE.Vector3(cx / len, cy / len, cz / len);

		let maxAngle = 0;
		for (const pos of positions) {
			const angle = Math.acos(Math.min(1, pos.dot(centroidDir)));
			if (angle > maxAngle) maxAngle = angle;
		}

		const targetFov = Math.min(120, Math.max(20, THREE.MathUtils.radToDeg(maxAngle) * 2.5 + 10));
		const target = centroidDir.clone().multiplyScalar(0.001);

		const startTarget = controlsRef.target.clone();
		const startFov = cameraRef.fov;
		const duration = 1200;
		const startTime = performance.now();

		function animate() {
			const elapsed = performance.now() - startTime;
			const t = Math.min(1, elapsed / duration);
			const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
			controlsRef!.target.lerpVectors(startTarget, target, ease);
			cameraRef!.fov = startFov + (targetFov - startFov) * ease;
			cameraRef!.updateProjectionMatrix();
			controlsRef!.update();
			if (t < 1) requestAnimationFrame(animate);
		}
		animate();
	}

	export function resetView() {
		if (!controlsRef || !cameraRef) return;
		const startTarget = controlsRef.target.clone();
		const startFov = cameraRef.fov;
		const endTarget = new THREE.Vector3(0, 0, -0.001);
		const duration = 800;
		const startTime = performance.now();

		function animate() {
			const elapsed = performance.now() - startTime;
			const t = Math.min(1, elapsed / duration);
			const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
			controlsRef!.target.lerpVectors(startTarget, endTarget, ease);
			cameraRef!.fov = startFov + (DEFAULT_FOV - startFov) * ease;
			cameraRef!.updateProjectionMatrix();
			controlsRef!.update();
			if (t < 1) requestAnimationFrame(animate);
		}
		animate();
	}

	$effect(() => {
		updateConstellation(matchResult);
	});

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

		// --- Build star geometry with custom attributes ---
		const count = stars.length;
		const positions = new Float32Array(count * 3);
		const magnitudes = new Float32Array(count);
		const colorIndices = new Float32Array(count);

		for (let i = 0; i < count; i++) {
			const s = stars[i];
			const pos = raDecToXYZ(s.ra, s.dec);
			positions[i * 3] = pos.x;
			positions[i * 3 + 1] = pos.y;
			positions[i * 3 + 2] = pos.z;
			magnitudes[i] = s.mag;
			colorIndices[i] = s.ci ?? 0.62; // Default to solar-type if missing
		}

		const indices = new Float32Array(count);
		for (let i = 0; i < count; i++) indices[i] = i;

		const starGeom = new THREE.BufferGeometry();
		starGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
		starGeom.setAttribute('aMag', new THREE.Float32BufferAttribute(magnitudes, 1));
		starGeom.setAttribute('aColorIndex', new THREE.Float32BufferAttribute(colorIndices, 1));
		starGeom.setAttribute('aIndex', new THREE.Float32BufferAttribute(indices, 1));

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
			uniforms.uTime.value = clock.getElapsedTime();
			// Stars grow as you zoom in (lower FOV)
			uniforms.uFovScale.value = DEFAULT_FOV / camera.fov;
			controls.update();
			renderer.render(scene, camera);
		}
		render();

		const onResize = () => {
			camera.aspect = container.clientWidth / container.clientHeight;
			camera.updateProjectionMatrix();
			renderer.setSize(container.clientWidth, container.clientHeight);
		};
		window.addEventListener('resize', onResize);

		onReady();

		return () => {
			cancelAnimationFrame(animId);
			window.removeEventListener('resize', onResize);
			renderer.domElement.removeEventListener('wheel', onWheel);
			renderer.domElement.removeEventListener('mousemove', onMouseMove);
			renderer.dispose();
			if (renderer.domElement.parentNode) {
				renderer.domElement.parentNode.removeChild(renderer.domElement);
			}
		};
	});
</script>

<div bind:this={container} class="star-field"></div>
<div bind:this={tooltip} class="star-tooltip"></div>

<style>
	.star-field {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
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
