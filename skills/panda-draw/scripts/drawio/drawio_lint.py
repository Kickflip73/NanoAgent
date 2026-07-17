#!/usr/bin/env python3
"""drawio_lint.py — .drawio 布局确定性检查(stdlib only)

检查项:
  E1 overflow      顶点文字按字宽估算超出盒子(不换行超宽 / 换行后超高 / 单元词超宽)
  E2 overlap       同一 parent 下两个不透明顶点部分重叠(完全包含视为视觉分组,不报)
  E3 out-of-parent 容器子元素越出容器内区(扣除 swimlane 标题条)
  E4 structure     重复 id / 边引用不存在的 source/target / 边缺 mxGeometry / XML 注释
  W1 negative-pos  顶点绝对坐标为负(可能跑出画布)
  W2 ext-label     draw.io 外置标签估算 bbox 与同级节点/标签碰撞
  W3 gate-label    小 gate 圆形承载过长中文标签
  W4 note-fold     note 折角过大或未给文字预留右侧空间
  W5 straight-edge 水平/垂直无遮挡边却使用正交折线/waypoint
  W6 return-loop   返工/回流线自动倒插目标右侧

用法:
  python3 drawio_lint.py <file.drawio>
退出码: 0=干净(或仅 WARN), 1=有 ERROR, 2=文件/解析错误

支持: 明文 mxfile / 压缩 mxfile(deflate+base64) / 裸 mxGraphModel。
字宽估算按 Helvetica/系统字体近似: CJK=1.0×fontSize, 大写=0.68, 小写≈0.54,
窄字符≈0.30, 粗体 ×1.06;盒内可用宽 = width - 8(左右各 4px label inset)。
估算有 ±5% 容差,报出来的基本是真出框;贴边但没报的需靠 PNG 视觉自检兜底。
"""

import argparse
import base64
import html
import re
import sys
import urllib.parse
import xml.etree.ElementTree as ET
import zlib

CJK_START = 0x2E80
NARROW = set("ilfjrt.,:;|!'`\"()[]{} -/\\")

# 形状内文字可用区域系数 (width_factor, height_factor)
SHAPE_FACTOR = {
    "rhombus": (0.52, 0.52),
    "ellipse": (0.72, 0.72),
    "doubleEllipse": (0.65, 0.65),
    "cloud": (0.55, 0.50),
    "triangle": (0.50, 0.60),
    "hexagon": (0.78, 0.85),
    "cylinder": (0.85, 0.70),
    "cylinder2": (0.85, 0.70),
    "cylinder3": (0.85, 0.70),
    "step": (0.78, 0.90),
    "parallelogram": (0.70, 0.90),
    "trapezoid": (0.70, 0.90),
    "document": (0.88, 0.78),
    "card": (0.85, 0.90),
}


def char_w(ch, fs):
    o = ord(ch)
    if o >= CJK_START:
        return fs * 1.0
    if ch in NARROW:
        return fs * 0.30
    if ch.isupper():
        return fs * 0.68
    if ch.isdigit():
        return fs * 0.56
    return fs * 0.54


def text_w(s, fs, bold=False):
    w = sum(char_w(c, fs) for c in s)
    return w * (1.06 if bold else 1.0)


def label_lines(value):
    """HTML label → 纯文本行列表。<br>/<div>/<p> 视为换行,其余标签剥掉。"""
    s = value
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"</(div|p|li|h[1-6])>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    lines = [ln.strip() for ln in s.split("\n")]
    return [ln for ln in lines if ln]


def wrap_units(line):
    """切成不可再分换行单元: CJK 逐字可断, latin 连续串整体一个单元。"""
    units, cur = [], ""
    for ch in line:
        if ord(ch) >= CJK_START:
            if cur:
                units.append(cur)
                cur = ""
            units.append(ch)
        elif ch == " ":
            if cur:
                units.append(cur + " ")
                cur = ""
        else:
            cur += ch
    if cur:
        units.append(cur)
    return units


