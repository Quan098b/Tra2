"use strict";

const $ = (id) => document.getElementById(id);

const VIEWS = {
    image: {
        title: "Nhận diện qua ảnh",
        sub: "Tải ảnh MRI lên để phát hiện vùng nghi ngờ u não.",
        emptyTitle: "Chưa có ảnh",
        emptyText: "Bấm “Chọn ảnh” hoặc kéo thả ảnh MRI vào đây."
    },
    video: {
        title: "Nhận diện qua video",
        sub: "Nhận diện từng khung hình của video và lưu video kết quả.",
        emptyTitle: "Chưa có video",
        emptyText: "Bấm “Chọn video” hoặc kéo thả video vào đây (.mp4, .avi, .mov, .mkv, .wmv)."
    },
    camera: {
        title: "Camera trực tiếp",
        sub: "Nhận diện thời gian thực từ webcam hoặc camera điện thoại.",
        emptyTitle: "Camera chưa bật",
        emptyText: "Chọn camera máy tính hoặc camera điện thoại (IP Webcam), rồi bấm “Bắt đầu”."
    },
    settings: {
        title: "Cài đặt model",
        sub: "Chọn file trọng số YOLO11 và xem thông tin model."
    }
};

let currentView = "image";
let streaming = null;          // "video" | "camera" | null
let pollTimer = null;
let imageFile = null;
let imageResult = null;        // {url, detections, ms} để hiển thị lại khi quay về tab ảnh

const view = $("view");


// =========================
// TIỆN ÍCH
// =========================
async function api(url, options = {}) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Lỗi máy chủ (HTTP ${res.status})`);
    return data;
}

function postJSON(url, body) {
    return api(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
}

function showMessage(text) {
    $("message").textContent = text || "";
    $("message").hidden = !text;
}

function showView(src) {
    if (src) {
        view.src = src;
        view.hidden = false;
        $("empty").hidden = true;
    } else {
        view.removeAttribute("src");
        view.hidden = true;
        $("empty").hidden = false;
    }
}

/** Đổi số liệu, có hiệu ứng "nảy" khi giá trị thay đổi. */
function setStat(id, value) {
    const el = $(id);
    const text = String(value);
    if (el.textContent === text) return;
    el.textContent = text;
    el.classList.remove("pop");
    void el.offsetWidth;   // chạy lại animation
    el.classList.add("pop");
}

function setScanning(on) {
    $("stage").classList.toggle("scanning", on);
}

function renderResults({ detections = [], ms = null, fps = null, status = null }) {
    const n = detections.length;
    setStat("stat-count", n);
    $("tile-count").classList.toggle("alert", n > 0);
    setStat("stat-ms", ms ? Math.round(ms) : "-");
    setStat("stat-fps", fps ? fps.toFixed(1) : "-");

    const el = $("status");
    if (status === null) {
        el.className = "status " + (n > 0 ? "detected" : "safe");
        el.textContent = n > 0 ? `Phát hiện ${n} vùng nghi ngờ u não` : "Không phát hiện vùng nghi ngờ";
    } else {
        el.className = "status";
        el.textContent = status;
    }

    const list = $("det-list");
    list.replaceChildren();
    if (!n) {
        const li = document.createElement("li");
        li.className = "muted";
        li.textContent = "Không phát hiện vùng nghi ngờ nào";
        list.appendChild(li);
    }
    detections.forEach((d, i) => {
        const li = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = `#${i + 1} ${d.class}`;
        const conf = document.createElement("b");
        conf.textContent = d.confidence.toFixed(1) + "%";
        li.append(name, conf);
        list.appendChild(li);
    });
}

function resetResults(status = "Chưa có kết quả") {
    renderResults({ status });
}

function setDownload(id, url) {
    const a = $(id);
    if (url) {
        a.href = url;
        a.classList.remove("disabled");
    } else {
        a.removeAttribute("href");
        a.classList.add("disabled");
    }
}


