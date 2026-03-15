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
	let sceneRef: THREE.Scene | null = null;
	let cameraRef: THREE.PerspectiveCamera | null = null;
	let controlsRef: OrbitControls | null = null;
	let constellationGroup: THREE.Group | null = null;
	let starMatRef: THREE.PointsMaterial | null = null;
	const DEFAULT_FOV = 60;

	function raDecToXYZ(ra: number, dec: number): THREE.Vector3 {
		return new THREE.Vector3(
			Math.cos(dec) * Math.cos(ra),
			Math.sin(dec),
			-Math.cos(dec) * Math.sin(ra)
		);
	}

	function updateConstellation(result: MatchResult | null) {
		if (!sceneRef) return;

		// Remove old
		if (constellationGroup) {
			sceneRef.remove(constellationGroup);
			constellationGroup = null;
		}

		if (!result) {
			// Restore background star brightness
			if (starMatRef) starMatRef.opacity = 0.9;
			return;
		}

		constellationGroup = new THREE.Group();

		// Build node index -> star position map
		// Pull positions slightly inward (0.999) so constellation renders in front of star sphere
		const nodeToPos = new Map<number, THREE.Vector3>();
		for (const pair of result.pairs) {
			nodeToPos.set(pair.nodeIndex, raDecToXYZ(pair.star.ra, pair.star.dec).multiplyScalar(0.999));
		}

		// Constellation lines
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
				color: 0xffb830,
				transparent: true,
				opacity: 0.5,
				depthTest: false,
			});
			const lines = new THREE.LineSegments(lineGeom, lineMat);
			lines.renderOrder = 1;
			constellationGroup.add(lines);
		}

		// Highlighted star points
		const hlPositions: number[] = [];
		for (const pair of result.pairs) {
			const pos = nodeToPos.get(pair.nodeIndex);
			if (pos) hlPositions.push(pos.x, pos.y, pos.z);
		}

		if (hlPositions.length > 0) {
			const hlGeom = new THREE.BufferGeometry();
			hlGeom.setAttribute('position', new THREE.Float32BufferAttribute(hlPositions, 3));
			const hlMat = new THREE.PointsMaterial({
				color: 0xffd700,
				size: 0.025,
				sizeAttenuation: true,
				depthTest: false,
			});
			const points = new THREE.Points(hlGeom, hlMat);
			points.renderOrder = 2;
			constellationGroup.add(points);
		}

		sceneRef.add(constellationGroup);

		// Dim background stars to make constellation stand out
		if (starMatRef) starMatRef.opacity = 0.3;
	}

	export function animateToMatch(result: MatchResult) {
		if (!controlsRef || !cameraRef) return;

		// Compute centroid direction on the unit sphere
		let cx = 0, cy = 0, cz = 0;
		const positions: THREE.Vector3[] = [];
		for (const pair of result.pairs) {
			const pos = raDecToXYZ(pair.star.ra, pair.star.dec);
			positions.push(pos);
			cx += pos.x; cy += pos.y; cz += pos.z;
		}
		const len = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
		const centroidDir = new THREE.Vector3(cx / len, cy / len, cz / len);

		// Compute angular extent: max angle from centroid to any star
		let maxAngle = 0;
		for (const pos of positions) {
			const angle = Math.acos(Math.min(1, pos.dot(centroidDir)));
			if (angle > maxAngle) maxAngle = angle;
		}

		// Set FOV to frame the constellation with padding
		const targetFov = Math.min(120, Math.max(20, THREE.MathUtils.radToDeg(maxAngle) * 2.5 + 10));

		// Target must stay near origin (camera is inside the sphere)
		// Use a tiny offset in the centroid direction
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
		renderer.setClearColor(0x000008);
		container.appendChild(renderer.domElement);

		const controls = new OrbitControls(camera, renderer.domElement);
		controls.enablePan = false;
		controls.enableZoom = false; // We handle zoom via FOV
		controls.rotateSpeed = -0.25;
		controls.enableDamping = true;
		controls.dampingFactor = 0.08;
		controls.target.set(0, 0, -0.001);
		controls.minDistance = 0.0001;
		controls.maxDistance = 0.01;
		controls.update();
		controlsRef = controls;

		// FOV-based zoom (scroll wheel changes field of view)
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			camera.fov = Math.max(10, Math.min(120, camera.fov + e.deltaY * 0.05));
			camera.updateProjectionMatrix();
		};
		renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

		// --- Star field using simple PointsMaterial ---
		const count = stars.length;
		const positions = new Float32Array(count * 3);
		const starColors = new Float32Array(count * 3);
		const starSizes = new Float32Array(count);

		for (let i = 0; i < count; i++) {
			const s = stars[i];
			const pos = raDecToXYZ(s.ra, s.dec);
			positions[i * 3] = pos.x;
			positions[i * 3 + 1] = pos.y;
			positions[i * 3 + 2] = pos.z;

			// Brightness factor: mag -1 -> bright, mag 6.5 -> dim
			const bright = Math.max(0, 1 - s.mag / 7);
			const t = Math.min(1, s.mag / 6);
			starColors[i * 3] = 0.7 + bright * 0.3;
			starColors[i * 3 + 1] = 0.7 + bright * 0.25 - t * 0.05;
			starColors[i * 3 + 2] = 0.75 + t * 0.25;

			starSizes[i] = Math.max(0.003, 0.03 - s.mag * 0.004);
		}

		const starGeom = new THREE.BufferGeometry();
		starGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
		starGeom.setAttribute('color', new THREE.BufferAttribute(starColors, 3));

		const starMat = new THREE.PointsMaterial({
			size: 0.015,
			sizeAttenuation: true,
			vertexColors: true,
			transparent: true,
			opacity: 0.9,
		});
		starMatRef = starMat;

		scene.add(new THREE.Points(starGeom, starMat));

		// Render loop
		let animId: number;
		function render() {
			animId = requestAnimationFrame(render);
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
			renderer.dispose();
			if (renderer.domElement.parentNode) {
				renderer.domElement.parentNode.removeChild(renderer.domElement);
			}
		};
	});
</script>

<div bind:this={container} class="star-field"></div>

<style>
	.star-field {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}
</style>
