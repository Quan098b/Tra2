import os
import sys
import time
import uuid
import socket
import ctypes
import threading
import webbrowser
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request
from ultralytics import YOLO
import cv2
import numpy as np
import torch

# =========================
# ĐƯỜNG DẪN & CẤU HÌNH
# =========================
BASE_DIR = Path(__file__).resolve().parent
MODEL_DIR = BASE_DIR / "models"                 # đặt các file .pt vào đây
UPLOAD_FOLDER = BASE_DIR / "static" / "uploads"
RESULT_FOLDER = BASE_DIR / "static" / "results"

UPLOAD_FOLDER.mkdir(parents=True, exist_ok=True)
RESULT_FOLDER.mkdir(parents=True, exist_ok=True)

HOST = "127.0.0.1"
IS_WINDOWS = sys.platform == "win32"

IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".bmp", ".webp"]
VIDEO_EXTENSIONS = [".mp4", ".avi", ".mov", ".mkv", ".wmv"]
IMG_SIZE_CHOICES = [320, 416, 480, 640, 800, 960, 1280]

CLASS_NAME = "U Nao"  # tên hiển thị trên khung
BOX_COLOR = (147, 20, 255)  # màu khung (BGR) - hồng đậm #FF1493

# Dùng GPU nếu có, không thì chạy CPU
DEVICE = 0 if torch.cuda.is_available() else "cpu"
DEVICE_NAME = "CUDA" if DEVICE == 0 else "CPU"

# Chỉnh được trên giao diện
settings = {
    "conf": 0.25,   # ngưỡng tin cậy (ảnh, video, camera)
    "imgsz": 640,   # kích thước ảnh đầu vào model
    "zoom": 1.0,    # zoom số cho camera (đặt camera xa)
}

app = Flask(__name__)


# =========================
# MÔ HÌNH
# =========================
model_lock = threading.Lock()
model_info = {"model": None, "name": None}


def list_models():
    return sorted(p.name for p in MODEL_DIR.glob("*.pt"))


def load_model(name):
    path = MODEL_DIR / name
    if path.parent != MODEL_DIR or not path.exists():
        raise FileNotFoundError(f"Không tìm thấy model: {name}")
    model = YOLO(str(path))
    with model_lock:
        model_info["model"] = model
        model_info["name"] = name
    print(f"Đã nạp model {name} | nhãn: {model.names} | thiết bị: {DEVICE_NAME}")


def cv_path(path):
    """OpenCV trên Windows không mở được đường dẫn có ký tự Unicode -> dùng tên ngắn 8.3."""
    path = str(path)
    if not IS_WINDOWS or path.isascii():
        return path
    buf = ctypes.create_unicode_buffer(1024)
    if ctypes.windll.kernel32.GetShortPathNameW(path, buf, 1024):
        return buf.value
    return path


