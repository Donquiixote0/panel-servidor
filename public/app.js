// =============================================================================
// app.js — Lógica del frontend
// =============================================================================
// Pide los datos a /api/estado cada 5 segundos y actualiza las tarjetas.
// Está escrito en JavaScript "puro" (sin frameworks como React) porque la
// página es pequeña: un framework añadiría complejidad sin aportar mucho, y así
// se ve claramente cómo funciona el DOM por debajo.
// =============================================================================

// Cada cuánto pedimos datos nuevos (en milisegundos).
const INTERVALO_MS = 5000;

// Atajo para no escribir document.getElementById una y otra vez.
const $ = (id) => document.getElementById(id);

// -----------------------------------------------------------------------------
// Funciones de formato: convierten números "crudos" en texto legible.
// -----------------------------------------------------------------------------

/** Convierte bytes a la unidad más cómoda: 8589934592 -> "8.0 GB". */
function formatearBytes(bytes) {
  const unidades = ['B', 'KB', 'MB', 'GB', 'TB'];
  let valor = bytes;
  let i = 0;
  // Dividimos entre 1024 mientras el número sea grande y queden unidades.
  while (valor >= 1024 && i < unidades.length - 1) {
    valor /= 1024;
    i++;
  }
  return `${valor.toFixed(1)} ${unidades[i]}`;
}

/** Convierte segundos a "3 d 4 h 12 min". */
function formatearUptime(segundos) {
  const dias = Math.floor(segundos / 86400); // 86400 s = 1 día
  const horas = Math.floor((segundos % 86400) / 3600);
  const minutos = Math.floor((segundos % 3600) / 60);

  const partes = [];
  if (dias > 0) partes.push(`${dias} d`);
  if (horas > 0 || dias > 0) partes.push(`${horas} h`);
  partes.push(`${minutos} min`);
  return partes.join(' ');
}

// -----------------------------------------------------------------------------
// Funciones para pintar en la página
// -----------------------------------------------------------------------------

/**
 * Escribe un valor en un elemento. Si el valor es null, muestra
 * "No disponible" con un estilo atenuado. Así manejamos en un solo sitio el
 * caso de que la API devuelva null (por ejemplo, si no hay batería).
 *
 * Usamos textContent (y no innerHTML) porque textContent trata todo como texto
 * plano: es más seguro, ya que nunca interpretará HTML que venga en los datos.
 */
function pintarValor(id, texto) {
  const elemento = $(id);
  if (texto === null) {
    elemento.textContent = 'No disponible';
    elemento.classList.add('no-disponible');
  } else {
    elemento.textContent = texto;
    elemento.classList.remove('no-disponible');
  }
}

/**
 * Actualiza una barra de progreso.
 *
 * @param {string} id          id del contenedor .barra
 * @param {number|null} pct    porcentaje 0-100 (o null si no hay dato)
 * @param {boolean} invertida  false = "más es peor" (RAM, disco).
 *                             true  = "menos es peor" (batería).
 *
 * El color cambia según umbrales para que de un vistazo se vea si algo va mal.
 */
function pintarBarra(id, pct, invertida = false) {
  const barra = $(id);
  const relleno = barra.querySelector('.relleno');

  if (pct === null) {
    relleno.style.width = '0%';
    barra.removeAttribute('aria-valuenow');
    return;
  }

  // Math.min/Math.max evitan que un valor raro (p. ej. 102) se salga de la barra.
  const limitado = Math.max(0, Math.min(100, pct));
  relleno.style.width = `${limitado}%`;
  barra.setAttribute('aria-valuenow', String(limitado));

  // Si la barra es invertida (batería), "dar la vuelta" al porcentaje nos
  // permite reutilizar los mismos umbrales: 15% de batería ≈ 85% de "peligro".
  const nivel = invertida ? 100 - limitado : limitado;
  relleno.classList.toggle('peligro', nivel >= 90);
  relleno.classList.toggle('aviso', nivel >= 75 && nivel < 90);
}

