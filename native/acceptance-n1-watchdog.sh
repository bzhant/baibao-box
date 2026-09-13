#!/usr/bin/env bash
# ============================================================================
#  验收第 5 条：注入过程中途 kill 掉注入器，目标进程不能变成僵尸或崩溃
# ============================================================================
#
#  为什么单独一个脚本：这条**没法**靠"起注入器 → 马上 taskkill"来验。
#  注入器真正挂着目标的窗口只有微秒级，外部脚本睡多久都撞不上；
#  撞不上时测到的其实是"注入成功的正常路径"，不能证明看门狗有用。
#
#  所以注入器自带 `--watchdog-test`，把那个瞬间**确定性地**造出来：
#    自测进程用 CREATE_SUSPENDED 启动目标（= "改了 EIP 还没 Resume"的状态）
#    → 拉起真看门狗（盯住自己）→ TerminateProcess 自杀（不给收尾机会）。
#  看门狗若正常，会在注入器消失那一刻发现"注入器没了 + 目标还挂着"并代为 Resume。
#
#  ★ 关键是怎么**判定**看门狗真的干活了。四个证据：
#
#    ① 目标进程还活着             —— 弱：挂着的进程也在 tasklist 里，
#                                   这条只能排除"崩了/被杀"
#    ② 目标主线程挂起计数 = 0      —— 强：说明确实被 Resume 了
#    ③ 目标写出了自己的启动自述文件 —— 最强：挂着的进程根本跑不到那行代码，
#                                   文件出现 = 目标**真的开始执行**了
#    ④ 看门狗进程自己退出          —— 顺带确认它不留残余
#
#  ①②③ 全过才算通过。只测 ① 会漏掉"看门狗没干活但目标也没崩"的假通过。
#
#  用法：cd native && bash acceptance-n1-watchdog.sh [x86|x64]
# ============================================================================
set -u

ARCH="${1:-x64}"
case "$ARCH" in
    x86) INJ_EXE="bbInject32.exe" ;;
    x64) INJ_EXE="bbInject64.exe" ;;
    *) echo "架构只能是 x86 或 x64"; exit 2 ;;
esac

NATIVE_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$NATIVE_DIR/build/$ARCH"
INJ="$BUILD_DIR/$INJ_EXE"
TOY="$BUILD_DIR/toygame.exe"
REPORT="$BUILD_DIR/toygame.exe.wdtest.txt"
SELFREP="$BUILD_DIR/toygame.exe.selfreport.txt"

if [ ! -f "$INJ" ]; then echo "找不到注入器：$INJ（先跑 node build.mjs）"; exit 2; fi
if [ ! -f "$TOY" ]; then echo "找不到玩具目标：$TOY"; exit 2; fi

# ★ 一律用**绝对路径 + 单斜杠选项**调系统工具。
#   踩过的坑：在 Git Bash 里写 `tasklist //FI "..."`，`//` 会被转换成 `/`，
#   但本宿主环境的 shell runtime shim 会把它**原样**传给 exe（报"无效参数 - '//FI'"），
#   于是过滤条件被忽略、命令静默失败 —— 表现是"进程存活检查永远返回 0"，
#   把一次真实的崩溃误判成"通过"。改用 `/c/Windows/System32/xxx.exe /F /IM` 才稳。
TL='/c/Windows/System32/tasklist.exe'
TK='/c/Windows/System32/taskkill.exe'
kill_toy()  { "$TL" 2>/dev/null | grep -i toygame | awk '{print $2}' | while read -r p; do
                "$TK" /F /PID "$p" >/dev/null 2>&1; done; sleep 0.3; }
kill_pid()  { "$TK" /F /PID "$1" >/dev/null 2>&1; }
alive_toy() { "$TL" 2>/dev/null | grep -ci toygame; }
pid_alive() { "$TL" 2>/dev/null | awk -v p="$1" '$2==p' | grep -q . && echo 1 || echo 0; }

# Git Bash 路径 → Windows 路径（原生程序只认后者；/c/... 会被翻译坏）
w() { cygpath -w "$1"; }

