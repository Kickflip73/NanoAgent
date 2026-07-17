#!/usr/bin/env python3
"""指数退避 + 随机抖动 演示程序（终端动画版）"""
import random, time, sys

BASE = 1.0
MAX = 32.0
RETRIES = 6
SUCCESS_AT = 3

def pause(sec):
    time.sleep(sec)
    sys.stdout.flush()

def cprint(text, delay=0.6):
    print(text)
    pause(delay)

def flaky_service(attempt):
    if attempt < SUCCESS_AT:
        return False
    return random.random() < 0.5

def full_jitter(sleep_time, _):
    return random.uniform(0, sleep_time)

def equal_jitter(sleep_time, _):
    half = sleep_time / 2
    return half + random.uniform(0, half)

def no_jitter(sleep_time, _):
    return sleep_time

def run_demo(label, jitter_fn):
    cprint(f"\n{'=' * 54}", 0.3)
    cprint(f"  {label}", 0.3)
    cprint(f"{'=' * 54}", 0.3)
    cprint(f"  {'#':<4} {'Status':<8} {'Wait(s)':<10} {'Total(s)'}", 0.2)
    cprint(f"  {'-' * 34}", 0.2)

    total = 0.0
    for i in range(1, RETRIES + 1):
        sleep_time = min(BASE * (2 ** (i - 1)), MAX)
        actual_wait = jitter_fn(sleep_time, i)
        success = flaky_service(i)
        status = "OK" if success else "FAILED"

        if success:
            cprint(f"  {i:<4} {status:<8} {'—':<10} {total:<.2f}")
            cprint(f"  {'→ 成功！':>45}", 0.8)
            return
        else:
            total += actual_wait
            cprint(f"  {i:<4} {status:<8} {actual_wait:<10.4f} {total:<.2f}")
            if i < RETRIES:
                cprint(f"    等待 {actual_wait:.2f}s ...", 0.3)
                time.sleep(min(actual_wait, 2))

    cprint(f"  ✗ 已达最大重试 {RETRIES} 次", 0.5)

if __name__ == "__main__":
    cprint("", 0.1)
    cprint("  指数退避 + 随机抖动 演示", 0.4)
    cprint(f"  基准={BASE}s  上限={MAX}s  最大重试={RETRIES}次", 0.3)
    cprint(f"  前 {SUCCESS_AT} 次必失败，之后 50% 概率成功", 0.3)
    pause(0.5)

    run_demo("1. 无抖动 (No Jitter)", no_jitter)
    run_demo("2. Full Jitter — [0, sleep)", full_jitter)
    run_demo("3. Equal Jitter — sleep/2 + [0, sleep/2)", equal_jitter)

    cprint(f"\n{'=' * 54}", 0.3)
    cprint("演示结束 · 代码: examples/exponential_backoff.py", 0.5)
