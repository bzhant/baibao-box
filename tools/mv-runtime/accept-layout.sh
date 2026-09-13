#!/usr/bin/env bash
# ============================================================================
#  MV 排版回填 —— 一键验收（可逆安装 → 真实游戏里自检 → 逐字节还原）
# ============================================================================
#  用法：bash tools/mv-runtime/accept-layout.sh "<游戏目录>"
#   例： bash tools/mv-runtime/accept-layout.sh "E:/games/某游戏"
#
#  它做两件事：
#    ① 跑探针（BB_Probe）—— 报出运行时的真实布局参数（窗口宽/字号/每字宽）
#    ② 跑排版验收（BB_Layout + BB_LayoutAccept）—— 断言折行正确
#
#  两条都**不需要肉眼看窗口**：插件把逐行宽度算出来自己断言，
#  结果以 JSON 落盘，脚本读它、非 0 退出即失败。
#
#  ★ 全程可逆：安装前备份 plugins.js（记 SHA-256），跑完逐字节还原并校验哈希。
#    任何一步失败都会走同一个还原路径（runner 里挂在 process.on('exit')）。
set -u

GAME_DIR="${1:-}"
if [ -z "$GAME_DIR" ]; then
    echo "用法：bash tools/mv-runtime/accept-layout.sh \"<游戏目录>\""
    exit 2
fi

# 定位仓库根（本脚本在 <root>/tools/mv-runtime/）
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT" || exit 1

echo "================================================================"
echo " MV 排版回填验收"
echo " 游戏：$GAME_DIR"
echo "================================================================"

FAIL=0

echo ""
echo "--- 第 1 步：运行时探针（只读，报真实参数）---"
if node tools/mv-runtime/run.mjs "$GAME_DIR" \
        --plugin tools/mv-runtime/BB_Probe.js \
        --out bb_probe_result.json --timeout 70000; then
    echo "  → 探针通过"
else
    echo "  → 探针失败"
    FAIL=$((FAIL + 1))
fi

echo ""
echo "--- 第 2 步：排版验收（折行 / 禁则 / 不丢字 / 还原）---"
if node tools/mv-runtime/run.mjs "$GAME_DIR" \
        --plugin src/engines/mvmz/runtime/BB_Layout.js \
        --plugin tools/mv-runtime/BB_LayoutAccept.js \
        --out bb_layout_accept.json --timeout 70000; then
    echo "  → 排版验收通过"
else
    echo "  → 排版验收失败"
    FAIL=$((FAIL + 1))
fi

echo ""
echo "================================================================"
if [ "$FAIL" -eq 0 ]; then
    echo " 全部通过"
    echo " 结果文件：bb_probe_result.json / bb_layout_accept.json"
else
    echo " 有 $FAIL 步失败"
fi
echo "================================================================"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
