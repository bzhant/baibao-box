#!/usr/bin/env bash
# ============================================================================
#  N2 验收：排版回填（折行 / 字号自适应 / 缺字兜底 / 全部还原）
# ============================================================================
#  覆盖排版回填的四条验收标准：
#    ① 固定宽度对话框里塞 3 倍长度中文 → 必须自动折行且**不溢出**
#    ② 同一段文字，字号自动降级后必须**完整可见**
#    ③ 放一个日文原字体没有的汉字（龘）→ 必须能显示而不是豆腐块
#    ④ 提供"全部还原"命令，字体和字号都回到原始状态
#
#  ★ 怎么在没有肉眼看窗口的情况下断言"不溢出"
#    排版发生在**目标进程内部**（hook 在 TextOutW 里重排），外部拿不到 HDC、
#    也拿不到文本框。所以让被注入的一侧把事实**写进日志**：
#      LAYOUT handled=1 ok=1 lines=7 widest=360 boxw=364 usedh=126 boxh=138 ...
#    验收脚本断言 `widest <= boxw` 且 `usedh <= boxh` —— 这就是"不溢出"的硬证据。
#
#  用法：cd native && bash acceptance-n2.sh [x86|x64]
# ============================================================================
set -u

ARCH="${1:-x86}"
case "$ARCH" in
    x86) INJ_EXE="bbInject32.exe" ;;
    x64) INJ_EXE="bbInject64.exe" ;;
    *) echo "架构只能是 x86 或 x64"; exit 2 ;;
esac

NATIVE_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$NATIVE_DIR/build/$ARCH"
INJ="$WORK/$INJ_EXE"
HOOKLOG="$WORK/toyHook.log"

TL='/c/Windows/System32/tasklist.exe'
TK='/c/Windows/System32/taskkill.exe'
kill_toy()  { "$TL" 2>/dev/null | grep -i toygame | awk '{print $2}' | while read -r p; do
                "$TK" /F /PID "$p" >/dev/null 2>&1; done; sleep 0.3; }
toy_pid()   { "$TL" 2>/dev/null | grep -i toygame | awk '{print $2}' | head -1; }

pass=0; fail=0
ok()  { echo "  [通过] $1"; pass=$((pass+1)); }
bad() { echo "  [失败] $1"; fail=$((fail+1)); }
note(){ echo "        $1"; }

echo "================================================================"
echo " N2 验收（$ARCH）：排版回填"
echo "================================================================"

# ── 第 0 步：无 GUI 的排版自检（折行/度量/缺字/还原的纯逻辑）──
echo ""
echo "--- 第 0 步：排版自检（measure_selftest.exe）---"
SELF="$WORK/measure_selftest.exe"
if [ ! -f "$SELF" ]; then
    bad "找不到 $SELF（先跑 node build.mjs）"
else
    SOUT="$("$SELF" 2>&1)"
    SPASS="$(echo "$SOUT" | grep -oE 'PASS=[0-9]+' | cut -d= -f2)"
    SFAIL="$(echo "$SOUT" | grep -oE 'FAIL=[0-9]+' | cut -d= -f2)"
    note "自检结果：通过 ${SPASS:-?} 项，失败 ${SFAIL:-?} 项"
    echo "$SOUT" | grep -E '^\s*(黑体|宋体|MS Gothic|微软雅黑|MS Gothic):' | sed 's/^ */       /'
    echo "$SOUT" | grep -aE '\[失败\]' | sed 's/^/       /' || true
    if [ "${SFAIL:-1}" = "0" ] && [ "${SPASS:-0}" -gt 0 ]; then
        ok "排版自检全部通过（$SPASS 项）"
    else
        bad "排版自检有失败项（FAIL=${SFAIL:-?}）"
    fi
    # 把关键结论单独断言一遍，免得"自检自己被改坏了"也能通过
    if echo "$SOUT" | grep -q '龘 在 MS Gothic = 无'; then
        ok "缺字检测有效：日文字体 MS Gothic 判为**不含**「龘」"
    else
        bad "缺字检测没认出「龘」在 MS Gothic 里缺失（检测可能退化成 GDI 判断）"
    fi
    if echo "$SOUT" | grep -q '龘 在 黑体       = 有'; then
        ok "中文字体 黑体 判为含「龘」（兜底字体可用）"
    else
        bad "黑体被判为不含「龘」，兜底方案无从落地"
    fi
fi

