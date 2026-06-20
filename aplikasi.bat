@echo off
setlocal EnableDelayedExpansion

:: ==========================================================
::  WA Blaster Pro KPPN Pekalongan - One Click Launcher
:: ==========================================================

set "APP_DIR=%~dp0"
set "LOCAL_URL=http://localhost:3000"
set "TUNNEL_ORIGIN=http://127.0.0.1:3000"
set "CF_EXE="
set "CF_DIR="
set "CF_URL="
set "CF_LOG=%APP_DIR%cloudflared.log"
set "CF_URL_FILE=%APP_DIR%cloudflared-url.txt"

cd /d "%APP_DIR%"

echo ================================================
echo   WA Blaster Pro KPPN Pekalongan
echo   One Click Launcher
echo ================================================
echo.

if not exist "%APP_DIR%start.bat" (
    echo [ERROR] File start.bat tidak ditemukan di folder:
    echo %APP_DIR%
    echo.
    pause
    exit /b 1
)

:: Cari cloudflared.exe / cloudfare.exe.
:: Prioritas dibuat mengikuti kondisi manual Anda: folder user/Downloads juga didukung.
if exist "%APP_DIR%cloudflared.exe" set "CF_EXE=%APP_DIR%cloudflared.exe"
if not defined CF_EXE if exist "%APP_DIR%cloudfare.exe" set "CF_EXE=%APP_DIR%cloudfare.exe"
if not defined CF_EXE if exist "%USERPROFILE%\Downloads\cloudflared.exe" set "CF_EXE=%USERPROFILE%\Downloads\cloudflared.exe"
if not defined CF_EXE if exist "%USERPROFILE%\Downloads\cloudfare.exe" set "CF_EXE=%USERPROFILE%\Downloads\cloudfare.exe"
if not defined CF_EXE if exist "%USERPROFILE%\cloudflared.exe" set "CF_EXE=%USERPROFILE%\cloudflared.exe"
if not defined CF_EXE if exist "%USERPROFILE%\cloudfare.exe" set "CF_EXE=%USERPROFILE%\cloudfare.exe"

if defined CF_EXE (
    for %%I in ("%CF_EXE%") do set "CF_DIR=%%~dpI"
    echo [OK] Cloudflare ditemukan: !CF_EXE!
    echo [OK] Folder Cloudflare : !CF_DIR!
) else (
    echo [PERINGATAN] cloudflared.exe tidak ditemukan.
    echo Lokasi yang dicari:
    echo - %APP_DIR%
    echo - %USERPROFILE%\Downloads
    echo - %USERPROFILE%
    echo.
    echo Aplikasi tetap akan dijalankan lokal tanpa tunnel online.
)

if exist "%CF_LOG%" del /f /q "%CF_LOG%" >nul 2>nul
if exist "%CF_URL_FILE%" del /f /q "%CF_URL_FILE%" >nul 2>nul

echo.
echo [1/5] Menjalankan server aplikasi...
start "WA Blaster - Server" cmd /k "cd /d "%APP_DIR%" && call start.bat"

echo [2/5] Menunggu server lokal siap di %LOCAL_URL% ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "for ($i=0; $i -lt 45; $i++) { try { $r = Invoke-WebRequest -Uri '%LOCAL_URL%' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -ge 200) { exit 0 } } catch {}; Start-Sleep -Seconds 1 }; exit 1" >nul 2>nul

if %errorlevel% equ 0 (
    echo [OK] Server lokal sudah aktif.
) else (
    echo [ERROR] Server lokal belum merespon.
    echo Coba buka manual: %LOCAL_URL%
    echo Tunnel online tidak akan stabil kalau server lokal belum aktif.
    echo.
    pause
    exit /b 1
)

echo [3/5] Membuka dashboard lokal...
start "" "%LOCAL_URL%"

if defined CF_EXE (
    echo.
    echo [4/5] Menjalankan Cloudflare Tunnel...
    echo Command dibuat sama seperti manual Anda:
    echo cloudflared.exe tunnel --url %TUNNEL_ORIGIN%
    echo.
    echo Catatan: jendela Cloudflare Tunnel jangan ditutup.
    echo.

    :: Jalankan dari folder tempat cloudflared.exe berada, agar sama seperti saat manual berhasil.
    start "Cloudflare Tunnel" powershell -NoProfile -ExecutionPolicy Bypass -NoExit -Command "& { cd '!CF_DIR!'; & '!CF_EXE!' tunnel --url '!TUNNEL_ORIGIN!' 2>&1 | Tee-Object -FilePath '!CF_LOG!' }"

    echo Menunggu link https://....trycloudflare.com dari Cloudflare Tunnel...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$log='%CF_LOG%'; $out='%CF_URL_FILE%'; for ($i=0; $i -lt 120; $i++) { if (Test-Path $log) { $txt = Get-Content $log -Raw -ErrorAction SilentlyContinue; $m = [regex]::Match($txt, 'https://[-a-zA-Z0-9.]+\.trycloudflare\.com'); if ($m.Success) { Set-Content -Path $out -Value $m.Value; exit 0 } }; Start-Sleep -Seconds 1 }; exit 1" >nul 2>nul

    if exist "%CF_URL_FILE%" (
        set /p CF_URL=<"%CF_URL_FILE%"
        echo [OK] Link Cloudflare ditemukan: !CF_URL!
        echo.
        echo [5/5] Menunggu tunnel register/stabil 20 detik sebelum membuka browser...
        timeout /t 20 /nobreak >nul
        echo Membuka link Cloudflare di browser...
        start "" "!CF_URL!"
        echo.
        echo Jika masih muncul "Can't reach this page", tunggu beberapa detik lalu tekan Ctrl+R.
        echo Jika tetap gagal, buka file cloudflared.log untuk melihat error tunnel.
    ) else (
        echo [ERROR] Link Cloudflare tidak berhasil terbaca otomatis.
        echo Cek jendela Cloudflare Tunnel atau file:
        echo %CF_LOG%
        if exist "%CF_LOG%" start notepad "%CF_LOG%"
    )
) else (
    echo.
    echo Cloudflare Tunnel tidak dijalankan karena cloudflared.exe/cloudfare.exe belum ditemukan.
)

echo.
echo Selesai.
echo - Dashboard lokal : %LOCAL_URL%
if defined CF_URL echo - Dashboard online: !CF_URL!
echo.
echo Jangan tutup jendela "WA Blaster - Server" dan "Cloudflare Tunnel" selama aplikasi digunakan online.
echo.
pause
endlocal
