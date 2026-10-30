@echo off
rem The whole test: hello.cmd says hello.
for /f "delims=" %%l in ('call "%~dp0hello.cmd"') do if "%%l"=="Hello, world!" exit /b 0
echo hello.cmd didn't say hello 1>&2
exit /b 1