def detect_and_draw(img):
    """Chạy YOLO trên 1 ảnh BGR, vẽ khung lên ảnh. Trả về (danh sách phát hiện, ms)."""
    start = time.perf_counter()
    with model_lock:
        model = model_info["model"]
        results = model.predict(
            source=img,
            conf=settings["conf"],
            imgsz=settings["imgsz"],
            device=DEVICE,
            verbose=False
        )
    ms = (time.perf_counter() - start) * 1000

    detections = []
    for result in results:
        if result.boxes is None:
            continue

        for box in result.boxes:
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            confidence = float(box.conf[0])

            detections.append({
                "class": CLASS_NAME,
                "original_class": model.names[int(box.cls[0])],
                "confidence": round(confidence * 100, 2),
            })

            # Khung hồng đậm + nhãn nền hồng chữ trắng
            cv2.rectangle(img, (x1, y1), (x2, y2), BOX_COLOR, 2)

            label = f"{CLASS_NAME} {confidence * 100:.1f}%"
            (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.7, 2)
            text_y = max(y1 - 10, th + 10)
            cv2.rectangle(img, (x1, text_y - th - 10), (x1 + tw + 10, text_y + 5), BOX_COLOR, -1)
            cv2.putText(img, label, (x1 + 5, text_y - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)

    return detections, round(ms, 1)


def zoom_frame(frame, zoom):
    """Zoom số: cắt vùng giữa khung hình rồi phóng lại về kích thước gốc."""
    if zoom <= 1.0:
        return frame
    h, w = frame.shape[:2]
    cw, ch = int(w / zoom), int(h / zoom)
    x, y = (w - cw) // 2, (h - ch) // 2
    return cv2.resize(frame[y:y + ch, x:x + cw], (w, h), interpolation=cv2.INTER_LINEAR)


# =========================
# TRẠNG THÁI STREAM (video / camera)
# =========================
# Mỗi lần bắt đầu stream mới thì tăng id -> stream cũ tự dừng.
stream_lock = threading.Lock()
capture_lock = threading.Lock()  # chỉ 1 camera được mở tại một thời điểm
stream_state = {"id": 0}
last_frame = {"img": None}       # frame kết quả mới nhất (để chụp ảnh)


def new_stream(mode, total=0):
    with stream_lock:
        stream_state.update({
            "id": stream_state["id"] + 1,
            "mode": mode,
            "running": mode is not None,
            "done": False,
            "error": None,
            "frame": 0,
            "total": total,
            "fps": 0.0,
            "ms": 0.0,
            "detections": [],
            "max_confidence": 0.0,
            "frames_with_tumor": 0,
            "result_file": None,
        })
        last_frame["img"] = None
        return stream_state["id"]


def stream_active(sid):
    return stream_state["id"] == sid


def update_stream(sid, detections, fps, ms):
    with stream_lock:
        if not stream_active(sid):
            return
        stream_state["frame"] += 1
        stream_state["fps"] = round(fps, 1)
        stream_state["ms"] = ms
        stream_state["detections"] = detections
        if detections:
            stream_state["frames_with_tumor"] += 1
            stream_state["max_confidence"] = max(
                stream_state["max_confidence"],
                max(d["confidence"] for d in detections)
            )


def finish_stream(sid, error=None):
    with stream_lock:
        if stream_active(sid):
            stream_state["running"] = False
            stream_state["done"] = error is None
            stream_state["error"] = error


def mjpeg(frame):
    ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
    if not ok:
        return b""
    return b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpg.tobytes() + b"\r\n"


def process_frames(sid, read_frame, writer=None, camera=False):
    """Đọc frame -> nhận diện -> trả MJPEG cho trình duyệt."""
    last = time.time()
    fps = 0.0
    while stream_active(sid):
        frame = read_frame()
        if frame is None:
            break

        if camera:
            frame = zoom_frame(frame, settings["zoom"])

        detections, ms = detect_and_draw(frame)

        if writer is not None:
            writer.write(frame)

        now = time.time()
        fps = 0.8 * fps + 0.2 * (1.0 / max(now - last, 1e-6))
        last = now
        update_stream(sid, detections, fps, ms)
        last_frame["img"] = frame

        yield mjpeg(frame)


# =========================
# CAMERA (webcam / điện thoại IP Webcam)
# =========================
class CameraReader:
    """Đọc camera ở luồng riêng, luôn giữ frame mới nhất
    (tránh trễ dồn khi model chạy chậm hơn camera, nhất là IP Webcam)."""

    def __init__(self, cap):
        self.cap = cap
        self.frame = None
        self.seq = 0
        self.failed = False
        self.stopped = False
        self.cond = threading.Condition()
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        fails = 0
        while not self.stopped:
            ok, frame = self.cap.read()
            if not ok:
                fails += 1
                if fails > 50:
                    break
                time.sleep(0.05)
                continue
            fails = 0
            with self.cond:
                self.frame = frame
                self.seq += 1
                self.cond.notify_all()
        with self.cond:
            self.failed = True
            self.cond.notify_all()

    def reader(self):
        last_seq = [0]

        def read():
            with self.cond:
                self.cond.wait_for(lambda: self.seq != last_seq[0] or self.failed, timeout=10)
                if self.seq == last_seq[0]:
                    return None
                last_seq[0] = self.seq
                return self.frame.copy()

        return read

    def release(self):
        self.stopped = True
        time.sleep(0.1)
        self.cap.release()


def normalize_ip_url(url):
    """'192.168.1.16:8080' -> 'http://192.168.1.16:8080/video' (app IP Webcam)."""
    url = url.strip()
    if "://" not in url:
        url = "http://" + url
    scheme, rest = url.split("://", 1)
    if "/" not in rest:
        url += "/video"
    return url


def list_cameras():
    """Danh sách webcam theo thứ tự DirectShow (khớp chỉ số cv2.CAP_DSHOW)."""
    names = []
    if IS_WINDOWS:
        try:
            from pygrabber.dshow_graph import FilterGraph
            names = FilterGraph().get_input_devices()
        except Exception as exc:
            print("Không đọc được tên camera:", exc)

    if not names and capture_lock.acquire(timeout=5):
        try:
            backend = cv2.CAP_DSHOW if IS_WINDOWS else cv2.CAP_ANY
            for i in range(5):
                cap = cv2.VideoCapture(i, backend)
                if cap.isOpened():
                    names.append(f"Camera {i}")
                cap.release()
        finally:
            capture_lock.release()

    return [{"index": i, "name": n} for i, n in enumerate(names)]


def camera_stream(sid, source):
    # Chờ stream cũ giải phóng camera rồi mới mở
    if not capture_lock.acquire(timeout=10):
        finish_stream(sid, "Camera đang bận, hãy thử lại.")
        return

    reader = None
    try:
        if not stream_active(sid):
            return

        if isinstance(source, int):
            backend = cv2.CAP_DSHOW if IS_WINDOWS else cv2.CAP_ANY
            cap = cv2.VideoCapture(source, backend)
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        else:
            cap = cv2.VideoCapture(source)

        if not cap.isOpened():
            cap.release()
            finish_stream(
                sid,
                "Không mở được camera. Kiểm tra camera có đang bị ứng dụng khác dùng, "
                "hoặc địa chỉ IP Webcam và điện thoại cùng mạng Wi-Fi với máy tính."
            )
            return

        reader = CameraReader(cap)
        yield from process_frames(sid, reader.reader(), camera=True)

        if stream_active(sid) and reader.failed:
            finish_stream(sid, "Mất tín hiệu camera.")
        else:
            finish_stream(sid)
    finally:
        if reader is not None:
            reader.release()
        capture_lock.release()


@app.route("/api/cameras")
def api_cameras():
    return jsonify(list_cameras())


@app.route("/stream/camera")
def stream_camera():
    source = request.args.get("source", "0")
    if source == "ip":
        url = request.args.get("url", "")
        if not url.strip():
            return Response("Chưa nhập địa chỉ IP Webcam.", status=400)
        source = normalize_ip_url(url)
    else:
        try:
            source = int(source)
        except ValueError:
            return Response(status=400)

    sid = new_stream("camera")
    return Response(camera_stream(sid, source), mimetype="multipart/x-mixed-replace; boundary=frame")


@app.route("/api/snapshot", methods=["POST"])
def api_snapshot():
    img = last_frame["img"]
    if img is None:
        return jsonify(error="Chưa có khung hình để chụp."), 400
    name = time.strftime("camera_%Y%m%d_%H%M%S.jpg")
    ok, jpg = cv2.imencode(".jpg", img)
    jpg.tofile(str(RESULT_FOLDER / name))
    return jsonify(url="/static/results/" + name, name=name)


# =========================
# VIDEO
# =========================
@app.route("/api/upload_video", methods=["POST"])
def api_upload_video():
    file = request.files.get("video")
    if file is None or file.filename == "":
        return jsonify(error="Chưa chọn video."), 400
    ext = Path(file.filename).suffix.lower()
    if ext not in VIDEO_EXTENSIONS:
        return jsonify(error="Định dạng video không được hỗ trợ."), 400
    name = uuid.uuid4().hex + ext
    file.save(str(UPLOAD_FOLDER / name))
    return jsonify(id=name)


def video_stream(sid, cap, writer):
    try:
        def read():
            ok, frame = cap.read()
            return frame if ok else None

        yield from process_frames(sid, read, writer)
        finish_stream(sid)
    finally:
        cap.release()
        if writer is not None:
            writer.release()
        with stream_lock:
            if stream_active(sid):
                stream_state["running"] = False


@app.route("/stream/video/<name>")
def stream_video(name):
    src = UPLOAD_FOLDER / name
    if Path(name).name != name or not src.exists():
        return Response(status=404)

    cap = cv2.VideoCapture(cv_path(src))
    sid = new_stream("video", int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0))

    if not cap.isOpened():
        cap.release()
        finish_stream(sid, "Không đọc được video.")
        return Response(status=415)

    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    size = (int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))

    result_name = "result_" + Path(name).stem + ".mp4"
    result_path = RESULT_FOLDER / result_name
    result_path.touch()

    # H.264 để mở được bằng mọi trình phát; không được thì dùng mp4v
    writer = None
    if IS_WINDOWS:
        writer = cv2.VideoWriter(cv_path(result_path), cv2.CAP_MSMF, cv2.VideoWriter_fourcc(*"H264"), fps, size)
    if writer is None or not writer.isOpened():
        writer = cv2.VideoWriter(cv_path(result_path), cv2.VideoWriter_fourcc(*"mp4v"), fps, size)
    if writer.isOpened():
        with stream_lock:
            stream_state["result_file"] = "/static/results/" + result_name
    else:
        writer = None

    return Response(video_stream(sid, cap, writer), mimetype="multipart/x-mixed-replace; boundary=frame")


