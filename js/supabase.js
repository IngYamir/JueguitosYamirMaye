import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// -----------------------------------------------------------------------------
// CONFIGURACION DE SUPABASE
// Reemplaza solamente estos dos valores con los datos publicos de tu proyecto.
// La clave debe ser la Publishable key (o la anon key heredada), nunca una clave
// privada del servidor ni la contrasena de PostgreSQL.
// -----------------------------------------------------------------------------
export const SUPABASE_URL = 'https://ynwcnwfejyrylosijciy.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_GIbjR2aaUWIH5JkkdKGP7w_h2pqW-ig';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
        // El juego usa damas.sesiones_jugador, no Supabase Auth.
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
    },
});

// Todas las tablas, vistas y RPC del juego viven en el esquema "damas".
export const damasDB = supabase.schema('damas');

export const CLAVES_SESION = Object.freeze({
    sesionId: 'damas_sesion_id',
    jugadorId: 'damas_jugador_id',
    nombreUsuario: 'damas_nombre_usuario',
    foto: 'damas_foto',
    partidaId: 'damas_partida_id',
});

export const EVENTO_SESION_INVALIDA = 'damas:sesion-invalida';
export const INTERVALO_HEARTBEAT_MS = 4 * 60 * 1000;

export const FOTOS_LOCALES = Object.freeze({
    Yamir: './img/Yamir.jpeg',
    Febe: './img/Maye.jpeg',
    Maye: './img/Maye.jpeg',
});

const fotosLocalesNormalizadas = new Map(
    Object.entries(FOTOS_LOCALES).map(([nombre, ruta]) => [
        nombre.trim().toLocaleLowerCase('es'),
        ruta,
    ]),
);

const intentosDeFoto = new WeakMap();

let heartbeatIntervalo = null;
let heartbeatVisibilidad = null;
let heartbeatEnCurso = null;
let heartbeatSesionId = null;
let heartbeatVersion = 0;
let heartbeatAlInvalidar = null;
let heartbeatAlFallar = null;

function obtenerAlmacenamientoSesion() {
    try {
        return globalThis.sessionStorage ?? null;
    } catch (error) {
        console.error('No fue posible acceder a sessionStorage.', error);
        return null;
    }
}

function leerValor(storage, clave) {
    const valor = storage?.getItem(clave);
    return typeof valor === 'string' && valor.trim() ? valor : null;
}

function obtenerCampo(datos, nombres) {
    for (const nombre of nombres) {
        if (Object.prototype.hasOwnProperty.call(datos, nombre)) {
            return { presente: true, valor: datos[nombre] };
        }
    }

    return { presente: false, valor: undefined };
}

function guardarCampo(storage, clave, campo) {
    if (!campo.presente) return;

    if (campo.valor === null || campo.valor === undefined || String(campo.valor).trim() === '') {
        storage.removeItem(clave);
        return;
    }

    storage.setItem(clave, String(campo.valor));
}

/**
 * Recupera exclusivamente los datos propios de la aplicacion. Nunca se guarda
 * ni se devuelve la contrasena del jugador.
 */
export function obtenerSesionGuardada() {
    const storage = obtenerAlmacenamientoSesion();

    return {
        sesionId: leerValor(storage, CLAVES_SESION.sesionId),
        jugadorId: leerValor(storage, CLAVES_SESION.jugadorId),
        nombreUsuario: leerValor(storage, CLAVES_SESION.nombreUsuario),
        foto: leerValor(storage, CLAVES_SESION.foto),
        partidaId: leerValor(storage, CLAVES_SESION.partidaId),
    };
}

/**
 * Guarda una parte o la totalidad de la sesion. Acepta tanto nombres camelCase
 * del frontend como los nombres snake_case devueltos por las RPC.
 */
