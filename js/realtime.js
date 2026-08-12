import { EVENTO_SESION_INVALIDA, supabase } from './supabase.js';

const ESQUEMA = 'damas';
const CLAVE_SALA = 'sala';
const TOPIC_SALA = 'sala-espera';
const DEBOUNCE_PARTIDA_MS = 140;
const EVENTOS_TABLERO = new Set(['movimiento', 'captura', 'coronacion']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const EVENTO_ESTADO_REALTIME = 'damas:realtime-estado';
export const ESTADOS_REALTIME = Object.freeze({
    CONECTADO: 'SUBSCRIBED',
    ERROR: 'CHANNEL_ERROR',
    AGOTADO: 'TIMED_OUT',
    CERRADO: 'CLOSED',
});

// Un registro por recurso impide abrir dos sockets logicos para la misma sala
// o partida. Los callbacks se multiplexan sobre el canal compartido.
const canales = new Map();
const clavesPorCanal = new WeakMap();

function validarCallback(callback) {
    if (typeof callback !== 'function') {
        throw new TypeError('La suscripcion Realtime necesita un callback.');
    }
}

function normalizarPartidaId(partidaId) {
    const id = String(partidaId ?? '').trim().toLocaleLowerCase('en');
    if (!UUID.test(id)) {
        throw new TypeError('El identificador de la partida no es un UUID valido.');
    }
    return id;
}

function invocarSeguro(callback, ...argumentos) {
    try {
        const resultado = callback(...argumentos);
        if (resultado && typeof resultado.catch === 'function') {
            resultado.catch((error) => {
                console.error('Error en un callback de Realtime:', error);
            });
        }
    } catch (error) {
        console.error('Error en un callback de Realtime:', error);
    }
}

function emitirEstado(registro, estado, error = null) {
    registro.estado = estado;
    registro.error = error;

    if (estado === ESTADOS_REALTIME.ERROR || estado === ESTADOS_REALTIME.AGOTADO) {
        console.error(`Realtime ${registro.clave}: ${estado}`, error ?? 'Sin detalle adicional.');
    }

    for (const callback of registro.callbacksEstado.values()) {
        invocarSeguro(callback, estado, registro.canal, error);
    }

    if (
        typeof globalThis.dispatchEvent === 'function' &&
        typeof globalThis.CustomEvent === 'function'
    ) {
        globalThis.dispatchEvent(new CustomEvent(EVENTO_ESTADO_REALTIME, {
            detail: {
                clave: registro.clave,
                estado,
                error,
            },
        }));
    }
}

function vaciarDebounce(listener) {
    if (listener.temporizador !== null) {
        globalThis.clearTimeout(listener.temporizador);
        listener.temporizador = null;
    }

    if (!listener.ultimoEvento) return;

    const evento = listener.ultimoEvento;
    const payload = listener.ultimoPayload;
    const eventosAgrupados = listener.eventosAgrupados.slice();

    listener.ultimoEvento = null;
    listener.ultimoPayload = null;
    listener.eventosAgrupados.length = 0;

    invocarSeguro(listener.callback, evento, payload, { eventosAgrupados });
}

function entregarEvento(listener, evento, payload) {
    const esCambioDeTablero = EVENTOS_TABLERO.has(evento?.tipo_evento);

    if (esCambioDeTablero && listener.debounceMs > 0) {
        listener.ultimoEvento = evento;
        listener.ultimoPayload = payload;
        listener.eventosAgrupados.push(evento);

        if (listener.temporizador !== null) {
            globalThis.clearTimeout(listener.temporizador);
        }

        listener.temporizador = globalThis.setTimeout(() => {
            vaciarDebounce(listener);
        }, listener.debounceMs);
        return;
    }

    // Conserva el orden: antes de una victoria o revancha se entrega cualquier
    // actualizacion de tablero que estuviera esperando el pequeno debounce.
    vaciarDebounce(listener);
    invocarSeguro(listener.callback, evento, payload, { eventosAgrupados: [evento] });
}

function entregarPayload(registro, payload) {
    const evento = payload?.new;
    if (!evento || typeof evento !== 'object') return;

    for (const listener of registro.listeners.values()) {
        entregarEvento(listener, evento, payload);
    }
}

function crearRegistro({ clave, topic, tabla, filter = undefined }) {
    const configuracion = {
        event: 'INSERT',
        schema: ESQUEMA,
        table: tabla,
    };

    if (filter) configuracion.filter = filter;

    const registro = {
        clave,
        topic,
        canal: null,
        estado: null,
        error: null,
        listeners: new Map(),
        callbacksEstado: new Map(),
        eliminacion: null,
    };

    const canal = supabase
        .channel(topic)
        .on('postgres_changes', configuracion, (payload) => {
            entregarPayload(registro, payload);
        });

    registro.canal = canal;
    canales.set(clave, registro);
    clavesPorCanal.set(canal, clave);

    try {
        canal.subscribe((estado, error) => {
            emitirEstado(registro, estado, error ?? null);
        });
    } catch (error) {
        canales.delete(clave);
        clavesPorCanal.delete(canal);
        emitirEstado(registro, ESTADOS_REALTIME.ERROR, error);
        throw error;
    }

    return registro;
}

function agregarCallbackEstado(registro, callback, propietario) {
    if (typeof callback !== 'function') return;

    registro.callbacksEstado.set(propietario, callback);

    // Si el canal ya estaba conectado, el consumidor nuevo tambien recibe su
    // estado sin obligar a crear otra suscripcion.
    if (registro.estado) {
        queueMicrotask(() => {
            if (registro.callbacksEstado.get(propietario) === callback) {
                invocarSeguro(callback, registro.estado, registro.canal, registro.error);
            }
        });
    }
}

function agregarListener(registro, callback, debounceMs) {
    const existente = registro.listeners.get(callback);
    if (existente) {
        existente.debounceMs = debounceMs;
        return;
    }

    registro.listeners.set(callback, {
        callback,
        debounceMs,
        temporizador: null,
        ultimoEvento: null,
        ultimoPayload: null,
        eventosAgrupados: [],
    });
}

function normalizarDebounce(valor) {
    if (valor === undefined) return DEBOUNCE_PARTIDA_MS;

    const numero = Number(valor);
    if (!Number.isFinite(numero)) return DEBOUNCE_PARTIDA_MS;
    return Math.min(1000, Math.max(0, numero));
}

/**
 * Escucha INSERT en damas.eventos_sala_espera. El callback recibe
 * (evento, payload). La comprobacion de jugador_destino_id corresponde al
 * controlador de sala, que conoce al jugador actual.
 */
export function suscribirseSala(callback, { onEstado } = {}) {
    validarCallback(callback);

    const registro = canales.get(CLAVE_SALA) ?? crearRegistro({
        clave: CLAVE_SALA,
        topic: TOPIC_SALA,
        tabla: 'eventos_sala_espera',
    });

    agregarListener(registro, callback, 0);
    agregarCallbackEstado(registro, onEstado, callback);

    return registro.canal;
}

/**
 * Escucha los eventos de una unica partida. movimiento/captura/coronacion se
 * agrupan durante 140 ms por defecto para que una rafaga provoque una sola
 * recarga de v_tablero_partida y v_resumen_partida en el controlador.
 */
export function suscribirsePartida(
    partidaId,
    callback,
    { onEstado, debounceMs = DEBOUNCE_PARTIDA_MS } = {},
) {
    validarCallback(callback);

    const id = normalizarPartidaId(partidaId);
    const clave = `partida:${id}`;
    const registro = canales.get(clave) ?? crearRegistro({
        clave,
        topic: `partida-${id}`,
        tabla: 'eventos_partida',
        filter: `partida_id=eq.${id}`,
    });

    agregarListener(registro, callback, normalizarDebounce(debounceMs));
    agregarCallbackEstado(registro, onEstado, callback);

    return registro.canal;
}

function registroPorTexto(valor) {
    const texto = String(valor ?? '').trim();
    if (!texto) return null;

    if (canales.has(texto)) return canales.get(texto);
    if (['sala-espera', 'damas-sala-espera', 'realtime:sala-espera'].includes(texto)) {
        return canales.get(CLAVE_SALA) ?? null;
    }

    const sinPrefijoRealtime = texto.startsWith('realtime:')
        ? texto.slice('realtime:'.length)
        : texto;

    if (sinPrefijoRealtime.startsWith('partida-')) {
        const id = sinPrefijoRealtime.slice('partida-'.length).toLocaleLowerCase('en');
        return canales.get(`partida:${id}`) ?? null;
    }

    for (const registro of canales.values()) {
        if (registro.topic === sinPrefijoRealtime) return registro;
    }

    return null;
}

function encontrarRegistro(claveOCanal) {
    if (typeof claveOCanal === 'string') return registroPorTexto(claveOCanal);
    if (!claveOCanal || typeof claveOCanal !== 'object') return null;

    const clave = clavesPorCanal.get(claveOCanal);
    return clave ? canales.get(clave) ?? null : null;
}

function limpiarRegistro(registro) {
    for (const listener of registro.listeners.values()) {
        if (listener.temporizador !== null) {
            globalThis.clearTimeout(listener.temporizador);
        }
        listener.temporizador = null;
        listener.ultimoEvento = null;
        listener.ultimoPayload = null;
        listener.eventosAgrupados.length = 0;
    }

    registro.listeners.clear();
    registro.callbacksEstado.clear();
}

/**
 * Elimina por clave ("sala" o "partida:UUID"), topic ("partida-UUID") o por
 * el objeto RealtimeChannel devuelto al suscribirse. Es seguro llamarla mas de
 * una vez con el mismo canal.
 */
export async function eliminarCanal(claveOCanal) {
    const registro = encontrarRegistro(claveOCanal);

    if (!registro) {
        // Permite limpiar tambien un RealtimeChannel valido aunque no haya sido
        // creado por este modulo; no intenta interpretar otros objetos.
        if (
            claveOCanal &&
            typeof claveOCanal === 'object' &&
            typeof claveOCanal.unsubscribe === 'function'
        ) {
            return supabase.removeChannel(claveOCanal);
        }
        return false;
    }

    if (registro.eliminacion) return registro.eliminacion;

    canales.delete(registro.clave);
    limpiarRegistro(registro);

    registro.eliminacion = (async () => {
        try {
            return await supabase.removeChannel(registro.canal);
        } catch (error) {
            console.error(`No se pudo eliminar el canal ${registro.clave}.`, error);
            return 'error';
        } finally {
            clavesPorCanal.delete(registro.canal);
        }
    })();

    return registro.eliminacion;
}

/** Elimina todos los canales administrados por este modulo. */
export async function eliminarTodosLosCanales() {
    const registros = Array.from(canales.values());
    return Promise.all(registros.map((registro) => eliminarCanal(registro.canal)));
}

/** Util para diagnostico/UI; no expone ni modifica el Map interno. */
export function obtenerEstadoCanales() {
    return Array.from(canales.values(), ({ clave, topic, estado }) => ({
        clave,
        topic,
        estado,
    }));
}

// El heartbeat publica este evento antes de que el controlador redirija. Asi
// las suscripciones se detienen incluso si la pantalla olvida hacerlo.
if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener(EVENTO_SESION_INVALIDA, () => {
        void eliminarTodosLosCanales();
    });
}
