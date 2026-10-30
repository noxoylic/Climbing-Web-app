// 3D view of the map. Everything is read from the 2D page (the wall
// diagram's outline, the climb markers and their filter state), so the
// 2D map stays the one source of truth: filters, sends and set switches
// all show up here too. Three.js loads on first open, not with the page.

const HEIGHT = 70;      // wall height in overlay units (the map is 256 x 512)
const MARKER_Y = 42;    // markers float at mid-wall height
const STACK = 11;       // vertical gap between markers that overlap in 2D
const KEY = 'summit-3d';

const toggle = document.getElementById('view-3d');
const box = document.getElementById('wall3d');
const viewport = document.getElementById('map-viewport');
const layer = document.getElementById('climb-layer');
let view = null;        // built on first open
let active = false;

window.Wall3D = {
    focus(id) { if (view && active) view.focus(String(id)); },
};

// Absolute M/L/H/V/Z path data -> polylines of [x, y]. The wall
// diagram only uses these commands; anything else is skipped.
export function polylines(d) {
    const lines = [];
    const tokens = String(d || '').match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
    let cmd = null, cur = null, start = null, x = 0, y = 0;
    for (let i = 0; i < tokens.length;) {
        if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
        const num = () => parseFloat(tokens[i++]);
        if (cmd === 'M') {
            x = num(); y = num();
            cur = [[x, y]]; start = [x, y]; lines.push(cur);
            cmd = 'L'; // extra pairs after M are line-tos
        } else if (cmd === 'L' && cur) { x = num(); y = num(); cur.push([x, y]); }
        else if (cmd === 'H' && cur) { x = num(); cur.push([x, y]); }
        else if (cmd === 'V' && cur) { y = num(); cur.push([x, y]); }
        else if ((cmd === 'Z' || cmd === 'z') && cur) { cur.push([...start]); cmd = null; }
        else i++;
    }
    return lines
        .map((l) => l.filter(([px, py]) => Number.isFinite(px) && Number.isFinite(py)))
        .filter((l) => l.length > 1);
}

function canvasTexture(THREE, w, h, draw) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'));
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
}