export function guardarSesion(datos = {}) {
    if (!datos || typeof datos !== 'object') {
        throw new TypeError('Los datos de sesion deben ser un objeto.');
    }

    const storage = obtenerAlmacenamientoSesion();
    if (!storage) {
        throw new Error('El navegador no permite guardar la sesion en esta pestana.');
    }

    guardarCampo(
        storage,
        CLAVES_SESION.sesionId,
        obtenerCampo(datos, ['sesionId', 'sesion_id']),
    );
    guardarCampo(
        storage,
        CLAVES_SESION.jugadorId,
        obtenerCampo(datos, ['jugadorId', 'jugador_id']),
    );
    guardarCampo(
        storage,
        CLAVES_SESION.nombreUsuario,
        obtenerCampo(datos, ['nombreUsuario', 'nombre_usuario']),
    );
    guardarCampo(
        storage,
        CLAVES_SESION.foto,
        obtenerCampo(datos, ['foto', 'fotoPerfilUrl', 'foto_perfil_url']),
    );
    guardarCampo(
        storage,
        CLAVES_SESION.partidaId,
        obtenerCampo(datos, ['partidaId', 'partida_id']),
    );

    return obtenerSesionGuardada();
}

/** Borra solo las claves damas_* conocidas, sin afectar datos de otras apps. */
export function limpiarSesionDamas() {
    detenerHeartbeat();

    const storage = obtenerAlmacenamientoSesion();
    if (!storage) return;

    for (const clave of new Set(Object.values(CLAVES_SESION))) {
        storage.removeItem(clave);
    }
}

/** Limpieza local deliberada; no invoca por si sola ninguna RPC. */
export function cerrarSesionLocal() {
    limpiarSesionDamas();
}

/**
 * Da prioridad a las fotos empaquetadas con el juego. Las rutas antiguas de la
 * base se ignoran porque no existen en este frontend.
 */
export function resolverFotoPerfil(nombreUsuario, fotoBaseDatos) {
    const nombreNormalizado = String(nombreUsuario ?? '')
        .trim()
        .toLocaleLowerCase('es');
    const fotoLocal = fotosLocalesNormalizadas.get(nombreNormalizado);

    if (fotoLocal) return fotoLocal;

    const foto = String(fotoBaseDatos ?? '').trim();
    return /^https?:\/\//i.test(foto) ? foto : null;
}

function inicialDe(nombreUsuario) {
    const nombre = String(nombreUsuario ?? '').trim();
    return nombre ? Array.from(nombre)[0].toLocaleUpperCase('es') : '?';
}

function resolverElemento(elemento) {
    if (typeof elemento !== 'string') return elemento ?? null;
    return globalThis.document?.querySelector(elemento) ?? null;
}

function crearFallbackSiHaceFalta(imagen, fallback) {
    if (fallback || !imagen?.parentElement || !globalThis.document) return fallback;

    const inicial = document.createElement('span');
    inicial.className = 'avatar-inicial foto-fallback';
    imagen.insertAdjacentElement('afterend', inicial);
    return inicial;
}

/**
 * Aplica una foto sin dejar visible el icono de imagen rota. Si la URL no es
 * valida o falla la descarga, muestra la inicial del nombre.
 */
