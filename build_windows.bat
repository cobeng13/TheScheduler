@echo off
setlocal
cd /d %~dp0

echo Building frontend...
pushd frontend
echo Installing frontend dependencies...
call npm install --include=optional
if errorlevel 1 (
  echo ERROR: npm install failed.
  popd
  exit /b 1
)

set BUILD_LOG=build_windows.log
call npm run build > "%BUILD_LOG%" 2>&1
if errorlevel 1 (
  findstr /c:"@rollup/rollup-win32-x64-msvc" /c:"Cannot find module '@rollup/rollup-win32-x64-msvc'" /c:"Cannot find module @rollup/rollup-win32-x64-msvc" "%BUILD_LOG%" >nul
  if not errorlevel 1 (
    echo ERROR: Rollup optional dependency issue detected. Cleaning and retrying...
    if exist node_modules rmdir /s /q node_modules
    if exist package-lock.json del /f /q package-lock.json
    call npm install --include=optional
    if errorlevel 1 (
      echo ERROR: npm install failed after cleanup.
      popd
      exit /b 1
    )
    call npm run build
    if errorlevel 1 (
      echo ERROR: Frontend build failed after cleanup.
      popd
      exit /b 1
    )
  ) else (
    type "%BUILD_LOG%"
    echo ERROR: Frontend build failed.
    popd
    exit /b 1
  )
)
popd

echo Copying frontend build...
set DIST_DIR=backend\app\web\dist
if exist "%DIST_DIR%" rmdir /s /q "%DIST_DIR%"
mkdir "%DIST_DIR%"
xcopy /e /i /y "frontend\dist\*" "%DIST_DIR%\"

echo Building executable...
pushd backend
if exist dist rmdir /s /q dist
if exist build rmdir /s /q build
if exist TheScheduler.spec del /f /q TheScheduler.spec
pyinstaller --onefile --name TheScheduler --distpath dist --add-data "app\web\dist;app\web\dist" --collect-submodules app --hidden-import app --hidden-import app.main desktop_entrypoint.py
popd

echo Done.
