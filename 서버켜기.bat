@echo off
chcp 65001 >nul
title 게임판 서버
cd /d "%~dp0"

rem ===== 여기만 고치세요: 관리자 비밀번호 (남한테 알려주지 마세요) =====
set ADMIN_KEY=여기에_관리자_비밀번호_쓰기
rem ==========================================================

set ACCOUNTS_FILE=%~dp0accounts.json
set PORT=3000
echo 서버를 켭니다. 이 창을 닫으면 서버가 꺼져요.
node server.js
pause
