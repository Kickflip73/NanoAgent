/**
 * 3D Interactive Portfolio — html-in-canvas + Three.js WebGPU
 *
 * Systems: HTML texture pipeline → Crack animation → earcut tessellation →
 * 3D debris physics → Code tunnel background → Bloom post-processing →
 * Keyboard/mouse interactions → GSAP animations → Audio feedback
 */
import * as THREE from 'three';
import earcut from 'earcut';
import gsap from 'gsap';
import html2canvas from 'html2canvas';

// ═══════════════════════════════════════════════
// FEATURE DETECTION
// ═══════════════════════════════════════════════
let hasDrawElement = false;
let hasHtml2Canvas = true;

function checkSupport() {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  hasDrawElement = !!(ctx && typeof ctx.drawElementImage === 'function');

  if (!hasDrawElement) {
    console.warn('drawElementImage not available, using html2canvas fallback');
  }

  // Only fail if neither is available
  if (!hasDrawElement && !hasHtml2Canvas) {
    document.getElementById('no-support').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    document.getElementById('ui-hint').style.display = 'none';
    return false;
  }
  return true;
}

if (!checkSupport()) throw new Error('No rendering backend available');

// ═══════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════
const PAGE_WIDTH = 1440;
const PAGE_HEIGHT = 3200;
const TUNNEL_LENGTH = 80;
const TUNNEL_RADIUS = 15;
const GRAVITY = -9.8;
const CRACK_DURATION = 0.6; // seconds
const DEBRIS_LIFETIME = 4.0;

// ═══════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════
const state = {
  theme: 'dark',
  freeCamera: false,
  debrisPieces: [],
  cracks: [],
  scrollY: 0,
  targetScroll: 0,
  mouseX: 0,
  mouseY: 0,
  draggingPiece: null,
  dragPlane: new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
  dragOffset: new THREE.Vector3(),
  time: 0,
};

// ═══════════════════════════════════════════════
// AUDIO — Web Audio synthesized effects
// ═══════════════════════════════════════════════
let audioCtx = null;
function initAudio() {
  if (audioCtx) return audioCtx;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playCrack(x, y) {
  try {
    const ctx = initAudio();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(200 + Math.random() * 400, now);
    osc.frequency.exponentialRampToValueAtTime(60, now + 0.15);

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(800, now);
    filter.Q.setValueAtTime(5, now);

    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

    osc.connect(filter).connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.2);

    // Impact burst
    const noise = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.08, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.02));
    noise.buffer = buf;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.08, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    noise.connect(ng).connect(ctx.destination);
    noise.start(now);
  } catch(e) { /* audio not critical */ }
}

function playExplosion() {
  try {
    const ctx = initAudio();
    const now = ctx.currentTime;
    for (let i = 0; i < 5; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(100 + Math.random() * 300, now + i * 0.02);
      osc.frequency.exponentialRampToValueAtTime(40, now + 0.3);
      gain.gain.setValueAtTime(0.06, now + i * 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.02);
      osc.stop(now + 0.3);
    }
    // Low rumble
    const rumble = ctx.createOscillator();
    const rg = ctx.createGain();
    rumble.type = 'sine';
    rumble.frequency.setValueAtTime(30, now);
    rg.gain.setValueAtTime(0.1, now);
    rg.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    rumble.connect(rg).connect(ctx.destination);
    rumble.start(now);
    rumble.stop(now + 0.5);
  } catch(e) {}
}

function playReset() {
  try {
    const ctx = initAudio();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, now);
    osc.frequency.exponentialRampToValueAtTime(1200, now + 0.15);
    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  } catch(e) {}
}

// ═══════════════════════════════════════════════
// THREE.JS SETUP
// ═══════════════════════════════════════════════
const appEl = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
renderer.setAnimationLoop(animate);
appEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#0a0a0f');
scene.fog = new THREE.Fog('#0a0a0f', 20, 100);

