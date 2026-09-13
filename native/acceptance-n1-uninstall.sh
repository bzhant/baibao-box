#!/usr/bin/env bash
# ============================================================================
#  N1 端到端：注入 -> 验证 hook 生效 -> 卸载 -> 验证 hook 已拆 -> 进程不崩
# ============================================================================
#  这是用户口径的验收："注入后玩具窗口上的日文变中文，点卸载立刻恢复日文且不崩"
#
#  怎么在没有肉眼看窗口的情况下证明 hook 生效/失效：
#    hook DLL 会往 toyHook.log 写 "Install 开始/完成"（注入时），
#    Uninstall 会追加 "Uninstall 开始/完成"（卸载时）。
#
#  ★ 关键坑：**日志文件在目标进程运行期间是读不到的**。
#    DLL 用 `_wfopen_s(..., L"ab")` 持有它，Cygwin 的 cp/cat 一律报
#    "Device or resource busy"，连 cp 绕开占用都不行。
#    只有 Uninstall 末尾的 `Log::close()` 会释放句柄。
#    所以本脚本**只在卸载之后**读一次日志 —— 因为是追加写，
#    卸载前的 "Install 完成" 记录仍然在里面，一次读就能同时验证两件事，
#    还能顺便验证先后顺序（Install 必须在 Uninstall 之前）。
#    （另一条路是先把目标 kill 掉再读，但那样就测不了"卸载后进程仍存活"。）
#
#  用法：cd native && bash acceptance-n1-uninstall.sh [x86|x64]
# ============================================================================
set -u

ARCH="${1:-x64}"
case "$ARCH" in
    x86) INJ_EXE="bbInject32.exe" ;;
    x64) INJ_EXE="bbInject64.exe" ;;
    *) echo "架构只能是 x86 或 x64"; exit 2 ;;
esac

NATIVE_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$NATIVE_DIR/build/$ARCH"
INJ="$WORK/$INJ_EXE"

TL='/c/Windows/System32/tasklist.exe'
TK='/c/Windows/System32/taskkill.exe'
kill_toy()  { "$TL" 2>/dev/null | grep -i toygame | awk '{print $2}' | while read -r p; do
                "$TK" /F /PID "$p" >/dev/null 2>&1; done; sleep 0.3; }
toy_pid()   { "$TL" 2>/dev/null | grep -i toygame | awk '{print $2}' | head -1; }
pid_alive() { "$TL" 2>/dev/null | awk -v p="$1" '$2==p' | grep -q . && echo 1 || echo 0; }

pass=0; fail=0
ok()  { echo "  [通过] $1"; pass=$((pass+1)); }
bad() { echo "  [失败] $1"; fail=$((fail+1)); }

echo "================================================================"
echo " 端到端（$ARCH）：注入 -> 卸载 -> 原文恢复 -> 进程不崩"
echo "================================================================"

kill_toy
rm -f "$WORK/toyHook.log" "$WORK/bbinject.log"

# ── 1) 注入 ──
echo "--- 1) 注入 ---"
OUT="$(cd "$WORK" && ./$INJ_EXE --exe toygame.exe --dll toyHook.dll --timeout 15000 --json 2>&1)"
CODE=$?
echo "退出码 = $CODE"
if [ "$CODE" = "0" ] && echo "$OUT" | grep -q '"ok":true'; then
    ok "注入成功（ok=true）"
else
    bad "注入失败：$OUT"
fi

sleep 1.0
PID="$(toy_pid)"
if [ -n "$PID" ]; then ok "目标进程存活 pid=$PID"; else bad "目标进程不存在"; fi

# ── 2) 卸载（趁进程还活着，这是"点卸载"的真实时序）──
echo "--- 2) 卸载（--uninstall $PID）---"
if [ -n "$PID" ]; then
    UOUT="$(cd "$WORK" && ./$INJ_EXE --uninstall "$PID" --dll toyHook.dll --json 2>&1)"
    UCODE=$?
    echo "卸载退出码 = $UCODE"
    echo "  输出：$UOUT"
    if [ "$UCODE" = "0" ] && echo "$UOUT" | grep -q '"ok":true'; then
        ok "卸载成功（ok=true）"
    else
        bad "卸载失败（code=$UCODE）"
    fi
