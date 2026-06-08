INICIAR LA APP 

(reemplazar por tu ubicacion)
cd "C:\Users\usuario\Documents\TESIS PROYECTOS\AppMovil-ECG\AppMovil-ECG\camera-app"
npm run dev -- --host 0.0.0.0 --port 5173

levantar en ngrok:
primero levantar al localhost front y back 

crear en un block de notas ngrok.yml con estos datos: el token tenes que crearte la cuenta en ngrok y poner el tuyo

version: 2
authtoken: ***************************************
tunnels:
  frontend:
    proto: http
    addr: 5173
  backend:
    proto: http
    addr: 8000


despues en un cmd
ngrok start --all

o pones la ruta del yml
ngrok start --config "C:\Users\belen\.ngrok2\ngrok.yml" --all