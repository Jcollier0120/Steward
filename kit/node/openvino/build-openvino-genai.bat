@echo off
rem Builds OpenVINO GenAI 2026.4.1.0's openvino_genai.dll with Castellan's two fixes for Qwen3-VL on the NPU, against
rem OpenVINO 2026.4.1 from pip (its CMake config and import libraries). Only the library is built: no Python, samples,
rem tests, tools or tokenizers. Set SRC to a clone of openvinotoolkit/openvino.genai at 2026.4.1.0 with the patch applied,
rem OUT to a build folder, and OPENVINO to a venv's site-packages\openvino with openvino==2026.4.1 installed.
setlocal
set "VS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools"
call "%VS%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
set "PATH=%VS%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;%VS%\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%PATH%"
set "SRC=C:\worktrees\openvino-genai\genai"
set "OUT=C:\worktrees\openvino-genai\out"
set "OPENVINO=C:\worktrees\openvino-genai\venv\Lib\site-packages\openvino"
cmake -S "%SRC%" -B "%OUT%" -G Ninja -DCMAKE_BUILD_TYPE=Release -DOpenVINO_DIR="%OPENVINO%\cmake" ^
  -DENABLE_PYTHON=OFF -DENABLE_SAMPLES=OFF -DENABLE_TESTS=OFF -DENABLE_TOOLS=OFF -DBUILD_TOKENIZERS=OFF || exit /b 1
cmake --build "%OUT%" --target openvino_genai --parallel 6 || exit /b 1
echo BUILD_OK: %OUT%\openvino_genai\openvino_genai.dll