// Camera
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.5, 120);
camera.position.set(0, 0, 20);
camera.lookAt(0, 0, 0);

// Lighting
const ambientLight = new THREE.AmbientLight('#404060', 0.6);
scene.add(ambientLight);
const keyLight = new THREE.DirectionalLight('#ffffff', 0.8);
keyLight.position.set(5, 10, 10);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight('#8855ff', 0.4);
rimLight.position.set(-5, -2, -5);
scene.add(rimLight);

// ═══════════════════════════════════════════════
// HTML TEXTURE PIPELINE
// ═══════════════════════════════════════════════
const textureCanvas = document.createElement('canvas');
textureCanvas.width = PAGE_WIDTH;
textureCanvas.height = PAGE_HEIGHT;
const textureCtx = textureCanvas.getContext('2d', { willReadFrequently: true });

const contentSource = document.getElementById('content-source');

async function updateHTMLTexture() {
  textureCtx.clearRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
  if (hasDrawElement) {
    textureCtx.drawElementImage(contentSource, 0, 0);
  } else {
    const h2cCanvas = await html2canvas(contentSource, {
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      scale: 1,
      useCORS: true,
      backgroundColor: '#0d0d1a',
    });
    textureCtx.drawImage(h2cCanvas, 0, 0);
  }
}

// ── Pre-fill texture with placeholder gradient ──
function fillPlaceholderTexture() {
  const grad = textureCtx.createLinearGradient(0, 0, 0, PAGE_HEIGHT);
  grad.addColorStop(0, '#0d0d1a');
  grad.addColorStop(0.3, '#13132a');
  grad.addColorStop(0.7, '#0d0d1a');
  grad.addColorStop(1, '#0a0a14');
  textureCtx.fillStyle = grad;
  textureCtx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);

  // Loading indicator
  textureCtx.fillStyle = '#a78bfa';
  textureCtx.font = 'bold 24px monospace';
  textureCtx.textAlign = 'center';
  textureCtx.fillText('加载中...', PAGE_WIDTH/2, PAGE_HEIGHT/2);
}
fillPlaceholderTexture();

// Initial texture render (async — will replace placeholder)
(async () => {
  try {
    await updateHTMLTexture();
    pageTexture.needsUpdate = true;
  } catch(e) {
    console.error('HTML texture render failed:', e);
    // Keep placeholder on failure
  }
})();

const pageTexture = new THREE.CanvasTexture(textureCanvas);
pageTexture.colorSpace = THREE.SRGBColorSpace;
pageTexture.minFilter = THREE.LinearMipmapLinearFilter;
pageTexture.magFilter = THREE.LinearFilter;
pageTexture.generateMipmaps = true;

// ═══════════════════════════════════════════════
// PAGE PLANE — the main page as a 3D plane
// ═══════════════════════════════════════════════
const pageAspect = PAGE_WIDTH / PAGE_HEIGHT;
const pageScale = 8; // world units height
const pageGeo = new THREE.PlaneGeometry(pageScale * pageAspect, pageScale, 32, 32);
const pageMat = new THREE.MeshStandardMaterial({
  map: pageTexture,
  roughness: 0.4,
  metalness: 0.05,
  side: THREE.DoubleSide,
});
const pagePlane = new THREE.Mesh(pageGeo, pageMat);
scene.add(pagePlane);

// ═══════════════════════════════════════════════
// BACKGROUND TUNNEL — code particle tunnel
// ═══════════════════════════════════════════════
const codeChars = '01アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン<>{}[]()/*+-=&#@!?λφΩΔΣΠ';
const tunnelGroup = new THREE.Group();
scene.add(tunnelGroup);

