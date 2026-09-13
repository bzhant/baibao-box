#!/usr/bin/env bash
# ============================================================================
#  N1 §3.3 特性验收：largeAddressAware + makeLaunchBat
# ============================================================================
#  这两个特性靠 profile.json 里的开关触发，所以要**走 --profile 路径**测试
#  （命令行没有对应开关 —— 它们本来就是"跟游戏绑定的配置"）。
#
#  largeAddressAware 会**改目标 exe 文件本身**，所以要重点验证三件事：
#    ① 改之前真的建了 .bak 备份
#    ② PE 头 Characteristics 的 0x0020 位真的置上了
#    ③ 第二次运行**不会**把已改过的 exe 当原始版本覆盖掉 .bak
#      （这条最容易写错：无脑 CopyFileW 覆盖备份 = 再也回不去原始版本）
#
#  makeLaunchBat 验证：.bat 生成、里面有 chcp 65001、有工作目录切换、
#    并且带 UTF-8 BOM（cmd 才会按 UTF-8 解析）。
#
#  ★ 路径处理（踩坑记录）：本宿主环境的 shell shim 会做路径转换，
#    把 Windows 路径当参数传给 node / 原生程序会变成 `C:\c\Users\...`（多个 \c）。
#    所以本脚本**一律先 cd 到工作目录，只传相对文件名** ——
#    相对名不含盘符，shim 无从下手，任何工具都能正确解析。
#
#  用法：cd native && bash acceptance-n1-profile.sh [x86|x64]
# ============================================================================
set -u

ARCH="${1:-x86}"          # largeAddressAware 只对 32 位有意义，默认 x86
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

pass=0; fail=0
ok()  { echo "  [通过] $1"; pass=$((pass+1)); }
bad() { echo "  [失败] $1"; fail=$((fail+1)); }

echo "================================================================"
echo " §3.3 特性验收（$ARCH）：largeAddressAware + makeLaunchBat"
echo "================================================================"

kill_toy

# ── 准备：确保测试前是一份"没打过标志、没有 .bak"的干净 exe ──
if [ -f "$WORK/toygame.exe.bak" ]; then
    cp -f "$WORK/toygame.exe.bak" "$WORK/toygame.exe"
    rm -f "$WORK/toygame.exe.bak"
    echo "（已从上次残留的 .bak 还原 toygame.exe）"
fi
rm -f "$WORK"/toygame_注入启动.bat "$WORK/_test_profile.json" "$WORK/toygame.exe.selfreport.txt"

# ── 用 node 生成 profile（在 $WORK 里跑，只给相对文件名）──
(
  cd "$WORK" || exit 1
  node -e '
const fs = require("fs");
const p = {
  injectAtOEP: true,
  makeLaunchBat: true,
  largeAddressAware: true,
  constArgs: {
    gameExe: "toygame.exe",
    dllPath: "toyHook.dll",
    is64Bit: process.argv[1] === "x64",
    needEnglishPath: false,
    envAppend: { BB_TEST_ENV: "hello-from-profile" }
  }
};
fs.writeFileSync("_test_profile.json", JSON.stringify(p, null, 2), "utf8");
' "$ARCH"
)
if [ -f "$WORK/_test_profile.json" ]; then
    ok "已生成 profile：_test_profile.json"
else
    bad "生成 profile 失败"
    echo
    echo "结果：$pass 通过 / $fail 失败"
    exit 1
fi

