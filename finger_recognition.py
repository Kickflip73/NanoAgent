"""
手指识别程序 (适配 MediaPipe 0.10.x)
基于 MediaPipe HandLandmarker 检测手部关键点，识别手指状态 + 手势动作。
使用自定义绘图（不用 drawing_utils，避免兼容性崩溃）。

快捷键: Q 退出 | S 截图

使用方式:
    python3 finger_recognition.py          # 摄像头模式
    python3 finger_recognition.py --demo   # 演示模式
"""

import cv2
import numpy as np
import sys
import os
import time
import random
import math
import traceback

# ---------- MediaPipe ----------
import mediapipe as mp
from mediapipe.tasks.python.vision import (
    HandLandmarker, HandLandmarkerOptions, RunningMode
)
from mediapipe.tasks.python import BaseOptions

# ============================================================
#  常量
# ============================================================

# 指尖关键点索引
TIP_IDS = [4, 8, 12, 16, 20]
PIP_IDS = [2, 6, 10, 14, 18]
FINGER_NAMES = {4: '拇指', 8: '食指', 12: '中指', 16: '无名指', 20: '小指'}
FINGER_COLORS = {
    4: (255, 0, 0),    # 蓝
    8: (0, 255, 0),    # 绿
    12: (0, 0, 255),   # 红
    16: (255, 255, 0), # 青
    20: (255, 0, 255), # 紫
}

# 手部连接线
HAND_CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 4),
    (0, 5), (5, 6), (6, 7), (7, 8),
    (0, 9), (9, 10), (10, 11), (11, 12),
    (0, 13), (13, 14), (14, 15), (15, 16),
    (0, 17), (17, 18), (18, 19), (19, 20),
    (5, 9), (9, 13), (13, 17),
]

# 最后一帧（用于截图）
_last_frame = None


# ============================================================
#  1. 手指判断
# ============================================================

def is_thumb_up(landmarks):
    """判断拇指是否竖起（用 x 方向）"""
    return abs(landmarks[4].x - landmarks[2].x) > abs(landmarks[3].x - landmarks[2].x) * 0.9

def is_finger_up(landmarks, tip_id, pip_id):
    """判断其他手指是否伸直（y 方向）"""
    return landmarks[tip_id].y < landmarks[pip_id].y

def get_fingers(landmarks):
    """获取所有手指状态，返回 [拇指, 食指, 中指, 无名指, 小指]"""
    return [
        is_thumb_up(landmarks),
        is_finger_up(landmarks, 8, 6),
        is_finger_up(landmarks, 12, 10),
        is_finger_up(landmarks, 16, 14),
        is_finger_up(landmarks, 20, 18),
    ]

def count_fingers(fingers):
    return sum(fingers)

def recognize_gesture(fingers):
    """识别手势，返回 (中文名, id) 或 (None, None)"""
    t, i, m, r, p = fingers
    if all(fingers):
        return ("✋ 手掌张开", "open_palm")
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
#  2. 绘图（自定义，不用 drawing_utils）
# ============================================================

def draw_hand(img, landmarks):
    """绘制手部骨架和关键点"""
    h, w, _ = img.shape
    pts = [(int(lm.x * w), int(lm.y * h)) for lm in landmarks]

    # 连接线
    for i, j in HAND_CONNECTIONS:
        cv2.line(img, pts[i], pts[j], (100, 180, 255), 2)

    # 关键点
    for i, (x, y) in enumerate(pts):
        if i in TIP_IDS:
            cv2.circle(img, (x, y), 7, FINGER_COLORS[i], -1)
        else:
            cv2.circle(img, (x, y), 4, (255, 100, 0), -1)

    return pts


# ============================================================
#  3. 动作执行（安全版）
# ============================================================

_last_action_time = {}
ACTION_COOLDOWN = 2.0

def safe_action(name, fn):
    """带冷却和安全执行的包装器"""
    global _last_action_time
    now = time.time()
    if name in _last_action_time and now - _last_action_time[name] < ACTION_COOLDOWN:
        return None
    _last_action_time[name] = now
    try:
        return fn()
    except Exception as e:
        print(f"⚠️ 动作 [{name}] 失败: {e}")
        traceback.print_exc()
        return None


def do_thumbs_up():
    print("👍 竖大拇指！")
    # macOS 通知
    if sys.platform == 'darwin':
        import subprocess
        subprocess.run(['osascript', '-e',
            'display notification "👍 给你点赞！" with title "手势识别"'],
            capture_output=True, timeout=3)

def do_peace():
    global _last_frame
    if _last_frame is not None:
        name = f"peace_{int(time.time())}.jpg"
        cv2.imwrite(name, _last_frame)
        print(f"✌️ 截图已保存: {name}")

def do_fist():
    print("✊ 握拳！")

def do_open_palm():
    print("✋ 手掌张开！")

def do_call_me():
    print("🤙 打电话！")
    if sys.platform == 'darwin':
        import subprocess
        subprocess.Popen(['open', '-a', 'Calculator'])

def do_point():
    print("☝️ 食指！")

def do_three():
    print("🖖 三指！")
    if sys.platform == 'darwin':
        import subprocess
        subprocess.Popen(['open', '-a', 'Safari'])

def do_ok():
    print("👌 OK！")

def do_heart():
    print("🫶 比心！")


GESTURE_ACTIONS = {
    "thumbs_up":  ("👍 竖大拇指", do_thumbs_up),
    "peace":      ("✌️ 胜利 → 截图", do_peace),
    "fist":       ("✊ 握拳", do_fist),
    "open_palm":  ("✋ 手掌张开", do_open_palm),
    "call_me":    ("🤙 打电话 → 计算器", do_call_me),
    "point":      ("☝️ 食指", do_point),
    "three":      ("🖖 三指 → 浏览器", do_three),
    "ok":         ("👌 OK", do_ok),
    "heart":      ("🫶 比心", do_heart),
}


