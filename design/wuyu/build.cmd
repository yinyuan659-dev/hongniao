@echo off
rem Bundle src\*.js into game.js (see the header of src\main.js). three.js is read from the engine folder, not modified.
cd /d %~dp0..\..
node web\node_modules\esbuild\bin\esbuild design\wuyu\src\main.js --bundle --format=iife --minify --alias:three=E:/soft/xiaoshuodongtai/web/node_modules/three/build/three.module.js --outfile=design\wuyu\game.js --log-level=warning