function createCodeSprite(char) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const cx = c.getContext('2d');
  cx.fillStyle = `hsl(${260 + Math.random() * 40}, 70%, ${50 + Math.random() * 30}%)`;
  cx.font = 'bold 36px monospace';
  cx.textAlign = 'center';
  cx.textBaseline = 'middle';
  cx.fillText(char, 32, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.5, 0.5, 1);
  sprite.userData = {
    angle: Math.random() * Math.PI * 2,
    radius: TUNNEL_RADIUS + (Math.random() - 0.5) * 3,
    z: (Math.random() - 0.5) * TUNNEL_LENGTH,
    speed: 2 + Math.random() * 4,
    rotSpeed: (Math.random() - 0.5) * 1.5,
  };
  return sprite;
}

const codeSprites = [];
for (let i = 0; i < 600; i++) {
  const char = codeChars[Math.floor(Math.random() * codeChars.length)];
  const sprite = createCodeSprite(char);
  tunnelGroup.add(sprite);
  codeSprites.push(sprite);
}

// ═══════════════════════════════════════════════
// DEBRIS SYSTEM
// ═══════════════════════════════════════════════
const debrisGroup = new THREE.Group();
scene.add(debrisGroup);

function createDebrisMesh(vertices, uvs, centerUV) {
  // Create geometry from earcut triangles
  const positions = [];
  const texCoords = [];
  const faceUVs = [];

  for (let i = 0; i < vertices.length; i += 2) {
    const u = vertices[i] / PAGE_WIDTH;
    const v = 1 - vertices[i + 1] / PAGE_HEIGHT;

    // Convert to world space on the page plane
    const wx = (u - 0.5) * pageScale * pageAspect;
    const wy = (v - 0.5) * pageScale;
    positions.push(wx, wy, 0.01);
    texCoords.push(u, v);
  }

  const indices = earcut(vertices, null, 2);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(texCoords, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    map: pageTexture.clone(),
    roughness: 0.3,
    metalness: 0.1,
    side: THREE.DoubleSide,
    depthWrite: true,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(pagePlane.position);

  // Physics data
  mesh.userData = {
    velocity: new THREE.Vector3(
      (Math.random() - 0.5) * 3,
      (Math.random() - 0.5) * 2 + 2,
      (Math.random() - 0.5) * 6 + 3
    ),
    angularVelocity: new THREE.Vector3(
      (Math.random() - 0.5) * 8,
      (Math.random() - 0.5) * 8,
      (Math.random() - 0.5) * 4
    ),
    life: DEBRIS_LIFETIME,
    age: 0,
    centerUV: centerUV,
  };

  return mesh;
}

// ═══════════════════════════════════════════════
// CRACK SYSTEM — Canvas 2D crack animation
// ═══════════════════════════════════════════════
const crackCanvas = document.createElement('canvas');
crackCanvas.width = PAGE_WIDTH;
crackCanvas.height = PAGE_HEIGHT;
const crackCtx = crackCanvas.getContext('2d');

let activeCrack = null;

function startCrack(cx, cy) {
  if (activeCrack) return;
  activeCrack = {
    cx, cy,
    branches: [],
    age: 0,
    duration: CRACK_DURATION,
    vertices: [],
  };

  // Generate crack tree
  function branch(x, y, angle, length, depth) {
    if (depth > 6 || length < 30) return;
    const endX = x + Math.cos(angle) * length;
    const endY = y + Math.sin(angle) * length;

    activeCrack.branches.push({
      x1: x, y1: y, x2: endX, y2: endY,
      depth, progress: 0, speed: 1 + Math.random() * 2,
    });

    // Branch
    const numBranches = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < numBranches; i++) {
      const spreadAngle = angle + (Math.random() - 0.5) * 1.2;
      branch(endX, endY, spreadAngle, length * (0.5 + Math.random() * 0.3), depth + 1);
    }
  }

  // 6-8 main branches
  const numMain = 6 + Math.floor(Math.random() * 3);
  for (let i = 0; i < numMain; i++) {
    const angle = (i / numMain) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
    branch(cx, cy, angle, 150 + Math.random() * 200, 0);
  }

  playCrack(cx, cy);
}

