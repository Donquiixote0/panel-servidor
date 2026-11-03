// =============================================================================
// server.js — Backend del panel de estado del servidor
// =============================================================================
// Este archivo hace dos cosas:
//   1. Expone la API GET /api/estado, que devuelve en JSON el estado del sistema.
//   2. Sirve los archivos estáticos (HTML, CSS, JS) de la carpeta "public".
//
// Idea clave: en Linux "todo es un archivo". El kernel publica información del
// hardware como archivos de texto dentro de /sys y /proc. Así que para saber la
// batería o la temperatura NO necesitamos librerías externas: basta con leer
// esos archivos. Eso mantiene el proyecto pequeño y fácil de entender.
// =============================================================================

// "express" es el framework web: nos simplifica crear rutas y servir archivos.
const express = require('express');

// Usamos la versión con promesas de "fs" para poder usar async/await y no
// bloquear el servidor mientras se leen archivos (Node atiende a todos los
// clientes en un solo hilo, así que bloquearlo afectaría a todos).
const fs = require('fs/promises');

// "os" viene con Node y ya nos da datos como la RAM total, el uptime y la carga.
const os = require('os');

// "path" sirve para construir rutas de archivos de forma segura en cualquier SO.
const path = require('path');

const app = express();

// El puerto se toma de la variable de entorno PORT si existe; si no, 3001.
// Así se puede cambiar el puerto sin tocar el código: PORT=8080 npm start
const PORT = process.env.PORT || 3001;

// -----------------------------------------------------------------------------
// Funciones auxiliares
// -----------------------------------------------------------------------------

/**
 * Lee un archivo de texto y devuelve su contenido sin espacios ni saltos de
 * línea al final. Si el archivo no existe o no se puede leer, devuelve null.
 *
 * ¿Por qué devolver null en vez de lanzar un error? Porque el enunciado pide
 * que si un dato no está disponible (por ejemplo, no hay batería) el campo sea
 * null y la API siga funcionando. Centralizar ese comportamiento aquí evita
 * repetir try/catch en cada función.
 */
async function leerArchivo(ruta) {
  try {
    const contenido = await fs.readFile(ruta, 'utf8');
    return contenido.trim();
  } catch {
    return null;
  }
}

/**
 * Busca la carpeta de la batería.
 *
 * Normalmente es /sys/class/power_supply/BAT0, pero en algunas laptops
 * (incluidas varias HP) el kernel la llama BAT1. Primero probamos BAT0 y, si no
 * existe, buscamos cualquier carpeta que empiece por "BAT". Si no hay ninguna,
 * devolvemos null (por ejemplo, en un PC de escritorio o si quitaste la batería).
 */
async function buscarCarpetaBateria() {
  const base = '/sys/class/power_supply';
  const preferida = path.join(base, 'BAT0');

  // Si BAT0 tiene el archivo "capacity", la usamos directamente.
  if ((await leerArchivo(path.join(preferida, 'capacity'))) !== null) {
    return preferida;
  }

  try {
    const entradas = await fs.readdir(base);
    const bateria = entradas.find((nombre) => nombre.startsWith('BAT'));
    return bateria ? path.join(base, bateria) : null;
  } catch {
    // La carpeta /sys/class/power_supply podría no existir (p. ej. en un contenedor).
    return null;
  }
}

/**
 * Devuelve { porcentaje, estado } de la batería, o nulls si no hay batería.
 */
async function obtenerBateria() {
  const carpeta = await buscarCarpetaBateria();
  if (!carpeta) {
    return { porcentaje: null, estado: null };
  }

  // "capacity" contiene un número del 0 al 100 en texto, p. ej. "87".
  const capacidadTexto = await leerArchivo(path.join(carpeta, 'capacity'));
  // Number.parseInt devuelve NaN si el texto no es un número; lo convertimos a null.
  const porcentaje = capacidadTexto !== null ? Number.parseInt(capacidadTexto, 10) : NaN;

  // "status" contiene texto en inglés: "Charging", "Discharging", "Full",
  // "Not charging" o "Unknown". Lo traducimos para mostrarlo en español.
  const estadoIngles = await leerArchivo(path.join(carpeta, 'status'));
  const traducciones = {
    Charging: 'Cargando',
    Discharging: 'Descargando',
    Full: 'Completa',
    'Not charging': 'Conectada, sin cargar',
    Unknown: 'Desconocido',
  };
  // Si llega un valor que no conocemos, devolvemos el original en vez de perderlo.
  const estado = estadoIngles === null ? null : traducciones[estadoIngles] || estadoIngles;

  return {
    porcentaje: Number.isNaN(porcentaje) ? null : porcentaje,
    estado,
  };
}