# ── 端到端：注入 → 排版接管 → 还原 ──
echo ""
echo "--- 第 1 步：注入玩具目标，让排版 hook 接管 ─---"
kill_toy
rm -f "$HOOKLOG" "$WORK/bbinject.log"

( cd "$WORK" && ./$INJ_EXE --exe toygame.exe --dll toyHook.dll --timeout 15000 --json \
    > "$WORK/_n2_inject.json" 2>&1 )
ICODE=$?
note "注入退出码 = $ICODE"
PID="$(toy_pid)"
if [ "$ICODE" = "0" ] && [ -n "$PID" ]; then
    ok "注入成功，目标 pid=$PID"
else
    bad "注入失败（退出码 $ICODE）"
    cat "$WORK/_n2_inject.json" | sed 's/^/       /'
fi

# 让玩具重绘几帧，排版 hook 有机会工作
sleep 2.0

# 日志被目标进程独占 → 先 kill 再读
kill_toy
sleep 0.5

if [ ! -f "$HOOKLOG" ]; then
    bad "没有产出 hook 日志 $HOOKLOG"
    echo
    echo "结果：$pass 通过 / $fail 失败"
    exit 1
fi
LOG="$(cat "$HOOKLOG" 2>/dev/null)"

# 取最后一条 LAYOUT 记录（稳定态）
LAST="$(echo "$LOG" | grep -a 'LAYOUT handled=1' | tail -1)"
if [ -z "$LAST" ]; then
    bad "日志里没有 LAYOUT handled=1 记录（排版 hook 没接管文本）"
    echo "$LOG" | tail -20 | sed 's/^/       /'
else
    ok "排版 hook 确实接管了文本绘制"

    # 从 KEY=value 里取值
    val() { echo "$LAST" | grep -oE "$1=[0-9-]+" | head -1 | cut -d= -f2; }
    L_OK="$(val ok)"; L_LINES="$(val lines)"; L_W="$(val widest)"
    L_BW="$(val boxw)"; L_H="$(val usedh)"; L_BH="$(val boxh)"
    L_FONT="$(val fonth)"; L_SHRINK="$(val shrink)"; L_SUB="$(val substituted)"
    note "最后一条：ok=$L_OK lines=$L_LINES widest=$L_W/$L_BW usedh=$L_H/$L_BH fonth=$L_FONT shrink=$L_SHRINK substituted=$L_SUB"

    # ① 不溢出
    if [ -n "$L_W" ] && [ -n "$L_BW" ] && [ "$L_W" -le "$L_BW" ]; then
        ok "① 折行不溢出：最宽行 ${L_W}px <= 区域宽 ${L_BW}px"
    else
        bad "① 折行溢出：最宽 ${L_W:-?}px > 区域宽 ${L_BW:-?}px"
    fi
    # ② 完整可见（高不超）
    if [ -n "$L_H" ] && [ -n "$L_BH" ] && [ "$L_H" -le "$L_BH" ]; then
        ok "② 完整可见：总高 ${L_H}px <= 区域高 ${L_BH}px"
    else
        bad "② 垂直溢出：总高 ${L_H:-?}px > 区域高 ${L_BH:-?}px"
    fi
    # 确实是多行（证明真的折了，而不是"一行恰好放得下"）
    if [ -n "$L_LINES" ] && [ "$L_LINES" -ge 2 ]; then
        ok "① 确实发生了折行：${L_LINES} 行"
    else
        bad "① 只有 ${L_LINES:-?} 行 —— 没看出折行效果"
    fi
    # ③ 缺字兜底
    if [ "$L_SUB" = "1" ]; then
        ok "③ 缺字兜底生效：发生了字体替换（原始日文字体缺字形）"
        FACE="$(echo "$LAST" | grep -oE 'face=[^ ]+' | head -1 | cut -d= -f2)"
        note "最终字体：${FACE:-?}"
        SUBLINE="$(echo "$LOG" | grep -a '字体替换' | tail -1)"
        [ -n "$SUBLINE" ] && note "$SUBLINE"
    else
        bad "③ 没有发生字体替换 —— 缺字兜底可能没生效"
    fi
    # ② 字号自适应确实降了
    #
    # ★ 这里要在**所有** LAYOUT 行里找 shrink>0，而不是只看最后一条。
    #   原因：一帧里会画好几段文本（长对白 + 一行提示），最后一条可能恰好是
    #   那种"本来就放得下、不用降字号"的短文本 —— 只查最后一条会误判成
    #   "字号自适应没生效"（实测踩到过）。真正要断言的是
    #   "**至少有一段文本**因为放不下而降过字号"。
    SHRINK_MAX=0
    while IFS= read -r ln; do
        s="$(echo "$ln" | grep -oE 'shrink=[0-9]+' | head -1 | cut -d= -f2)"
        if [ -n "$s" ] && [ "$s" -gt "$SHRINK_MAX" ]; then SHRINK_MAX="$s"; fi
    done <<< "$(echo "$LOG" | grep -a 'LAYOUT handled=1')"

    if [ "$SHRINK_MAX" -gt 0 ]; then
        ok "② 字号自适应生效：有文本因放不下而降了字号（最多降 $SHRINK_MAX 级）"
        echo "$LOG" | grep -a 'LAYOUT handled=1' | grep -aE "shrink=[1-9]" | tail -1 | sed 's/^ */       /'
    else
        bad "② 没有任何文本降过字号 —— 字号自适应可能没生效"
    fi
