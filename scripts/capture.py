#!/usr/bin/env python3
# dsh-visibridge capture.py — USB camera single-frame capture for the
# capture_image tool. Pure Python + OpenCV; no dsh dependencies.
#
# Usage:
#   python capture.py --out <path.jpg> [--camera 0] [--width 1280] [--height 720]
#                     [--flip none|h|v|b]
#
# Exit codes: 0 ok, 2 camera not opened, 3 frame grab failed, 4 write failed.
import argparse
import os
import sys
import time

import cv2


def main() -> int:
    parser = argparse.ArgumentParser(description="USB camera single-frame capture")
    parser.add_argument("--out", required=True, help="output jpg path")
    parser.add_argument("--camera", type=int, default=0, help="camera device index")
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument(
        "--flip", choices=["none", "h", "v", "b"], default="none",
        help="software flip: h=horizontal, v=vertical, b=both",
    )
    args = parser.parse_args()

    # Windows prefers DSHOW backend for USB cameras.
    backend = cv2.CAP_DSHOW if os.name == "nt" else cv2.CAP_ANY
    cap = cv2.VideoCapture(args.camera, backend)
    if not cap.isOpened():
        print(f"无法打开摄像头 {args.camera}", file=sys.stderr)
        return 2

    cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
    # UVC controls — best effort: some cameras ignore these (then touch
    # buttons are the hardware fallback). Failures here are non-fatal.
    try:
        cap.set(cv2.CAP_PROP_AUTOFOCUS, 1)  # auto focus
        cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 1)  # auto exposure
    except Exception:
        pass

    # Warm up: drop a few frames so exposure/focus settle.
    for _ in range(5):
        cap.read()
    time.sleep(0.5)

    ok, frame = cap.read()
    cap.release()
    if not ok or frame is None:
        print("抓帧失败", file=sys.stderr)
        return 3

    if args.flip == "h":
        frame = cv2.flip(frame, 1)
    elif args.flip == "v":
        frame = cv2.flip(frame, 0)
    elif args.flip == "b":
        frame = cv2.flip(frame, -1)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    if not cv2.imwrite(args.out, frame, [cv2.IMWRITE_JPEG_QUALITY, 90]):
        print(f"写入失败: {args.out}", file=sys.stderr)
        return 4

    print(f"OK {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
