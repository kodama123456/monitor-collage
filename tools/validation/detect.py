"""技術検証: テスト写真で MediaPipe の各検出がどこまで効くかを調べる。

使い方: .venv/bin/python detect.py ../../testdata
出力: out/detect.json と out/annot_*.jpg（検出結果を描いた確認画像）
"""
import json
import sys
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mpt
from mediapipe.tasks.python import vision

HERE = Path(__file__).parent
M = HERE / "models"
OUT = HERE / "out"
OUT.mkdir(exist_ok=True)

face_det = vision.FaceDetector.create_from_options(vision.FaceDetectorOptions(
    base_options=mpt.BaseOptions(model_asset_path=str(M / "blaze_face_short_range.tflite")),
    min_detection_confidence=0.3))
face_lm = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
    base_options=mpt.BaseOptions(model_asset_path=str(M / "face_landmarker.task")),
    num_faces=1, min_face_detection_confidence=0.3, min_face_presence_confidence=0.3))
pose = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
    base_options=mpt.BaseOptions(model_asset_path=str(M / "pose_landmarker_full.task")),
    min_pose_detection_confidence=0.3, min_pose_presence_confidence=0.3))
seg = vision.ImageSegmenter.create_from_options(vision.ImageSegmenterOptions(
    base_options=mpt.BaseOptions(model_asset_path=str(M / "selfie_segmenter.tflite")),
    output_confidence_masks=True))

# FaceLandmarker の目の輪郭（画像上の左目・右目）
EYE_A = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
EYE_B = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]
CHIN = 152
FOREHEAD = 10


def analyze(path: Path) -> dict:
    bgr = cv2.imread(str(path))
    h, w = bgr.shape[:2]
    img = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    r = {"file": str(path), "w": w, "h": h}

    fd = face_det.detect(img).detections
    r["face_detector"] = None
    if fd:
        b = fd[0].bounding_box
        r["face_detector"] = {"score": round(fd[0].categories[0].score, 3),
                              "box": [b.origin_x, b.origin_y, b.width, b.height]}

    fl = face_lm.detect(img).face_landmarks
    r["face_landmarker"] = None
    if fl:
        pts = np.array([[p.x * w, p.y * h] for p in fl[0]])
        r["face_landmarker"] = {
            "eyeA": pts[EYE_A].tolist(), "eyeB": pts[EYE_B].tolist(),
            "chin": pts[CHIN].tolist(), "forehead": pts[FOREHEAD].tolist(),
            "box": [pts[:, 0].min(), pts[:, 1].min(), pts[:, 0].max(), pts[:, 1].max()],
        }

    po = pose.detect(img).pose_landmarks
    r["pose"] = None
    if po:
        names = {0: "nose", 2: "eyeL", 5: "eyeR", 7: "earL", 8: "earR", 9: "mouthL", 10: "mouthR",
                 11: "shoulderL", 12: "shoulderR"}
        r["pose"] = {n: [po[0][i].x * w, po[0][i].y * h, round(po[0][i].visibility, 3)]
                     for i, n in names.items()}

    sm = np.squeeze(seg.segment(img).confidence_masks[0].numpy_view())
    mask = (sm > 0.5).astype(np.uint8)
    ys, xs = np.nonzero(mask)
    r["person_mask"] = None
    if len(ys):
        r["person_mask"] = {"top": int(ys.min()), "area_ratio": round(float(mask.mean()), 3)}
    np.save(OUT / (path.parent.name + "_" + path.stem + "_mask.npy"), mask)

    # 確認画像
    a = bgr.copy()
    a[mask == 0] = (a[mask == 0] * 0.4).astype(np.uint8)
    if r["face_detector"]:
        x, y, bw, bh = r["face_detector"]["box"]
        cv2.rectangle(a, (x, y), (x + bw, y + bh), (0, 255, 0), 4)
    if r["face_landmarker"]:
        for k in ("eyeA", "eyeB"):
            cv2.polylines(a, [np.array(r["face_landmarker"][k], np.int32)], True, (255, 0, 255), 4)
        cv2.circle(a, tuple(int(v) for v in r["face_landmarker"]["chin"]), 12, (0, 255, 255), -1)
    if r["pose"]:
        for n, (x, y, v) in r["pose"].items():
            if n.startswith(("eye", "ear", "nose", "mouth")):
                cv2.circle(a, (int(x), int(y)), 10, (0, 128, 255) if v > 0.5 else (0, 0, 255), -1)
    if r["person_mask"]:
        cv2.line(a, (0, r["person_mask"]["top"]), (w, r["person_mask"]["top"]), (255, 200, 0), 3)
    cv2.imwrite(str(OUT / f"annot_{path.parent.name}_{path.stem}.jpg"), cv2.resize(a, (w // 3, h // 3)))
    return r


def main():
    root = Path(sys.argv[1])
    res = [analyze(p) for p in sorted(root.glob("set*/*.jpg"))]
    (OUT / "detect.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
    for r in res:
        print(f"{Path(r['file']).parent.name}/{Path(r['file']).stem:14s}",
              "FD:", r["face_detector"]["score"] if r["face_detector"] else "×",
              "| FLM:", "○" if r["face_landmarker"] else "×",
              "| POSE eyes vis:", [r["pose"][k][2] for k in ("eyeL", "eyeR")] if r["pose"] else "×",
              "| mask top:", r["person_mask"]["top"] if r["person_mask"] else "×")


if __name__ == "__main__":
    main()
