@echo off
echo ================================================
echo   WA KPPN Pekalongan - Installer
echo ================================================
echo.

:: Cek apakah Node.js sudah terinstal
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [X] Node.js BELUM terinstal.
    echo.
    echo Silakan install Node.js terlebih dahulu.
    echo Browser akan dibuka untuk mengunduh Node.js...
    echo.
    start https://nodejs.org/en/download/
    echo.
    echo Setelah Node.js terinstal, jalankan lagi file install.bat ini.
    pause
    exit /b
)

echo [OK] Node.js sudah terinstal.
echo.
echo Memulai instalasi dependencies...
echo.

npm install

echo.
echo ================================================
echo   Instalasi selesai!
echo ================================================
echo.
echo Silakan jalankan file "start.bat" untuk menjalankan aplikasi.
pause