function updateCracks(dt) {
  if (!activeCrack) return;

  activeCrack.age += dt;
  const progress = Math.min(activeCrack.age / activeCrack.duration, 1);

  crackCtx.clearRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
  crackCtx.strokeStyle = '#a78bfa';
  crackCtx.lineWidth = 3;
  crackCtx.lineCap = 'round';
  crackCtx.shadowColor = '#a78bfa';
  crackCtx.shadowBlur = 10;

  // Draw active crack branches
  for (const b of activeCrack.branches) {
    b.progress = Math.min(b.progress + b.speed * dt * 3, 1);
    const bp = b.progress * progress;
    if (bp <= 0) continue;
    const ex = b.x1 + (b.x2 - b.x1) * bp;
    const ey = b.y1 + (b.y2 - b.y1) * bp;
    crackCtx.globalAlpha = 1 - bp * 0.5;
    crackCtx.beginPath();
    crackCtx.moveTo(b.x1, b.y1);
    crackCtx.lineTo(ex, ey);
    crackCtx.stroke();
  }

  // Glow center
  const gp = 1 - progress;
  crackCtx.globalAlpha = gp;
  const grd = crackCtx.createRadialGradient(activeCrack.cx, activeCrack.cy, 0, activeCrack.cx, activeCrack.cy, 60 * gp + 10);
  grd.addColorStop(0, '#c4b5fd');
  grd.addColorStop(1, 'transparent');
  crackCtx.fillStyle = grd;
  crackCtx.fillRect(activeCrack.cx - 60, activeCrack.cy - 60, 120, 120);

  crackCtx.globalAlpha = 1;
  crackCtx.shadowBlur = 0;

  // Crack complete → create debris
  if (progress >= 1) {
    createDebrisFromCrack(activeCrack);
    activeCrack = null;
  }
}

function createDebrisFromCrack(crack) {
  const { cx, cy, branches } = crack;

  // Collect all branch endpoints + center as polygon vertices
  const allPoints = new Map();
  allPoints.set('0,0', [cx, cy]);

  for (const b of branches) {
    allPoints.set(`${b.x2.toFixed(0)},${b.y2.toFixed(0)}`, [b.x2, b.y2]);
  }

  const pts = Array.from(allPoints.values());

  // Sort by angle around center
  pts.sort((a, b) => {
    const angA = Math.atan2(a[1] - cy, a[0] - cx);
    const angB = Math.atan2(b[1] - cy, b[0] - cx);
    return angA - angB;
  });

  // Create fan triangles from center
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const triVerts = [cx, cy, pts[i][0], pts[i][1], pts[j][0], pts[j][1]];

    // Add some randomness to vertex positions
    const jittered = [];
    const jitter = 5;
    for (let k = 0; k < triVerts.length; k += 2) {
      jittered.push(triVerts[k] + (Math.random() - 0.5) * jitter);
      jittered.push(triVerts[k + 1] + (Math.random() - 0.5) * jitter);
    }

    const centerUV = { u: cx / PAGE_WIDTH, v: 1 - cy / PAGE_HEIGHT };
    const mesh = createDebrisMesh(jittered, [], centerUV);
    debrisGroup.add(mesh);
    state.debrisPieces.push(mesh);
  }
}

