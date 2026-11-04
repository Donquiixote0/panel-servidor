# panel-servidor

Panel web sencillo para ver el estado de un servidor **Ubuntu Server** (pensado para una laptop HP vieja reutilizada como servidor).

Muestra en tarjetas, con actualización automática cada 5 segundos:

- 🔋 Porcentaje de batería y estado de carga
- 🧠 RAM usada / total
- 💾 Uso de disco de la partición raíz (`/`)
- ⏱️ Tiempo encendido (uptime)
- 📈 Carga promedio (1, 5 y 15 minutos)
- 🌡️ Temperatura de la CPU (si el equipo tiene sensor)

Si algún dato no está disponible (por ejemplo, la laptop no tiene batería puesta), la API devuelve `null` en ese campo y el panel muestra "No disponible", sin romperse.

---

## Estructura del proyecto

```
panel-servidor/
├── server.js          # Backend: servidor Express y API /api/estado
├── package.json       # Nombre del proyecto, dependencias y script "start"
├── .gitignore         # Archivos que git no debe subir (node_modules)
├── README.md          # Este archivo
└── public/            # Frontend (lo que ve el navegador)
    ├── index.html     # Estructura de la página: cabecera y tarjetas
    ├── estilos.css    # Diseño oscuro, cuadrícula de tarjetas y barras de progreso
    └── app.js         # Pide /api/estado cada 5 s y actualiza las tarjetas
```

### ¿Qué hace cada archivo?

| Archivo | Para qué sirve |
|---|---|
| `server.js` | Arranca un servidor web con Express. Lee la información del sistema desde los archivos que publica el kernel de Linux (`/sys` y `/proc`) y desde el módulo `os` de Node, y la devuelve en JSON en `GET /api/estado`. También sirve la carpeta `public/`. |
| `package.json` | Declara la única dependencia (`express`) y el comando `npm start`. |
| `public/index.html` | El "esqueleto" de la página: una tarjeta por cada dato. |
| `public/estilos.css` | El aspecto: tema oscuro, tarjetas en cuadrícula adaptable (se ve bien en móvil) y barras de colores (verde / ámbar / rojo). |
| `public/app.js` | JavaScript puro (sin frameworks). Llama a la API, formatea los números (bytes → GB, segundos → días/horas) y actualiza la página. Si el servidor no responde, el indicador de la cabecera se pone en rojo. |

---

## Instalación en Ubuntu Server

### 1. Instalar Node.js (versión 18.15 o superior)

El proyecto usa `fs.statfs`, que existe desde Node 18.15. Las versiones de Node que trae `apt` en Ubuntu a veces son antiguas, así que lo recomendable es usar el repositorio oficial de NodeSource (versión LTS):

```bash
sudo apt update
```

```bash
sudo apt install -y curl git
```

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
```

```bash
sudo apt install -y nodejs
```

Comprueba la versión:

```bash
node -v
```

### 2. Descargar el proyecto

```bash
git clone https://github.com/donquiixote0/panel-servidor.git
```

```bash
cd panel-servidor
```

### 3. Instalar dependencias

```bash
npm install
```

Esto descarga Express dentro de la carpeta `node_modules/`.

### 4. Ejecutar

```bash
npm start
```

Verás el mensaje `Panel del servidor disponible en http://localhost:3001`.

Abre en el navegador de **otro equipo de tu red**:

```
http://IP_DE_LA_LAPTOP:3001
```

Para saber la IP de la laptop:

```bash
hostname -I
```

#### Cambiar el puerto

El puerto se lee de la variable de entorno `PORT` (por defecto `3001`):

```bash
PORT=8080 npm start
```

#### Si usas el firewall `ufw`

Tendrás que permitir el puerto para poder entrar desde otro equipo:

```bash
sudo ufw allow 3001/tcp
```

### 5. Probar solo la API

```bash
curl http://localhost:3001/api/estado
```

Ejemplo de respuesta:

```json
{
  "hostname": "hp-servidor",
  "bateria": 87,
  "estadoCarga": "Cargando",
  "ram": { "usadaBytes": 1503238553, "totalBytes": 4102029312, "porcentaje": 36.6 },
  "disco": { "usadoBytes": 21474836480, "totalBytes": 117440512000, "libreBytes": 90000000000, "porcentaje": 19.3 },
  "uptimeSegundos": 273600,
  "cargaPromedio": { "1min": 0.3, "5min": 0.2, "15min": 0.1 },
  "nucleos": 2,
  "temperaturaCpu": 48.5,
  "fecha": "2026-11-03T15:41:52.201Z"
}
```

---

## (Opcional) Que arranque solo al encender la laptop

Con `systemd` (el gestor de servicios de Ubuntu) el panel se inicia automáticamente al arrancar y se reinicia si falla.

Crea el archivo del servicio (cambia `TU_USUARIO` y la ruta por las tuyas):

```bash
sudo nano /etc/systemd/system/panel-servidor.service
```

Contenido:

```ini
[Unit]
Description=Panel web de estado del servidor
After=network.target

[Service]
Type=simple
User=TU_USUARIO
WorkingDirectory=/home/TU_USUARIO/panel-servidor
ExecStart=/usr/bin/node server.js
Environment=PORT=3001
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Actívalo e inícialo:

```bash
sudo systemctl daemon-reload
```

```bash
sudo systemctl enable --now panel-servidor
```

Ver su estado o sus mensajes:

```bash
systemctl status panel-servidor
```

```bash
journalctl -u panel-servidor -f
```

---

## Preguntas frecuentes

**La batería sale "No disponible".**
Comprueba qué fuentes de energía ve el kernel con `ls /sys/class/power_supply/`. El panel busca `BAT0` y, si no existe, cualquier carpeta que empiece por `BAT` (algunas HP usan `BAT1`). Si no aparece ninguna, la batería no está conectada o no se detecta.

**La temperatura sale "No disponible".**
Mira si hay sensores con `ls /sys/class/thermal/`. Si no aparece ninguna carpeta `thermal_zone*`, el equipo no expone la temperatura por esa vía.

**La RAM usada parece más baja que en otros programas.**
Es intencionado: se calcula con `MemAvailable` (igual que la columna *available* de `free -h`), que no cuenta como "usada" la caché de disco que Linux libera cuando hace falta.

**¿Es seguro exponerlo a Internet?**
No está pensado para eso: no tiene contraseña. Úsalo dentro de tu red local.