# ============================================================
#  4. 主循环
# ============================================================

def demo_mode():
    """演示模式"""
    print("📺 演示模式")
    print("可用手势:")
    for gid, (name, _) in GESTURE_ACTIONS.items():
        print(f"  {name}")
    
    img = np.ones((480, 640, 3), dtype=np.uint8) * 40
    msgs = ["✨ 手指识别 + 动作系统 ✨", "",
            "👍 ✌️ ✊ ✋ 🤙 ☝️ 🖖 👌 🫶"]
    for i, msg in enumerate(msgs):
        cv2.putText(img, msg, (50, 80 + i * 60),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)
    cv2.putText(img, "(连接摄像头开始实时识别)", (50, 300),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 200), 1)
    cv2.imshow("Finger Recognition", img)
    cv2.waitKey(2000)
    cv2.destroyAllWindows()


def main():
    global _last_frame

    if '--demo' in sys.argv:
        demo_mode()
        return

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

    print("🚀 启动中...")
    options = HandLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model_path),
        running_mode=RunningMode.IMAGE,
        num_hands=2,
        min_hand_detection_confidence=0.7,
        min_tracking_confidence=0.5)
    detector = HandLandmarker.create_from_options(options)
    print("✅ 模型加载成功")

    # 摄像头（小分辨率，更稳定）
    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("❌ 摄像头无法打开")
        detector.close()
        return
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    print("✅ 摄像头已打开")
    
    print("\n🎮 手势动作列表:")
    for gid, (name, _) in GESTURE_ACTIONS.items():
        print(f"   {name}")
    print("   Q 退出 | S 截图\n")

    prev_gesture_id = None
    gesture_hold = 0
    frame_count = 0

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                print("⚠️ 读取摄像头失败")
                break

            frame_count += 1
            frame = cv2.flip(frame, 1)
            _last_frame = frame.copy()
            h, w, _ = frame.shape

            try:
                # 检测
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                result = detector.detect(mp_image)

                current_gesture = None
                current_gesture_id = None

                if result.hand_landmarks:
                    for idx, landmarks in enumerate(result.hand_landmarks):
                        # 绘制手部
                        pts = draw_hand(frame, landmarks)

                        # 手指判断
                        fingers = get_fingers(landmarks)
                        cnt = count_fingers(fingers)
                        
                        # 手部信息
                        cx, cy = pts[0]
                        cv2.putText(frame, f"手{idx+1}: {cnt}根", (10, 30 + idx*30),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)

                        # 指尖标注
                        for tip_id in TIP_IDS:
                            if fingers[[4, 8, 12, 16, 20].index(tip_id)]:
                                tx, ty = pts[tip_id]
                                name = FINGER_NAMES.get(tip_id, '')
                                cv2.putText(frame, f"⬆{name}", (tx+10, ty-10),
                                            cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                                            FINGER_COLORS[tip_id], 2)

                        # 中心大数字
                        cx_c = int(sum(lm.x for lm in landmarks) / 21 * w)
                        cy_c = int(sum(lm.y for lm in landmarks) / 21 * h) - 60
                        cv2.putText(frame, str(cnt), (cx_c-15, cy_c),
                                    cv2.FONT_HERSHEY_SIMPLEX, 2.0, (0, 255, 255), 4)

                        # 手势识别
                        gname, gid = recognize_gesture(fingers)
                        if gid:
                            current_gesture = gname
                            current_gesture_id = gid

                # ----- 防抖触发动作 -----
                if current_gesture_id:
                    if current_gesture_id == prev_gesture_id:
                        gesture_hold += 1
                    else:
                        gesture_hold = 1
                        prev_gesture_id = current_gesture_id
                else:
                    gesture_hold = 0
                    prev_gesture_id = None

                # 连续 5 帧触发
                if gesture_hold >= 5 and current_gesture_id in GESTURE_ACTIONS:
                    _, action_fn = GESTURE_ACTIONS[current_gesture_id]
                    safe_action(current_gesture_id, action_fn)
                    gesture_hold = 0  # 触发后重置，等待手势变化

                # 底部显示当前手势
                if current_gesture:
                    cv2.putText(frame, f"🎯 {current_gesture}",
                                (w//2 - 120, h - 30),
                                cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 0), 3)
                else:
                    cv2.putText(frame, "手势: 无",
                                (w//2 - 100, h - 30),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.8, (150, 150, 150), 2)

            except Exception as e:
                print(f"⚠️ 帧 {frame_count} 处理异常: {e}")
                traceback.print_exc()

            # 提示
            cv2.putText(frame, "Q:退出 S:截图", (w-180, 30),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)

            cv2.imshow("Finger Recognition", frame)

            key = cv2.waitKey(1) & 0xFF
            if key == ord('q'):
                print("👋 退出")
                break
            elif key == ord('s'):
                cv2.imwrite(f"screenshot_{frame_count}.jpg", frame)
                print(f"📸 截图保存: screenshot_{frame_count}.jpg")

    except KeyboardInterrupt:
        print("👋 用户中断")
    except Exception as e:
        print(f"❌ 主循环崩溃: {e}")
        traceback.print_exc()
    finally:
        cap.release()
        cv2.destroyAllWindows()
        detector.close()
        print("✅ 已退出")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        with open('crash_log.txt', 'w') as f:
            f.write(f"Error: {e}\n\n")
            traceback.print_exc(file=f)
        print(f"❌ 程序崩溃，详情见 crash_log.txt")
        traceback.print_exc()
        cv2.destroyAllWindows()
