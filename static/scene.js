/* =========================================================
   KHUNG CẢNH ĐỘNG PHÍA SAU GIAO DIỆN
   Ngày / đêm, mặt trời, mặt trăng, sao, sao băng, mây,
   chim, cò, bướm, đom đóm, đồi cây và 4 mùa:
   xuân (hoa đào rơi), hạ (nắng, bướm, đom đóm),
   thu (lá vàng rơi), đông (tuyết rơi, đồi phủ tuyết).
   ========================================================= */
(() => {
    "use strict";

    const DAY_SECONDS = 120;      // 1 vòng ngày - đêm (chế độ Tự động)
    const SEASON_SECONDS = 45;    // mỗi mùa (chế độ Tự động)

    const SEASONS = ["spring", "summer", "autumn", "winter"];
    const SEASON_NAMES = { spring: "Mùa xuân", summer: "Mùa hạ", autumn: "Mùa thu", winter: "Mùa đông" };

    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

    // ---------- Lưu lựa chọn ----------
    const prefs = { time: "auto", season: "auto", on: true };
    try {
        Object.assign(prefs, JSON.parse(localStorage.getItem("sceneprefs") || "{}"));
    } catch { /* bỏ qua */ }
    const savePrefs = () => {
        try { localStorage.setItem("sceneprefs", JSON.stringify(prefs)); } catch { /* bỏ qua */ }
    };

    // ---------- Canvas ----------
    const canvas = document.createElement("canvas");
    canvas.className = "sky";
    canvas.setAttribute("aria-hidden", "true");
    document.body.prepend(canvas);
    const ctx = canvas.getContext("2d");

    let W = 0, H = 0;

    function resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        W = window.innerWidth;
        H = window.innerHeight;
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        makeStars();
        makeClouds();
    }

    // ---------- Tiện ích màu ----------
    const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
    const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
    const rand = (a, b) => a + Math.random() * (b - a);
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const smooth = (a, b, v) => {
        const t = clamp01((v - a) / (b - a));
        return t * t * (3 - 2 * t);
    };

    // Màu trời theo thời điểm trong ngày (phase 0 = bình minh, 0.25 = trưa, 0.5 = hoàng hôn, 0.75 = nửa đêm)
    const SKY = [
        [0.00, "#ffb1c8", "#ffe2c4"],
        [0.10, "#8ccdf7", "#ffe9f2"],
        [0.25, "#6ec3f5", "#e3f5ff"],
        [0.42, "#8ccdf7", "#fff0e0"],
        [0.50, "#ff8fb1", "#ffc38a"],
        [0.58, "#5b3f8c", "#e58bb5"],
        [0.75, "#120f33", "#3b2a66"],
        [0.92, "#2c2a6b", "#b07ab8"],
        [1.00, "#ffb1c8", "#ffe2c4"]
    ].map(([p, a, b]) => [p, hex(a), hex(b)]);

    function skyColors(p) {
        for (let i = 0; i < SKY.length - 1; i++) {
            const [p0, t0, b0] = SKY[i];
            const [p1, t1, b1] = SKY[i + 1];
            if (p >= p0 && p <= p1) {
                const t = (p - p0) / (p1 - p0);
                return [mix(t0, t1, t), mix(b0, b1, t)];
            }
        }
        return [SKY[0][1], SKY[0][2]];
    }

    // Độ tối: 0 = ban ngày, 1 = ban đêm
    function nightness(p) {
        if (p < 0.05) return 0.4 * (1 - smooth(0, 0.05, p));   // bình minh: sao mờ dần
        if (p < 0.5) return 0;                                  // ban ngày
        if (p < 0.9) return smooth(0.5, 0.62, p);               // hoàng hôn -> đêm
        return 1 - 0.6 * smooth(0.9, 1, p);                     // gần sáng
    }

    const SEASON_STYLE = {
        spring: { tint: [255, 170, 205, 0.10], hills: ["#c3ebb6", "#9fdc9b", "#7fcb83"], tree: "#ffb3cf" },
        summer: { tint: [255, 225, 110, 0.08], hills: ["#9ad99a", "#68c672", "#47ae56"], tree: "#3f9e4b" },
        autumn: { tint: [255, 150, 60, 0.12], hills: ["#f2cd8b", "#e8a35a", "#cf7a3a"], tree: "#e8762e" },
        winter: { tint: [205, 225, 255, 0.20], hills: ["#e9f1fb", "#dbe7f5", "#f8fbff"], tree: null }
    };
    const NIGHT_HILL = hex("#2a2152");

    // ---------- Trạng thái ----------
    let phase = 0.15;          // thời điểm trong ngày (0..1)
    let seasonIdx = 0;
    let prevSeasonIdx = 0;
    let seasonBlend = 1;       // 0..1 chuyển màu từ mùa cũ sang mùa mới
    let seasonClock = 0;
    let time = 0;

    const season = () => SEASONS[seasonIdx];

    function targetPhase() {
        if (prefs.time === "day") return 0.22;
        if (prefs.time === "night") return 0.75;
        return null;
    }

    function setSeason(idx) {
        if (idx === seasonIdx) return;
        prevSeasonIdx = seasonIdx;
        seasonIdx = idx;
        seasonBlend = 0;
        updateLabel();
    }

    // ---------- Sao ----------
    let stars = [];
    function makeStars() {
        const n = Math.round((W * H) / 9000);
        stars = Array.from({ length: n }, () => ({
            x: Math.random() * W,
            y: Math.random() * H * 0.7,
            r: rand(0.5, 1.8),
            tw: rand(0, Math.PI * 2),
            sp: rand(1, 3)
        }));
    }

    let shooting = null;

    // ---------- Mây ----------
    let clouds = [];
    function makeClouds() {
        const n = Math.max(4, Math.round(W / 260));
        clouds = Array.from({ length: n }, (_, i) => newCloud(Math.random() * W, i));
    }
    function newCloud(x) {
        const s = rand(0.6, 1.4);
        return {
            x,
            y: rand(0.02, 0.3) * H,
            s,
            v: rand(6, 16) * s,
            puffs: Array.from({ length: 5 }, (_, i) => ({
                dx: (i - 2) * 26 + rand(-6, 6),
                dy: -Math.abs(2 - i) * -6 + rand(-6, 2) - (i === 2 ? 14 : 0),
                r: (i === 2 ? 30 : 22) + rand(-4, 6)
            }))
        };
    }

    // ---------- Chim, cò ----------
    let flocks = [];
    let nextBird = 3;
    let nextStork = 8;

    function spawnFlock(kind) {
        const dir = Math.random() < 0.5 ? 1 : -1;
        const count = kind === "stork" ? Math.round(rand(1, 3)) : Math.round(rand(3, 7));
        const scale = kind === "stork" ? rand(0.8, 1.15) : rand(0.7, 1.2);
        const y = (Math.random() < 0.55 ? rand(0.035, 0.1) : rand(0.8, 0.9)) * H;
        const x = dir > 0 ? -120 : W + 120;
        const members = [];
        for (let i = 0; i < count; i++) {
            const row = Math.ceil(i / 2);
            const side = i % 2 ? -1 : 1;
            members.push({
                ox: -row * (kind === "stork" ? 70 : 26) * dir,
                oy: row * side * (kind === "stork" ? 26 : 14),
                ph: rand(0, Math.PI * 2)
            });
        }
        flocks.push({
            kind, dir, x, y, scale, members,
            v: (kind === "stork" ? rand(32, 46) : rand(55, 85)) * dir,
            bob: rand(0, Math.PI * 2)
        });
    }

    function drawBird(x, y, s, flap) {
        const w = 12 * s;
        const lift = 7 * s * flap;
        ctx.beginPath();
        ctx.moveTo(x - w, y - lift);
        ctx.quadraticCurveTo(x - w * 0.45, y - 2 * s - lift * 0.4, x, y);
        ctx.quadraticCurveTo(x + w * 0.45, y - 2 * s - lift * 0.4, x + w, y - lift);
        ctx.stroke();
    }

    function drawStork(x, y, s, dir, flap) {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(s * dir, s);

        // Chân dài thả phía sau
        ctx.strokeStyle = "#ff7a59";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-12, 3); ctx.lineTo(-44, 8);
        ctx.moveTo(-12, 5); ctx.lineTo(-42, 12);
        ctx.stroke();

        // Cánh xa
        drawStorkWing(-flap * 0.85, "#e9e6f0");

        // Thân
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.ellipse(0, 0, 17, 7, -0.05, 0, Math.PI * 2);
        ctx.fill();

        // Cổ, đầu, mỏ
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 4.5;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(13, -2);
        ctx.quadraticCurveTo(22, -3, 30, -5);
        ctx.stroke();
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(31, -5, 4.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#4a2b3a";
        ctx.beginPath();
        ctx.arc(32.5, -6, 0.9, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#ff9a3c";
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(34, -4.5);
        ctx.lineTo(48, -1);
        ctx.stroke();

        // Cánh gần
        drawStorkWing(flap, "#ffffff");
        ctx.restore();
    }

    function drawStorkWing(flap, color) {
        const tipY = -30 * flap;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(-9, -2);
        ctx.quadraticCurveTo(-12, tipY * 0.6, -6, tipY);
        ctx.lineTo(10, tipY * 0.95);
        ctx.quadraticCurveTo(12, tipY * 0.5, 8, -2);
        ctx.closePath();
        ctx.fill();
        // Lông đầu cánh màu đen
        ctx.fillStyle = "#2b2236";
        ctx.beginPath();
        ctx.moveTo(-6, tipY);
        ctx.lineTo(10, tipY * 0.95);
        ctx.lineTo(9, tipY * 0.72);
        ctx.lineTo(-7, tipY * 0.78);
        ctx.closePath();
        ctx.fill();
    }

    // ---------- Bướm & đom đóm ----------
    const butterflies = Array.from({ length: 5 }, () => ({
        x: Math.random(), y: rand(0.84, 0.95), t: rand(0, 100),
        c: ["#ff7eb0", "#ffd166", "#b69cff", "#7fd4ff"][Math.floor(rand(0, 4))]
    }));
    const fireflies = Array.from({ length: 26 }, () => ({
        x: Math.random(), y: rand(0.8, 0.97), t: rand(0, 100)
    }));

    // ---------- Hoa, lá, tuyết rơi ----------
    const DENSITY = { spring: 45, summer: 14, autumn: 38, winter: 110 };
    const particles = Array.from({ length: 110 }, (_, i) => newParticle(i, true));

    function newParticle(i, anywhere) {
        const s = season();
        const p = {
            i,
            type: s,
            active: i < DENSITY[s],
            x: Math.random() * W,
            y: anywhere ? Math.random() * H : rand(-60, -10),
            rot: rand(0, Math.PI * 2),
            vr: rand(-1.5, 1.5),
            sway: rand(0, Math.PI * 2)
        };
        if (s === "spring") Object.assign(p, { vy: rand(25, 45), size: rand(4, 7), color: ["#ffb7d0", "#ff9cc2", "#ffd1e1"][i % 3] });
        if (s === "summer") Object.assign(p, { vy: rand(-12, -5), size: rand(1.2, 2.6), color: "#fff2a8", y: anywhere ? Math.random() * H : H + 10 });
        if (s === "autumn") Object.assign(p, { vy: rand(30, 55), size: rand(7, 11), color: ["#f59e0b", "#ea580c", "#dc2626", "#facc15"][i % 4] });
        if (s === "winter") Object.assign(p, { vy: rand(20, 55), size: rand(1.2, 3.6), color: "#ffffff" });
        return p;
    }

    function drawParticle(p) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.type === "spring") {
            // Cánh hoa đào
            ctx.beginPath();
            ctx.moveTo(0, -p.size);
            ctx.quadraticCurveTo(p.size, -p.size * 0.2, 0, p.size);
            ctx.quadraticCurveTo(-p.size, -p.size * 0.2, 0, -p.size);
            ctx.fill();
        } else if (p.type === "autumn") {
            // Lá thu
            const s = p.size;
            ctx.beginPath();
            ctx.moveTo(0, -s);
            ctx.quadraticCurveTo(s * 0.8, -s * 0.2, 0, s);
            ctx.quadraticCurveTo(-s * 0.8, -s * 0.2, 0, -s);
            ctx.fill();
            ctx.strokeStyle = "rgba(90,40,10,0.45)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, -s);
            ctx.lineTo(0, s + 3);
            ctx.stroke();
        } else if (p.type === "winter") {
            ctx.globalAlpha = 0.9;
            ctx.beginPath();
            ctx.arc(0, 0, p.size, 0, Math.PI * 2);
            ctx.fill();
        } else {
            // Hạ: hạt nắng lấp lánh bay lên
            ctx.globalAlpha = 0.5 + 0.5 * Math.sin(time * 3 + p.sway);
            ctx.beginPath();
            ctx.arc(0, 0, p.size, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    // ---------- Vẽ mặt trời, mặt trăng ----------
    function drawSun(x, y, r) {
        const glow = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 4);
        glow.addColorStop(0, "rgba(255,226,120,0.55)");
        glow.addColorStop(1, "rgba(255,226,120,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(x - r * 4, y - r * 4, r * 8, r * 8);

        // Tia nắng xoay
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(time * 0.25);
        ctx.fillStyle = "rgba(255,200,90,0.85)";
        const rays = 12;
        const len = season() === "summer" ? 1.75 : 1.5;
        for (let i = 0; i < rays; i++) {
            ctx.rotate((Math.PI * 2) / rays);
            ctx.beginPath();
            ctx.moveTo(-r * 0.18, -r * 1.15);
            ctx.lineTo(0, -r * (len + 0.08 * Math.sin(time * 3 + i)));
            ctx.lineTo(r * 0.18, -r * 1.15);
            ctx.fill();
        }
        ctx.restore();

        ctx.fillStyle = "#ffd25e";
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        cuteFace(x, y, r, false);
    }

    function drawMoon(x, y, r) {
        const glow = ctx.createRadialGradient(x, y, r * 0.8, x, y, r * 3.5);
        glow.addColorStop(0, "rgba(255,246,216,0.4)");
        glow.addColorStop(1, "rgba(255,246,216,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(x - r * 3.5, y - r * 3.5, r * 7, r * 7);

        ctx.fillStyle = "#fff4d1";
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(220,200,160,0.45)";
        [[-0.35, -0.3, 0.18], [0.4, 0.25, 0.13], [0.1, 0.5, 0.1]].forEach(([dx, dy, rr]) => {
            ctx.beginPath();
            ctx.arc(x + dx * r, y + dy * r, rr * r, 0, Math.PI * 2);
            ctx.fill();
        });
        cuteFace(x, y, r, true);
    }

    // Mặt cười (mặt trời) / mặt ngủ (mặt trăng)
    function cuteFace(x, y, r, sleeping) {
        ctx.strokeStyle = "#7a4a3a";
        ctx.fillStyle = "#7a4a3a";
        ctx.lineWidth = Math.max(1.5, r * 0.07);
        ctx.lineCap = "round";
        const ex = r * 0.32, ey = -r * 0.08;
        if (sleeping) {
            [-1, 1].forEach((s) => {
                ctx.beginPath();
                ctx.arc(x + s * ex, y + ey, r * 0.12, 0.15 * Math.PI, 0.85 * Math.PI);
                ctx.stroke();
            });
        } else {
            const blink = Math.sin(time * 1.3) > 0.97 ? 0.15 : 1;
            [-1, 1].forEach((s) => {
                ctx.beginPath();
                ctx.ellipse(x + s * ex, y + ey, r * 0.07, r * 0.1 * blink, 0, 0, Math.PI * 2);
                ctx.fill();
            });
        }
        ctx.beginPath();
        ctx.arc(x, y + r * 0.12, r * 0.18, 0.15 * Math.PI, 0.85 * Math.PI);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,120,160,0.45)";
        [-1, 1].forEach((s) => {
            ctx.beginPath();
            ctx.ellipse(x + s * r * 0.55, y + r * 0.2, r * 0.14, r * 0.08, 0, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    // ---------- Đồi & cây ----------
    function hillY(layer, x) {
        const base = H * (0.8 + layer * 0.06);
        const amp = H * (0.035 - layer * 0.006);
        return base - amp * Math.sin(x / (W / (2.2 + layer)) + layer * 1.7) - amp * 0.5 * Math.sin(x / 90 + layer);
    }

    const TREES = [0.08, 0.22, 0.47, 0.71, 0.9];

    function drawHillsAndTrees(n) {
        const cur = SEASON_STYLE[season()];
        const prev = SEASON_STYLE[SEASONS[prevSeasonIdx]];
        for (let layer = 0; layer < 3; layer++) {
            let c = mix(hex(prev.hills[layer]), hex(cur.hills[layer]), seasonBlend);
            c = mix(c, NIGHT_HILL, n * (0.6 - layer * 0.08));
            ctx.fillStyle = rgb(c);
            ctx.beginPath();
            ctx.moveTo(0, H);
            for (let x = 0; x <= W + 20; x += 20) ctx.lineTo(x, hillY(layer, x));
            ctx.lineTo(W, H);
            ctx.closePath();
            ctx.fill();

            if (layer === 1) TREES.forEach((f, i) => drawTree(W * f, hillY(1, W * f), i, n));
        }
    }

    function drawTree(x, y, i, n) {
        const s = season();
        const sway = Math.sin(time * 1.2 + i) * 0.04;
        const h = 46 + (i % 3) * 10;
        const dark = (c) => rgb(mix(hex(c), NIGHT_HILL, n * 0.5));

        ctx.save();
        ctx.translate(x, y + 4);
        ctx.rotate(sway);
        ctx.strokeStyle = dark("#8b5a3c");
        ctx.lineWidth = 6;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, -h);
        ctx.stroke();

        if (s === "winter") {
            // Cành khô phủ tuyết
            ctx.lineWidth = 3;
            [[-1, 0.55], [1, 0.7], [-1, 0.85], [1, 0.95]].forEach(([d, k]) => {
                ctx.strokeStyle = dark("#8b5a3c");
                ctx.beginPath();
                ctx.moveTo(0, -h * k);
                ctx.lineTo(d * 18, -h * k - 14);
                ctx.stroke();
                ctx.fillStyle = "#ffffff";
                ctx.beginPath();
                ctx.ellipse(d * 14, -h * k - 13, 7, 3, d * -0.6, 0, Math.PI * 2);
                ctx.fill();
            });
        } else {
            const color = SEASON_STYLE[s].tree;
            ctx.fillStyle = dark(color);
            [[0, -h - 14, 24], [-16, -h - 2, 18], [16, -h - 2, 18], [0, -h + 8, 18]].forEach(([dx, dy, r]) => {
                ctx.beginPath();
                ctx.arc(dx, dy, r, 0, Math.PI * 2);
                ctx.fill();
            });
            if (s === "spring") {
                // Bông hoa đào trên tán
                ctx.fillStyle = dark("#ffffff");
                [[-10, -h - 18], [8, -h - 8], [-4, -h + 4], [14, -h - 20], [-18, -h - 4]].forEach(([dx, dy]) => {
                    ctx.beginPath();
                    ctx.arc(dx, dy, 2.6, 0, Math.PI * 2);
                    ctx.fill();
                });
            }
            if (s === "autumn") {
                ctx.fillStyle = dark("#facc15");
                [[-8, -h - 16], [10, -h - 6], [0, -h + 6]].forEach(([dx, dy]) => {
                    ctx.beginPath();
                    ctx.arc(dx, dy, 6, 0, Math.PI * 2);
                    ctx.fill();
                });
            }
        }
        ctx.restore();
    }

    // ---------- Vòng lặp ----------
    let last = performance.now();
    let paused = false;

    function step(now) {
        const dt = Math.min((now - last) / 1000, 0.1);
        last = now;
        if (!paused) {
            update(reduceMotion ? 0 : dt);
            draw();
        }
        if (!reduceMotion) requestAnimationFrame(step);
    }

    function update(dt) {
        time += dt;

        // Thời gian trong ngày
        const target = targetPhase();
        if (target === null) {
            phase = (phase + dt / DAY_SECONDS) % 1;
        } else {
            let d = target - phase;
            if (d > 0.5) d -= 1;
            if (d < -0.5) d += 1;
            phase = (phase + d * Math.min(1, dt * 1.5) + 1) % 1;
        }

        // Mùa
        if (prefs.season === "auto") {
            seasonClock += dt;
            if (seasonClock > SEASON_SECONDS) {
                seasonClock = 0;
                setSeason((seasonIdx + 1) % 4);
            }
        }
        seasonBlend = Math.min(1, seasonBlend + dt / 3);

        const n = nightness(phase);

        // Mây
        clouds.forEach((c, i) => {
            c.x += c.v * dt;
            if (c.x - 120 * c.s > W) clouds[i] = newCloud(-140 * c.s);
        });

        // Chim & cò (ban ngày)
        nextBird -= dt;
        nextStork -= dt;
        if (n < 0.4) {
            if (nextBird <= 0) {
                spawnFlock("bird");
                nextBird = season() === "winter" ? rand(18, 30) : rand(7, 14);
            }
            if (nextStork <= 0) {
                if (season() !== "winter") spawnFlock("stork");
                nextStork = rand(14, 24);
            }
        }
        flocks.forEach((f) => { f.x += f.v * dt; });
        flocks = flocks.filter((f) => (f.dir > 0 ? f.x < W + 400 : f.x > -400));

        // Sao băng
        if (n > 0.7 && !shooting && Math.random() < dt * 0.12) {
            shooting = { x: rand(0.2, 0.9) * W, y: rand(0.05, 0.3) * H, life: 0 };
        }
        if (shooting) {
            shooting.life += dt;
            if (shooting.life > 1.1) shooting = null;
        }

        // Hạt rơi
        const density = DENSITY[season()];
        particles.forEach((p, i) => {
            if (!p.active) {
                if (i < density && Math.random() < dt * 0.6) particles[i] = newParticle(i, false);
                return;
            }
            p.y += p.vy * dt;
            p.sway += dt * (p.type === "winter" ? 1.2 : 2);
            p.x += Math.sin(p.sway) * (p.type === "autumn" ? 40 : 18) * dt;
            p.rot += p.vr * dt;
            const out = p.vy > 0 ? p.y > H + 20 : p.y < -20;
            if (out || p.x < -40 || p.x > W + 40) {
                particles[i] = i < density ? newParticle(i, false) : { ...p, active: false };
            }
        });
    }

    function draw() {
        const n = nightness(phase);
        const [top, bottom] = skyColors(phase);

        // Bầu trời
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, rgb(top));
        g.addColorStop(1, rgb(bottom));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);

        // Màu nhuộm theo mùa
        const tc = SEASON_STYLE[season()].tint;
        const tp = SEASON_STYLE[SEASONS[prevSeasonIdx]].tint;
        const tint = mix(tp, tc, seasonBlend);
        ctx.fillStyle = rgb(tint, tint[3] * (1 - n * 0.6));
        ctx.fillRect(0, 0, W, H);

        // Sao
        if (n > 0.02) {
            ctx.fillStyle = "#ffffff";
            stars.forEach((s) => {
                ctx.globalAlpha = n * (0.4 + 0.6 * Math.abs(Math.sin(time * s.sp * 0.5 + s.tw)));
                ctx.beginPath();
                ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
                ctx.fill();
            });
            ctx.globalAlpha = 1;
        }

        if (shooting) {
            const t = shooting.life;
            const x = shooting.x + t * 420;
            const y = shooting.y + t * 160;
            const tail = ctx.createLinearGradient(x, y, x - 120, y - 46);
            tail.addColorStop(0, `rgba(255,255,255,${1 - t / 1.1})`);
            tail.addColorStop(1, "rgba(255,255,255,0)");
            ctx.strokeStyle = tail;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x - 120, y - 46);
            ctx.stroke();
        }

        // Mặt trời: đi từ trái sang phải trong nửa ngày đầu
        const r = Math.max(26, Math.min(W, H) * 0.045);
        if (phase < 0.54) {
            const t = (phase + 0.02) / 0.56;
            drawSun(W * (0.08 + 0.84 * t), H * 0.6 - Math.sin(Math.PI * t) * H * 0.52, r);
        }
        // Mặt trăng: nửa ngày sau
        if (phase > 0.46) {
            const t = (phase - 0.46) / 0.56;
            drawMoon(W * (0.08 + 0.84 * t), H * 0.6 - Math.sin(Math.PI * t) * H * 0.52, r * 0.85);
        }

        // Mây
        const cloudColor = mix(hex(season() === "winter" ? "#f1f4fa" : "#ffffff"), hex("#5d4f8f"), n * 0.75);
        clouds.forEach((c) => {
            ctx.fillStyle = rgb(cloudColor, 0.9);
            c.puffs.forEach((p) => {
                ctx.beginPath();
                ctx.arc(c.x + p.dx * c.s, c.y + p.dy * c.s, p.r * c.s, 0, Math.PI * 2);
                ctx.fill();
            });
        });

        // Chim & cò
        flocks.forEach((f) => {
            const bob = Math.sin(time * 1.5 + f.bob) * 6;
            f.members.forEach((m) => {
                const x = f.x + m.ox;
                const y = f.y + m.oy + bob;
                if (f.kind === "stork") {
                    drawStork(x, y, f.scale, f.dir, Math.sin(time * 3.2 + m.ph));
                } else {
                    ctx.strokeStyle = rgb(mix(hex("#4a2b3a"), hex("#ffffff"), n), 0.75);
                    ctx.lineWidth = 2;
                    ctx.lineCap = "round";
                    drawBird(x, y, f.scale, Math.sin(time * 9 + m.ph));
                }
            });
        });

        // Đồi & cây
        drawHillsAndTrees(n);

        // Bướm (xuân, hạ - ban ngày)
        if ((season() === "spring" || season() === "summer") && n < 0.5) {
            butterflies.forEach((b) => {
                b.t += 0.016;
                const x = ((b.x * W + b.t * 30) % (W + 60)) - 30;
                const y = b.y * H + Math.sin(b.t * 2) * 30;
                const wing = Math.abs(Math.sin(b.t * 14));
                ctx.fillStyle = b.c;
                ctx.globalAlpha = 0.9 * (1 - n * 2);
                [-1, 1].forEach((s) => {
                    ctx.beginPath();
                    ctx.ellipse(x + s * 5 * wing, y, 6 * wing + 1, 8, s * 0.4, 0, Math.PI * 2);
                    ctx.fill();
                });
                ctx.globalAlpha = 1;
            });
        }

        // Đom đóm (hạ - ban đêm)
        if (season() === "summer" && n > 0.4) {
            fireflies.forEach((f) => {
                f.t += 0.016;
                const x = (f.x * W + Math.sin(f.t * 0.7) * 40);
                const y = f.y * H + Math.cos(f.t * 0.9) * 20;
                const a = n * (0.3 + 0.7 * Math.abs(Math.sin(f.t * 2)));
                const glow = ctx.createRadialGradient(x, y, 0, x, y, 8);
                glow.addColorStop(0, `rgba(255,245,150,${a})`);
                glow.addColorStop(1, "rgba(255,245,150,0)");
                ctx.fillStyle = glow;
                ctx.fillRect(x - 8, y - 8, 16, 16);
            });
        }

        // Hoa / lá / tuyết / hạt nắng
        particles.forEach((p) => { if (p.active) drawParticle(p); });
    }

    // ---------- Bảng điều khiển ----------
    const panel = document.createElement("div");
    panel.className = "scene-ctl";
    panel.innerHTML = `
        <button type="button" class="scene-toggle" id="scene-toggle" aria-expanded="false" title="Khung cảnh">
            <span id="scene-icon">🌤️</span><span id="scene-label">Khung cảnh</span>
        </button>
        <div class="scene-box" id="scene-box" hidden>
            <div class="scene-group">
                <span>Thời gian</span>
                <div class="chips" data-key="time">
                    <button type="button" data-v="auto">🔄 Tự động</button>
                    <button type="button" data-v="day">☀️ Ban ngày</button>
                    <button type="button" data-v="night">🌙 Ban đêm</button>
                </div>
            </div>
            <div class="scene-group">
                <span>Mùa</span>
                <div class="chips" data-key="season">
                    <button type="button" data-v="auto">🔄 Tự động</button>
                    <button type="button" data-v="spring">🌸 Xuân</button>
                    <button type="button" data-v="summer">🌻 Hạ</button>
                    <button type="button" data-v="autumn">🍁 Thu</button>
                    <button type="button" data-v="winter">❄️ Đông</button>
                </div>
            </div>
            <div class="scene-group">
                <span>Hiệu ứng</span>
                <div class="chips" data-key="on">
                    <button type="button" data-v="true">Bật</button>
                    <button type="button" data-v="false">Tắt (máy chạy nhẹ hơn)</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(panel);

    const box = panel.querySelector("#scene-box");
    const toggle = panel.querySelector("#scene-toggle");
    toggle.addEventListener("click", () => {
        box.hidden = !box.hidden;
        toggle.setAttribute("aria-expanded", String(!box.hidden));
    });

    function refreshChips() {
        panel.querySelectorAll(".chips").forEach((group) => {
            const key = group.dataset.key;
            group.querySelectorAll("button").forEach((b) => {
                b.classList.toggle("on", String(prefs[key]) === b.dataset.v);
            });
        });
    }

    panel.querySelectorAll(".chips").forEach((group) => {
        group.addEventListener("click", (e) => {
            const b = e.target.closest("button");
            if (!b) return;
            const key = group.dataset.key;
            prefs[key] = key === "on" ? b.dataset.v === "true" : b.dataset.v;
            if (key === "season" && prefs.season !== "auto") setSeason(SEASONS.indexOf(prefs.season));
            if (key === "season" && prefs.season === "auto") seasonClock = 0;
            if (key === "on") applyOnOff();
            savePrefs();
            refreshChips();
            updateLabel();
        });
    });

    function applyOnOff() {
        canvas.hidden = !prefs.on;
        document.body.classList.toggle("scene-off", !prefs.on);
        paused = !prefs.on;
    }

    let lastLabel = "";
    function updateLabel() {
        const night = nightness(phase) > 0.5;
        const icon = !prefs.on ? "🎀" : night ? "🌙" : { spring: "🌸", summer: "☀️", autumn: "🍁", winter: "❄️" }[season()];
        const text = !prefs.on ? "Khung cảnh: tắt" : `${SEASON_NAMES[season()]} · ${night ? "Ban đêm" : "Ban ngày"}`;
        if (text + icon === lastLabel) return;
        lastLabel = text + icon;
        panel.querySelector("#scene-icon").textContent = icon;
        panel.querySelector("#scene-label").textContent = text;
    }
    setInterval(updateLabel, 1000);

    // ---------- Khởi động ----------
    if (prefs.season !== "auto" && SEASONS.includes(prefs.season)) {
        seasonIdx = prevSeasonIdx = SEASONS.indexOf(prefs.season);
    } else {
        // Tự động: bắt đầu theo mùa thật của tháng hiện tại
        const m = new Date().getMonth();
        seasonIdx = prevSeasonIdx = m < 3 ? 0 : m < 6 ? 1 : m < 9 ? 2 : 3;
    }
    if (targetPhase() !== null) phase = targetPhase();

    resize();
    particles.forEach((p, i) => { particles[i] = newParticle(i, true); });
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", () => {
        paused = document.hidden || !prefs.on;
        last = performance.now();
    });

    applyOnOff();
    refreshChips();
    updateLabel();
    draw();
    if (!reduceMotion) requestAnimationFrame(step);
})();