# ★ 用一个"文件指纹"判断某个文件是不是**这一阶段刚被写出来的**。
#   为什么不用"先删掉、再看存不存在"：
#   ① 本宿主环境有 safe-delete 保护，同一轮里删除操作超过一定数量会被**拦截**，
#      于是"删除"静默失败，残留文件把后面的判定全带偏（实测踩到过：
#      阴性对照因为读到了上一套测试留下的自述文件，被误判成"目标被执行了"）
#   ② 就算能删，删除本身也有"删了但没删掉"的模糊状态
#   指纹方案（修改时间 + 大小）不依赖能否删除：只要文件**变了**就说明刚写过。
stamp() {   # $1 = 文件路径；不存在则输出 none
    if [ -f "$1" ]; then
        stat -c '%Y:%s' "$1" 2>/dev/null || echo none
    else
        echo none
    fi
}

pass=0; fail=0
ok()  { echo "  [通过] $1"; pass=$((pass+1)); }
bad() { echo "  [失败] $1"; fail=$((fail+1)); }

echo "================================================================"
echo " 验收第 5 条（$ARCH）：注入器被强杀 -> 目标必须被立刻恢复"
echo "================================================================"

# 清场：结束残留目标进程。
# ★ 这里**故意不删**报告/自述文件 —— 判定改用了"指纹比对"（见 stamp()），
#   已经不需要靠删除来制造"干净起点"，也就不会再被 safe-delete 保护拦到。
kill_toy

# ── 第 0 步：阴性对照 ────────────────────────────────────────────────
#   ★ 这一步比正例更重要。没有它，正例通过也可能是因为**别的什么**
#     把目标恢复了（比如 CREATE_SUSPENDED 的挂起被系统自动解开），
#     那样我们测到的根本不是看门狗。
#   做法：同样的流程，但**不拉看门狗**。这时目标必须一直挂着 ——
#     挂起计数 ≥1、且自述文件没被写出来。两条都成立才说明判定条件有鉴别力。
echo ""
echo "--- 第 0 步：阴性对照（不拉看门狗，目标应当一直挂着）---"
kill_toy
SELFREP_BEFORE="$(stamp "$SELFREP")"
"$INJ" --watchdog-test "$(w "$TOY")" --no-watchdog > "$BUILD_DIR/_wdtest_${ARCH}_neg.out" 2>&1
echo "阴性对照返回码 = $?（自杀取 173，属正常）"

if [ -f "$REPORT" ]; then
    NPID="$(grep -a '^目标 pid' "$REPORT" | grep -o '[0-9]\+' | head -1)"
    NTID="$(grep -a '^目标主线程 tid' "$REPORT" | grep -o '[0-9]\+' | head -1)"
    sleep 1.5
    NOUT="$("$INJ" --probe-suspend "$NPID" "$NTID" 2>&1)"
    echo "    阴性对照挂起计数：$NOUT"
    case "$NOUT" in
        *SUSPEND_COUNT=0*)
            bad "阴性对照下目标竟被恢复（计数 0）—— 判定条件没有鉴别力，正例通过不可信" ;;
        *SUSPEND_COUNT=*)
            ok "阴性对照下目标仍挂着（计数 >=1）—— 证实没人抢救就真的不会恢复" ;;
        *)
            bad "阴性对照挂起计数探测失败：$NOUT" ;;
    esac
    # ★ 断言"自述文件**没有发生变化**"，而不是"不存在" ——
    #   后者会被上一轮测试的残留文件骗到（见 stamp() 的说明）。
    SELFREP_AFTER="$(stamp "$SELFREP")"
    if [ "$SELFREP_AFTER" = "$SELFREP_BEFORE" ]; then
        ok "阴性对照下自述文件没有被写入（指纹未变）—— 证实目标确实从未执行"
    else
        bad "阴性对照下自述文件被写入了（$SELFREP_BEFORE → $SELFREP_AFTER）—— 有别的东西在恢复它"
    fi
    kill_pid "$NPID"
else
    bad "阴性对照没产出报告文件 $REPORT"
fi
sleep 0.5
kill_toy

