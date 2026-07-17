"""
空中鼠标 - 手指控制鼠标光标
基于 MediaPipe HandLandmarker，用食指控制光标，拇指+食指捏合点击
macOS Quartz 原生实现，无需额外权限弹窗

快捷键: Q 退出 | R 重置位置到屏幕中心
"""

import cv2
import numpy as np
import sys
import os
import time
import math

import mediapipe as mp
from mediapipe.tasks.python.vision import (
    HandLandmarker, HandLandmarkerOptions, RunningMode
)
from mediapipe.tasks.python import BaseOptions

# macOS 原生鼠标控制
import Quartz
from Quartz import (
    CGEventCreateMouseEvent, CGEventPost, kCGHIDEventTap,
    kCGEventMouseMoved, kCGEventLeftMouseDown, kCGEventLeftMouseUp,
    kCGEventRightMouseDown, kCGEventRightMouseUp,
    kCGMouseButtonLeft, kCGMouseButtonRight,
    CGMainDisplayID, CGDisplayBounds
)

# ============================================================
#  常量
# ============================================================

TIP_IDS = [4, 8, 12, 16, 20]
FINGER_NAMES = {4: '拇指', 8: '食指', 12: '中指', 16: '无名指', 20: '小指'}
FINGER_COLORS = {
    4: (255, 0, 0), 8: (0, 255, 0), 12: (0, 0, 255),
    16: (255, 255, 0), 20: (255, 0, 255),
}

HAND_CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 4),
    (0, 5), (5, 6), (6, 7), (7, 8),
    (0, 9), (9, 10), (10, 11), (11, 12),
    (0, 13), (13, 14), (14, 15), (15, 16),
    (0, 17), (17, 18), (18, 19), (19, 20),
    (5, 9), (9, 13), (13, 17),
]

# 屏幕尺寸
display_bounds = CGDisplayBounds(CGMainDisplayID())
SCREEN_W = int(display_bounds.size.width)
SCREEN_H = int(display_bounds.size.height)

# ============================================================
#  macOS 鼠标控制
# ============================================================

def mouse_move(x, y):
    """移动鼠标到绝对位置"""
    x = max(0, min(SCREEN_W - 1, int(x)))
    y = max(0, min(SCREEN_H - 1, int(y)))
    event = CGEventCreateMouseEvent(None, kCGEventMouseMoved, (x, y), kCGMouseButtonLeft)
    CGEventPost(kCGHIDEventTap, event)

def mouse_click(x, y, button=kCGMouseButtonLeft):
    """单击"""
    x, y = int(x), int(y)
    down = CGEventCreateMouseEvent(None, kCGEventLeftMouseDown, (x, y), button)
    up = CGEventCreateMouseEvent(None, kCGEventLeftMouseUp, (x, y), button)
    CGEventPost(kCGHIDEventTap, down)
    CGEventPost(kCGHIDEventTap, up)

def mouse_drag_start(x, y):
    """开始拖拽（左键按下）"""
    x, y = int(x), int(y)
    event = CGEventCreateMouseEvent(None, kCGEventLeftMouseDown, (x, y), kCGMouseButtonLeft)
    CGEventPost(kCGHIDEventTap, event)

def mouse_drag_end(x, y):
    """结束拖拽（左键松开）"""
    x, y = int(x), int(y)
    event = CGEventCreateMouseEvent(None, kCGEventLeftMouseUp, (x, y), kCGMouseButtonLeft)
    CGEventPost(kCGHIDEventTap, event)

def mouse_right_click(x, y):
    """右键单击"""
    x, y = int(x), int(y)
    down = CGEventCreateMouseEvent(None, kCGEventRightMouseDown, (x, y), kCGMouseButtonRight)
    up = CGEventCreateMouseEvent(None, kCGEventRightMouseUp, (x, y), kCGMouseButtonRight)
    CGEventPost(kCGHIDEventTap, down)
    CGEventPost(kCGHIDEventTap, up)


# ============================================================
#  手指判断
# ============================================================

def is_thumb_up(landmarks):
    return abs(landmarks[4].x - landmarks[2].x) > abs(landmarks[3].x - landmarks[2].x) * 0.9

def is_finger_up(landmarks, tip_id, pip_id):
    return landmarks[tip_id].y < landmarks[pip_id].y

def get_fingers(landmarks):
    return [
        is_thumb_up(landmarks),
        is_finger_up(landmarks, 8, 6),
        is_finger_up(landmarks, 12, 10),
        is_finger_up(landmarks, 16, 14),
        is_finger_up(landmarks, 20, 18),
    ]

def thumb_index_distance(landmarks):
    """拇指指尖与食指指尖的距离（归一化 0-1）"""
    dx = landmarks[4].x - landmarks[8].x
    dy = landmarks[4].y - landmarks[8].y
    return math.sqrt(dx * dx + dy * dy)