# ── 读 exe 的 Characteristics（用 node 读 PE 头，在 $WORK 里跑相对名）──
read_chars() {   # $1 = 相对 $WORK 的文件名
    ( cd "$WORK" && node -e '
    const fs = require("fs");
    const b = fs.readFileSync(process.argv[1]);
    const e = b.readUInt32LE(0x3C);
    process.stdout.write("0x" + b.readUInt16LE(e + 4 + 18).toString(16));
    ' "$1" )
}

BEFORE="$(read_chars toygame.exe)"
echo "改动前 Characteristics = $BEFORE"
if [ -z "$BEFORE" ]; then
    bad "读不出改动前的 Characteristics，测试无法判定"
    echo
    echo "结果：$pass 通过 / $fail 失败"
    exit 1
fi

# ── 第一次运行：应当打标志 + 建备份 + 生成 .bat ──
echo "--- 第 1 次运行（--profile）---"
OUT1="$(cd "$WORK" && ./$INJ_EXE --profile _test_profile.json --timeout 15000 --json 2>&1)"
CODE1=$?
echo "退出码 = $CODE1"
if [ "$CODE1" = "0" ]; then ok "带 profile 注入成功"; else bad "注入失败：$OUT1"; fi

AFTER="$(read_chars toygame.exe)"
echo "改动后 Characteristics = $AFTER"

# ① 备份
if [ -f "$WORK/toygame.exe.bak" ]; then
    ok "已生成备份 toygame.exe.bak"
    BAKC="$(read_chars toygame.exe.bak)"
    if [ "$BAKC" = "$BEFORE" ]; then
        ok "备份里存的是**改动前**的版本（$BAKC = 原值）"
    else
        bad "备份内容不对：$BAKC，期望 $BEFORE"
    fi
else
    bad "没有生成备份 toygame.exe.bak"
fi

# ②b envAppend：玩具启动时会把自己的环境写进自述文件，读它来验证
#     ★ 这条是 envAppend 唯一的**端到端**证据：注入器说"我追加了"不算数，
#       得看目标进程里真的读得到这个变量才算。
REPORT="$WORK/toygame.exe.selfreport.txt"
if [ -f "$REPORT" ]; then
    if grep -aq 'BB_TEST_ENV.*已设置' "$REPORT"; then
        ok "envAppend 生效：目标进程内读得到 BB_TEST_ENV（自查自述文件确认）"
    else
        bad "envAppend 没生效：目标进程内读不到 BB_TEST_ENV"
        grep -a 'BB_TEST_ENV' "$REPORT" | sed 's/^/      /'
    fi
else
    bad "目标没写出启动自述文件（$REPORT），无法验证 envAppend"
fi

# ② 标志位（0x0020 置上）
if [ "$((AFTER & 0x20))" != "0" ]; then
    ok "largeAddressAware 已置位（Characteristics $BEFORE → $AFTER，含 0x20）"
else
    bad "largeAddressAware 没置上（Characteristics 仍是 $AFTER）"
fi

# ③ .bat
BAT="$(ls "$WORK"/*_注入启动.bat 2>/dev/null | head -1)"
if [ -n "$BAT" ]; then
    ok "已生成启动脚本：$(basename "$BAT")"
    B="$(cat "$BAT")"
    if echo "$B" | grep -q 'chcp 65001'; then
        ok "脚本含 chcp 65001（中文不乱码的关键）"
    else
        bad "脚本里没有 chcp 65001"
    fi
    if echo "$B" | grep -q 'cd /d'; then
        ok "脚本含 cd /d（跨盘符切到游戏目录）"
    else
        bad "脚本里没有 cd /d"
    fi
    if echo "$B" | grep -qi 'toygame.exe\|_test_profile.json'; then
        ok "脚本指向正确的目标/配置"
    else
        bad "脚本里看不出指向哪个目标"
    fi
    if head -c 3 "$BAT" | od -An -tx1 | grep -qi 'ef bb bf'; then
        ok "脚本以 UTF-8 BOM 开头（cmd 才会按 UTF-8 解析）"
    else
        bad "脚本没有 UTF-8 BOM"
    fi
else
    bad "没有生成启动脚本"
fi

# ── 第二次运行：.bak **不能**被覆盖 ──
echo "--- 第 2 次运行（验证备份不会被覆盖）---"
kill_toy
sleep 0.5
OUT2="$(cd "$WORK" && ./$INJ_EXE --profile _test_profile.json --timeout 15000 --json 2>&1)"
CODE2=$?
BAKC2="$(read_chars toygame.exe.bak)"
if [ "$BAKC2" = "$BEFORE" ]; then
    ok "第 2 次运行后备份仍是**原始版本**（$BAKC2），没有被已改过的 exe 覆盖"
else
    bad "第 2 次运行把备份覆盖坏了：$BAKC2，期望 $BEFORE —— 这样就再也回不去原始版本了"
fi
if echo "$OUT2" | grep -q '本来就带\|无需修改'; then
    ok "第 2 次运行正确识别出「标志已存在，无需修改」"
else
    echo "  [注意] 第 2 次运行没明确说「已存在」：$(echo "$OUT2" | head -c 220)"
fi

kill_toy

# ── 还原现场 ──
echo "--- 还原现场 ---"
if [ -f "$WORK/toygame.exe.bak" ]; then
    cp -f "$WORK/toygame.exe.bak" "$WORK/toygame.exe"
    rm -f "$WORK/toygame.exe.bak"
fi
rm -f "$WORK"/toygame_注入启动.bat "$WORK/_test_profile.json"
REST="$(read_chars toygame.exe)"
if [ "$REST" = "$BEFORE" ]; then
    ok "已还原 toygame.exe（Characteristics 回到 $REST）"
else
    bad "还原失败：现在是 $REST，期望 $BEFORE"
fi

echo
echo "================================================================"
echo " 结果：$pass 通过 / $fail 失败"
echo "================================================================"
[ "$fail" -eq 0 ] || exit 1
exit 0