/**
 * Devuelve la RAM { usadaBytes, totalBytes, porcentaje }.
 *
 * Detalle importante: os.freemem() devuelve la memoria "completamente libre"
 * (MemFree), pero Linux usa la RAM sobrante como caché de disco para ir más
 * rápido. Esa caché se libera en cuanto un programa la necesita, así que en
 * realidad está "disponible". Si usáramos MemFree, el panel diría que la RAM
 * está casi llena todo el tiempo, lo cual asusta pero no es cierto.
 *
 * Por eso leemos "MemAvailable" de /proc/meminfo, que es la estimación del
 * kernel de cuánta memoria se puede usar realmente (lo mismo que muestra la
 * columna "available" del comando `free -h`). Si por algún motivo no se puede
 * leer, usamos os.freemem() como plan B.
 */
async function obtenerRam() {
  const totalBytes = os.totalmem();
  let disponibleBytes = os.freemem(); // valor de respaldo

  const meminfo = await leerArchivo('/proc/meminfo');
  if (meminfo) {
    // La línea tiene la forma: "MemAvailable:    3456789 kB"
    const coincidencia = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (coincidencia) {
      disponibleBytes = Number(coincidencia[1]) * 1024; // kB -> bytes
    }
  }

  const usadaBytes = totalBytes - disponibleBytes;
  return {
    usadaBytes,
    totalBytes,
    porcentaje: redondear((usadaBytes / totalBytes) * 100),
  };
}

/**
 * Devuelve el uso del disco de la partición raíz "/".
 *
 * fs.statfs() (disponible desde Node 18.15) le pregunta al sistema de archivos
 * cuántos bloques tiene y cuántos están libres. Es lo mismo que hace `df`, pero
 * sin tener que ejecutar un comando externo y "parsear" su texto, lo cual sería
 * más frágil (la salida de df puede cambiar según el idioma o la versión).
 */
async function obtenerDisco() {
  try {
    const info = await fs.statfs('/');
    // bsize = tamaño de cada bloque en bytes.
    // blocks = bloques totales. bavail = bloques libres para usuarios normales.
    // Usamos bavail (no bfree) porque ext4 reserva ~5% para root, y `df` también
    // calcula así; de este modo nuestros números coinciden con los de `df -h`.
    const totalBytes = info.blocks * info.bsize;
    const libreBytes = info.bavail * info.bsize;
    const usadoBytes = (info.blocks - info.bfree) * info.bsize;
    // El porcentaje se calcula como df: usado / (usado + disponible).
    const porcentaje = redondear((usadoBytes / (usadoBytes + libreBytes)) * 100);

    return { usadoBytes, totalBytes, libreBytes, porcentaje };
  } catch {
    return null;
  }
}

/**
 * Devuelve la temperatura de la CPU en grados Celsius, o null si no hay sensor.
 *
 * Linux expone sensores en /sys/class/thermal/thermal_zoneN/. Cada zona tiene:
 *   - "type": qué mide (p. ej. "x86_pkg_temp" = el chip de la CPU, "acpitz" =
 *     sensor genérico de la placa base).
 *   - "temp": la temperatura en MILI-grados (45000 = 45.0 °C).
 *
 * Preferimos las zonas que corresponden claramente a la CPU. Si no hay ninguna
 * así, nos quedamos con la temperatura más alta de las disponibles, que es la
 * opción más prudente para vigilar que el equipo no se caliente.
 */