// =========================
// CHUYỂN CHẾ ĐỘ
// =========================
function switchView(name) {
    if (streaming) stopStream();
    currentView = name;

    document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    document.querySelectorAll(".toolbar").forEach((t) => { t.hidden = t.dataset.for !== name; });

    const v = VIEWS[name];
    $("page-title").textContent = v.title;
    $("page-sub").textContent = v.sub;
    const top = document.querySelector(".topbar > div");
    top.classList.remove("page-enter");
    void top.offsetWidth;
    top.classList.add("page-enter");
    setScanning(false);

    const isSettings = name === "settings";
    $("stage").hidden = isSettings;
    $("settings-page").hidden = !isSettings;
    $("zoom-field").hidden = name !== "camera";
    $("video-stats").hidden = name !== "video";
    $("video-progress-wrap").hidden = true;
    showMessage("");

    if (!isSettings) {
        $("empty-title").textContent = v.emptyTitle;
        $("empty-text").textContent = v.emptyText;
    }

    if (name === "image" && imageResult) {
        showView(imageResult.url);
        renderResults(imageResult);
    } else {
        showView(null);
        resetResults();
    }

    if (name === "camera") loadCameras();
    if (name === "settings") loadSettings();
}

document.querySelectorAll(".nav-item").forEach((b) => {
    b.addEventListener("click", () => switchView(b.dataset.view));
});


// =========================
// CÀI ĐẶT (ngưỡng, kích thước, zoom, model)
// =========================
let settingsTimer = null;

function saveSettings(body, rerunImage = false) {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(async () => {
        try {
            const s = await postJSON("/api/settings", body);
            applySettings(s);
            if (rerunImage && currentView === "image" && imageFile) detectImage(imageFile);
        } catch (exc) {
            showMessage(exc.message);
        }
    }, 200);
}

function applySettings(s) {
    $("badge-model").textContent = s.model || "-";
    $("badge-device").textContent = s.device;
    $("info-model").textContent = s.model || "-";
    $("info-device").textContent = s.gpu ? `${s.device} · ${s.gpu}` : s.device;
    $("info-classes").textContent = s.classes.join(", ") || "-";
    $("info-imgsz").textContent = s.imgsz + " px";

    const sel = $("imgsz");
    if (!sel.options.length) {
        s.imgsz_choices.forEach((v) => sel.add(new Option(v + " px", v)));
    }
    sel.value = s.imgsz;

    const models = $("model-select");
    models.replaceChildren(...s.models.map((m) => new Option(m, m)));
    models.value = s.model;
}

async function loadSettings() {
    try {
        const s = await api("/api/settings");
        applySettings(s);
        $("conf").value = s.conf;
        $("conf-value").textContent = s.conf.toFixed(2);
        $("zoom").value = s.zoom;
        $("zoom-value").textContent = s.zoom.toFixed(1) + "x";
    } catch (exc) {
        showMessage("Không kết nối được máy chủ: " + exc.message);
    }
}

$("conf").addEventListener("input", (e) => {
    $("conf-value").textContent = Number(e.target.value).toFixed(2);
    saveSettings({ conf: Number(e.target.value) }, true);
});

$("imgsz").addEventListener("change", (e) => {
    saveSettings({ imgsz: Number(e.target.value) }, true);
});

$("zoom").addEventListener("input", (e) => {
    $("zoom-value").textContent = Number(e.target.value).toFixed(1) + "x";
    saveSettings({ zoom: Number(e.target.value) });
});

$("model-load").addEventListener("click", async () => {
    const btn = $("model-load");
    btn.disabled = true;
    btn.textContent = "Đang nạp...";
    try {
        applySettings(await postJSON("/api/model", { name: $("model-select").value }));
        showMessage("");
    } catch (exc) {
        showMessage(exc.message);
    } finally {
        btn.disabled = false;
        btn.textContent = "Nạp model";
    }
});


// =========================
// ẢNH
// =========================
async function detectImage(file) {
    imageFile = file;
    $("image-name").textContent = file.name;
    showMessage("");
    renderResults({ status: "Đang nhận diện..." });

    const form = new FormData();
    form.append("image", file);
    setScanning(true);
    try {
        const r = await api("/api/detect_image", { method: "POST", body: form });
        imageResult = { url: r.url, detections: r.detections, ms: r.ms };
        if (currentView !== "image") return;
        showView(r.url);
        renderResults(imageResult);
        setDownload("image-download", r.url);
    } catch (exc) {
        showMessage(exc.message);
        resetResults();
    } finally {
        setScanning(false);
    }
}

$("image-input").addEventListener("change", (e) => {
    if (e.target.files[0]) detectImage(e.target.files[0]);
    e.target.value = "";
});