// ═══════════════════════════════════════════════
// EXPLODE ALL
// ═══════════════════════════════════════════════
function explodeAll() {
  if (activeCrack) return;
  playExplosion();

  // Generate grid of cracks across the page
  const cols = 4, rows = 8;
  const cellW = PAGE_WIDTH / cols;
  const cellH = PAGE_HEIGHT / rows;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = cellW * (c + 0.5);
      const cy = cellH * (r + 0.5);

      // Simple polygon for each cell
      const verts = [
        cellW * c, cellH * r,
        cellW * (c + 1), cellH * r,
        cellW * (c + 1), cellH * (r + 1),
        cellW * c, cellH * (r + 1),
      ];

      const centerUV = { u: cx / PAGE_WIDTH, v: 1 - cy / PAGE_HEIGHT };
      const mesh = createDebrisMesh(verts, [], centerUV);
      // Stronger velocity for explosion
      mesh.userData.velocity.set(
        (cx - PAGE_WIDTH / 2) / PAGE_WIDTH * 8 + (Math.random() - 0.5) * 2,
        (cy - PAGE_HEIGHT / 2) / PAGE_HEIGHT * 5 + (Math.random() - 0.5) * 2 + 3,
        (Math.random() - 0.5) * 10 + 5
      );
      mesh.userData.life = 6;
      debrisGroup.add(mesh);
      state.debrisPieces.push(mesh);
    }
  }
}

// ═══════════════════════════════════════════════
// RESET
// ═══════════════════════════════════════════════
function resetAll() {
  playReset();
  // Animate debris back
  for (const piece of state.debrisPieces) {
    gsap.to(piece.position, {
      x: pagePlane.position.x,
      y: pagePlane.position.y,
      z: pagePlane.position.z + 0.01,
      duration: 0.6,
      ease: 'power2.inOut',
    });
    gsap.to(piece.rotation, {
      x: 0, y: 0, z: 0,
      duration: 0.6,
      ease: 'power2.inOut',
      onComplete: () => {
        debrisGroup.remove(piece);
        piece.geometry.dispose();
        piece.material.dispose();
      },
    });
  }
  state.debrisPieces = [];
  activeCrack = null;
  crackCtx.clearRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
}

// ═══════════════════════════════════════════════
// POST PROCESSING — Stage 6 will add proper Bloom + multi-pass
// Currently relying on AdditiveBlending sprites for natural glow
// ═══════════════════════════════════════════════

// ═══════════════════════════════════════════════
// MOUSE / TOUCH → RAYCAST
// ═══════════════════════════════════════════════
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

function getPageUV(event) {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(pagePlane);

  if (intersects.length > 0) {
    const point = intersects[0].point;
    const local = pagePlane.worldToLocal(point.clone());
    const u = local.x / (pageScale * pageAspect) + 0.5;
    const v = local.y / pageScale + 0.5;
    return {
      u, v,
      px: u * PAGE_WIDTH,
      py: (1 - v) * PAGE_HEIGHT,
      worldPoint: point.clone(),
    };
  }
  return null;
}

// ═══════════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════════
window.addEventListener('click', (event) => {
  // Handle UI hint button clicks
  const hint = event.target.closest('.key-hint');
  if (hint) {
    const key = hint.dataset.key;
    if (key === 'space') { startCrack(PAGE_WIDTH / 2, PAGE_HEIGHT / 2 + state.scrollY * (PAGE_HEIGHT / pageScale)); }
    else if (key === 'r') { resetAll(); }
    else if (key === 'x') { explodeAll(); }
    else if (key === 'o') {
      state.freeCamera = !state.freeCamera;
      if (!state.freeCamera) { gsap.to(camera.position, { x: 0, y: 0, z: 20, duration: 0.8, ease: 'power2.inOut' }); camera.lookAt(0, 0, 0); }
      hint.classList.toggle('active', state.freeCamera);
    }
    else if (key === 't') {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      scene.background = new THREE.Color(state.theme === 'dark' ? '#0a0a0f' : '#f5f5f0');
      scene.fog = new THREE.Fog(state.theme === 'dark' ? '#0a0a0f' : '#f5f5f0', 20, 100);
      contentSource.style.background = state.theme === 'dark' ? '#0d0d1a' : '#fafaf5';
      contentSource.style.color = state.theme === 'dark' ? '#e0e0f0' : '#1a1a2e';
      updateHTMLTexture().then(() => { pageTexture.needsUpdate = true; });
    }
    else if (key === 'f') {
      if (document.fullscreenElement) { document.exitFullscreen(); }
      else { document.body.requestFullscreen(); }
    }
    return;
  }

  if (state.freeCamera) return;
  if (state.draggingPiece) return;

  const uv = getPageUV(event);
  if (uv && uv.u >= 0 && uv.u <= 1 && uv.v >= 0 && uv.v <= 1) {
    startCrack(uv.px, uv.py);
  }
});