export function aplicarFotoPerfil(imagen, fallback, nombreUsuario, fotoBaseDatos) {
    const elementoImagen = resolverElemento(imagen);
    let elementoFallback = resolverElemento(fallback);

    if (!elementoImagen) return null;

    elementoFallback = crearFallbackSiHaceFalta(elementoImagen, elementoFallback);

    const inicial = inicialDe(nombreUsuario);
    const url = resolverFotoPerfil(nombreUsuario, fotoBaseDatos);
    const intento = (intentosDeFoto.get(elementoImagen) ?? 0) + 1;
    intentosDeFoto.set(elementoImagen, intento);

    elementoImagen.alt = nombreUsuario
        ? `Foto de ${String(nombreUsuario).trim()}`
        : 'Foto de perfil';
    elementoImagen.setAttribute?.('decoding', 'async');

    if (elementoFallback) {
        elementoFallback.textContent = inicial;
        elementoFallback.setAttribute?.(
            'aria-label',
            nombreUsuario ? `Inicial de ${String(nombreUsuario).trim()}` : 'Foto de perfil',
        );
    }

    const mostrarFallback = () => {
        if (intentosDeFoto.get(elementoImagen) !== intento) return;

        elementoImagen.onload = null;
        elementoImagen.onerror = null;
        elementoImagen.removeAttribute?.('src');
        elementoImagen.hidden = true;
        elementoImagen.classList?.add('oculto');
        elementoImagen.setAttribute?.('aria-hidden', 'true');
        if (elementoImagen.style) elementoImagen.style.display = 'none';

        if (elementoFallback) {
            elementoFallback.hidden = false;
            elementoFallback.classList?.remove('oculto');
            elementoFallback.removeAttribute?.('aria-hidden');
            if (elementoFallback.style) elementoFallback.style.display = '';
        }
    };

    const mostrarImagen = () => {
        if (intentosDeFoto.get(elementoImagen) !== intento) return;

        elementoImagen.hidden = false;
        elementoImagen.classList?.remove('oculto');
        elementoImagen.removeAttribute?.('aria-hidden');
        if (elementoImagen.style) elementoImagen.style.display = '';
        if (elementoFallback) {
            elementoFallback.hidden = true;
            elementoFallback.classList?.add('oculto');
            elementoFallback.setAttribute?.('aria-hidden', 'true');
            if (elementoFallback.style) elementoFallback.style.display = 'none';
        }
    };

    // Se oculta hasta confirmar la carga para que nunca aparezca el icono roto.
    elementoImagen.hidden = true;
    elementoImagen.classList?.add('oculto');
    elementoImagen.setAttribute?.('aria-hidden', 'true');
    if (elementoImagen.style) elementoImagen.style.display = 'none';
    if (elementoFallback) {
        elementoFallback.hidden = false;
        elementoFallback.classList?.remove('oculto');
        elementoFallback.removeAttribute?.('aria-hidden');
        if (elementoFallback.style) elementoFallback.style.display = '';
    }

    if (!url) {
        mostrarFallback();
        return null;
    }

    elementoImagen.onload = mostrarImagen;
    elementoImagen.onerror = mostrarFallback;
    elementoImagen.src = url;

    // Las imagenes en cache pueden estar completas antes de que el navegador
    // programe el evento load.
    if (elementoImagen.complete && elementoImagen.naturalWidth > 0) {
        queueMicrotask(mostrarImagen);
    }

    return url;
}

function textoDeError(error) {
    if (typeof error === 'string') return error;
    if (!error || typeof error !== 'object') return '';

    const partes = [
        error.message,
        error.details,
        error.hint,
        error.error_description,
        error.cause?.message,
    ];

    return partes.filter((parte) => typeof parte === 'string' && parte.trim()).join(' ');
}

