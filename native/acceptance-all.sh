#!/usr/bin/env bash
# ============================================================================
#  原生侧 —— 全量验收总入口（N1 注入 + N2 排版）
# ============================================================================
#  一次跑完所有套，任何一套失败就整体失败。
#
#  N1（注入链路）：
#    · acceptance-n1.sh           注入本体 28 项（正例 x86/x64 + 各负例退出码）
#    · acceptance-n1-uninstall.sh 注入→卸载端到端（断言日志顺序 + 卸载后进程存活）
#    · acceptance-n1-watchdog.sh  注入器被强杀 → 目标必须被立刻恢复（含**阴性对照**）
#    · acceptance-n1-profile.sh   profile 特性：largeAddressAware / makeLaunchBat / envAppend
#
#  N2（排版回填）：
#    · acceptance-n2.sh           文本度量 / 折行不溢出 / 字号自适应 / 缺字兜底 / 全部还原
#
#  ⚠️ 必须**按顺序**跑、且每套自己清场：它们都要独占 toygame.exe 进程，
#     并发跑会互相把对方的目标进程杀掉，得到一堆假失败。
#
#  用法：cd native && node build.mjs && bash acceptance-all.sh
# ============================================================================
set -u

NATIVE_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$NATIVE_DIR" || exit 1

TOTAL_FAIL=0
declare -a SUMMARY

# 过滤掉宿主 shell shim 的噪声（每次调用都会打两行与测试无关的报错）
NOISE='shell-runtime-bash-env\|dirname: command not found\|cd: null directory'

run_suite() {   # $1 = 说明；其余 = 脚本名 + 传给它的参数
    local desc="$1"; shift
    echo ""
    echo "############################################################"
    echo "#  $desc"
    echo "#  命令：bash $*"
    echo "############################################################"

    # ★ 不能写成 `bash ... | grep -v ...` 然后看 $? ——
    #   管道的退出码是**最后一个命令**（grep）的，不是 bash 的。
    #   这样哪怕整套验收失败，grep 找到内容就返回 0，汇总里会显示"通过"。
    #   （实测踩到：看门狗那组有一条失败，汇总却报"通过"。）
    #   正确做法：先跑到文件、立刻取 $?，再对文件做过滤输出。
    local out; out="$(mktemp)"
    bash "$NATIVE_DIR/$1" "${@:2}" > "$out" 2>&1
    local rc=$?
    grep -v "$NOISE" "$out"
    rm -f "$out"

    if [ "$rc" -eq 0 ]; then
        SUMMARY+=("通过    $desc")
    else
        SUMMARY+=("失败    $desc  (退出码 $rc)")
        TOTAL_FAIL=$((TOTAL_FAIL + 1))
    fi
}

echo "================================================================"
echo " 原生侧全量验收（N1 注入 + N2 排版）"
echo "================================================================"

run_suite "N1-1 注入本体（正例 x86/x64 + 负例退出码）"        acceptance-n1.sh
run_suite "N1-2 注入→卸载端到端（x64）"                       acceptance-n1-uninstall.sh x64
run_suite "N1-3 注入→卸载端到端（x86）"                       acceptance-n1-uninstall.sh x86
run_suite "N1-4 看门狗（x64，含阴性对照）"                     acceptance-n1-watchdog.sh x64
run_suite "N1-5 看门狗（x86，含阴性对照）"                     acceptance-n1-watchdog.sh x86
run_suite "N1-6 profile 特性（largeAddressAware/makeLaunchBat/envAppend）" acceptance-n1-profile.sh x86
run_suite "N2-1 排版回填（x86）"                              acceptance-n2.sh x86
run_suite "N2-2 排版回填（x64）"                              acceptance-n2.sh x64

echo ""
echo "============================================================"
echo " 全量验收汇总"
echo "============================================================"
for line in "${SUMMARY[@]}"; do echo "  $line"; done
echo "------------------------------------------------------------"
if [ "$TOTAL_FAIL" -eq 0 ]; then
    echo " 全部通过（8 组）"
else
    echo " 有 $TOTAL_FAIL 组失败"
fi
echo "============================================================"
[ "$TOTAL_FAIL" -eq 0 ] || exit 1
exit 0