/** Recibe el JSON de la API y actualiza todas las tarjetas. */
function pintarEstado(datos) {
  $('hostname').textContent = datos.hostname;

  // --- Batería ---
  pintarValor('bateria-valor', datos.bateria === null ? null : `${datos.bateria}%`);
  pintarBarra('bateria-barra', datos.bateria, true);
  $('bateria-estado').textContent = datos.estadoCarga ?? 'Sin batería detectada';

  // --- RAM ---
  // El operador ?. (optional chaining) devuelve undefined si datos.ram es null,
  // en vez de lanzar un error. Así el panel no se rompe si falta el dato.
  const ram = datos.ram;
  pintarValor('ram-valor', ram ? `${ram.porcentaje}%` : null);
  pintarBarra('ram-barra', ram?.porcentaje ?? null);
  $('ram-detalle').textContent = ram
    ? `${formatearBytes(ram.usadaBytes)} de ${formatearBytes(ram.totalBytes)}`
    : '—';

  // --- Disco ---
  const disco = datos.disco;
  pintarValor('disco-valor', disco ? `${disco.porcentaje}%` : null);
  pintarBarra('disco-barra', disco?.porcentaje ?? null);
  $('disco-detalle').textContent = disco
    ? `${formatearBytes(disco.usadoBytes)} usados · ${formatearBytes(disco.libreBytes)} libres`
    : '—';

  // --- Temperatura ---
  pintarValor('temp-valor', datos.temperaturaCpu === null ? null : `${datos.temperaturaCpu} °C`);
  // Umbrales orientativos para una laptop: hasta ~70 °C es normal en uso.
  let textoTemp = 'No se encontró un sensor';
  if (datos.temperaturaCpu !== null) {
    if (datos.temperaturaCpu >= 85) textoTemp = 'Muy caliente: revisa ventilación';
    else if (datos.temperaturaCpu >= 70) textoTemp = 'Algo caliente';
    else textoTemp = 'Temperatura normal';
  }
  $('temp-detalle').textContent = textoTemp;

  // --- Carga promedio ---
  const carga = datos.cargaPromedio;
  pintarValor('carga-valor', carga ? String(carga['1min']) : null);
  $('carga-detalle').textContent = carga
    ? `Último minuto · 5 min: ${carga['5min']} · 15 min: ${carga['15min']} · ${datos.nucleos} núcleos`
    : '—';

  // --- Uptime ---
  pintarValor('uptime-valor', datos.uptimeSegundos == null ? null : formatearUptime(datos.uptimeSegundos));

  // Hora local de la lectura (toLocaleTimeString usa el formato del navegador).
  $('ultima-actualizacion').textContent = new Date(datos.fecha).toLocaleTimeString();
}

/** Cambia el indicador de conexión de la cabecera. */
function pintarConexion(ok, mensaje) {
  const indicador = $('conexion');
  indicador.classList.toggle('ok', ok);
  indicador.classList.toggle('error', !ok);
  $('conexion-texto').textContent = mensaje;
}

// -----------------------------------------------------------------------------
// Petición a la API
// -----------------------------------------------------------------------------

/**
 * Pide /api/estado y pinta el resultado.
 *
 * Si falla (servidor apagado, red caída...), NO borramos los datos que ya se
 * ven: mostramos el indicador en rojo para avisar de que pueden estar
 * desactualizados. Es más útil que dejar la pantalla en blanco.
 */
async function actualizar() {
  try {
    // Ruta relativa: funciona igual con localhost o con la IP de la laptop.
    // cache: 'no-store' evita que el navegador nos devuelva una respuesta vieja.
    const respuesta = await fetch('/api/estado', { cache: 'no-store' });
    // fetch NO lanza error con códigos 4xx/5xx, así que lo comprobamos a mano.
    if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);

    const datos = await respuesta.json();
    pintarEstado(datos);
    pintarConexion(true, 'En línea');
  } catch (error) {
    console.error('No se pudo actualizar el estado:', error);
    pintarConexion(false, 'Sin conexión');
  } finally {
    // Programamos la siguiente actualización cuando esta termina (en lugar de
    // usar setInterval). Así, si el servidor tarda en responder, las peticiones
    // nunca se acumulan una encima de otra.
    setTimeout(actualizar, INTERVALO_MS);
  }
}

// Primera carga inmediata; las siguientes se encadenan solas cada 5 s.
actualizar();
