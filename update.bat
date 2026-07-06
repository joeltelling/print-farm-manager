@echo off
rem Always run from the directory this bat file lives in (the repo root),
rem regardless of where it was launched from.
cd /d %~dp0

echo ============================================================
echo  Print Farm Manager — Update
echo ============================================================
echo.

echo [1/4] Pulling latest code from GitHub...
rem npm install rewrites package-lock.json when the local npm version differs
rem from the one that generated it. That drift blocks git pull the next time
rem the lockfile changes upstream. This machine never has intentional local
rem changes, so discard lockfile drift before pulling.
git checkout -- package-lock.json client/package-lock.json 2>nul
git pull
if %errorlevel% neq 0 (
    echo.
    echo ERROR: git pull failed. Check your internet connection or resolve conflicts.
    pause
    exit /b 1
)
echo Done.
echo.

echo [2/4] Installing server dependencies...
call npm install
if not exist node_modules (
    echo.
    echo ERROR: server npm install failed — node_modules not created.
    pause
    exit /b 1
)
echo Done.
echo.

echo [3/4] Building client...
cd client
call npm install --legacy-peer-deps
if not exist node_modules (
    echo.
    echo ERROR: client npm install failed — node_modules not created.
    cd ..
    pause
    exit /b 1
)
call npm run build
if %errorlevel% neq 0 (
    echo.
    echo ERROR: client build failed. See output above.
    cd ..
    pause
    exit /b 1
)
cd ..
echo Done.
echo.

echo [4/4] Restarting server...
rem Kill only the process on port 3000 — avoids accidentally killing this bat's own process tree.
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /R ":3000 "') do (
    taskkill /F /PID %%a 2>nul
)
timeout /t 2 /nobreak >nul
echo.
echo ============================================================
echo  Update complete! Server starting below.
echo  Close this window to stop the server.
echo ============================================================
echo.
node server\index.js