fi

sleep 0.8

# ── 3) 卸载后进程必须仍然存活（验收口径里的"不崩"）──
#     ★ 顺序要紧：先查存活，再读日志 —— 因为读日志说明不了进程还在，
#       而我们真正要断言的是"卸载没把游戏搞崩"。
echo "--- 3) 卸载后进程存活 ---"
if [ -n "$PID" ] && [ "$(pid_alive "$PID")" = "1" ]; then
    ok "卸载后目标进程仍然存活（没崩）—— 正是验收要求的「不崩」"
else
    bad "卸载后目标进程消失了（崩了或被连带杀掉）"
fi

# ── 4) 现在读日志（Uninstall 里的 Log::close 已释放句柄）──
#     一次读同时验证：Install 生效、两个 API hook 装上、Uninstall 执行、且顺序正确。
echo "--- 4) 读 hook 日志，验证 Install 与 Uninstall 都真的跑过 ---"
LOG=""
if [ -f "$WORK/toyHook.log" ]; then
    LOG="$(cat "$WORK/toyHook.log" 2>/dev/null)"
else
    bad "找不到 hook 日志 $WORK/toyHook.log"
fi

if echo "$LOG" | grep -q 'Install 完成'; then
    ok "日志有「Install 完成」—— 注入时 hook 确实装上了"
else
    bad "日志里没有「Install 完成」"
fi
if echo "$LOG" | grep -q 'MultiByteToWideChar' && echo "$LOG" | grep -q 'WideCharToMultiByte'; then
    ok "两个 API hook 都记录到安装成功（MultiByteToWideChar / WideCharToMultiByte）"
else
    bad "两个 API hook 没有全部安装成功"
fi
if echo "$LOG" | grep -q 'Uninstall 完成'; then
    ok "日志有「Uninstall 完成」—— hook 已拆干净"
else
    bad "日志里没有「Uninstall 完成」（卸载没真正执行）"
fi

# 顺序校验：Install 必须出现在 Uninstall 之前（否则说明读到了错乱的数据）
LI="$(echo "$LOG" | grep -n 'Install 完成' | head -1 | cut -d: -f1)"
LU="$(echo "$LOG" | grep -n 'Uninstall 完成' | head -1 | cut -d: -f1)"
if [ -n "$LI" ] && [ -n "$LU" ] && [ "$LI" -lt "$LU" ]; then
    ok "顺序正确：Install（第 $LI 行）在 Uninstall（第 $LU 行）之前"
else
    bad "顺序不对或行号解析失败（Install=$LI Uninstall=$LU）"
fi

# ── 5) 负例：对没注入过的进程卸载 → 必须明确报错 ──
echo "--- 5) 负例：对没注入过的进程卸载 ---"
kill_toy
"$WORK/toygame.exe" &
sleep 1.0
RAW="$(toy_pid)"
if [ -n "$RAW" ]; then
    NOUT="$(cd "$WORK" && ./$INJ_EXE --uninstall "$RAW" --dll toyHook.dll --json 2>&1)"
    NCODE=$?
    echo "退出码 = $NCODE"
    echo "  输出：$NOUT"
    if [ "$NCODE" = "21" ]; then
        ok "对未注入进程卸载 → 退出码 21（目标进程里没有我们的 DLL）"
    else
        bad "期望退出码 21，实际 $NCODE"
    fi
else
    bad "拿不到裸玩具进程 pid"
fi

# ── 6) 负例：pid 不存在 ──
echo "--- 6) 负例：pid 不存在 ---"
BOUT="$(cd "$WORK" && ./$INJ_EXE --uninstall 999999 --dll toyHook.dll --json 2>&1)"
BCODE=$?
echo "退出码 = $BCODE"
if [ "$BCODE" = "20" ]; then
    ok "pid 不存在 → 退出码 20"
else
    bad "期望退出码 20，实际 $BCODE"
fi

kill_toy
echo
echo "================================================================"
echo " 结果：$pass 通过 / $fail 失败"
echo "================================================================"
[ "$fail" -eq 0 ] || exit 1
exit 0
