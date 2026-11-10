@echo off
rem Runs PulseGuard locally (never used on the live server). The Python environment lives one folder up (..\.venv),
rem so this folder only holds the website itself.
setlocal
cd /d "%~dp0"
if not exist "..\.venv" (
  python -m venv "..\.venv"
)
rem Install the requirements only when Flask is missing (a uv-built .venv has no pip of its own).
"..\.venv\Scripts\python" -c "import flask" 2>nul || "..\.venv\Scripts\python" -m pip install -q -r requirements.txt
if not defined PORT set "PORT=5000"

echo.
echo  PulseGuard lokaal starten
echo    1 = demo-database (admin, demo, dr.jansen)   [standaard]
echo    2 = demo-database eerst resetten, dan starten
echo    3 = uw eigen database (src\health_quest.db)
echo.
set "CHOICE=1"
set /p "CHOICE=Keuze [1]: "

if "%CHOICE%"=="3" (
  set "HEALTH_QUEST_DB=%~dp0health_quest.db"
) else (
  set "HEALTH_QUEST_DB=%~dp0..\.dev\demo.db"
  if not defined INITIAL_ADMIN_PASSWORD set "INITIAL_ADMIN_PASSWORD=admin demo password"
  if "%CHOICE%"=="2" (
    "..\.venv\Scripts\python" scripts\reset_demo.py --yes
    if errorlevel 1 goto end
  ) else (
    if not exist "%~dp0..\.dev\demo.db" "..\.venv\Scripts\python" scripts\reset_demo.py --yes
  )
)

echo.
echo  Database: %HEALTH_QUEST_DB%
echo  Open http://127.0.0.1:%PORT%  -  stoppen met Ctrl+C
start "" http://127.0.0.1:%PORT%
"..\.venv\Scripts\python" app.py
:end
pause