def recognize_gesture(fingers):
    t, i, m, r, p = fingers
    if all(fingers):
        return ("✋ 张开", "open_palm")
    if not any(fingers):
        return ("✊ 握拳", "fist")
    if t and not i and not m and not r and p:
        return ("🤙 打电话", "call_me")
    if t and not any([i, m, r, p]):
        return ("👍 竖大拇指", "thumbs_up")
    if i and not any([t, m, r, p]):
        return ("☝️ 食指", "point")
    if i and m and not any([t, r, p]):
        return ("✌️ 胜利", "peace")
    if i and m and r and not any([t, p]):
        return ("🖖 三指", "three")
    if t and i and not any([m, r, p]):
        return ("👌 OK", "ok")
    if t and i and m and not any([r, p]):
        return ("🫶 比心", "heart")
    return (None, None)


# ============================================================
#  绘图
# ============================================================

def draw_hand(img, landmarks):
    h, w, _ = img.shape
    pts = [(int(lm.x * w), int(lm.y * h)) for lm in landmarks]
    for i, j in HAND_CONNECTIONS:
        cv2.line(img, pts[i], pts[j], (100, 180, 255), 2)
    for i, (x, y) in enumerate(pts):
        if i in TIP_IDS:
            cv2.circle(img, (x, y), 7, FINGER_COLORS[i], -1)
        else:
            cv2.circle(img, (x, y), 4, (255, 100, 0), -1)
    return pts


# ============================================================
#  主循环
# ============================================================