window.addEventListener('mousemove', (event) => {
  state.mouseX = (event.clientX / window.innerWidth) * 2 - 1;
  state.mouseY = -(event.clientY / window.innerHeight) * 2 + 1;

  if (state.draggingPiece) {
    mouse.x = state.mouseX;
    mouse.y = state.mouseY;
    raycaster.setFromCamera(mouse, camera);
    const target = new THREE.Vector3();
    raycaster.ray.intersectPlane(state.dragPlane, target);
    if (target) {
      state.draggingPiece.position.copy(target.sub(state.dragOffset));
    }
  }
});

window.addEventListener('wheel', (event) => {
  if (state.freeCamera) {
    // Zoom camera
    camera.position.z += event.deltaY * 0.05;
    camera.position.z = THREE.MathUtils.clamp(camera.position.z, 5, 50);
  } else {
    state.targetScroll += event.deltaY;
    state.targetScroll = THREE.MathUtils.clamp(state.targetScroll, -pageScale / 2 + 2, pageScale / 2 - 2);
  }
}, { passive: true });

window.addEventListener('keydown', (event) => {
  switch (event.key.toLowerCase()) {
    case ' ':
      event.preventDefault();
      if (!state.freeCamera && !state.draggingPiece) {
        // Crack at screen center
        startCrack(PAGE_WIDTH / 2, PAGE_HEIGHT / 2 + state.scrollY * (PAGE_HEIGHT / pageScale));
      }
      break;
    case 'r':
      event.preventDefault();
      resetAll();
      break;
    case 'x':
      event.preventDefault();
      explodeAll();
      break;
    case 'o':
      event.preventDefault();
      state.freeCamera = !state.freeCamera;
      if (!state.freeCamera) {
        gsap.to(camera.position, { x: 0, y: 0, z: 20, duration: 0.8, ease: 'power2.inOut' });
        camera.lookAt(0, 0, 0);
      }
      break;
    case 't':
      event.preventDefault();
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      if (state.theme === 'dark') {
        scene.background = new THREE.Color('#0a0a0f');
        scene.fog = new THREE.Fog('#0a0a0f', 20, 100);
        contentSource.style.background = '#0d0d1a';
        contentSource.style.color = '#e0e0f0';
      } else {
        scene.background = new THREE.Color('#f5f5f0');
        scene.fog = new THREE.Fog('#f5f5f0', 20, 100);
        contentSource.style.background = '#fafaf5';
        contentSource.style.color = '#1a1a2e';
      }
      updateHTMLTexture().then(() => { pageTexture.needsUpdate = true; });
      break;
    case 'f':
      event.preventDefault();
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        document.body.requestFullscreen();
      }
      break;
  }
});

// Debris dragging
window.addEventListener('mousedown', (event) => {
  if (!state.freeCamera) return;

  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  const intersects = raycaster.intersectObjects(state.debrisPieces);
  if (intersects.length > 0) {
    const piece = intersects[0].object;
    state.draggingPiece = piece;
    state.dragPlane.constant = -piece.position.z;
    const target = new THREE.Vector3();
    raycaster.ray.intersectPlane(state.dragPlane, target);
    state.dragOffset.copy(piece.position).sub(target);

    // Disable physics while dragging
    piece.userData._physicsPaused = true;
  }
});

