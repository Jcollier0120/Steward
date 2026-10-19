@echo off
rem Builds GenieX v0.9.1's llama_cpp plugin (geniex_plugin.dll) with Castellan's memory patches, against the same
rem llama.cpp commit and GenieX patches as the shipped DLLs. Hexagon and OpenCL are off: only the plugin is taken.
setlocal
set "VS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools"
call "%VS%\VC\Auxiliary\Build\vcvarsarm64.bat" >nul || exit /b 1
set "PATH=%VS%\VC\Tools\Llvm\ARM64\bin;%VS%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;%VS%\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%PATH%"
set "SRC=C:\worktrees\geniex-091-patch\sdk"
set "OUT=C:\worktrees\geniex-091-patch\build-castellan"
clang --version | findstr /i version
cmake -S "%SRC%" -B "%OUT%" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE="%SRC%\cmake\arm64-windows-llvm.cmake" ^
  -DGENIEX_PLUGIN_LLAMA_CPP=ON -DGENIEX_PLUGIN_QAIRT=OFF -DGGML_HEXAGON=OFF -DGGML_OPENCL=OFF -DGGML_OPENMP=OFF ^
  -DGENIEX_BENCHMARK=OFF -DGIT_EXECUTABLE="C:/Program Files/Git/cmd/git.exe" || exit /b 1
cmake --build "%OUT%" --target geniex_llama_cpp -j 8 || exit /b 1
echo BUILD_OK