def wrapped_line_count(lines, fs, bold, avail_w):
    """whiteSpace=wrap 时模拟贪心换行,返回行数;单元本身超宽返回 None。"""
    total = 0
    for line in lines:
        cur = 0.0
        total += 1
        for u in wrap_units(line):
            uw = text_w(u, fs, bold)
            if uw > avail_w * 1.05:
                return None
            if cur > 0 and cur + uw > avail_w * 1.02:
                total += 1
                cur = uw
            else:
                cur += uw
    return total


def parse_style(style):
    d = {}
    if not style:
        return d
    for i, token in enumerate(style.split(";")):
        if not token:
            continue
        if "=" in token:
            k, _, v = token.partition("=")
            d[k] = v
        else:
            d[token] = "1"
            if i == 0:
                d["_shape"] = token
    if "shape" in d:
        d["_shape"] = d["shape"]
    return d


class Cell:
    __slots__ = ("id", "value", "style", "sd", "vertex", "edge", "parent",
                 "source", "target", "x", "y", "w", "h", "relative", "has_geom",
                 "geom_as", "points")

    def __init__(self, el, value_override=None, id_override=None):
        self.id = id_override or el.get("id")
        self.value = value_override if value_override is not None else (el.get("value") or "")
        self.style = el.get("style") or ""
        self.sd = parse_style(self.style)
        self.vertex = el.get("vertex") == "1"
        self.edge = el.get("edge") == "1"
        self.parent = el.get("parent")
        self.source = el.get("source")
        self.target = el.get("target")
        self.x = self.y = self.w = self.h = 0.0
        self.relative = False
        self.has_geom = False
        self.geom_as = None
        self.points = []
        g = el.find("mxGeometry")
        if g is not None:
            self.has_geom = True
            self.x = float(g.get("x") or 0)
            self.y = float(g.get("y") or 0)
            self.w = float(g.get("width") or 0)
            self.h = float(g.get("height") or 0)
            self.relative = g.get("relative") == "1"
            self.geom_as = g.get("as")
            pts = g.find("Array[@as='points']")
            if pts is not None:
                for pt in pts.findall("mxPoint"):
                    self.points.append((float(pt.get("x") or 0),
                                        float(pt.get("y") or 0)))

    def snippet(self):
        txt = " ".join(label_lines(self.value))[:18]
        return f'"{txt}"' if txt else "(无文字)"


def decompress_diagram(text):
    data = base64.b64decode(text.strip())
    xml = zlib.decompress(data, -15).decode("utf-8")
    return urllib.parse.unquote(xml)


def load_models(path):
    """返回 [(page_name, mxGraphModel Element, raw_xml_str)]"""
    raw = open(path, encoding="utf-8").read()
    root = ET.fromstring(raw)
    models = []
    if root.tag == "mxGraphModel":
        models.append(("(单页)", root, raw))
    elif root.tag == "mxfile":
        for i, dia in enumerate(root.findall("diagram")):
            name = dia.get("name") or f"page-{i + 1}"
            model = dia.find("mxGraphModel")
            if model is not None:
                models.append((name, model, ET.tostring(model, encoding="unicode")))
            elif dia.text and dia.text.strip():
                xml = decompress_diagram(dia.text)
                models.append((name, ET.fromstring(xml), xml))
    else:
        raise ValueError(f"未知根节点 <{root.tag}>")
    return models


def collect_cells(model):
    cells = {}
    order = []
    root_el = model.find("root")
    if root_el is None:
        return cells, order
    for el in root_el:
        if el.tag == "mxCell":
            c = Cell(el)
        elif el.tag in ("object", "UserObject"):
            inner = el.find("mxCell")
            if inner is None:
                continue
            c = Cell(inner, value_override=el.get("label") or "",
                     id_override=el.get("id"))
        else:
            continue
        if c.id is not None:
            if c.id in cells:
                order.append(("E4", f"structure id={c.id} 重复定义"))
            cells[c.id] = c
    return cells, order


