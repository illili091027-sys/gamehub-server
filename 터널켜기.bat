@echo off
chcp 65001 >nul
title 게임판 터널(ngrok)
echo 서버(3000번)를 인터넷에 연결합니다. 이 창을 닫으면 연결이 끊겨요.
ngrok http 3000
pause
