#!/usr/bin/env bash
# ============================================================================
# N1 注入器验收（Bash 版）
#
# 为什么全部塞进一个脚本一次跑完：
#   本机的命令执行环境在命令结束时回收整棵进程树，所以"先注入、再检查"
#   这种两段式测试会看到假象（目标进程被环境带走，看起来像注入后崩了）。
#   本脚本在**同一次执行内**完成 注入 → 观察 → 清理。
#
# 两个踩过的测试脚本自身的坑（写在这里免得下次再踩）：
#   · hook DLL 的日志文件被**活着的目标进程**一直持有（log.h 里不关文件），
#     所以必须先 kill 目标再读日志，否则 cat 报 "Device or resource busy"。
#   · 给 exe 传路径时若用 Git Bash 的 /c/... 形式，经 argv 传给原生程序会被
#     翻译坏（实测变成 C:\c\Users\...）。统一用 `cygpath -w` 转成 Windows 路径。
# ============================================================================
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NATIVE="$ROOT/native"
PASS=0
FAIL=0
OUT="$NATIVE/_acceptance_out.txt"
: > "$OUT"

say()  { echo "$*" >> "$OUT"; }
pass() { PASS=$((PASS+1)); say "  [通过] $1  $2"; }
fail() { FAIL=$((FAIL+1)); say "  [失败] $1  $2"; }
check(){ if [ "$2" = "1" ]; then pass "$1" "$3"; else fail "$1" "$3"; fi; }

TL='/c/Windows/System32/tasklist.exe'
TK='/c/Windows/System32/taskkill.exe'
kill_toy() { "$TL" 2>/dev/null | grep -i toygame | awk '{print $2}' | while read -r p; do
               "$TK" /F /PID "$p" >/dev/null 2>&1; done; sleep 0.3; }
alive_toy() { "$TL" 2>/dev/null | grep -ci toygame; }
# Git Bash 路径 → Windows 路径（原生程序只认后者）
win() { cygpath -w "$1"; }

say "################ N1 注入器验收 ################"

# ── 正例：x86 / x64 ────────────────────────────────────────────────────────
for ARCH in x86 x64; do
  case $ARCH in x86) INJ=bbInject32.exe;; x64) INJ=bbInject64.exe;; esac
  WORK="$NATIVE/build/$ARCH"
  say ""
  say "=== 用例：$ARCH 正例注入 ==="
  kill_toy
  rm -f "$WORK/bbinject.log" "$WORK/toyHook.log" "$WORK/bbinject-trace.log"

  JSON="$(cd "$WORK" && ./$INJ --exe toygame.exe --dll toyHook.dll --json 2>&1)"
  CODE=$?
  check "$ARCH 注入器退出码 0" "$([ "$CODE" = "0" ] && echo 1 || echo 0)" "exit=$CODE"
  check "$ARCH JSON ok=true" "$(echo "$JSON" | grep -q '"ok":true' && echo 1 || echo 0)" ""

  # 立刻查进程（同一进程树内）—— 这是"注入后目标是否存活"的硬证据。
  # 注：tasklist 的列宽随架构/会话略有差异，用 "toygame.exe" 全名匹配更稳。
  sleep 0.6
  N="$(alive_toy)"
  check "$ARCH 目标进程注入后存活" "$([ "$N" -ge 1 ] && echo 1 || echo 0)" "匹配 $N 个"

  # 存活是硬指标；顺手确认它不是在"僵尸态"——还能被杀掉说明是个正常进程
  # ★ 必须先 kill 目标进程再读 hook 日志：日志文件被它持有，活锁着读不到
  kill_toy
  if [ -f "$WORK/toyHook.log" ]; then
    H="$(cat "$WORK/toyHook.log" 2>/dev/null)"
    say "  toyHook.log 内容：$(echo "$H" | tr '\n' '|')"
    check "$ARCH toyHook.log 有 Install 开始"  "$(echo "$H" | grep -q 'Install 开始' && echo 1 || echo 0)" ""
    check "$ARCH toyHook.log 有 Install 完成"  "$(echo "$H" | grep -q 'Install 完成' && echo 1 || echo 0)" ""
    check "$ARCH 两个 API hook 都装上" \
          "$(echo "$H" | grep -q 'MultiByteToWideChar' && echo "$H" | grep -q 'WideCharToMultiByte' && echo 1 || echo 0)" ""
  else
    fail "$ARCH toyHook.log 存在" "文件没生成"
  fi
done

WORK="$NATIVE/build/x86"
X64W="$(win "$NATIVE/build/x64")"

# ── 负例 1：非 PE 当目标 ───────────────────────────────────────────────────
say ""
say "=== 用例：负例 — 非 PE 文件当目标 ==="
printf 'this is not a PE file at all' > "$WORK/_notpe_target.bin"
JSON="$(cd "$WORK" && ./bbInject32.exe --exe _notpe_target.bin --dll toyHook.dll --json 2>&1)"
CODE=$?
say "  输出：$JSON"
check "非 PE 目标 → 退出码非 0" "$([ "$CODE" != "0" ] && echo 1 || echo 0)" "exit=$CODE"
check "非 PE 目标 → 退出码 11" "$([ "$CODE" = "11" ] && echo 1 || echo 0)" "exit=$CODE"
check "非 PE 目标 → 有人话错误" "$(echo "$JSON" | grep -q '"errors":\["' && echo 1 || echo 0)" ""
rm -f "$WORK/_notpe_target.bin"