# ── 第 1 步：正例 ────────────────────────────────────────────────────
echo ""
echo "--- 第 1 步：正例（拉看门狗，目标应当被立刻恢复）---"
SELFREP_BEFORE2="$(stamp "$SELFREP")"
"$INJ" --watchdog-test "$(w "$TOY")" > "$BUILD_DIR/_wdtest_$ARCH.out" 2>&1
SELF_RC=$?
echo "自测进程返回码 = $SELF_RC（自杀时取 0xDEAD 的截断值 173，非 0 属正常）"
if [ -f "$BUILD_DIR/_wdtest_$ARCH.out" ]; then
    sed 's/^/    /' "$BUILD_DIR/_wdtest_$ARCH.out" | head -8
fi

if [ ! -f "$REPORT" ]; then
    bad "自测没产出报告文件 $REPORT —— 自测在拉起看门狗之前就失败了"
    echo
    echo "结果：$pass 通过 / $fail 失败"
    exit 1
fi
echo "--- 自测报告 ---"
sed 's/^/    /' "$REPORT"

PID="$(grep -a '^目标 pid' "$REPORT" | grep -o '[0-9]\+' | head -1)"
TID="$(grep -a '^目标主线程 tid' "$REPORT" | grep -o '[0-9]\+' | head -1)"
WD_PID="$(grep -a '^看门狗 pid' "$REPORT" | grep -o '[0-9]\+' | head -1)"
echo "解析出：目标 pid=$PID tid=$TID 看门狗 pid=$WD_PID"
if [ -z "$PID" ] || [ -z "$TID" ]; then
    bad "报告里没解析出目标 pid/tid，无法继续判定"
    echo
    echo "结果：$pass 通过 / $fail 失败"
    exit 1
fi

# ── 等看门狗干活。它是"注入器一退出就动手"，正常 <200ms ──
sleep 3

# ── 证据 ①：目标还活着 ──
if [ "$(pid_alive "$PID")" = "1" ]; then
    ok "目标进程 pid=$PID 仍然存活（没崩、没变僵尸）"
else
    bad "目标进程 pid=$PID 已消失"
fi

# ── 证据 ②：主线程挂起计数归 0 ──
SUSP_OUT="$("$INJ" --probe-suspend "$PID" "$TID" 2>&1)"
PROBE_RC=$?
echo "    挂起计数探测：$SUSP_OUT (rc=$PROBE_RC)"
case "$SUSP_OUT" in
    *SUSPEND_COUNT=0*)
        ok "目标主线程挂起计数 = 0（看门狗确实代为恢复了执行）" ;;
    PROBE_ERROR*)
        bad "挂起计数探测失败：$SUSP_OUT（不能当作通过）" ;;
    *)
        bad "目标主线程仍被挂起：$SUSP_OUT" ;;
esac

# ── 证据 ③：目标写出了启动自述（= 真的跑起来了）──
#     同样用指纹比对，而不是"文件存在" —— 免得被残留文件骗到。
SELFREP_AFTER2="$(stamp "$SELFREP")"
if [ "$SELFREP_AFTER2" != "$SELFREP_BEFORE2" ]; then
    ok "目标写出了启动自述文件（指纹 $SELFREP_BEFORE2 → $SELFREP_AFTER2）—— 挂着的进程跑不到那行代码，确实被恢复了"
    grep -a '当前目录纯ASCII' "$SELFREP" | sed 's/^/      /'
else
    bad "自述文件没有被写入（指纹仍是 $SELFREP_AFTER2）—— 说明它被挂住后**从未真正执行**"
fi

# ── 证据 ④：看门狗进程自己已收工退出 ──
if [ -n "$WD_PID" ]; then
    if [ "$(pid_alive "$WD_PID")" = "0" ]; then
        ok "看门狗进程 pid=$WD_PID 已自行退出（干完活不留残余进程）"
    else
        echo "  [注意] 看门狗进程 pid=$WD_PID 仍在运行（可能还在等兜底超时）"
    fi
fi

# 清理
kill_toy

echo
echo "================================================================"
echo " 结果：$pass 通过 / $fail 失败"
echo "================================================================"
[ "$fail" -eq 0 ] || exit 1
exit 0