fi

# ── 第 2 步：全部还原 ──
echo ""
echo "--- 第 2 步：全部还原（RestoreAll）---"
if [ -n "$PID" ]; then
    # 注意：上一步已经把目标 kill 了，这里重新注一个
    rm -f "$HOOKLOG"
    ( cd "$WORK" && ./$INJ_EXE --exe toygame.exe --dll toyHook.dll --timeout 15000 \
        >/dev/null 2>&1 )
    sleep 1.5
    PID2="$(toy_pid)"
    note "新的目标 pid = ${PID2:-?}"
    if [ -n "$PID2" ]; then
        COUT="$(cd "$WORK" && ./$INJ_EXE --call "$PID2" --dll toyHook.dll --entry RestoreAll \
            --json 2>&1)"
        CCODE=$?
        note "调用退出码 = $CCODE"
        echo "$COUT" | sed 's/^/       /'
        if [ "$CCODE" = "0" ] && echo "$COUT" | grep -q '"ok":true'; then
            ok "④ RestoreAll 调用成功"
        else
            bad "④ RestoreAll 调用失败（退出码 $CCODE）"
        fi
        # 还原后目标必须仍然活着（还原不能把游戏搞崩）
        sleep 0.8
        if [ "$(toy_pid)" = "$PID2" ]; then
            ok "④ 还原后目标进程仍然存活（没崩）"
        else
            bad "④ 还原后目标进程消失了"
        fi
    else
        bad "第二次注入后拿不到目标 pid"
    fi
fi

# 读日志验证还原
kill_toy
sleep 0.5
LOG2="$(cat "$HOOKLOG" 2>/dev/null)"
if echo "$LOG2" | grep -q 'RestoreAll 完成'; then
    ok "④ 日志有「RestoreAll 完成」"
else
    bad "④ 日志里没有「RestoreAll 完成」"
fi
if echo "$LOG2" | grep -q 'RESTOREALL ok=1'; then
    ok "④ 还原自述行存在（RESTOREALL ok=1 fontOverride=0 layoutDisabled=1）"
else
    bad "④ 缺少还原自述行"
fi
# ★ 关键：还原之后排版就不该再接管了（否则"字体与字号回到原始状态"不成立）
if echo "$LOG2" | grep -q 'LAYOUT handled=0 reason=layout-disabled'; then
    ok "④ 还原后排版停止接管（字体与字号回到游戏原始状态）"
else
    bad "④ 还原后排版仍在接管 —— 字体/字号没有真正还原"
fi

# 还原前后对比：还原前有 handled=1，还原后有 handled=0
BEFORE_LINE="$(echo "$LOG2" | grep -an 'LAYOUT handled=1' | head -1 | cut -d: -f1)"
AFTER_LINE="$(echo "$LOG2" | grep -an 'LAYOUT handled=0' | head -1 | cut -d: -f1)"
if [ -n "$BEFORE_LINE" ] && [ -n "$AFTER_LINE" ] && [ "$BEFORE_LINE" -lt "$AFTER_LINE" ]; then
    ok "④ 顺序正确：先接管（第 $BEFORE_LINE 行）→ 再还原（第 $AFTER_LINE 行）"
else
    bad "④ 顺序不对（接管=$BEFORE_LINE 还原=$AFTER_LINE）"
fi

kill_toy
echo
echo "================================================================"
echo " 结果：$pass 通过 / $fail 失败"
echo "================================================================"
[ "$fail" -eq 0 ] || exit 1
exit 0
