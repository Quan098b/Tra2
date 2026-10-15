@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Lan dau: tao moi truong ao .venv va cai thu vien (can Internet).
if not exist ".venv\Scripts\python.exe" (
    echo [1/2] Tao moi truong ao .venv ...
    python -m venv .venv || (
        echo [LOI] Chua cai Python. Tai tai https://www.python.org/downloads/
        pause
        exit /b 1
    )
    echo [2/2] Cai thu vien, vui long doi...
    ".venv\Scripts\python.exe" -m pip install --upgrade pip
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt || (
        echo [LOI] Cai thu vien that bai.
        rmdir /s /q .venv
        pause
        exit /b 1
    )
)

".venv\Scripts\python.exe" app.py
pause