function normalizarTexto(texto) {
    return String(texto ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('es');
}

/**
 * Detecta fallos de instalacion de la Data API que no pueden corregirse
 * cambiando el usuario o la contrasena. PostgREST usa PGRST106 cuando el
 * cliente solicita un esquema que existe, pero no esta expuesto por la API.
 */
export function esErrorConfiguracionSupabase(error) {
    const codigo = String(error?.code ?? '').trim().toLocaleUpperCase('en');
    const texto = normalizarTexto(textoDeError(error));

    return (
        codigo === 'PGRST106' ||
        codigo === 'PGRST202' ||
        codigo === 'PGRST205' ||
        texto.includes('invalid schema: damas') ||
        texto.includes('schema must be one of the following') ||
        texto.includes('could not find the function damas.') ||
        texto.includes('could not find the table damas.')
    );
}

const ERRORES_CONOCIDOS = Object.freeze([
    ['credenciales invalidas', 'Credenciales invalidas. Revisa el usuario y la contrasena.'],
    [
        'solo pueden haber 2 jugadores conectados',
        'Solo pueden haber 2 jugadores conectados al mismo tiempo.',
    ],
    ['sesion invalida o vencida', 'La sesion es invalida o vencio. Inicia sesion nuevamente.'],
    ['no es el turno de este jugador', 'Todavia no es tu turno.'],
    ['la casilla destino esta ocupada', 'La casilla de destino esta ocupada.'],
    [
        'no existe una ficha activa en la casilla origen',
        'Ya no hay una ficha activa en la casilla de origen.',
    ],
    [
        'la ficha no pertenece al jugador del turno',
        'Esa ficha no pertenece al jugador que tiene el turno.',
    ],
    [
        'debe continuar la captura multiple con la misma ficha',
        'Debes continuar la captura multiple con la misma ficha.',
    ],
    ['movimiento invalido para una ficha normal', 'Ese movimiento no es valido para esta ficha.'],
    ['no hay una ficha para capturar', 'No hay una ficha rival para capturar en ese movimiento.'],
    ['partida inexistente', 'La partida no existe o ya no esta disponible.'],
    ['la partida ya no esta activa', 'La partida ya termino y no admite mas movimientos.'],
    ['coordenadas fuera del tablero', 'Las coordenadas del movimiento estan fuera del tablero.'],
    ['la casilla destino no es una casilla jugable', 'Esa casilla no se puede usar para jugar.'],
    ['el movimiento debe ser diagonal', 'Las fichas deben moverse en diagonal.'],
    ['no puede capturar una ficha propia', 'No puedes capturar una ficha propia.'],
    ['la dama no puede atravesar mas de una ficha', 'La dama no puede atravesar mas de una ficha en un salto.'],
    ['debe continuar capturando con la misma ficha', 'Debes continuar capturando con la misma ficha.'],
    ['la captura multiple debe continuar con la misma ficha', 'La captura multiple debe continuar con la misma ficha.'],
    ['la ficha rival ya no esta disponible para capturar', 'La ficha rival ya fue movida o capturada.'],
    ['la dama no puede saltar una ficha propia', 'La dama no puede saltar una ficha propia.'],
    [
        'al capturar, la dama debe quedar justo despues de la ficha capturada',
        'La dama debe quedar justo despues de la ficha capturada.',
    ],
    [
        'primero el perdedor debe enviar el mensaje positivo al ganador',
        'Primero el perdedor debe enviar el mensaje positivo al ganador.',
    ],
    ['la partida no esta finalizada', 'La partida todavia no esta finalizada.'],
    ['solo el perdedor puede enviar este mensaje', 'Solo el perdedor puede enviar el mensaje positivo.'],
    ['el mensaje debe tener entre 1 y 500 caracteres', 'El mensaje debe tener entre 1 y 500 caracteres.'],
    ['el jugador no pertenece a esta partida', 'Tu jugador no pertenece a esta partida.'],
    ['el jugador ya esta en una partida activa', 'Ya tienes una partida activa. Volveremos a recuperarla.'],
]);

/** Convierte errores de PostgREST/PostgreSQL en mensajes breves para la UI. */
export function mensajeError(error, mensajePredeterminado = 'No se pudo completar la operacion.') {
    const textoOriginal = textoDeError(error);
    const textoNormalizado = normalizarTexto(textoOriginal);
    const codigo = String(error?.code ?? '').trim().toLocaleUpperCase('en');

    if (
        codigo === 'PGRST106' ||
        textoNormalizado.includes('invalid schema: damas') ||
        textoNormalizado.includes('schema must be one of the following')
    ) {
        return 'El esquema "damas" no esta habilitado en la Data API de Supabase. Agregalo en Data API > Exposed schemas y recarga esta pagina.';
    }

    if (
        codigo === 'PGRST202' ||
        codigo === 'PGRST205' ||
        textoNormalizado.includes('could not find the function damas.') ||
        textoNormalizado.includes('could not find the table damas.')
    ) {
        return 'La API de Supabase no encuentra las funciones o vistas del juego. Ejecuta el script SQL completo y recarga el esquema de la Data API.';
    }

    for (const [fragmento, mensaje] of ERRORES_CONOCIDOS) {
        if (textoNormalizado.includes(fragmento)) return mensaje;
    }

    if (
        textoNormalizado.includes('failed to fetch') ||
        textoNormalizado.includes('networkerror') ||
        textoNormalizado.includes('network request failed') ||
        textoNormalizado.includes('load failed')
    ) {
        return 'No se pudo conectar con el juego. Revisa tu conexion e intenta de nuevo.';
    }

    if (
        textoNormalizado.includes('invalid input syntax for type uuid') ||
        textoNormalizado.includes('uuid') && textoNormalizado.includes('invalid')
    ) {
        return 'Los datos de la sesion o de la partida no son validos.';
    }

    if (error?.name === 'AbortError') {
        return 'La operacion tardo demasiado. Intenta de nuevo.';
    }

    // Conserva los mensajes breves creados deliberadamente por el frontend,
    // pero no muestra detalles tecnicos arbitrarios de PostgREST/PostgreSQL.
    if (
        error instanceof Error &&
        !('code' in error) &&
        textoOriginal.length > 0 &&
        textoOriginal.length <= 180
    ) {
        return textoOriginal;
    }

    return mensajePredeterminado;
}

export function esErrorSesion(error) {
    if (error === false) return true;

    const texto = normalizarTexto(textoDeError(error));
    return (
        texto.includes('sesion invalida o vencida') ||
        texto.includes('sesion vencida') ||
        texto.includes('sesion expirada')
    );
}

function ejecutarCallbackSeguro(callback, ...argumentos) {
    if (typeof callback !== 'function') return;

    try {
        const resultado = callback(...argumentos);
        if (resultado && typeof resultado.catch === 'function') {
            resultado.catch((error) => console.error('Error en callback de sesion.', error));
        }
    } catch (error) {
        console.error('Error en callback de sesion.', error);
    }
}

function emitirSesionInvalida(detalle) {
    if (typeof globalThis.dispatchEvent !== 'function' || typeof globalThis.CustomEvent !== 'function') {
        return;
    }

    globalThis.dispatchEvent(new CustomEvent(EVENTO_SESION_INVALIDA, { detail: detalle }));
}

async function ejecutarHeartbeat(version) {
    if (
        version !== heartbeatVersion ||
        !heartbeatSesionId ||
        heartbeatEnCurso
    ) {
        return heartbeatEnCurso;
    }

    const sesionId = heartbeatSesionId;

    const peticion = (async () => {
        const { data, error } = await damasDB.rpc('fn_mantener_sesion', {
            p_sesion_id: sesionId,
        });

        if (version !== heartbeatVersion || sesionId !== heartbeatSesionId) return null;

        if (error) {
            console.error('Error original al mantener la sesion:', error);

            if (!esErrorSesion(error)) {
                ejecutarCallbackSeguro(heartbeatAlFallar, error, mensajeError(error));
                return false;
            }
        }

        if (error || data !== true) {
            const detalle = {
                sesionId,
                error: error ?? null,
                mensaje: 'La sesion vencio. Inicia sesion nuevamente.',
            };
            const alInvalidar = heartbeatAlInvalidar;

            detenerHeartbeat();
            limpiarSesionDamas();
            emitirSesionInvalida(detalle);
            ejecutarCallbackSeguro(alInvalidar, detalle);
            return false;
        }

        return true;
    })();

    heartbeatEnCurso = peticion;

    try {
        return await peticion;
    } catch (error) {
        if (version === heartbeatVersion) {
            console.error('Error inesperado en el heartbeat:', error);
            ejecutarCallbackSeguro(heartbeatAlFallar, error, mensajeError(error));
        }
        return false;
    } finally {
        if (heartbeatEnCurso === peticion) heartbeatEnCurso = null;
    }
}

/**
 * Inicia un unico heartbeat compartido. Una segunda llamada reemplaza de forma
 * segura al heartbeat anterior, evitando intervalos y peticiones duplicados.
 */
export function iniciarHeartbeat({
    sesionId = obtenerSesionGuardada().sesionId,
    onSesionInvalida,
    onError,
    intervaloMs = INTERVALO_HEARTBEAT_MS,
    inmediato = true,
} = {}) {
    detenerHeartbeat();

    const id = String(sesionId ?? '').trim();
    if (!id) return null;

    heartbeatSesionId = id;
    heartbeatAlInvalidar = onSesionInvalida;
    heartbeatAlFallar = onError;

    const version = heartbeatVersion;
    const periodo = Number.isFinite(intervaloMs) && intervaloMs > 0
        ? intervaloMs
        : INTERVALO_HEARTBEAT_MS;

    heartbeatIntervalo = globalThis.setInterval(() => {
        void ejecutarHeartbeat(version);
    }, periodo);

    if (globalThis.document?.addEventListener) {
        heartbeatVisibilidad = () => {
            if (document.visibilityState === 'visible') {
                void ejecutarHeartbeat(version);
            }
        };
        document.addEventListener('visibilitychange', heartbeatVisibilidad);
    }

    if (inmediato) void ejecutarHeartbeat(version);

    return detenerHeartbeat;
}

export function detenerHeartbeat() {
    heartbeatVersion += 1;

    if (heartbeatIntervalo !== null) {
        globalThis.clearInterval(heartbeatIntervalo);
        heartbeatIntervalo = null;
    }

    if (heartbeatVisibilidad && globalThis.document?.removeEventListener) {
        document.removeEventListener('visibilitychange', heartbeatVisibilidad);
    }

    heartbeatVisibilidad = null;
    heartbeatEnCurso = null;
    heartbeatSesionId = null;
    heartbeatAlInvalidar = null;
    heartbeatAlFallar = null;
}
