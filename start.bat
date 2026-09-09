@echo off
echo Starting MessengerPlus Backend...
start cmd /k "cd backend && uvicorn main:app --host 0.0.0.0 --port 8000"

echo Starting MessengerPlus Frontend...
start cmd /k "npm run dev"

echo.
echo ========================================================
echo MessengerPlus is now running!
echo.
echo Open this URL on your Windows PC: http://localhost:3000
echo Open this URL on your ANDROID PHONE: http://192.168.1.10:3000
echo ========================================================