def main():
    # 模型
    model_path = 'hand_landmarker.task'
    if not os.path.exists(model_path):
        print("📥 下载模型...")
        import urllib.request
        urllib.request.urlretrieve(
            "https://storage.googleapis.com/mediapipe-models/"
            "hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
            model_path)
        print("✅ 下载完成")

    print(f"🖥️  屏幕分辨率: {SCREEN_W}x{SCREEN_H}")
    print("🚀 启动空中鼠标...")
    
    options = HandLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model_path),
        running_mode=RunningMode.IMAGE,
        num_hands=1,
        min_hand_detection_confidence=0.7,
        min_tracking_confidence=0.5)
    detector = HandLandmarker.create_from_options(options)
    print("✅ 模型加载成功")

    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("❌ 摄像头无法打开")
        detector.close()
        return
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    print("✅ 摄像头已打开")

    # ---- 鼠标控制状态 ----
    # 平滑滤波
    smooth_x, smooth_y = SCREEN_W / 2, SCREEN_H / 2
    smoothing = 0.35       # 0~1，越大越跟手，越小越平滑
    
    # 点击检测
    PINCH_THRESHOLD = 0.06   # 捏合阈值（归一化距离）
    PINCH_RELEASE = 0.10     # 松开放大阈值，防止抖动
    is_dragging = False
    was_pinched = False
    pinch_start_time = 0
    
    # 手势防抖
    prev_gesture_id = None
    gesture_hold = 0
    
    # 控制开关
    enabled = True
    
    # 预览窗口显示提示
    print("\n🎮 空中鼠标操作指南:")
    print("   食指位置 → 鼠标光标")
    print("   拇指+食指捏合 → 左键单击")
    print("   捏合保持 + 移动 → 拖拽")
    print("   中指单独伸直 → 右键单击")
    print("   握拳 → 暂停/恢复控制")
    print("   Q 退出 | R 重置光标到中心\n")

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                break

            frame = cv2.flip(frame, 1)
            h, w, _ = frame.shape

            try:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                result = detector.detect(mp_image)

                cursor_x, cursor_y = smooth_x, smooth_y
                gesture_text = "无"
                status_text = "🟢 运行中" if enabled else "⏸️ 暂停"
                pinch_dist = 0

                if result.hand_landmarks:
                    landmarks = result.hand_landmarks[0]
                    pts = draw_hand(frame, landmarks)
                    fingers = get_fingers(landmarks)
                    
                    # 食指指尖坐标 → 屏幕坐标
                    index_tip = landmarks[8]
                    raw_x = index_tip.x * SCREEN_W
                    raw_y = index_tip.y * SCREEN_H
                    
                    # 拇指-食指距离
                    pinch_dist = thumb_index_distance(landmarks)
                    
                    # ---- 暂停/恢复（握拳切换） ----
                    gname, gid = recognize_gesture(fingers)
                    if gid == "fist":
                        if prev_gesture_id != "fist":
                            enabled = not enabled
                            if not enabled:
                                print("⏸️  鼠标控制暂停")
                            else:
                                print("▶️  鼠标控制恢复")
                        prev_gesture_id = "fist"
                    else:
                        prev_gesture_id = None
                    
                    # ---- 鼠标控制 ----
                    if enabled:
                        # 平滑跟踪
                        smooth_x = smooth_x * (1 - smoothing) + raw_x * smoothing
                        smooth_y = smooth_y * (1 - smoothing) + raw_y * smoothing
                        cursor_x, cursor_y = smooth_x, smooth_y
                        mouse_move(cursor_x, cursor_y)

                        # 捏合检测（拇指+食指）
                        if pinch_dist < PINCH_THRESHOLD:
                            if not was_pinched:
                                # 刚捏合
                                was_pinched = True
                                pinch_start_time = time.time()
                                # 短捏合先不点，等松开判断是单击还是拖拽
                        else:
                            if was_pinched and pinch_dist > PINCH_RELEASE:
                                # 松开了
                                hold_time = time.time() - pinch_start_time
                                if hold_time < 0.3:
                                    # 短捏合 → 单击
                                    mouse_click(cursor_x, cursor_y)
                                    print(f"🖱️ 左键单击 ({int(cursor_x)}, {int(cursor_y)})")
                                was_pinched = False

                        # 拖拽：捏合保持超过 0.3 秒进入拖拽模式
                        if was_pinched and (time.time() - pinch_start_time) > 0.3:
                            if not is_dragging:
                                is_dragging = True
                                mouse_drag_start(cursor_x, cursor_y)
                                print(f"🖱️ 开始拖拽")
                            else:
                                # 拖拽中持续移动
                                mouse_move(cursor_x, cursor_y)
                        
                        # 如果松开了拖拽
                        if not was_pinched and is_dragging:
                            is_dragging = False
                            mouse_drag_end(cursor_x, cursor_y)
                            print(f"🖱️ 结束拖拽")

                        # 右键：单独中指
                        if fingers[2] and not fingers[0] and not fingers[1] and not fingers[3] and not fingers[4]:
                            mouse_right_click(cursor_x, cursor_y)
                            print(f"🖱️ 右键单击 ({int(cursor_x)}, {int(cursor_y)})")

                        gesture_text = gname or "跟踪中"
                    else:
                        gesture_text = "⏸️ 暂停"
                        # 暂停时重置平滑位置
                        smooth_x, smooth_y = SCREEN_W / 2, SCREEN_H / 2

                # ---- 界面绘制 ----
                # 光标指示器
                if enabled:
                    disp_x = int(cursor_x * w / SCREEN_W)
                    disp_y = int(cursor_y * h / SCREEN_H)
                    cv2.circle(frame, (disp_x, disp_y), 12, (0, 255, 255), 3)
                    cv2.circle(frame, (disp_x, disp_y), 4, (0, 255, 255), -1)
                    # 十字准星
                    cv2.line(frame, (disp_x - 20, disp_y), (disp_x + 20, disp_y), (0, 255, 255), 1)
                    cv2.line(frame, (disp_x, disp_y - 20), (disp_x, disp_y + 20), (0, 255, 255), 1)
                    
                    # 捏合进度条
                    bar_x, bar_y = 20, h - 60
                    bar_w, bar_h = 150, 12
                    ratio = min(1.0, pinch_dist / PINCH_THRESHOLD) if pinch_dist < PINCH_THRESHOLD else 1.0
                    color = (0, 255, 0) if pinch_dist < PINCH_THRESHOLD else (200, 200, 200)
                    cv2.rectangle(frame, (bar_x, bar_y), (bar_x + bar_w, bar_y + bar_h), (80, 80, 80), -1)
                    cv2.rectangle(frame, (bar_x, bar_y), (bar_x + int(bar_w * (1 - ratio)), bar_y + bar_h), color, -1)
                    label = "捏合" if pinch_dist < PINCH_THRESHOLD else "距离"
                    cv2.putText(frame, label, (bar_x, bar_y - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 1)
                    
                    if is_dragging:
                        cv2.putText(frame, "🔄 拖拽中", (20, h - 90),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 200, 255), 2)

                # 状态信息
                cv2.putText(frame, status_text, (10, 30),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255) if enabled else (150, 150, 150), 2)
                cv2.putText(frame, f"手势: {gesture_text}", (10, 55),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)
                cv2.putText(frame, f"光标: ({int(cursor_x)}, {int(cursor_y)})", (10, 75),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, (150, 150, 150), 1)
                cv2.putText(frame, "Q:退出 R:重置", (w - 170, 30),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)

            except Exception as e:
                pass  # 单帧错误忽略

            cv2.imshow("Air Mouse - 空中鼠标", frame)
            key = cv2.waitKey(1) & 0xFF
            if key == ord('q'):
                print("👋 退出")
                break
            elif key == ord('r'):
                smooth_x, smooth_y = SCREEN_W / 2, SCREEN_H / 2
                mouse_move(smooth_x, smooth_y)
                print(f"📍 光标重置到中心 ({int(smooth_x)}, {int(smooth_y)})")

    except KeyboardInterrupt:
        print("👋 用户中断")
    except Exception as e:
        print(f"❌ 异常: {e}")
    finally:
        cap.release()
        cv2.destroyAllWindows()
        detector.close()
        # 松鼠标
        if is_dragging:
            mouse_drag_end(smooth_x, smooth_y)
        print("✅ 已退出")


if __name__ == "__main__":
    main()