@app.route("/api/stop", methods=["POST"])
def api_stop():
    # Tăng id -> stream đang chạy tự dừng và giải phóng camera
    new_stream(None)
    return jsonify(ok=True)


@app.route("/api/status")
def api_status():
    with stream_lock:
        return jsonify(stream_state)


# =========================
# ẢNH
# =========================
@app.route("/api/detect_image", methods=["POST"])
def api_detect_image():
    file = request.files.get("image")
    if file is None or file.filename == "":
        return jsonify(error="Chưa chọn ảnh."), 400
    ext = Path(file.filename).suffix.lower()
    if ext not in IMAGE_EXTENSIONS:
        return jsonify(error="Định dạng ảnh không được hỗ trợ."), 400

    img = cv2.imdecode(np.frombuffer(file.read(), np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return jsonify(error="Không đọc được ảnh."), 400

    detections, ms = detect_and_draw(img)

    name = "result_" + uuid.uuid4().hex + ".jpg"
    ok, jpg = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    jpg.tofile(str(RESULT_FOLDER / name))

    return jsonify(url="/static/results/" + name, detections=detections, ms=ms)


# =========================
# CÀI ĐẶT
# =========================
def settings_payload():
    model = model_info["model"]
    return {
        **settings,
        "imgsz_choices": IMG_SIZE_CHOICES,
        "model": model_info["name"],
        "models": list_models(),
        "classes": list(model.names.values()) if model else [],
        "device": DEVICE_NAME,
        "gpu": torch.cuda.get_device_name(0) if DEVICE == 0 else None,
    }


@app.route("/api/settings", methods=["GET", "POST"])
def api_settings():
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        try:
            if "conf" in data:
                settings["conf"] = min(max(float(data["conf"]), 0.01), 0.99)
            if "imgsz" in data and int(data["imgsz"]) in IMG_SIZE_CHOICES:
                settings["imgsz"] = int(data["imgsz"])
            if "zoom" in data:
                settings["zoom"] = min(max(float(data["zoom"]), 1.0), 4.0)
        except (TypeError, ValueError):
            return jsonify(error="Giá trị không hợp lệ."), 400
    return jsonify(settings_payload())


@app.route("/api/model", methods=["POST"])
def api_model():
    name = (request.get_json(silent=True) or {}).get("name", "")
    try:
        load_model(name)
    except Exception as exc:
        return jsonify(error=str(exc)), 400
    return jsonify(settings_payload())


@app.route("/")
def index():
    return render_template("index.html")


# =========================
# KHỞI CHẠY
# =========================
def find_free_port(preferred=5000):
    for port in [preferred, 0]:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((HOST, port))
                return s.getsockname()[1]
            except OSError:
                continue
    raise RuntimeError("Không tìm được cổng trống.")


models = list_models()
if not models:
    sys.exit(f"Không có file .pt nào trong thư mục {MODEL_DIR}")
load_model("best.pt" if "best.pt" in models else models[0])


if __name__ == "__main__":
    port = find_free_port()
    url = f"http://{HOST}:{port}"

    print("================================")
    print("AI NHẬN DIỆN U NÃO - YOLO11")
    print("================================")
    print(f"Mở trình duyệt tại: {url}")
    print("Nhấn Ctrl + C để thoát.")

    threading.Timer(1.5, webbrowser.open, [url]).start()
    app.run(host=HOST, port=port, threaded=True)
