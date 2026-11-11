@echo off
chcp 65001 >nul
"E:\Node.js\node.exe" "%USERPROFILE%\.codex\plugins\cache\tang-local-models\model-team\0.1.0\src\cli.mjs" open
if errorlevel 1 pause