window.addEventListener('mouseup', () => {
  if (state.draggingPiece) {
    state.draggingPiece.userData._physicsPaused = false;
    state.draggingPiece = null;
  }
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ═══════════════════════════════════════════════
// ANIMATION LOOP
// ═══════════════════════════════════════════════
const clock = new THREE.Clock();

function animate() {
  const dt = Math.min(clock.getDelta(), 0.1);
  state.time += dt;

  // ── Page scroll ──
  state.scrollY += (state.targetScroll - state.scrollY) * 5 * dt;
  pagePlane.position.y = state.scrollY;

  // ── Camera lerp (free cam: orbit with mouse) ──
  if (state.freeCamera) {
    const targetX = state.mouseX * 8;
    const targetY = state.mouseY * 5;
    camera.position.x += (targetX - camera.position.x) * 2 * dt;
    camera.position.y += (targetY - camera.position.y) * 2 * dt;
    camera.lookAt(0, state.scrollY, 0);
  } else {
    camera.position.x += ((state.mouseX * 3) - camera.position.x) * 1.5 * dt;
    camera.position.y += (state.scrollY + (state.mouseY * 1.5) - camera.position.y) * 1.5 * dt;
    camera.lookAt(0, state.scrollY, 0);
  }

  // ── Cracks ──
  updateCracks(dt);

  // ── Debris physics ──
  for (let i = state.debrisPieces.length - 1; i >= 0; i--) {
    const piece = state.debrisPieces[i];
    if (piece.userData._physicsPaused) continue;

    piece.userData.age += dt;
    piece.userData.velocity.y += GRAVITY * dt;
    piece.position.x += piece.userData.velocity.x * dt;
    piece.position.y += piece.userData.velocity.y * dt;
    piece.position.z += piece.userData.velocity.z * dt;
    piece.rotation.x += piece.userData.angularVelocity.x * dt;
    piece.rotation.y += piece.userData.angularVelocity.y * dt;
    piece.rotation.z += piece.userData.angularVelocity.z * dt;

    // Fade and remove old debris
    if (piece.userData.age > piece.userData.life) {
      debrisGroup.remove(piece);
      piece.geometry.dispose();
      piece.material.dispose();
      state.debrisPieces.splice(i, 1);
    } else if (piece.userData.age > piece.userData.life * 0.7) {
      const fadeProgress = (piece.userData.age - piece.userData.life * 0.7) / (piece.userData.life * 0.3);
      piece.material.opacity = 1 - fadeProgress;
      piece.material.transparent = true;
    }
  }

  // ── Tunnel animation ──
  for (const sprite of codeSprites) {
    sprite.userData.z += sprite.userData.speed * dt;
    if (sprite.userData.z > TUNNEL_LENGTH / 2) {
      sprite.userData.z = -TUNNEL_LENGTH / 2;
      sprite.userData.angle = Math.random() * Math.PI * 2;
    }
    sprite.userData.angle += sprite.userData.rotSpeed * dt;

    const r = sprite.userData.radius;
    const a = sprite.userData.angle;
    sprite.position.set(Math.cos(a) * r, Math.sin(a) * r, sprite.userData.z);

    // Distance-based scale and opacity
    const distFromCenter = Math.abs(sprite.userData.z);
    const maxDist = TUNNEL_LENGTH / 2;
    const visibility = 1 - distFromCenter / maxDist;
    sprite.scale.setScalar(0.3 + visibility * 0.5);
    sprite.material.opacity = visibility * 0.8;
  }

  // Tunnel follows camera position + mouse tilt
  tunnelGroup.position.copy(camera.position);
  tunnelGroup.position.z -= 15;
  tunnelGroup.rotation.y = state.mouseX * 0.3;
  tunnelGroup.rotation.x = state.mouseY * 0.2;

  // ── Update HTML texture periodically ──
  if (Math.floor(state.time * 10) % 3 === 0 && activeCrack) {
    updateHTMLTexture().then(() => {
      if (activeCrack) {
        textureCtx.drawImage(crackCanvas, 0, 0);
      }
      pageTexture.needsUpdate = true;
    });
  }

  // ── Render ──
  renderer.render(scene, camera);
}