async function obtenerTemperaturaCpu() {
  const base = '/sys/class/thermal';
  let zonas;
  try {
    zonas = (await fs.readdir(base)).filter((n) => n.startsWith('thermal_zone'));
  } catch {
    return null;
  }

  const tiposCpu = ['x86_pkg_temp', 'coretemp', 'cpu', 'k10temp', 'soc'];
  const lecturas = [];

  for (const zona of zonas) {
    const tipo = (await leerArchivo(path.join(base, zona, 'type'))) || '';
    const tempTexto = await leerArchivo(path.join(base, zona, 'temp'));
    const miliGrados = Number.parseInt(tempTexto, 10);
    // Descartamos lecturas inválidas o absurdas (algunos sensores rotos dan 0 o negativos).
    if (Number.isNaN(miliGrados) || miliGrados <= 0) continue;
    lecturas.push({ tipo, celsius: miliGrados / 1000 });
  }

  if (lecturas.length === 0) return null;

  const deCpu = lecturas.find((l) => tiposCpu.some((t) => l.tipo.toLowerCase().includes(t)));
  const elegida = deCpu || lecturas.reduce((max, l) => (l.celsius > max.celsius ? l : max));
  return redondear(elegida.celsius);
}

/** Redondea a 1 decimal. Así el JSON es más legible (45.3 en vez de 45.29999). */
function redondear(numero) {
  return Math.round(numero * 10) / 10;
}

// -----------------------------------------------------------------------------
// Rutas
// -----------------------------------------------------------------------------

/**
 * GET /api/estado
 *
 * Reúne todos los datos y los devuelve en un único JSON. Usamos Promise.all para
 * leer batería, RAM, disco y temperatura AL MISMO TIEMPO en lugar de uno detrás
 * de otro: como son lecturas independientes, así la respuesta llega antes.
 */
app.get('/api/estado', async (req, res) => {
  try {
    const [bateria, ram, disco, temperaturaCpu] = await Promise.all([
      obtenerBateria(),
      obtenerRam(),
      obtenerDisco(),
      obtenerTemperaturaCpu(),
    ]);

    // os.loadavg() devuelve la carga media de 1, 5 y 15 minutos.
    // En Windows siempre devuelve [0, 0, 0], pero en Linux es real.
    const [carga1, carga5, carga15] = os.loadavg();

    res.json({
      hostname: os.hostname(),
      bateria: bateria.porcentaje,
      estadoCarga: bateria.estado,
      ram,
      disco,
      // os.uptime() devuelve los segundos desde el último arranque. Mandamos
      // segundos (un número) y dejamos que el frontend decida cómo mostrarlo:
      // separar "datos" de "presentación" hace la API más reutilizable.
      uptimeSegundos: Math.floor(os.uptime()),
      cargaPromedio: {
        '1min': redondear(carga1),
        '5min': redondear(carga5),
        '15min': redondear(carga15),
      },
      // Número de núcleos: sirve para interpretar la carga. Una carga de 2.0 en
      // una CPU de 2 núcleos significa 100% ocupada; en una de 4, solo el 50%.
      nucleos: os.cpus().length,
      temperaturaCpu,
      // Marca de tiempo para que el frontend muestre cuándo se tomó la lectura.
      fecha: new Date().toISOString(),
    });
  } catch (error) {
    // Red de seguridad: si algo inesperado falla, respondemos con un error 500
    // en JSON (en lugar de que el servidor se caiga) y lo registramos en consola.
    console.error('Error al obtener el estado:', error);
    res.status(500).json({ error: 'No se pudo obtener el estado del servidor' });
  }
});

// Servimos la carpeta "public": al visitar http://IP:3001/ Express entregará
// public/index.html, y este a su vez pedirá estilos.css y app.js.
// Lo ponemos DESPUÉS de la ruta de la API para que la API tenga prioridad.
app.use(express.static(path.join(__dirname, 'public')));

// -----------------------------------------------------------------------------
// Arranque
// -----------------------------------------------------------------------------

// Escuchamos en '0.0.0.0' (todas las interfaces de red) para poder abrir el
// panel desde otro equipo de la red local, no solo desde la propia laptop.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Panel del servidor disponible en http://localhost:${PORT}`);
});
