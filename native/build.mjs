/**
 * 原生侧构建驱动（不依赖 cmd.exe / MSBuild / CMake）。
 *
 * 为什么这么写：受限环境里 cmd.exe 会被拦、bash 缺 shell 工具，
 * 直接给 cl.exe 拼好 INCLUDE/LIB/PATH 最省事，也少一层工程文件。
 *
 * 构建顺序（有依赖，不能乱）：
 *   1. shellcode_stub.cpp → .obj → 抽取成 shellcode_<arch>.h
 *      （注入器 #include 它，所以**必须先做**）
 *   2. toygame.exe
 *   3. toyHook.dll
 *   4. bbInject32/64.exe（按架构，文件名带位数后缀便于用户区分）
 *
 * 用法：node native/build.mjs [x86|x64|both]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractShellcode, emitHeader } from './shellcode/extract.mjs';

const NATIVE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(NATIVE, '..');
const MINHOOK = path.join(ROOT, 'libs', 'minhook');

const BUILD_TOOLS = process.env.BB_BUILD_TOOLS ?? 'D:\\BuildTools';
const SDK_ROOT = 'C:\\Program Files (x86)\\Windows Kits\\10';

function newestDir(base) {
  const vs = fs.readdirSync(base).filter((d) => fs.statSync(path.join(base, d)).isDirectory());
  if (!vs.length) throw new Error(`目录为空: ${base}`);
  return path.join(base, vs.sort().at(-1));
}

const MSVC = newestDir(path.join(BUILD_TOOLS, 'VC', 'Tools', 'MSVC'));
const MSVC_VER = path.basename(MSVC);
const SDK_VER = fs
  .readdirSync(path.join(SDK_ROOT, 'Include'))
  .filter((d) => /^10\./.test(d))
  .sort()
  .at(-1);

console.log(`MSVC   : ${MSVC_VER}`);
console.log(`SDK    : ${SDK_VER}`);
console.log(`MinHook: ${MINHOOK}`);

/** 给某个目标架构拼出编译环境 */
function envFor(arch) {
  const msvcBin = path.join(MSVC, 'bin', 'Hostx64', arch);
  const inc = [
    path.join(MSVC, 'include'),
    path.join(SDK_ROOT, 'Include', SDK_VER, 'ucrt'),
    path.join(SDK_ROOT, 'Include', SDK_VER, 'um'),
    path.join(SDK_ROOT, 'Include', SDK_VER, 'shared'),
    path.join(SDK_ROOT, 'Include', SDK_VER, 'winrt'),
  ];
  const lib = [
    path.join(MSVC, 'lib', arch),
    path.join(SDK_ROOT, 'Lib', SDK_VER, 'ucrt', arch),
    path.join(SDK_ROOT, 'Lib', SDK_VER, 'um', arch),
  ];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 免得干扰子进程
  delete env.NODE_OPTIONS;
  env.PATH = `${msvcBin};${env.PATH}`;
  env.INCLUDE = inc.join(';');
  env.LIB = lib.join(';');
  return { env, cl: path.join(msvcBin, 'cl.exe') };
}

const MINHOOK_SRC = [
  'src/buffer.c',
  'src/hook.c',
  'src/trampoline.c',
  'src/hde/hde32.c',
  'src/hde/hde64.c',
].map((p) => path.join(MINHOOK, p));

