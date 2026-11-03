@echo off
rem Drop a ClientClusters-<version>-update.zip on this file, or double-click it to use the newest one in Downloads.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" %1
