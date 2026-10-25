@echo off
rem bingbing 快捷入口：双击或命令行都行，不用记 node 路径。
rem   bingbing.cmd install      挂到 profile，然后重启宿主
rem   bingbing.cmd doctor       一条命令体检
rem   bingbing.cmd which        现在是哪套越狱
setlocal
node "%~dp0bin\bingbing.js" %*