function run(label, cl, args, env) {
  console.log(`\n--- ${label} ---`);
  const r = spawnSync(cl, args, { env, encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (out) console.log(out);
  if (r.status !== 0) {
    console.error(`[失败] ${label}（退出码 ${r.status}）`);
    return false;
  }
  return true;
}

function buildArch(arch) {
  const { env, cl } = envFor(arch);
  const out = path.join(NATIVE, 'build', arch);
  fs.mkdirSync(out, { recursive: true });

  console.log(`\n============================================================`);
  console.log(` 构建 ${arch}`);
  console.log(`============================================================`);

  const common = [
    '/nologo', '/W4', '/O2', '/MT',
    // 项目宪法指定 C++17（MSVC 默认还是 C++14，不加这个 if-init 之类的语法不过）
    '/std:c++17',
    // 源码是 UTF-8（注释含中文）。MSVC 默认按系统代码页(936/GBK)读源码，
    // 会把 UTF-8 的中文注释打乱、导致一连串莫名其妙的语法错误。
    // 必须显式声明源码与执行字符集都是 UTF-8。
    '/utf-8',
    '/D_CRT_SECURE_NO_WARNINGS', '/DUNICODE', '/D_UNICODE',
    `/I${path.join(MINHOOK, 'include')}`,
  ];

  // ────────────────────────────────────────────────────────────────────────
  // 1) shellcode：编译 → 抽取成头文件
  //
  // ★ 这一步必须最先做：注入器 #include 生成出来的 shellcode_<arch>.h。
  //
  // 编译参数刻意极端保守 —— shellcode 要在**别人的进程、没有 CRT** 的环境里跑：
  //   /GS-   去掉 __security_check_cookie（那是个 CRT 调用，目标进程里没有）
  //   /GR-   去掉 RTTI（会引入 .rdata 里的类型描述符）
  //   /EHs-c- 去掉 C++ 异常表（.xdata 里的表会被搬错位置）
  //   /Gy-   关掉函数级 COMDAT，让每个函数独占一个 .text$mn 节（便于精确抽取）
  //   /Zl    不写默认库引用
  //   /c     只编译不链接（我们不链接任何库）
  // ────────────────────────────────────────────────────────────────────────
  const scObj = path.join(out, 'shellcode_stub.obj');
  const okSc = run(
    `编译 shellcode 骨架 (${arch})`,
    cl,
    [
      '/nologo', '/c', '/O2', '/GS-', '/GR-', '/EHs-c-', '/Gy-', '/Zl', '/utf-8',
      '/D_CRT_SECURE_NO_WARNINGS', '/DUNICODE', '/D_UNICODE',
      `/I${path.join(NATIVE, 'common')}`,
      `/I${path.join(NATIVE, 'shellcode')}`,
      `/Fo:${scObj}`,
      path.join(NATIVE, 'shellcode', 'shellcode_stub.cpp'),
    ],
    env,
  );

  let shellcodeSummary = '';
  if (okSc) {
    try {
      const info = extractShellcode(scObj, ['ShellcodeMain'], { arch });
      fs.writeFileSync(
        path.join(NATIVE, 'shellcode', `shellcode_${arch}.h`),
        emitHeader(info),
        'utf8',
      );
      shellcodeSummary =
        `  镜像 ${info.bytes.length} 字节（代码 ${info.codeSize}）· ` +
        `入口 @0x${info.entryOffset.toString(16)} · ` +
        `rel32 已修 ${info.rel32Applied} · 运行时修正 ${info.runtimeFixes.length}`;
      console.log(`  ✓ shellcode 已抽取：${shellcodeSummary.trim()}`);
      console.log(
        `    rel32 相对引用：${info.rel32Applied} 处已就地填好（构建期完成，注入器不参与）`,
      );
      if (info.runtimeFixes.length) {
        console.log(`    运行时修正（注入器按目标基址/外部值重填）：`);
        for (const f of info.runtimeFixes) {
          const desc = f.kind === 'oepResume'
            ? 'ctx.oepResume（OEP 跳板目标）'
            : `镜像 0x${f.targetImageOffset.toString(16)}  ${f.what ?? ''}`;
          console.log(`      @0x${f.at.toString(16)}  ${f.size} 字节 → ${desc}`);
        }
      }
    } catch (err) {
      console.error(`  ✗ shellcode 抽取失败：${err.message}`);
      return false;
    }
  }

  const okToy = run(
    `编译玩具目标 toygame.exe (${arch})`,
    cl,
    [
      ...common,
      `/Fe:${path.join(out, 'toygame.exe')}`,
      path.join(NATIVE, 'toygame', 'toygame.cpp'),
      '/link', '/SUBSYSTEM:WINDOWS', 'user32.lib', 'gdi32.lib',
    ],
    env,
  );

  // 导出名处理：x64 的 WINAPI 无名字修饰，直接就是 Install/Uninstall；
  // x86 的 stdcall 会变成 _Install@4。我们**同时**给 .def 做别名映射，
  // 但注入器**不依赖**它成功 —— 实测 .def 别名在 x86 上不可靠，
  // 所以注入器内置了多候选名（见 injector.cpp 的 candidates）。
  const defArgs =
    arch === 'x86' ? [`/DEF:${path.join(NATIVE, 'hooks', 'toy', 'toyHook.x86.def')}`] : [];

  const okHook = run(
    `编译编码 hook toyHook.dll (${arch})`,
    cl,
    [
      ...common,
      '/LD', '/EHsc',
      `/Fe:${path.join(out, 'toyHook.dll')}`,
      path.join(NATIVE, 'hooks', 'toy', 'toyHook.cpp'),
      ...MINHOOK_SRC,
      '/link', ...defArgs,
      // gdi32   ：N2 排版回填要用（文本度量、GetGlyphOutlineW、CreateFontIndirect…）
      // advapi32：读字体注册表（ResolveFontFilePath → RegOpenKeyExW）
      'user32.lib', 'ws2_32.lib', 'gdi32.lib', 'advapi32.lib',
    ],
    env,
  );

  // ────────────────────────────────────────────────────────────────────────
  // 4) 注入器：输出名带位数后缀（bbInject32.exe / bbInject64.exe）
  //    这样用户一眼就知道该用哪个 —— 位数不匹配是这类工具最常见的使用错误。
  //    但**文件名本身也是逻辑**：看门狗用 GetModuleFileNameW 拿到自己的路径
  //    再拉起自己，所以改名不影响功能。
  // ────────────────────────────────────────────────────────────────────────
  const injectName = arch === 'x86' ? 'bbInject32.exe' : 'bbInject64.exe';
  const injectOut = path.join(out, injectName);
  const okInject = run(
    `编译注入器 ${injectName} (${arch})`,
    cl,
    [
      ...common,
      // 控制台子系统：注入器的输出（人话错误 + --json）要能被宿主 / 用户抓到
      `/Fe:${injectOut}`,
      path.join(NATIVE, 'injector', 'injector.cpp'),
      '/link', '/SUBSYSTEM:CONSOLE',
    ],
    env,
  );

  // ────────────────────────────────────────────────────────────────────────
  // 4b) 负例用的"DLL 位数对但没有 Install 导出"
  //     它是**验收测试的输入**，不是产品功能的一部分，但必须跟着构建一起产出：
  //     验收脚本（acceptance-n1.sh）不该自己去调 cl —— 那需要完整的 MSVC 环境，
  //     而验收脚本是要能在普通 shell 里跑起来的。做成构建产物最省事。
  // ────────────────────────────────────────────────────────────────────────
  const okNoExp = run(
    `编译负例 DLL noexport.dll (${arch})`,
    cl,
    [
      ...common,
      '/LD',
      `/Fe:${path.join(out, 'noexport.dll')}`,
      path.join(NATIVE, 'tools', 'noexport.cpp'),
      '/link', '/NOENTRY', '/DLL',
    ],
    env,
  );

  // ────────────────────────────────────────────────────────────────────────
  // 4c) 排版自检（N2）：无 GUI 的控制台程序
  //     排版这块的判断标准（行宽有没有超、某个字有没有字形、折行位置对不对）
  //     全都是**可自动断言的数值**，做成控制台自检就能进验收脚本，
  //     而不是靠人盯着窗口截图看。
  //     需要 gdi32（文本度量）与 user32（部分字符集常量）。
  // ────────────────────────────────────────────────────────────────────────
  const okMeasure = run(
    `编译排版自检 measure_selftest.exe (${arch})`,
    cl,
    [
      ...common,
      `/Fe:${path.join(out, 'measure_selftest.exe')}`,
      path.join(NATIVE, 'tools', 'measure_selftest.cpp'),
      '/link', 'gdi32.lib', 'user32.lib', 'advapi32.lib',
    ],
    env,
  );

  console.log(`\n--- 产物 (${arch}) ---`);
  // 词表是数据不是产物：从 native/data 拷到产物目录，hook 就在 dll 旁边找得到
  const mapSrc = path.join(NATIVE, 'data', 'toymap.json');
  if (fs.existsSync(mapSrc)) {
    fs.copyFileSync(mapSrc, path.join(out, 'toymap.json'));
  }
  for (const f of fs.readdirSync(out).sort()) {
    if (/\.(obj|pdb|ilk|exp|lib|map)$/i.test(f)) continue;   // 中间产物不列
    const size = fs.statSync(path.join(out, f)).size;
    console.log(`  ${String(size).padStart(9)} B  ${f}`);
  }
  if (shellcodeSummary) console.log(`  shellcode:${shellcodeSummary}`);
  return okToy && okHook && okInject && okSc && okNoExp && okMeasure;
}

const arg = (process.argv[2] ?? 'both').toLowerCase();
const targets = arg === 'both' ? ['x86', 'x64'] : [arg];
let allOk = true;
for (const t of targets) {
  if (!buildArch(t)) allOk = false;
}

console.log(allOk ? '\n==== 构建完成 ====' : '\n==== 有失败项 ====');
process.exit(allOk ? 0 : 1);