def is_zone(c):
    """视觉分组框/容器/纯文本标签 — 不参与不透明重叠判定"""
    sd = c.sd
    if sd.get("fillColor", "").lower() in ("none", "transparent"):
        return True
    if "swimlane" in sd or sd.get("container") == "1" or sd.get("group") == "1":
        return True
    if sd.get("_shape") == "text" or "text" == c.style.split(";")[0]:
        return True
    if float(sd.get("opacity", "100") or 100) < 50:
        return True
    return False


def abs_pos(c, cells):
    x, y = c.x, c.y
    p = cells.get(c.parent)
    depth = 0
    while p is not None and p.vertex and depth < 20:
        x += p.x
        y += p.y
        p = cells.get(p.parent)
        depth += 1
    return x, y


def rect(c):
    return (c.x, c.y, c.w, c.h)


def rect_intersection(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = min(ax + aw, bx + bw) - max(ax, bx)
    iy = min(ay + ah, by + bh) - max(ay, by)
    return ix, iy


def is_text_shape(c):
    return c.sd.get("_shape") == "text" or c.style.split(";")[0] == "text"


def cjk_count(text):
    return sum(1 for ch in text if ord(ch) >= CJK_START)


def style_float(sd, key, default=None):
    val = sd.get(key)
    if val is None or val == "":
        return default
    try:
        return float(val)
    except ValueError:
        return default


def external_label_box(c):
    """估算 draw.io 外置标签 bbox,坐标仍使用 cell 所在 parent 的局部坐标。"""
    sd = c.sd
    horizontal = sd.get("labelPosition")
    vertical = sd.get("verticalLabelPosition")
    if horizontal not in ("left", "right") and vertical not in ("top", "bottom"):
        return None
    lines = label_lines(c.value)
    if not lines:
        return None
    fs = float(sd.get("fontSize", 12) or 12)
    bold = int(sd.get("fontStyle", "0") or 0) & 1
    line_h = fs * 1.2
    label_w = max(text_w(ln, fs, bold) for ln in lines)
    label_h = len(lines) * line_h
    gap = 6.0
    pad = 4.0

    if vertical == "top":
        x = c.x + (c.w - label_w) / 2
        y = c.y - label_h - gap
    elif vertical == "bottom":
        x = c.x + (c.w - label_w) / 2
        y = c.y + c.h + gap
    elif horizontal == "left":
        x = c.x - label_w - gap
        y = c.y + (c.h - label_h) / 2
    else:
        x = c.x + c.w + gap
        y = c.y + (c.h - label_h) / 2

    return (x - pad, y - pad, label_w + pad * 2, label_h + pad * 2)


def is_label_collision_target(c):
    """外置标签不能压住可见节点或独立文本;大容器/背景仍跳过。"""
    if not is_zone(c):
        return True
    if is_text_shape(c) and label_lines(c.value):
        return True
    return False


def abs_rect(c, cells):
    ax, ay = abs_pos(c, cells)
    return (ax, ay, c.w, c.h)


def rect_contains_y(r, y):
    return r[1] <= y <= r[1] + r[3]


def rect_contains_x(r, x):
    return r[0] <= x <= r[0] + r[2]


def straight_edge_possible(edge, source, target, vertices, cells):
    """判断 source→target 是否可用水平/垂直直线。保守返回方向时才报警。"""
    sx, sy, sw, sh = abs_rect(source, cells)
    tx, ty, tw, th = abs_rect(target, cells)
    scy = sy + sh / 2
    tcy = ty + th / 2
    scx = sx + sw / 2
    tcx = tx + tw / 2

    if abs(scy - tcy) <= 4:
        if sx + sw <= tx:
            left, right = sx + sw, tx
        elif tx + tw <= sx:
            left, right = tx + tw, sx
        else:
            left = right = None
        if left is not None and right - left >= 8:
            corridor_y = (scy + tcy) / 2
            blocked = False
            for v in vertices:
                if v.id in (source.id, target.id) or is_zone(v):
                    continue
                vx, vy, vw, vh = abs_rect(v, cells)
                overlap_x = min(right, vx + vw) - max(left, vx)
                if overlap_x > 4 and rect_contains_y((vx, vy, vw, vh), corridor_y):
                    blocked = True
                    break
            if not blocked:
                return "horizontal"

    if abs(scx - tcx) <= 4:
        if sy + sh <= ty:
            top, bottom = sy + sh, ty
        elif ty + th <= sy:
            top, bottom = ty + th, sy
        else:
            top = bottom = None
        if top is not None and bottom - top >= 8:
            corridor_x = (scx + tcx) / 2
            blocked = False
            for v in vertices:
                if v.id in (source.id, target.id) or is_zone(v):
                    continue
                vx, vy, vw, vh = abs_rect(v, cells)
                overlap_y = min(bottom, vy + vh) - max(top, vy)
                if overlap_y > 4 and rect_contains_x((vx, vy, vw, vh), corridor_x):
                    blocked = True
                    break
            if not blocked:
                return "vertical"

    return None


def return_loop_entry_problem(edge, source, target, cells):
    """识别右下方回流到左上游节点时的自动右侧倒插风险。"""
    if edge.sd.get("edgeStyle") != "orthogonalEdgeStyle":
        return False
    sx, sy, sw, sh = abs_rect(source, cells)
    tx, ty, tw, th = abs_rect(target, cells)
    scx, scy = sx + sw / 2, sy + sh / 2
    tcx, tcy = tx + tw / 2, ty + th / 2
    # 只处理典型 flowchart: 返工/回滚节点在目标节点右下方,箭头指回上游。
    if scx <= tcx + 40 or scy <= tcy + 40:
        return False
    entry_x = style_float(edge.sd, "entryX")
    entry_y = style_float(edge.sd, "entryY")
    if entry_x is None or entry_y is None:
        return True
    if entry_y <= 0.1 or entry_y >= 0.9:
        return False
    return entry_x >= 0.8


def lint_model(name, model, raw_xml, findings):
    cells, structural = collect_cells(model)
    findings.extend(("ERROR", f"E4 {msg}") for _, msg in structural)

    if "<!--" in raw_xml:
        findings.append(("ERROR", "E4 structure XML 含注释 <!-- --> (draw.io 会剥掉,且易致解析/编辑问题)"))

    vertices = [c for c in cells.values()
                if c.vertex and not c.relative and c.w > 0 and c.h > 0]

    # E4: 边检查
    for c in cells.values():
        if not c.edge:
            continue
        if not c.has_geom:
            findings.append(("ERROR", f"E4 structure 边 id={c.id} 缺 <mxGeometry relative=\"1\" as=\"geometry\"/> 子元素,会不渲染"))
        elif not c.relative or c.geom_as != "geometry":
            findings.append(("ERROR", f"E4 structure 边 id={c.id} 的 mxGeometry 缺 relative=\"1\" 或 as=\"geometry\",draw.io 行为未定义"))
        for ref, val in (("source", c.source), ("target", c.target)):
            if val is not None and val not in cells:
                findings.append(("ERROR", f"E4 structure 边 id={c.id} 的 {ref}=\"{val}\" 引用不存在的 cell"))

    # E1: 文字出框
    for c in vertices:
        lines = label_lines(c.value)
        if not lines:
            continue
        sd = c.sd
        if sd.get("labelPosition") in ("left", "right") or \
           sd.get("verticalLabelPosition") in ("top", "bottom"):
            continue  # 标签在形状外部,不按盒内检查
        fs = float(sd.get("fontSize", 12) or 12)
        bold = int(sd.get("fontStyle", "0") or 0) & 1
        wf, hf = SHAPE_FACTOR.get(sd.get("_shape", ""), (1.0, 1.0))
        # 纯文本标签(text 形状)无边框,溢出视觉无害 → 降为 WARN
        lvl = "WARN" if sd.get("_shape") == "text" or c.style.split(";")[0] == "text" else "ERROR"
        box_w, box_h = c.w, c.h
        if "swimlane" in sd:
            start = float(sd.get("startSize", 23) or 23)
            if sd.get("horizontal") == "0":
                box_w, box_h = c.h, start  # 标题竖排在左条
            else:
                box_h = start
        avail_w = box_w * wf - 8
        avail_h = box_h * hf - 2
        if avail_w <= 0 or avail_h <= 0:
            findings.append((lvl, f"E1 overflow id={c.id} {c.snippet()} 盒子 {c.w:.0f}×{c.h:.0f} 对该形状太小,放不下任何文字"))
            continue
        line_h = fs * 1.2
        if sd.get("whiteSpace") == "wrap":
            n = wrapped_line_count(lines, fs, bold, avail_w)
            if n is None:
                need = max(text_w(u, fs, bold) for ln in lines for u in wrap_units(ln))
                findings.append((lvl, f"E1 overflow id={c.id} {c.snippet()} 有不可断单元宽 ~{need:.0f}px > 可用 {avail_w:.0f}px → 宽度加到 ≥{(need + 8) / wf:.0f} 或断词"))
            elif n * line_h > avail_h + 2:
                findings.append((lvl, f"E1 overflow id={c.id} {c.snippet()} 换行后 {n} 行需高 ~{n * line_h:.0f}px > 可用 {avail_h:.0f}px → 高度加到 ≥{(n * line_h + 6) / hf:.0f} 或精简文字"))
        else:
            max_w = max(text_w(ln, fs, bold) for ln in lines)
            if max_w > avail_w * 1.03:
                findings.append((lvl, f"E1 overflow id={c.id} {c.snippet()} 单行文本 ~{max_w:.0f}px > 可用 {avail_w:.0f}px → 宽度加到 ≥{(max_w + 10) / wf:.0f},或加 whiteSpace=wrap 并加高"))
            if len(lines) * line_h > avail_h + 4:
                findings.append((lvl, f"E1 overflow id={c.id} {c.snippet()} {len(lines)} 行需高 ~{len(lines) * line_h:.0f}px > 可用 {avail_h:.0f}px → 加高"))

    # W2: 外置标签 bbox 碰撞;E1 跳过外置标签,这里补可读性检查
    external_by_parent = {}
    targets_by_parent = {}
    for c in vertices:
        box = external_label_box(c)
        if box is not None:
            external_by_parent.setdefault(c.parent, []).append((c, box))
            if box[0] < -1 or box[1] < -1:
                findings.append(("WARN", f"W2 ext-label id={c.id} {c.snippet()} 外置标签 bbox ({box[0]:.0f},{box[1]:.0f}) 为负,可能跑出画布"))
        if is_label_collision_target(c):
            targets_by_parent.setdefault(c.parent, []).append(c)

    for parent, labels in external_by_parent.items():
        targets = targets_by_parent.get(parent, [])
        for c, box in labels:
            for t in targets:
                if t.id == c.id:
                    continue
                ix, iy = rect_intersection(box, rect(t))
                if ix > 2 and iy > 2:
                    findings.append(("WARN", f"W2 ext-label id={c.id} {c.snippet()} 外置标签与 id={t.id} {t.snippet()} 重叠 {ix:.0f}×{iy:.0f}px → 给标签预留 bbox 或改独立 text cell"))
        for i in range(len(labels)):
            for j in range(i + 1, len(labels)):
                a, abox = labels[i]
                b, bbox = labels[j]
                ix, iy = rect_intersection(abox, bbox)
                if ix > 2 and iy > 2:
                    findings.append(("WARN", f"W2 ext-label id={a.id} {a.snippet()} 外置标签与 id={b.id} {b.snippet()} 外置标签重叠 {ix:.0f}×{iy:.0f}px → 拉开图标或改独立 text cell"))

    # W3: 小 gate 圆形不承载长标签
    for c in vertices:
        lines = label_lines(c.value)
        if not lines:
            continue
        sd = c.sd
        if sd.get("_shape") != "ellipse":
            continue
        if max(c.w, c.h) > 50 or min(c.w, c.h) <= 0:
            continue
        text = "".join(lines)
        if cjk_count(text) > 3:
            findings.append(("WARN", f"W3 gate-label id={c.id} {c.snippet()} 小 gate {c.w:.0f}×{c.h:.0f} 承载超过 3 个中文字符 → 圆内保留短词,长文案放外部 label/pill"))

    # W4: note 折角必须小,且右侧要给折角留空间
    for c in vertices:
        if c.sd.get("_shape") != "note":
            continue
        size = style_float(c.sd, "size")
        if size is None:
            findings.append(("WARN", f"W4 note-fold id={c.id} {c.snippet()} note 缺 size,draw.io 默认折角偏大 → 加 size=8~10"))
            size = 18.0
        elif size > 12:
            findings.append(("WARN", f"W4 note-fold id={c.id} {c.snippet()} note 折角 size={size:.0f} 偏大 → 改到 8~10,避免遮挡文字"))
        if label_lines(c.value):
            spacing_right = style_float(c.sd, "spacingRight", 0.0)
            min_spacing = max(12.0, min(size, 12.0) + 4.0)
            if spacing_right < min_spacing:
                findings.append(("WARN", f"W4 note-fold id={c.id} {c.snippet()} note 右侧 spacingRight={spacing_right:.0f}px 不足 → 加到 ≥{min_spacing:.0f}px 给折角让位"))

    # W5: 同一水平/垂直泳道、无遮挡的边应是直线,不应生成狗腿线
    for c in cells.values():
        if not c.edge or not c.source or not c.target:
            continue
        source = cells.get(c.source)
        target = cells.get(c.target)
        if source is None or target is None or not source.vertex or not target.vertex:
            continue
        direction = straight_edge_possible(c, source, target, vertices, cells)
        if direction is None:
            continue
        edge_style = c.sd.get("edgeStyle")
        has_waypoints = bool(c.points)
        if edge_style == "orthogonalEdgeStyle" or has_waypoints:
            detail = "含 waypoint" if has_waypoints else "使用 orthogonalEdgeStyle"
            if direction == "horizontal":
                fix = "edgeStyle=none;exitX=1;exitY=0.5;entryX=0;entryY=0.5"
                zh_dir = "水平"
            else:
                fix = "edgeStyle=none;exitX=0.5;exitY=1;entryX=0.5;entryY=0"
                zh_dir = "垂直"
            findings.append(("WARN", f"W5 straight-edge id={c.id} source={source.id} target={target.id} {zh_dir}无遮挡但{detail} → 改用 {fix}"))

    # W6: 返工/回滚线指回上游时,避免 draw.io 自动选目标右侧入口形成倒插箭头
    for c in cells.values():
        if not c.edge or not c.source or not c.target:
            continue
        source = cells.get(c.source)
        target = cells.get(c.target)
        if source is None or target is None or not source.vertex or not target.vertex:
            continue
        if return_loop_entry_problem(c, source, target, cells):
            findings.append(("WARN", f"W6 return-loop id={c.id} source={source.id} target={target.id} 回流到右上/左上游节点但未显式指定安全入口 → 走外侧通道,并从顶部/底部进入,如 exitX=0.5;exitY=0;entryX=0.7;entryY=0"))

    # E2: 同级部分重叠(不透明形状)
    by_parent = {}
    for c in vertices:
        if is_zone(c):
            continue
        by_parent.setdefault(c.parent, []).append(c)
    for sibs in by_parent.values():
        for i in range(len(sibs)):
            for j in range(i + 1, len(sibs)):
                a, b = sibs[i], sibs[j]
                ix = min(a.x + a.w, b.x + b.w) - max(a.x, b.x)
                iy = min(a.y + a.h, b.y + b.h) - max(a.y, b.y)
                if ix <= 2 or iy <= 2:
                    continue
                a_in_b = a.x >= b.x - 1 and a.y >= b.y - 1 and \
                    a.x + a.w <= b.x + b.w + 1 and a.y + a.h <= b.y + b.h + 1
                b_in_a = b.x >= a.x - 1 and b.y >= a.y - 1 and \
                    b.x + b.w <= a.x + a.w + 1 and b.y + b.h <= a.y + a.h + 1
                both_labeled = bool(label_lines(a.value)) and bool(label_lines(b.value))
                level = "ERROR" if both_labeled else "WARN"
                if a_in_b or b_in_a:
                    outer, inner = (b, a) if a_in_b else (a, b)
                    if outer.w * outer.h >= 1.8 * inner.w * inner.h:
                        continue  # 大框包小卡 = 视觉分组手法,放行
                    findings.append((level, f"E2 overlap id={inner.id} {inner.snippet()} 被 id={outer.id} {outer.snippet()} 完全覆盖且尺寸接近,疑似重复叠放 → 删一个或挪开"))
                    continue
                findings.append((level, f"E2 overlap id={a.id} {a.snippet()} ∩ id={b.id} {b.snippet()} 部分重叠 {ix:.0f}×{iy:.0f}px → 拉开间距或对齐(无文字一方若是装饰可忽略)"))

    # E3: 子元素越出容器
    for c in vertices:
        p = cells.get(c.parent)
        if p is None or not p.vertex or p.w <= 0 or p.h <= 0:
            continue
        if p.sd.get("collapsed") == "1":
            continue
        min_x = min_y = 0.0
        if "swimlane" in p.sd:
            start = float(p.sd.get("startSize", 23) or 23)
            if p.sd.get("horizontal") == "0":
                min_x = start
            else:
                min_y = start
        if c.x < min_x - 2 or c.y < min_y - 2 or \
           c.x + c.w > p.w + 2 or c.y + c.h > p.h + 2:
            findings.append(("ERROR", f"E3 out-of-parent id={c.id} {c.snippet()} 越出容器 id={p.id} {p.snippet()} 内区 → 调整子元素坐标或扩容容器"))

    # W1: 负绝对坐标
    for c in vertices:
        ax, ay = abs_pos(c, cells)
        if ax < -1 or ay < -1:
            findings.append(("WARN", f"W1 negative-pos id={c.id} {c.snippet()} 绝对坐标 ({ax:.0f},{ay:.0f}) 为负,可能跑出画布"))


def main():
    ap = argparse.ArgumentParser(description=".drawio 布局确定性检查")
    ap.add_argument("file")
    args = ap.parse_args()

    try:
        models = load_models(args.file)
    except Exception as e:
        print(f"解析失败: {e}", file=sys.stderr)
        return 2

    total_err = total_warn = 0
    for name, model, raw in models:
        findings = []
        lint_model(name, model, raw, findings)
        errs = [m for lv, m in findings if lv == "ERROR"]
        warns = [m for lv, m in findings if lv == "WARN"]
        total_err += len(errs)
        total_warn += len(warns)
        print(f"== {args.file} · 页「{name}」 ==")
        for m in errs:
            print(f"  ERROR {m}")
        for m in warns:
            print(f"  WARN  {m}")
        if not findings:
            print("  ✓ 干净")
    print(f"共 {total_err} ERROR / {total_warn} WARN")
    return 1 if total_err else 0


if __name__ == "__main__":
    sys.exit(main())