// =========================
// STREAM (video / camera)
// =========================
function startPolling(mode) {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
        let s;
        try {
            s = await api("/api/status");
        } catch {
            return;
        }
        if (streaming !== mode || s.mode !== mode) return;
        if (s.frame > 0) setScanning(false);

        renderResults({
            detections: s.detections,
            ms: s.ms,
            fps: s.fps,
            status: s.running ? null : (s.error ? "Đã dừng do lỗi" : "Hoàn tất")
        });

        if (mode === "video") {
            $("vs-frames").textContent = s.total ? `${s.frame} / ${s.total}` : s.frame;
            $("vs-tumor").textContent = s.frames_with_tumor;
            $("vs-max").textContent = s.max_confidence ? s.max_confidence.toFixed(1) + "%" : "-";
            if (s.total) $("video-progress").style.width = (100 * s.frame / s.total).toFixed(1) + "%";
        }

        if (s.error) {
            showMessage(s.error);
            stopStream();
        } else if (!s.running && s.frame > 0) {
            if (mode === "video") {
                $("video-progress").style.width = "100%";
                setDownload("video-download", s.result_file);
                const el = $("status");
                el.className = "status " + (s.frames_with_tumor ? "detected" : "safe");
                el.textContent = s.frames_with_tumor
                    ? `Hoàn tất · có u ở ${s.frames_with_tumor}/${s.frame} khung hình`
                    : `Hoàn tất · không phát hiện u (${s.frame} khung hình)`;
            }
            finishStreamUI(false);
        }
    }, 500);
}

function finishStreamUI(clearView) {
    clearInterval(pollTimer);
    setScanning(false);
    const mode = streaming;
    streaming = null;
    if (clearView) showView(null);

    if (mode === "video") {
        $("video-stop").disabled = true;
    }
    if (mode === "camera") {
        $("camera-start").hidden = false;
        $("camera-stop").hidden = true;
        $("camera-snap").disabled = true;
        $("camera-select").disabled = false;
        $("ip-url").disabled = false;
        if (clearView) resetResults("Đã dừng");
    }
}

function stopStream() {
    const mode = streaming;
    // Máy chủ dừng luồng; video giữ lại khung cuối, camera thì tắt hình
    fetch("/api/stop", { method: "POST" }).catch(() => {});
    finishStreamUI(mode === "camera");
}

view.addEventListener("error", () => {
    if (!streaming) return;
    showMessage(
        streaming === "camera"
            ? "Không mở được camera. Kiểm tra camera hoặc địa chỉ IP Webcam."
            : "Không phát được video."
    );
    stopStream();
});


// =========================
// VIDEO
// =========================
async function startVideo(file) {
    if (streaming) stopStream();
    $("video-name").textContent = file.name;
    showMessage("");
    setDownload("video-download", null);
    $("video-progress").style.width = "0";
    $("video-progress-wrap").hidden = false;
    $("vs-frames").textContent = "0";
    $("vs-tumor").textContent = "0";
    $("vs-max").textContent = "-";
    renderResults({ status: "Đang tải video lên..." });
    setScanning(true);

    const form = new FormData();
    form.append("video", file);
    try {
        const r = await api("/api/upload_video", { method: "POST", body: form });
        if (currentView !== "video") return;
        streaming = "video";
        $("video-stop").disabled = false;
        renderResults({ status: "Đang xử lý..." });
        showView("/stream/video/" + encodeURIComponent(r.id) + "?t=" + Date.now());
        startPolling("video");
    } catch (exc) {
        showMessage(exc.message);
        resetResults();
        setScanning(false);
    }
}

$("video-input").addEventListener("change", (e) => {
    if (e.target.files[0]) startVideo(e.target.files[0]);
    e.target.value = "";
});

$("video-stop").addEventListener("click", stopStream);


// =========================
// CAMERA
// =========================
const camSelect = $("camera-select");
const ipUrl = $("ip-url");

try {
    ipUrl.value = localStorage.getItem("ipWebcamUrl") || "";
} catch { /* trình duyệt chặn lưu trữ */ }

