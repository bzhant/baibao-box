// ============================================================================
// 负例测试 DLL —— 位数正确、是个合法 PE、但**没有 Install 导出**
//
// 用途：验收"注入器是否会在 DLL 缺入口导出时明确报错（退出码 14）"。
//   这类负例比"喂垃圾文件"更接近真实场景：用户拿了一个别的工具的 hook DLL，
//   位数对、能加载，但里面根本没有我们约定的入口点。
//   如果这时注入器静默失败、或者干脆让目标进程挂住，都是不能接受的。
//
// 刻意导出一个名字相近但不对的符号（SomethingElse / Uninstall），
// 用来确认注入器**不是**靠"有没有导出"这种粗判断，而是真的按名字找。
//
// 编译参数与 toyHook 保持一致（/LD /NOENTRY /DLL），只为了产出合法 DLL。
// ============================================================================

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

extern "C" __declspec(dllexport) int SomethingElse(void) { return 1; }
extern "C" __declspec(dllexport) void Uninstall(void) { }

// 用一个假的 DllMain 语义：不需要真的被加载，所以什么都不做。
// 这里不写 DllMain 是有意的 —— /NOENTRY 让链接器不要求它。
