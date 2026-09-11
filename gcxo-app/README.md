# App de cambios de turno GCXO — cambios pendientes de subir

⚠️ **Este NO es el hogar del proyecto.** El repositorio del proyecto es
`deltagolf/cambiosGCXO`, y el código vive en el proyecto de Apps Script
`1t5cGrVKxr9ELI-F5FFZkCoN4qOPEvY2OqqXbk2MGPNROmpNhhV6eTrNt`
(«Macros grabadas (Turneros GCXO)», de turnerosgcxo@gmail.com).

Esta carpeta es solo un depósito temporal: la sesión que hizo estos cambios no
tenía permiso para subirlos con clasp, y el contenedor es efímero. Se deja aquí
para que el trabajo no se pierda.

`src/` sale de exportar el proyecto entero y aplicar los cambios de abajo, así
que se puede subir tal cual con `clasp push` desde una cuenta con acceso.

## Qué cambia

1. **Arreglo · caché de CONTROLADORES** (`Turnero.gs`)
   `leerControladoresCache()` leía de `controladores_<CACHE_V>` y escribía en
   `controladores`, así que el `get` no acertaba nunca y cada llamada releía la
   hoja entera. La escritura pasa a llevar el sufijo.

2. **Arreglo · anti-solapamiento en `registrarCambioAdmin`** (`Backend.gs`)
   La vía de admin no comprobaba `_bloqueados()`, así que era la única forma de
   dejar dos solicitudes reservando la misma celda. Ahora comprueba, bajo lock y
   con lectura fresca, igual que `registrarCambio`. De paso rechaza meses pasados.

3. **Nuevo · cambio directo entre controladores** (`Backend.gs`, `Js.html`)
   El admin aplica un cambio entre dos controladores desde «Gestión →
   Incidencias» sin la ronda de solicitud / aceptación / validación.
   - `candidatosCambioAdmin(token, mes, dia, cta)` — con quién puede cambiar otro
     controlador. Mismo núcleo que la lista del calendario (`_candidatosPara`,
     extraído de `_candidatosCadena`), pero en nombre de un tercero y sin ocultar
     a quien haya marcado 🔒 (sale al final, marcado).
   - `cambioDirectoAdmin(token, mes, movimientos, opts)` — lo aplica: fila en
     CAMBIOS ya TRANSCRITO, escritura del turnero por `_aplicarTurnoCelda`
     (LOG_CELDAS → deshacible) y línea en LOG_CAMBIOS.

   Lo que **no** se salta: la legalidad se comprueba igual (se puede forzar, y
   entonces las violaciones quedan escritas en la fila); la regla `ESTADO` no se
   fuerza nunca; una solicitud en curso sobre esos días detiene el cambio y solo
   se sigue anulándola explícitamente.

## Pruebas

`test/` monta un Apps Script simulado y carga los `.gs` de verdad:

    node test/test.js     # 63 comprobaciones

Cubre el motor, los dos arreglos y el cambio directo (camino feliz, balance,
legalidad, forzado, choque con solicitudes, permisos y jefaturas).