# ── 负例 2：非 PE 当 DLL ───────────────────────────────────────────────────
say ""
say "=== 用例：负例 — 非 PE 文件当 hook DLL ==="
printf 'not a dll either' > "$WORK/_notpe_dll.bin"
JSON="$(cd "$WORK" && ./bbInject32.exe --exe toygame.exe --dll _notpe_dll.bin --json 2>&1)"
CODE=$?
say "  输出：$JSON"
check "非 PE DLL → 退出码非 0" "$([ "$CODE" != "0" ] && echo 1 || echo 0)" "exit=$CODE"
check "非 PE DLL → 退出码 12" "$([ "$CODE" = "12" ] && echo 1 || echo 0)" "exit=$CODE"
rm -f "$WORK/_notpe_dll.bin"

# ── 负例 3：位数不匹配 ─────────────────────────────────────────────────────
say ""
say "=== 用例：负例 — 位数不匹配 ==="
JSON="$(cd "$WORK" && ./bbInject32.exe --exe "$(win "$NATIVE/build/x64/toygame.exe")" --dll toyHook.dll --json 2>&1)"
CODE=$?
say "  (32 位注入器 + 64 位目标) 输出：$JSON"
check "32 位注入器 + 64 位目标 → 退出码 13" "$([ "$CODE" = "13" ] && echo 1 || echo 0)" "exit=$CODE"
check "位数不匹配 → 错误里提到位数" "$(echo "$JSON" | grep -qE '32|64' && echo 1 || echo 0)" ""

JSON="$(cd "$WORK" && ./bbInject32.exe --exe toygame.exe --dll "$(win "$NATIVE/build/x64/toyHook.dll")" --json 2>&1)"
CODE=$?
say "  (32 位目标 + 64 位 DLL) 输出：$JSON"
check "32 位目标 + 64 位 DLL → 退出码 13" "$([ "$CODE" = "13" ] && echo 1 || echo 0)" "exit=$CODE"

# ── 负例 4：DLL 没有 Install 导出 ─────────────────────────────────────────
say ""
say "=== 用例：负例 — DLL 没有 Install 导出 ==="
# noexport.dll 是**构建产物**（native/tools/noexport.cpp），不在这里现编 ——
# 验收脚本要能在普通 shell 里跑，不该依赖 MSVC 环境变量。
if [ -f "$WORK/noexport.dll" ]; then
  JSON="$(cd "$WORK" && ./bbInject32.exe --exe toygame.exe --dll noexport.dll --json 2>&1)"
  CODE=$?
  say "  输出：$JSON"
  check "无 Install 导出 → 退出码非 0" "$([ "$CODE" != "0" ] && echo 1 || echo 0)" "exit=$CODE"
  check "无 Install 导出 → 退出码 14" "$([ "$CODE" = "14" ] && echo 1 || echo 0)" "exit=$CODE"
  check "无 Install 导出 → 提到导出名" "$(echo "$JSON" | grep -qE 'Install|导出' && echo 1 || echo 0)" ""
  check "无 Install 导出 → 报错时列出 DLL 实际导出" \
        "$(echo "$JSON" | grep -q 'SomethingElse\|Uninstall' && echo 1 || echo 0)" ""
else
  fail "noexport.dll 存在" "构建产物缺失（先跑 node native/build.mjs）"
fi

# ── 负例 5：目标不存在 ─────────────────────────────────────────────────────
say ""
say "=== 用例：负例 — 目标程序不存在 ==="
JSON="$(cd "$WORK" && ./bbInject32.exe --exe _no_such_game.exe --dll toyHook.dll --json 2>&1)"
CODE=$?
say "  输出：$JSON"
check "目标不存在 → 退出码非 0" "$([ "$CODE" != "0" ] && echo 1 || echo 0)" "exit=$CODE"
check "目标不存在 → 退出码 11" "$([ "$CODE" = "11" ] && echo 1 || echo 0)" "exit=$CODE"

# ── 负例 6：参数缺失 ───────────────────────────────────────────────────────
say ""
say "=== 用例：负例 — 缺少必需参数 ==="
JSON="$(cd "$WORK" && ./bbInject32.exe --exe toygame.exe --json 2>&1)"
CODE=$?
say "  输出：$JSON"
check "只给 --exe 不给 --dll → 退出码非 0" "$([ "$CODE" != "0" ] && echo 1 || echo 0)" "exit=$CODE"
check "只给 --exe 不给 --dll → 退出码 10（kBadArgs）" "$([ "$CODE" = "10" ] && echo 1 || echo 0)" "exit=$CODE"

# ── 总结 ───────────────────────────────────────────────────────────────────
say ""
say "################ 总结 ################"
say "  通过 $PASS 项，失败 $FAIL 项"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
