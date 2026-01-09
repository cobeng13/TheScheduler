@echo off
setlocal
cd /d %~dp0

echo Building frontend...
pushd frontend
call npm run build
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
