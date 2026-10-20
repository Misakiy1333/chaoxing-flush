@echo off
chcp 65001 >nul
title 超星刷课助手
cd /d "%~dp0"
if exist "dist\超星刷课.exe" (
  start "" "dist\超星刷课.exe"
) else if exist "超星刷课.exe" (
  start "" "超星刷课.exe"
) else (
  echo 找不到 超星刷课.exe，请确认文件和本文件在同一文件夹。
  pause
)