async function loadCameras() {
    const keep = camSelect.value;
    camSelect.replaceChildren(new Option("Đang tìm camera...", ""));
    let cams = [];
    try {
        cams = await api("/api/cameras");
    } catch { /* bỏ qua, vẫn cho dùng IP Webcam */ }

    camSelect.replaceChildren();
    cams.forEach((c) => camSelect.add(new Option("💻 " + c.name, c.index)));
    camSelect.add(new Option("📱 Camera điện thoại (IP Webcam)", "ip"));

    if ([...camSelect.options].some((o) => o.value === keep)) camSelect.value = keep;
    ipUrl.hidden = camSelect.value !== "ip";
}

camSelect.addEventListener("change", () => {
    ipUrl.hidden = camSelect.value !== "ip";
    if (!ipUrl.hidden) ipUrl.focus();
});

function startCamera() {
    if (streaming) stopStream();
    showMessage("");

    let src = "/stream/camera?source=" + encodeURIComponent(camSelect.value);
    if (camSelect.value === "ip") {
        const url = ipUrl.value.trim();
        if (!url) {
            showMessage("Nhập địa chỉ IP Webcam hiển thị trên điện thoại, ví dụ http://192.168.1.16:8080/video");
            ipUrl.focus();
            return;
        }
        try { localStorage.setItem("ipWebcamUrl", url); } catch { /* bỏ qua */ }
        src += "&url=" + encodeURIComponent(url);
    }

    streaming = "camera";
    $("camera-start").hidden = true;
    $("camera-stop").hidden = false;
    $("camera-snap").disabled = false;
    camSelect.disabled = true;
    ipUrl.disabled = true;
    renderResults({ status: "Đang mở camera..." });
    setScanning(true);
    showView(src + "&t=" + Date.now());
    startPolling("camera");
}

$("camera-start").addEventListener("click", startCamera);
$("camera-stop").addEventListener("click", stopStream);
$("camera-refresh").addEventListener("click", loadCameras);

$("camera-snap").addEventListener("click", async () => {
    try {
        const r = await api("/api/snapshot", { method: "POST" });
        const a = document.createElement("a");
        a.href = r.url;
        a.download = r.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
    } catch (exc) {
        showMessage(exc.message);
    }
});


// =========================
// KÉO THẢ FILE VÀO KHUNG
// =========================
const stage = $("stage");
stage.addEventListener("dragover", (e) => {
    if (currentView === "image" || currentView === "video") {
        e.preventDefault();
        stage.classList.add("dragover");
    }
});
stage.addEventListener("dragleave", () => stage.classList.remove("dragover"));
stage.addEventListener("drop", (e) => {
    e.preventDefault();
    stage.classList.remove("dragover");
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (currentView === "image") detectImage(file);
    if (currentView === "video") startVideo(file);
});

// Đóng trang -> dừng camera/video trên máy chủ
window.addEventListener("beforeunload", () => {
    if (streaming) navigator.sendBeacon("/api/stop");
});


// =========================
// TIM / NƠ BAY Ở NỀN
// =========================
function makeFloaties(count = 16) {
    const shapes = [
        '<svg viewBox="0 0 24 24" style="fill:currentColor;stroke:none"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.6 1.2 4.3 2.4h2c.7-1.2 2.2-2.4 4.3-2.4 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z"/></svg>',
        '<svg viewBox="0 0 64 40" style="stroke:none"><use href="#bow"/></svg>',
        '<svg viewBox="0 0 24 24" style="fill:currentColor;stroke:none"><path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z"/></svg>'
    ];
    const colors = ["#ff5c9a", "#ff8cba", "#ffb3cf", "#f23d83"];
    const box = $("floaties");
    for (let i = 0; i < count; i++) {
        const el = document.createElement("span");
        el.className = "floaty";
        el.innerHTML = shapes[i % shapes.length];
        const size = 14 + Math.random() * 22;
        el.style.left = Math.random() * 100 + "%";
        el.style.width = el.style.height = size + "px";
        el.style.color = colors[i % colors.length];
        el.style.animationDuration = 14 + Math.random() * 16 + "s";
        el.style.animationDelay = -Math.random() * 30 + "s";
        el.style.setProperty("--o", (0.25 + Math.random() * 0.35).toFixed(2));
        el.style.setProperty("--r", (Math.random() * 120 - 60).toFixed(0) + "deg");
        el.firstChild.style.width = el.firstChild.style.height = "100%";
        box.appendChild(el);
    }
}


// =========================
// KHỞI ĐỘNG
// =========================
makeFloaties();
loadSettings();
switchView("image");
