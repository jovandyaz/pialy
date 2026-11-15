# Pialy

Tu lugar, guardado al instante.

## Qué es

Un negocio que trabaja con citas pide un anticipo de $0.01 MXN con CoDi para apartar un horario. El horario queda apartado mientras vive la solicitud de cobro y se confirma solo cuando el banco confirma el pago; el cliente recibe un pase que el negocio verifica una sola vez.

## Cómo usa CoDi (vía pey)

El servidor es el único que habla con pey (`packages/connector-pey`):

- `POST /codi/pn`: cobro CoDi por notificación al celular que escribió el cliente (expira en 360 s).
- `POST /codi/qr`: QR CoDi de respaldo para la misma reserva (hasta 3 intentos de cobro por reserva, contando el push).
- `GET /transaction/{id}` y `GET /transaction/codi/qr/{idc}`: consulta del estado de un cobro push o QR.
- Las consultas (GET) se reintentan ante fallas de red o 5xx; un POST solo se reintenta si la respuesta prueba que pey no lo procesó.

Confirmación del pago:

- **Webhook firmado** en `POST /api/webhooks/pey`: firma Standard Webhooks verificada sobre el cuerpo crudo (401 si no es válida); cada `webhook-id` se registra en una bandeja de entrada en la misma transacción que su efecto, así que un webhook repetido no hace nada. El mismo pago tampoco se aplica dos veces aunque llegue por webhook y por consulta.
- **Barrido cada 15 s** (con candado de Postgres para una sola instancia activa): antes de liberar un apartado vencido consulta a pey; si está pagado lo aplica, si no lo vence y libera el horario. Cada cuarto barrido revisa también los intentos vencidos en los últimos 30 min, por si el pago llegó tarde.

Política de pagos:

- Pago mientras el horario sigue apartado: se confirma.
- Pago tardío: si el horario sigue libre se confirma marcado como tardío; si ya lo tomó otra persona, queda una devolución pendiente.
- Pago repetido, sobre una cita ya pagada o cancelada, o sin reserva: devolución pendiente visible en el tablero del negocio.
- Las devoluciones se hacen a mano por SPEI y se registran con una nota en el tablero.

## Arquitectura

```
Celular del cliente ─┐                         ┌─ pey API (CoDi push, QR, consulta)
Celular del dueño ───┤ HTTP + SSE              │
                     ▼                         │
            Fastify (API /api/*, SSE, SPA) ────┤
              ├─ barrido cada 15 s             │
              └─ outbox → SSE                  │
                     │                         │
                     ▼                         │
                 Postgres          pey ── webhook firmado ──▶ Fastify
```

- `packages/payments`: dominio de pagos sin I/O (intención de pago, intentos, dinero, máquina de estados, puertos).
- `packages/connector-pey`: implementa el conector de pey (cliente HTTP, validación con Zod, firma de webhooks).
- `apps/server`: Fastify; reservas, sesión del dueño, tablero, webhook, barrido, outbox y SSE; Drizzle sobre Postgres. Sirve la SPA compilada.
- `apps/web`: SPA en React + Vite (reservar, esperar el pago, pase, tablero, verificar pase).

## Correrlo

Requisitos: Node 24 (`.nvmrc`), pnpm y Docker (para la base de pruebas).

```sh
pnpm install
cp .env.example .env   # completa los valores
pnpm -r build
node apps/server/dist/migrate.js && node apps/server/dist/seed.js && node apps/server/dist/main.js
```

Variables de entorno (`.env.example`):

| Variable | Para qué |
|---|---|
| `NODE_ENV` | `development`, `test` o `production`; en producción todas las de abajo son obligatorias. |
| `PORT` | Puerto HTTP (3000 por defecto). |
| `DATABASE_URL` | Conexión a Postgres. |
| `PEY_API_KEY` | Llave de la API de pey. |
| `PEY_BASE_URL` | URL base de la API de pey. |
| `PEY_WEBHOOK_SECRET` | Secreto para verificar la firma de los webhooks de pey. |
| `BUSINESS_PIN` | PIN del tablero del negocio (6 dígitos o más). |
| `COOKIE_SECRET` | Firma la cookie de sesión del dueño (32 caracteres o más). |
| `PHONE_HASH_SALT` | Sal del hash del celular (límites por número). |
| `PUBLIC_BASE_URL` | URL pública del servicio. |
| `DEMO_DEPOSIT_CENTS` | Monto del anticipo en centavos; solo acepta `1`. |
| `WEB_ROOT` | Carpeta de la SPA compilada (por defecto `apps/web/dist`). |

Pruebas (Postgres en el puerto 54329; otra base con `TEST_DATABASE_URL`):

```sh
docker compose -f docker-compose.test.yml up -d
pnpm test
pnpm -r typecheck
pnpm lint
```

## Privacidad

- Del celular solo se guardan los últimos 4 dígitos y un hash con sal; el número completo nunca se guarda ni se registra en logs.
- El monto lo fija el servidor; ninguna solicitud del cliente lleva monto.
- El cliente nunca confirma un pago: solo el webhook verificado o la consulta a pey lo hacen.

## Limitaciones conocidas

- Un solo negocio.
- Las devoluciones son manuales por SPEI.
- Cerrar sesión solo borra la cookie del dueño; la sesión dura 12 h.
- Tras 20 PIN incorrectos en 10 min (de cualquier origen) nadie puede entrar al tablero durante esa ventana.
- Alguien que escriba el celular de otra persona puede impedirle apartar con ese número hasta por 10 min.

## Componentes previos

Ninguno.

## Licencia

Functional Source License 1.1 con licencia futura MIT (FSL-1.1-MIT). Ver `LICENSE`.