async function build() {
    const THREE = await import('three');
    const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');

    const css = getComputedStyle(document.documentElement);
    const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const colour = (value, fallback) => {
        const c = new THREE.Color(fallback);
        try { c.setStyle(value); } catch (e) { /* keep fallback */ }
        return c;
    };
    const accent = colour(v('--accent', '#5cc3e6'), '#5cc3e6');
    const surface = colour(v('--surface', '#0e1622'), '#0e1622');
    const ink = colour(v('--text', '#e8eef5'), '#e8eef5');
    const panel = colour(v('--surface-2', '#152032'), '#152032').lerp(ink, 0.14);

    // Diagram coordinates -> overlay coordinates -> world (x, 0, z).
    // Both SVGs share the pan/zoom transform, so the relative matrix
    // is the same at any zoom.
    const vb = layer.viewBox.baseVal;
    const cx = vb.width / 2, cz = vb.height / 2;
    const toWorld = ([x, y]) => new THREE.Vector3(x - cx, 0, y - cz);
    const layerInv = layer.getScreenCTM().inverse();
    const inLayer = (el) => {
        const m = layerInv.multiply(el.getScreenCTM());
        return ([x, y]) => {
            const p = new DOMPoint(x, y).matrixTransform(m);
            return [p.x, p.y];
        };
    };

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    box.prepend(renderer.domElement);
    const el = renderer.domElement;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 1, 4000);
    const HOME = { target: new THREE.Vector3(0, HEIGHT * 0.3, 0), cam: new THREE.Vector3(240, 300, 430) };
    camera.position.copy(HOME.cam);
    const controls = new OrbitControls(camera, el);
    controls.target.copy(HOME.target);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.48;
    controls.minDistance = 40;
    controls.maxDistance = 1000;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.3));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-220, 420, 260);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -320, right: 320, top: 320, bottom: -320, far: 1200 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0008;
    scene.add(sun);

    // Floor: a base plate, then the diagram's own filled regions.
    const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(vb.width + 80, vb.height + 80),
        new THREE.MeshStandardMaterial({ color: surface, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.5;
    ground.receiveShadow = true;
    scene.add(ground);
    document.querySelectorAll('.wall-svg .wall-panel').forEach((path, i) => {
        const map = inLayer(path);
        const fill = colour(getComputedStyle(path).fill, '#888888');
        const alpha = parseFloat(path.getAttribute('fill-opacity') || '1');
        for (const line of polylines(path.getAttribute('d'))) {
            const shape = new THREE.Shape(line.map(map).map(([x, y]) => new THREE.Vector2(x - cx, y - cz)));
            const geo = new THREE.ShapeGeometry(shape);
            geo.rotateX(Math.PI / 2); // shape XY -> floor XZ
            const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
                color: fill, transparent: true, opacity: 0.3 + alpha * 0.5,
                side: THREE.DoubleSide, roughness: 1, depthWrite: false,
            }));
            mesh.position.y = 0.05 * (i + 1); // no z-fighting between regions
            mesh.receiveShadow = true;
            scene.add(mesh);
        }
    });

    // Walls: every feature line becomes a plywood panel with T-nuts;
    // the outer frame becomes a low boundary wall.
    const studs = canvasTexture(THREE, 128, 128, (g) => {
        g.fillStyle = '#' + panel.getHexString();
        g.fillRect(0, 0, 128, 128);
        g.strokeStyle = 'rgba(0,0,0,.3)';
        g.lineWidth = 3;
        g.strokeRect(0, 0, 128, 128);
        g.fillStyle = 'rgba(0,0,0,.35)';
        for (let y = 12; y < 128; y += 26) {
            for (let x = y % 52 === 12 ? 12 : 25; x < 128; x += 26) {
                g.beginPath(); g.arc(x, y, 2.5, 0, Math.PI * 2); g.fill();
            }
        }
    });
    studs.wrapS = studs.wrapT = THREE.RepeatWrapping;
    const wallMat = new THREE.MeshStandardMaterial({ map: studs, side: THREE.DoubleSide, roughness: 0.85 });
    const frameMat = new THREE.MeshStandardMaterial({ color: surface.clone().lerp(ink, 0.06), side: THREE.DoubleSide, roughness: 0.95 });
    const lips = [];
    function extrude(path, height, mat) {
        if (!path) return;
        const map = inLayer(path);
        for (const line of polylines(path.getAttribute('d'))) {
            const pts = line.map(map).map(toWorld);
            for (let i = 0; i < pts.length - 1; i++) {
                const a = pts[i], b = pts[i + 1];
                const len = a.distanceTo(b);
                if (len < 0.01) continue;
                const geo = new THREE.BufferGeometry().setFromPoints(
                    [a, b, b.clone().setY(height), a.clone().setY(height)]);
                geo.setIndex([0, 1, 2, 0, 2, 3]);
                geo.setAttribute('uv', new THREE.Float32BufferAttribute(
                    [0, 0, len / 20, 0, len / 20, height / 20, 0, height / 20], 2));
                geo.computeVertexNormals();
                const mesh = new THREE.Mesh(geo, mat);
                mesh.castShadow = mesh.receiveShadow = true;
                scene.add(mesh);
                lips.push(a.clone().setY(height), b.clone().setY(height));
            }
        }
    }
    extrude(document.getElementById('wall-lines'), HEIGHT, wallMat);
    extrude(document.getElementById('frame'), HEIGHT * 0.35, frameMat);
    scene.add(new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(lips),
        new THREE.LineBasicMaterial({ color: accent })));

    // Markers: the 2D dot and grade, standing on a tape line. Dots
    // that overlap on the plan stack upwards so each stays tappable.
    const markerTex = new Map();
    function markerTexture(fill, label) {
        const key = fill + '|' + label;
        if (!markerTex.has(key)) {
            markerTex.set(key, canvasTexture(THREE, 128, 128, (g) => {
                g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2);
                g.fillStyle = fill; g.fill();
                g.lineWidth = 10; g.strokeStyle = '#ffffff'; g.stroke();
                g.font = '800 50px system-ui, sans-serif';
                g.textAlign = 'center'; g.textBaseline = 'middle';
                g.lineWidth = 8; g.strokeStyle = 'rgba(0,0,0,.5)';
                g.strokeText(label, 64, 67);
                g.fillStyle = '#ffffff';
                g.fillText(label, 64, 67);
            }));
        }
        return markerTex.get(key);
    }
    const markers = new Map();
    const placed = [];
    layer.querySelectorAll('.climb-marker').forEach((g) => {
        const dot = g.querySelector('.climb-dot');
        if (!dot) return;
        const x = parseFloat(dot.getAttribute('cx')), y = parseFloat(dot.getAttribute('cy'));
        const level = placed.filter(([px, py]) => Math.hypot(px - x, py - y) < 9).length;
        placed.push([x, y]);
        const fill = dot.getAttribute('fill') || '#888';
        const label = (g.querySelector('text')?.textContent || '?').trim();
        const base = toWorld([x, y]);
        const height = MARKER_Y + (level % 6) * STACK;
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: markerTexture(fill, label), transparent: true, depthWrite: false }));
        sprite.position.copy(base).setY(height);
        sprite.scale.setScalar(13);
        sprite.renderOrder = 10;
        sprite.userData.id = g.dataset.climbId;
        const tape = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([base.clone().setY(0.5), base.clone().setY(height - 6.5)]),
            new THREE.LineBasicMaterial({ color: colour(fill, '#888888'), transparent: true, opacity: 0.7 }));
        scene.add(sprite, tape);
        markers.set(g.dataset.climbId, { g, sprite, tape });
    });

    function sync() {
        for (const { g, sprite, tape } of markers.values()) {
            const dim = g.style.opacity !== '' && parseFloat(g.style.opacity) < 1;
            sprite.visible = tape.visible = g.style.display !== 'none';
            sprite.material.opacity = dim ? 0.2 : 1;
            tape.material.opacity = dim ? 0.15 : 0.7;
        }
    }
    new MutationObserver(sync).observe(layer, { subtree: true, attributes: true, attributeFilter: ['style'] });
    sync();

    // Selected climb: a pulsing ring on the floor under it.
    const ring = new THREE.Mesh(
        new THREE.RingGeometry(7, 9.5, 40),
        new THREE.MeshBasicMaterial({ color: accent, side: THREE.DoubleSide, transparent: true, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    scene.add(ring);

    let fly = null;
    function flyTo(target, cam) {
        fly = { t0: performance.now(), ft: controls.target.clone(), fc: camera.position.clone(), tt: target, tc: cam };
    }
    controls.addEventListener('start', () => { fly = null; });
    function focus(id) {
        const mk = markers.get(id);
        if (!mk) return;
        const target = mk.sprite.position.clone();
        const away = camera.position.clone().sub(controls.target).setY(0).normalize();
        flyTo(target, target.clone().addScaledVector(away, 150).setY(target.y + 70));
        ring.position.set(target.x, 0.6, target.z);
        ring.visible = true;
    }
    const fit = document.getElementById('fit-wall');
    if (fit) fit.addEventListener('click', () => { if (active) flyTo(HOME.target.clone(), HOME.cam.clone()); });

    // A tap (not a drag) on a marker opens it through the page's own
    // openClimb, so the sheet, deep links and keyboard all agree.
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    function hit(e) {
        const r = el.getBoundingClientRect();
        ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        ray.setFromCamera(ndc, camera);
        const visible = [...markers.values()].filter((m) => m.sprite.visible).map((m) => m.sprite);
        return ray.intersectObjects(visible, false)[0] || null;
    }
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', (e) => {
        const tap = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8;
        down = null;
        const h = tap && hit(e);
        if (h && typeof window.openClimb === 'function') window.openClimb(h.object.userData.id);
    });
    el.addEventListener('pointermove', (e) => {
        if (!e.buttons) el.style.cursor = hit(e) ? 'pointer' : 'grab';
    });

    new ResizeObserver(() => {
        const { clientWidth: w, clientHeight: h } = box;
        if (!w || !h) return;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }).observe(box);

    const clock = new THREE.Clock();
    function frame() {
        if (fly) {
            const k = Math.min(1, (performance.now() - fly.t0) / 700);
            const ease = 1 - (1 - k) ** 3;
            controls.target.lerpVectors(fly.ft, fly.tt, ease);
            camera.position.lerpVectors(fly.fc, fly.tc, ease);
            if (k === 1) fly = null;
        }
        if (ring.visible) ring.scale.setScalar(1 + 0.15 * Math.sin(clock.getElapsedTime() * 4));
        controls.update();
        renderer.render(scene, camera);
    }

    return {
        focus,
        setActive(on) { renderer.setAnimationLoop(on ? frame : null); },
    };
}

async function setOn(on) {
    if (on && !view) {
        toggle.disabled = true;
        try {
            view = await build();
        } catch (e) {
            // Offline or no WebGL: stay on the 2D map.
            toggle.title = 'The 3D view could not load';
            console.warn('3D view unavailable', e);
            return;
        } finally {
            toggle.disabled = false;
        }
    }
    active = on;
    toggle.setAttribute('aria-pressed', String(on));
    box.hidden = !on;
    // visibility, not display: the 2D map keeps its size and transforms.
    viewport.style.visibility = on ? 'hidden' : '';
    if (view) view.setActive(on);
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) { /* private mode */ }
}

if (toggle && box && viewport && layer) {
    toggle.addEventListener('click', () => setOn(toggle.getAttribute('aria-pressed') !== 'true'));
    let saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) { /* private mode */ }
    if (saved === '1') requestAnimationFrame(() => setOn(true));
}
