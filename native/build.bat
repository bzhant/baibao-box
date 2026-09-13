@echo off
rem ===========================================================================
rem  白的百宝箱 · 原生侧构建脚本
rem
rem  用法：
rem     build.bat            rem 默认两个架构都编（x86 + x64）
rem     build.bat x86        rem 只编 32 位
rem     build.bat x64        rem 只编 64 位
rem
rem  产物：native\build\<arch>\toygame.exe、toyHook.dll
rem
rem  为什么用 .bat + cl 而不用 CMake/MSBuild：
rem    我们只需要编一个玩具 exe 和一个 hook DLL，直接调 cl 最省事、
rem    少一层工程文件，也少一堆依赖。
rem ===========================================================================
setlocal enabledelayedexpansion

set "BB_ROOT=%~dp0.."
set "NATIVE=%~dp0"
set "MINHOOK=%BB_ROOT%\libs\minhook"
set "VCVARS=D:\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"

if not exist "%VCVARS%" (
  echo [错误] 找不到 vcvarsall.bat: %VCVARS%
  echo        请确认 MSVC Build Tools 装在 D:\BuildTools
  exit /b 1
)

set "ARCH=%~1"
if "%ARCH%"=="" set "ARCH=both"

if /i "%ARCH%"=="both" (
  call "%~f0" x86 || exit /b 1
  call "%~f0" x64 || exit /b 1
  echo.
  echo ==== 全部完成 ====
  exit /b 0
)

if /i "%ARCH%"=="x86" ( set "VCARG=x86" & set "OUTARCH=x86" ) else ( set "VCARG=x64" & set "OUTARCH=x64" )

set "OUT=%NATIVE%build\%OUTARCH%"
if not exist "%OUT%" mkdir "%OUT%"

echo.
echo ================================================================
echo  构建 %OUTARCH%
echo ================================================================
call "%VCVARS%" %VCARG% >nul 2>&1
if errorlevel 1 (
  echo [错误] vcvarsall %VCARG% 失败
  exit /b 1
)

set "CFLAGS=/nologo /W4 /O2 /MT /D_CRT_SECURE_NO_WARNINGS /DUNICODE /D_UNICODE /I"%MINHOOK%\include""
set "MINHOOK_SRC="%MINHOOK%\src\buffer.c" "%MINHOOK%\src\hook.c" "%MINHOOK%\src\trampoline.c" "%MINHOOK%\src\hde\hde32.c" "%MINHOOK%\src\hde\hde64.c""

echo --- 1/2 编译玩具目标 toygame.exe ---
cl %CFLAGS% /Fe:"%OUT%\toygame.exe" "%NATIVE%toygame\toygame.cpp" /link /SUBSYSTEM:WINDOWS user32.lib gdi32.lib
if errorlevel 1 (
  echo [失败] 玩具目标编译失败
  exit /b 1
)

echo --- 2/2 编译编码 hook toyHook.dll ---
cl %CFLAGS% /LD /EHsc /Fe:"%OUT%\toyHook.dll" "%NATIVE%hooks\toy\toyHook.cpp" %MINHOOK_SRC% /link user32.lib ws2_32.lib
if errorlevel 1 (
  echo [失败] hook DLL 编译失败
  exit /b 1
)

echo.
echo --- 产物 ---
dir /b "%OUT%"
echo.
echo [成功] %OUTARCH% 构建完成
exit /b 0
