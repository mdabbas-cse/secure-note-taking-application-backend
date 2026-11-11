# Secure Notes API (backend)

Backend of a secure note-taking application. The focus is authentication, role-based
access control, a deliberately minimal MongoDB indexing strategy that is verified with
`explain('executionStats')`, single-call aggregation pipelines, and pagination on every
list endpoint. The React frontend lives in a separate repository (`secure-notes-frontend`).

- Users keep **private notes**. Only the owner can see them; admins can read everyone's.
- Users publish **public posts** that every authenticated user can read.
- Admins **manage users** and can view users **grouped by interest**.

|                     |                                                                        |
| ------------------- | ---------------------------------------------------------------------- |
| Live API            | `https://<your-backend-project>.vercel.app` (fill in after deployment) |
| Health check        | `https://<your-backend-project>.vercel.app/api/health`                 |
| Frontend repository | `https://github.com/<your-account>/secure-notes-frontend`              |

---

## Contents

1. [Technology stack](#1-technology-stack)
2. [Architecture](#2-architecture)
3. [Installation](#3-installation)
4. [Environment configuration](#4-environment-configuration)
5. [Database setup](#5-database-setup)
6. [API endpoints](#6-api-endpoints)
7. [Authentication workflow](#7-authentication-workflow)
8. [Role-based access control](#8-role-based-access-control)
9. [Database schemas](#9-database-schemas)
10. [MongoDB indexing strategy](#10-mongodb-indexing-strategy)
11. [Aggregation pipelines](#11-aggregation-pipelines)
12. [Pagination](#12-pagination)
13. [API examples (curl)](#13-api-examples-curl)
14. [Testing](#14-testing)
15. [Design decisions and limitations](#15-design-decisions-and-limitations)
16. [Deployment on Vercel](#16-deployment-on-vercel)
17. [Troubleshooting](#17-troubleshooting)

---

## 1. Technology stack

| Layer    | Technology                                                                     |
| -------- | ------------------------------------------------------------------------------ |
| Runtime  | Node.js 24.x, TypeScript 6 (strict), ESM                                       |
| API      | Express 5, Zod 4 (validation), Helmet, CORS, cookie-parser, express-rate-limit |
| Auth     | jsonwebtoken (HS256), bcrypt                                                   |
| Database | MongoDB 8, Mongoose 9                                                          |
| Tests    | Vitest, Supertest, mongodb-memory-server (real `mongod`, MongoDB 8.2)          |
| Hosting  | Vercel (zero-config Express preset, Fluid compute), MongoDB Atlas              |
| Tooling  | ESLint (typescript-eslint, type-checked rules), Prettier, tsx, Docker Compose  |

TypeScript is pinned to 6.0 because typescript-eslint does not support TypeScript 7 yet.

## 2. Architecture

```
.
├── docker-compose.yml          MongoDB 8 for local development
├── src/
│   ├── app.ts                  Vercel entry: `export default app`, loads createApp() (JSON 500 on bad config)
│   ├── createApp.ts            builds the Express app (middleware, routes, error handling)
│   ├── server.ts               local/self-hosted server: connect, app.listen, graceful shutdown
│   ├── config/                 env.ts (Zod-validated, throws on bad config), database.ts (cached connection)
│   ├── models/                 User / Note / Post schemas + documented schema.index() calls
│   ├── middleware/             authenticate, authorize, validate, csrf, ensureDatabase, errorHandler
│   ├── modules/
│   │   ├── auth/               register, login, logout, me, cookie attributes
│   │   ├── users/              admin CRUD + interests aggregation
│   │   ├── notes/              private notes CRUD
│   │   └── posts/              public posts + $lookup aggregation
│   ├── routes/                 index.ts (mounts module routers under /api), health.ts
│   └── utils/                  ApiError, pagination, jwt, logger (credential redaction), validators
├── scripts/
│   ├── explain-queries.ts      explain('executionStats') report for every important query
│   ├── sync-indexes.ts         diff / apply schema indexes (used instead of autoIndex in prod)
│   ├── seed-admin.ts           creates the first admin (never promotes an existing account)
│   └── lib/                    query catalog + explain summariser (shared with tests)
├── tests/                      135 integration tests against a real mongod
├── tsconfig.json               bundler resolution (what Vercel compiles with)
└── tsconfig.node.json          NodeNext type check (strict Node ESM rules)
```

Each module follows the same layering:

| File                              | Responsibility                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `*.schemas.ts`                    | Zod schemas for body, params and query. They are the source of request types.               |
| `*.routes.ts`                     | Paths, `authenticate` and `authorize` middleware, and `validated(schemas, handler)` binding |
| `*.controller.ts`                 | HTTP only. Receives already-validated, typed input and shapes the response.                 |
| `*.service.ts`                    | Business rules and authorization scoping                                                    |
| `*.queries.ts` / `*.pipelines.ts` | Pure query and pipeline builders, shared with the explain tests                             |

Two structural choices differ from the suggested layout:

- **No `asyncHandler`.** Express 5 forwards rejected promises from async handlers to the
  error middleware natively, so a wrapper would be dead code.
- **Query builders live in their own files.** The services run them, and the explain tests
  and script run `explain('executionStats')` on the _same_ builders. Index claims are
  therefore verified against the exact production queries, not copies of them.

## 3. Installation

Prerequisites: Node.js 24.x, npm, and Docker (or any MongoDB ≥ 6).

```bash
docker compose up -d mongo      # local MongoDB on 127.0.0.1:27017
npm install
cp .env.example .env            # then set JWT_SECRET (see below)
npm run db:indexes -- --apply   # build indexes (dev also builds them on boot)
npm run db:seed-admin           # creates ADMIN_EMAIL / ADMIN_PASSWORD from .env
npm run dev                     # http://localhost:4000, health: /api/health
```

Run the frontend repository's `npm run dev` next to it: its Vite dev server proxies
`/api` to `http://localhost:4000`.

Self-hosted production (outside Vercel): `npm run build && npm start`.

## 4. Environment configuration

`src/config/env.ts` validates every variable with Zod when the app is loaded and throws a
readable error naming each bad variable (never its value). Locally the server exits. On
Vercel the entry point (`src/app.ts`) catches it, logs it, and answers every request with
`500 {"message":"Server misconfigured: …","errors":[{"field":"FRONTEND_URL",…}]}`. You see
the problem in the browser instead of Vercel's generic `FUNCTION_INVOCATION_FAILED` page.

| Variable                                        | Default                                  | Notes                                                                                                                                                   |
| ----------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                      | `development`                            | `production` on Vercel (set it explicitly)                                                                                                              |
| `MONGODB_URI`                                   | (required)                               | `mongodb://…` or `mongodb+srv://…` (Atlas). Never logged: credentials are redacted.                                                                     |
| `JWT_SECRET`                                    | (required, ≥ 32 chars)                   | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. The `.env.example` placeholder is rejected.                           |
| `JWT_EXPIRES_IN`                                | `1h`                                     | `<n>s`, `<n>m`, `<n>h` or `<n>d`; also the cookie max-age                                                                                               |
| `FRONTEND_URL`                                  | localhost:5173 in dev                    | **Required in production.** Exact frontend origin(s), comma separated, https only, no wildcards, no localhost. Used for CORS and the CSRF origin check. |
| `PORT`                                          | `4000`                                   | Local server only (ignored on Vercel)                                                                                                                   |
| `BCRYPT_SALT_ROUNDS`                            | `12`                                     | 4–15 allowed (tests use 4 for speed)                                                                                                                    |
| `COOKIE_SECURE`                                 | `true` in production                     | `Secure` flag on the auth cookie                                                                                                                        |
| `COOKIE_SAME_SITE`                              | `none` in production, `strict` otherwise | Use `strict` only if the frontend proxies `/api` (same site), see §16                                                                                   |
| `TRUST_PROXY`                                   | `1` on Vercel, else `0`                  | Proxy hops to trust for `X-Forwarded-For` (rate limiting by real client IP)                                                                             |
| `AUTH_RATE_LIMIT_WINDOW_MS`                     | `900000` (15 min)                        | Window for the login/register limiter                                                                                                                   |
| `AUTH_RATE_LIMIT_MAX`                           | `20`                                     | Requests per IP per window on login/register                                                                                                            |
| `MONGO_AUTO_INDEX`                              | `true` unless production                 | Build indexes on boot. When off, the API refuses DB work (503) until declared indexes exist (`db:indexes -- --apply`).                                  |
| `MONGO_MAX_POOL_SIZE`                           | `10`                                     | Connections per function instance (Atlas M0 allows 500 in total)                                                                                        |
| `ADMIN_NAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` | —                                        | Used only by `npm run db:seed-admin`                                                                                                                    |

## 5. Database setup

- `docker compose up -d mongo` starts MongoDB 8.0 on `127.0.0.1:27017` with a named volume.
  For production, MongoDB Atlas setup is in §16.
- **Indexes.** In development Mongoose builds the declared indexes on boot (`autoIndex`).
  In production `autoIndex` is off, because index builds on boot are slow and lock-prone.
  Build them explicitly:
  ```bash
  npm run db:indexes             # dry run: shows toCreate / toDrop per collection
  npm run db:indexes -- --apply  # syncIndexes(): create missing, DROP undeclared indexes
  ```
  `--apply` treats the schemas as the source of truth, so it also removes redundant
  indexes that were added by hand.
- **Index check.** With `autoIndex` off, the first connection on each instance compares
  the declared indexes with the database (`diffIndexes()`). If any is missing, the local
  server refuses to start, and on Vercel every database route returns 503 while
  `/api/health` reports `"database": "indexes_missing"`. Without the unique `email_1`
  index, duplicate accounts could be created.
- **First admin.** Self-registration can only create normal users, so the first admin is
  created with `npm run db:seed-admin`. The script **refuses** if the email already exists.
  Anyone can self-register, so promoting an existing account could hand admin rights to
  whoever pre-registered that address with their own password.

## 6. API endpoints

Base URL: `/api` (production: `https://<your-backend-project>.vercel.app/api`). All bodies
are JSON (`limit: 100kb`).

### Service

| Method | Path          | Auth   | Description                                                                                                             |
| ------ | ------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health` | public | `200 {status: "ok", database: "connected"}` or `503` with `unreachable` / `indexes_missing`. `Cache-Control: no-store`. |
| GET    | `/`           | public | Small JSON index pointing to `/api/health`                                                                              |

### Authentication

| Method | Path             | Auth                 | Description                                                                |
| ------ | ---------------- | -------------------- | -------------------------------------------------------------------------- |
| POST   | `/auth/register` | public, rate limited | Create a `user` account and set the auth cookie (201)                      |
| POST   | `/auth/login`    | public, rate limited | Verify credentials and set the auth cookie                                 |
| POST   | `/auth/logout`   | public               | Clear the auth cookie. Needed because JS cannot delete an HttpOnly cookie. |
| GET    | `/auth/me`       | user                 | Current profile                                                            |

### Notes (private)

| Method | Path         | Auth | Description                                                               |
| ------ | ------------ | ---- | ------------------------------------------------------------------------- |
| POST   | `/notes`     | user | Create a note. The owner comes from the token.                            |
| GET    | `/notes`     | user | User: own notes. Admin: all notes, or `?userId=` for one user. Paginated. |
| GET    | `/notes/:id` | user | User: own note. Admin: any note.                                          |
| PATCH  | `/notes/:id` | user | Update an **own** note (`title`, `content`)                               |
| DELETE | `/notes/:id` | user | Delete an **own** note                                                    |

### User management (admin only)

| Method | Path                           | Description                                                      |
| ------ | ------------------------------ | ---------------------------------------------------------------- |
| POST   | `/users`                       | Create a user with any role                                      |
| GET    | `/users`                       | List users. Paginated, `sortBy=createdAt\|email`.                |
| GET    | `/users/:id`                   | Get a user                                                       |
| PATCH  | `/users/:id`                   | Update name, email, password, role or interests                  |
| DELETE | `/users/:id`                   | Delete a user and cascade-delete their notes and posts           |
| GET    | `/users/aggregation/interests` | Users grouped by interest. Paginated, optional `?interests=a,b`. |

### Posts (public to authenticated users)

| Method | Path                  | Description                                                                 |
| ------ | --------------------- | --------------------------------------------------------------------------- |
| POST   | `/posts`              | Create a post                                                               |
| GET    | `/posts`              | Global feed with author, newest first. Paginated.                           |
| GET    | `/posts/user/:userId` | One user's posts with author, via **one** `$lookup` aggregation. Paginated. |

### Response format

```jsonc
// success (list)
{
  "success": true,
  "message": "Notes retrieved successfully",
  "data": [ /* ... */ ],
  "pagination": {
    "currentPage": 1, "limit": 10, "totalRecords": 100, "totalPages": 10,
    "hasNextPage": true, "hasPreviousPage": false
  }
}

// error
{
  "success": false,
  "message": "Validation failed",
  "errors": [{ "location": "query", "field": "limit", "message": "Too big: expected number to be <=100" }]
}
```

Status codes: `200`, `201`, `400` (validation, malformed JSON, malformed ObjectId),
`401` (missing, invalid or expired token; deleted account; role changed since login;
bad credentials), `403` (wrong role), `404` (missing, or outside the caller's scope),
`409` (duplicate email, last admin), `413` (body too large), `415` (unsupported
charset or encoding), `429` (rate limited), `500` (generic; details are logged
server-side only). Client errors raised inside Express, such as a malformed `%`-escape
in the URL, keep their 4xx status instead of turning into a 500.

## 7. Authentication workflow

```
POST /auth/login {email, password}
  -> Zod: email trimmed + lowercased, strict object (no extra keys)
  -> User.findOne({ email }).select('+password')        [email_1 index]
  -> bcrypt.compare
       unknown email: compare against a dummy hash anyway (same timing)
       either failure: 401 "Invalid email or password"   (generic, no enumeration)
  -> jwt.sign({ userId, role }, JWT_SECRET, { HS256, expiresIn, iss, aud })
  -> Set-Cookie: access_token=<jwt>; HttpOnly; Path=/api; Max-Age; <SameSite and Secure below>
```

Cookie attributes (`src/modules/auth/auth.cookies.ts`):

| Environment         | Attributes                                                | Why                                                                                                                                                                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local development   | `HttpOnly; SameSite=Strict; Path=/api`                    | The Vite proxy makes the API same-origin                                                                                                                                                                                                                                                                             |
| Production (Vercel) | `HttpOnly; Secure; SameSite=None; Partitioned; Path=/api` | `*.vercel.app` is on the Public Suffix List, so `secure-notes-frontend.vercel.app` and `secure-notes-backend.vercel.app` are **different sites**. A Strict/Lax cookie would never be sent. `Partitioned` (CHIPS) keys the cookie to the frontend's site, so browsers that block third-party cookies still accept it. |

On each protected request, `authenticate`:

1. Reads the token from the `access_token` cookie. It falls back to
   `Authorization: Bearer <token>` for non-browser clients.
2. Verifies the signature with the algorithm **pinned to HS256**, which blocks
   `alg: none` and algorithm-confusion attacks. It also checks `iss`, `aud` and `exp`.
3. Validates the claim shape with Zod (`userId` is a 24-hex ObjectId, `role` is
   `user|admin`).
4. Loads the account by `_id`, projecting `role` only. This is a single
   `EXPRESS_IXSCAN` on `_id_`: 1 key, 1 document, verified by explain.
   - If the account no longer exists: `401 "Account no longer exists"`.
   - If its current role differs from the token's role: `401 "Your role has changed,
please log in again"`.
5. Sets `req.auth = { userId, role }`. The role comes from the signed token **and** is
   confirmed against the database. It is never taken from the body, the query or
   frontend state.

Expired tokens get `401 "Token has expired"`. Other token failures get
`401 "Invalid token"`.

**Password handling.**

- bcrypt runs in a `pre('save')` hook, which covers register, admin create and admin
  password change.
- The schema marks `password` as `select: false`.
- Responses are built from allow-list DTOs (`toUserDTO`), and `toJSON` also strips the hash.
- Aggregations project only `name` and `email`, so the hash never enters a pipeline.
- Passwords over 72 bytes are rejected, because bcrypt silently truncates them.

**Browser security.**

- The SPA never sees the token: it is an HttpOnly cookie, and nothing is stored in
  localStorage.
- **CORS** allows exactly the `FRONTEND_URL` origin(s) with credentials. It never uses a
  wildcard, since a credentialed wildcard would let any site act as the user.
- **CSRF** (`src/middleware/csrf.ts`). The production cookie is `SameSite=None`, so
  every state-changing request (POST, PATCH, DELETE) gets two independent checks:
  1. If the browser sent an `Origin` header, it must be an allowed frontend origin.
     Otherwise the request gets 403 (OWASP "verify origin").
  2. A request carrying the auth cookie must also send `X-Requested-With: XMLHttpRequest`.
     HTML forms cannot set headers, and a cross-origin `fetch` that sets one triggers a
     preflight that CORS rejects (OWASP "custom request header"). The frontend's axios
     client sends the header on every request.

  JSON-only bodies are a third barrier. Bearer-token clients send no cookie, so only
  check 1 applies to them.

- Helmet sets security headers. Login and register are rate limited per client IP. On
  Vercel, `trust proxy` is set to exactly one hop, so the real client IP is read from
  `X-Forwarded-For`.

**Why not purely stateless.** An earlier version trusted the JWT role without the
database check. An independent review found that, under that design, a demoted admin's
unexpired token could `PATCH` its own role back to `admin` and then demote the admin who
demoted it. A deleted user's token could also keep creating notes and posts. Both
scenarios are now regression tests (`tests/users.test.ts`). The per-request point read is
cheap, and it makes demotion, promotion and deletion take effect on the next request.
The cost is one extra command per authenticated request, so the aggregation endpoints
send two commands: the auth lookup and the single `aggregate` (see §11).

## 8. Role-based access control

Middleware is reusable and declarative:

```ts
router.use(authenticate, authorize('admin')); // whole users router is admin-only
```

| Capability                                   | user |     admin     |
| -------------------------------------------- | :--: | :-----------: |
| Register, log in, view own profile           |  ✓   |       ✓       |
| Create, list, read, update, delete own notes |  ✓   |       ✓       |
| Read **other users'** notes                  |  ✗   |       ✓       |
| Update or delete other users' notes          |  ✗   | ✗ (see below) |
| Create and read posts                        |  ✓   |       ✓       |
| Create, list, read, update, delete users     |  ✗   |       ✓       |
| Users-by-interest aggregation                |  ✗   |       ✓       |
| Change own role                              |  ✗   |  ✓ (guarded)  |

How the rules are enforced:

- **Ownership is part of the query filter.** Writes use `{ _id, user: <token userId> }`
  in one atomic `findOneAndUpdate` or `deleteOne`, so there is no read-then-write race.
  A note outside the caller's scope returns **404, not 403**, so its existence is not
  revealed.
- **Admins read every note, but write only their own.** Section 6 grants admins _view_
  rights on all notes, and least privilege keeps writes owner-scoped. Admins can still
  remove a user entirely, which cascades to that user's notes.
- **The owner can never come from input.** Create and update schemas are `strictObject`,
  so a `user` field in the body is rejected with 400. A non-admin who passes `?userId=`
  for someone else gets 403.
- **No self-promotion.** Register rejects a `role` key with 400 (strict schema) and also
  hard-codes `role: 'user'`. Every `/users` route requires admin.
- **Role changes are immediate.** `authenticate` checks the token's role against the
  database on every request (§7). A demoted admin loses admin rights at once, and a
  deleted user's token stops working.
- **Last-admin protection.** Demoting or deleting an admin is allowed only while
  **another** admin exists, which covers an admin removing their own last admin account.
  Otherwise the API returns `409 "Cannot remove the last admin account"`.
- **Frontend checks are UX only.** The UI hides admin navigation for normal users. Every
  rule above is enforced by the API independently.

## 9. Database schemas

All schemas use `timestamps: true` (`createdAt`, `updatedAt`) and expose `id` instead of
`_id` in JSON.

**User** (`users`)

| Field       | Type     | Rules                                                              |
| ----------- | -------- | ------------------------------------------------------------------ |
| `name`      | string   | required, trimmed, 1–100                                           |
| `email`     | string   | required, trimmed, **lowercased**, unique (index)                  |
| `password`  | string   | required, bcrypt hash, `select: false`                             |
| `role`      | enum     | `user` \| `admin`, default `user`                                  |
| `interests` | string[] | trimmed, lowercased, de-duplicated, ≤ 20 items of ≤ 50 chars (Zod) |

**Note** (`notes`): `title` (required, 1–200), `content` (≤ 20 000, default `''`),
`user` (ObjectId ref `User`, required).

**Post** (`posts`): `title` (required, 1–200), `content` (required, 1–20 000),
`user` (ObjectId ref `User`, required).

## 10. MongoDB indexing strategy

The rule followed: **an index exists only if a query the API actually runs needs it, and
`explain('executionStats')` shows that query using it.** All indexes are declared with
`schema.index()`. No field uses `index: true` or `unique: true`, and a test enforces this.

### Index inventory

| Collection | Index (name)                       | Type       | Supports                                                                                     |
| ---------- | ---------------------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| users      | `_id_`                             | automatic  | Per-request auth lookup, `findById`, `$lookup` joins from posts, users list (creation order) |
| users      | `{ email: 1 }` (`email_1`)         | **unique** | Login `findOne({ email })`, one account per email, `sortBy=email`                            |
| users      | `{ interests: 1 }` (`interests_1`) | multikey   | Interest aggregation with `?interests=` (`$match $in`)                                       |
| notes      | `_id_`                             | automatic  | Single-note get, update and delete; admin list of all notes                                  |
| notes      | `{ user: 1, createdAt: -1 }`       | compound   | Owner listing + sort, owner count, cascade delete                                            |
| posts      | `_id_`                             | automatic  | Global feed order                                                                            |
| posts      | `{ user: 1, createdAt: -1 }`       | compound   | `/posts/user/:userId` `$match` + `$sort`, cascade delete                                     |

`tests/indexes.test.ts` asserts this inventory exactly, so a redundant index fails the
build. It also asserts that `Model.diffIndexes()` is empty.

### What each index does, and the query that uses it

- **`email_1` (unique).** Login is an equality lookup on a normalized email. Explain shows
  `EXPRESS_IXSCAN` with 1 key and 1 document examined. The same index enforces
  uniqueness. Register and admin create **do not pre-check** the email: they rely on the
  E11000 error (mapped to 409). A pre-check would be racy and would cost an extra query.
  Declaring a second, non-unique email index would duplicate this one.
- **`interests_1` (multikey).** With `?interests=chess,reading` the pipeline starts with
  `{ $match: { interests: { $in: [...] } } }`, and explain shows `IXSCAN interests_1`.
  Only users holding a requested interest are read: 66 of 1 000 in the report below.
  _Honest caveat:_ the **unfiltered** "group everyone" query must read every user, so it
  is a `COLLSCAN` with or without this index. An index cannot accelerate
  `$unwind`/`$group` over a whole collection. A multikey index on an array field also
  cannot _cover_ the query, because the plan still has to fetch `name` and `email`.
- **`notes { user: 1, createdAt: -1 }`.** `find({ user }).sort({ createdAt: ±1 }).skip().limit()`
  is an equality on the prefix plus a sort on the suffix. The result is an `IXSCAN` that
  is already in order, with **no `SORT` stage**. For page 2 it examines 20 keys and fetches
  only 10 documents. Ascending order walks the same index backwards.
  `countDocuments({ user })` becomes a `COUNT_SCAN` that examines 0 documents. The
  `deleteMany({ user })` cascade uses the same prefix.
- **`posts { user: 1, createdAt: -1 }`.** The `/posts/user/:userId` aggregation begins with
  `$match { user }` and `$sort { createdAt }`. MongoDB pushes both into the query layer,
  giving `IXSCAN user_1_createdAt_-1` with no `SORT`. Its `$lookup` into `users` reports
  `indexesUsed: ['_id_']`.

### Why compound indexes

Every per-user listing filters by `user` _and_ orders by `createdAt`. A single-field
`{ user: 1 }` index would find the user's documents, then sort them in memory: a blocking
`SORT` that loads the user's whole history to return 10 rows. A single-field
`{ createdAt: -1 }` index would walk everyone's documents in time order and filter. The
compound `{ user: 1, createdAt: -1 }` index (equality first, then sort, following the
ESR rule) gives both the filter and the order. Its `{ user: 1 }` prefix also makes a
separate `user` index redundant.

### Indexes deliberately _not_ created

| Candidate                                    | Why it was rejected                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| second `{ email: 1 }`                        | The unique index already serves lookups.                                                                                                                                                                                                                                                                                                                            |
| `{ user: 1 }` on notes or posts              | Prefix of the compound index.                                                                                                                                                                                                                                                                                                                                       |
| `{ createdAt: -1 }` on notes, posts or users | Unscoped "newest first" listings (admin all-notes, global feed, users list) sort by **`_id`**. ObjectIds embed their creation time, so the automatic `_id_` index gives creation order for free. Explain: `IXSCAN _id_`, no `SORT`. This avoids one extra index write on every insert.                                                                              |
| extra index for `$lookup`                    | `users._id` is indexed automatically.                                                                                                                                                                                                                                                                                                                               |
| `{ _id, user }` for single-note reads        | The `_id_` index already narrows the query to one document. The `user` predicate is then checked on that one document.                                                                                                                                                                                                                                              |
| `{ role: 1 }` on users                       | Only the rare last-admin guard filters by role, so it runs only when an admin is demoted or deleted. Explain shows an `_id_` scan with `$ne` bounds, which can read every user in the worst case. That is acceptable on a rare admin write path. If it ever gets hot, the fix is a _partial_ index `{ role: 1 }` with `partialFilterExpression: { role: 'admin' }`. |

**About the brief's claim.** The brief says the notes compound index supports "admin note
listing with pagination and sorting". That holds only when the admin filters by user
(`?userId=`). The unfiltered admin listing has no `user` equality, so
`{ user: 1, createdAt: -1 }` cannot provide its sort. That listing uses `_id_` instead,
and the report below shows it.

### Read and write performance

Every index speeds up the reads that use it. In exchange, it adds work to every insert,
every delete, and every update that touches its fields, and it uses RAM for the working
set. Notes and posts are the write-heavy collections, which is why they carry exactly one
secondary index each. The multikey `interests_1` index costs one key per interest per
user. That is bounded by validation (≤ 20 interests per user), and interests change
rarely.

### Indexes MongoDB creates automatically

Every collection gets a unique `_id_` index. Nothing else is automatic. (Mongoose's
`unique: true` on a field is not a MongoDB feature. It is shorthand for an index
declaration, which this project avoids in favor of `schema.index()`.)

### Inspecting indexes and plans

```bash
npm run db:indexes                               # schema vs database diff + index list
npm run db:explain                               # seeds an in-memory DB and explains every query
npm run db:explain -- --uri=mongodb://localhost:27017/secure_notes   # explain against real data
```

In `mongosh`:

```js
db.users.getIndexes();
db.notes.getIndexes();
db.posts.getIndexes();

// Owner listing, page 2 (expect IXSCAN user_1_createdAt_-1, no SORT, docsExamined = 10)
db.notes
  .find({ user: ObjectId('<userId>') })
  .sort({ createdAt: -1 })
  .skip(10)
  .limit(10)
  .explain('executionStats');

// Login (expect EXPRESS_IXSCAN / IXSCAN email_1)
db.users.find({ email: 'abbas@example.com' }).explain('executionStats');

// Scenario 2 pipeline (expect IXSCAN user_1_createdAt_-1, $lookup indexesUsed: ["_id_"])
db.posts.explain('executionStats').aggregate([
  { $match: { user: ObjectId('<userId>') } },
  { $sort: { createdAt: -1 } },
  {
    $facet: {
      metadata: [{ $count: 'totalRecords' }],
      data: [
        { $skip: 0 },
        { $limit: 10 },
        {
          $lookup: {
            from: 'users',
            localField: 'user',
            foreignField: '_id',
            pipeline: [{ $project: { _id: 0, id: '$_id', name: '$name', email: '$email' } }],
            as: 'author',
          },
        },
        { $unwind: { path: '$author', preserveNullAndEmptyArrays: true } },
      ],
    },
  },
]);

// Interest grouping filtered (expect IXSCAN interests_1)
db.users
  .explain('executionStats')
  .aggregate([
    { $match: { interests: { $in: ['chess'] } } },
    { $project: { name: 1, email: 1, interests: 1 } },
    { $unwind: '$interests' },
    { $group: { _id: '$interests', users: { $addToSet: { name: '$name', email: '$email' } } } },
  ]);
```

What to read in the output: `winningPlan` stages (`IXSCAN` and its `indexName`, versus
`COLLSCAN`; any `SORT` means an in-memory sort), `totalKeysExamined`,
`totalDocsExamined` and `nReturned`. Ideally docs examined ≈ returned. For `$lookup`, read
`indexesUsed` and `collectionScans`.

From Mongoose:

```ts
await Note.find({ user }).sort({ createdAt: -1 }).limit(10).explain('executionStats');
await Post.aggregate(pipeline).explain('executionStats');
```

### Verified results

The output below comes from `npm run db:explain` on MongoDB 8.2.6 with 1 000 users,
30 000 notes and 10 000 posts. User 1 owns about 3 000 notes and about 1 000 posts. Each
query was built by the same builders the API uses. Mongoose cannot explain
`countDocuments()`, so the count row runs the real query, captures the exact aggregation
the driver sends for it, and explains that.

| Query                             | Endpoint                                          | Plan stages                                       | Index               | `$lookup` index | Keys | Docs  | Returned |
| --------------------------------- | ------------------------------------------------- | ------------------------------------------------- | ------------------- | --------------- | ---- | ----- | -------- |
| Login lookup by email             | `POST /api/auth/login`                            | EXPRESS_IXSCAN                                    | email_1             | —               | 1    | 1     | 1        |
| Authentication: role by `_id`     | every authenticated request                       | EXPRESS_IXSCAN                                    | _id_                | —               | 1    | 1     | 1        |
| Own notes, newest first (page 2)  | `GET /api/notes`                                  | LIMIT > FETCH > SKIP > IXSCAN                     | user_1_createdAt_-1 | —               | 20   | 10    | 10       |
| Own notes, oldest first           | `GET /api/notes?sortOrder=asc`                    | LIMIT > FETCH > SKIP > IXSCAN                     | user_1_createdAt_-1 | —               | 20   | 10    | 10       |
| Own notes total (countDocuments)  | `GET /api/notes` (total)                          | GROUP > COUNT_SCAN                                | user_1_createdAt_-1 | —               | 3027 | **0** | 1        |
| All notes for admin, newest first | `GET /api/notes` (admin)                          | LIMIT > FETCH > SKIP > IXSCAN                     | _id_                | —               | 20   | 10    | 10       |
| Admin notes filtered by user      | `GET /api/notes?userId=`                          | LIMIT > FETCH > SKIP > IXSCAN                     | user_1_createdAt_-1 | —               | 20   | 10    | 10       |
| Single note scoped to owner       | `GET/PATCH/DELETE /api/notes/:id`                 | LIMIT > FETCH > IXSCAN                            | _id_                | —               | 1    | 1     | 1        |
| Users list, newest first          | `GET /api/users`                                  | LIMIT > PROJECTION_SIMPLE > FETCH > SKIP > IXSCAN | _id_                | —               | 20   | 10    | 10       |
| Users list sorted by email        | `GET /api/users?sortBy=email`                     | LIMIT > PROJECTION_SIMPLE > FETCH > SKIP > IXSCAN | email_1             | —               | 20   | 10    | 10       |
| Interest groups, filtered         | `GET /api/users/aggregation/interests?interests=` | PROJECTION_SIMPLE > FETCH > IXSCAN                | interests_1         | —               | 66   | 66    | 66       |
| Interest groups, everyone         | `GET /api/users/aggregation/interests`            | PROJECTION_SIMPLE > COLLSCAN                      | —                   | —               | 0    | 1000  | 1000     |
| One user's posts + `$lookup`      | `GET /api/posts/user/:userId`                     | PROJECTION_SIMPLE > FETCH > IXSCAN                | user_1_createdAt_-1 | _id_            | 1009 | 1009  | 1009     |
| Global feed + `$lookup`           | `GET /api/posts`                                  | LIMIT > PROJECTION_SIMPLE > FETCH > SKIP > IXSCAN | _id_                | _id_            | 20   | 10    | 10       |
| Last-admin guard                  | `PATCH/DELETE /api/users/:id`                     | LIMIT > PROJECTION_SIMPLE > FETCH > IXSCAN        | _id_                | —               | 1    | 1     | 1        |
| Cascade delete of notes           | `DELETE /api/users/:id`                           | BATCHED_DELETE > FETCH > IXSCAN                   | user_1_createdAt_-1 | —               | 3027 | 3027  | 0        |

`PROJECTION_SIMPLE` in the aggregation plans shows MongoDB's dependency analysis pushing
the needed fields down to the query layer. The user-posts row is explained below.

## 11. Aggregation pipelines

### Scenario 1: users grouped by interest (exactly one `User.aggregate()`)

`src/modules/users/users.queries.ts → buildInterestGroupsPipeline`

```js
[
  // only with ?interests=chess,reading  -> IXSCAN interests_1
  { $match: { interests: { $in: ['chess', 'reading'] } } },
  { $project: { _id: 1, name: 1, email: 1, interests: 1 } }, // narrow early; no password
  { $unwind: '$interests' }, // one doc per (user, interest)
  { $match: { interests: { $in: ['chess', 'reading'] } } }, // only with filter: drop other interests
  {
    $group: {
      _id: '$interests',
      users: { $addToSet: { id: '$_id', name: '$name', email: '$email' } },
    },
  },
  { $set: { userCount: { $size: '$users' } } },
  { $sort: { _id: 1 } }, // or { userCount: ±1, _id: 1 } with sortBy=userCount
  {
    $facet: {
      metadata: [{ $count: 'totalRecords' }], // number of interest groups
      data: [
        { $skip: 0 },
        { $limit: 10 },
        {
          $project: {
            _id: 0,
            interest: '$_id',
            userCount: '$userCount',
            users: { $sortArray: { input: '$users', sortBy: { name: 1, email: 1 } } },
          },
        },
      ],
    },
  },
];
```

Why the pipeline looks like this:

- **`$project` before `$unwind`.** It shrinks every document carried through the pipeline
  and guarantees the password hash never enters it.
- **`$addToSet` instead of `$push`.** A user appears at most once per interest, even with
  legacy duplicate data. Interests are also normalized (trimmed, lowercased,
  de-duplicated) at write time, so `Chess` and `chess` group together.
- **`$facet`.** Pagination (`totalRecords` plus one page of groups) comes from the **same
  single call**. `$sortArray` (MongoDB ≥ 5.2) sorts members only for the groups on the
  returned page.
- **One call is enforced on the wire.** `tests/aggregation.test.ts` listens to the
  driver's `commandStarted` events during the HTTP request. It asserts that the request
  sends exactly two commands, in this order:
  1. `find` on `users` by the caller's `_id`: the authentication check (§7).
  2. `aggregate` on `users`: the entire interests operation.

  With the auth lookup set aside, the operation is exactly `[{ aggregate: 'users' }]`,
  with no `find`, `count`, `distinct` or `populate`.

Response for the brief's example:

```json
[
  {
    "interest": "chess",
    "userCount": 1,
    "users": [{ "id": "…", "name": "Abbas", "email": "abbas@example.com" }]
  },
  {
    "interest": "football",
    "userCount": 1,
    "users": [{ "id": "…", "name": "John", "email": "john@example.com" }]
  },
  {
    "interest": "reading",
    "userCount": 2,
    "users": [
      { "id": "…", "name": "Abbas", "email": "abbas@example.com" },
      { "id": "…", "name": "John", "email": "john@example.com" }
    ]
  }
]
```

This is the logical result `{ chess: [Abbas], reading: [Abbas, John], football: [John] }`.
The test suite asserts it literally.

### Scenario 2: a user's posts with author via `$lookup` (exactly one `Post.aggregate()`)

`src/modules/posts/posts.pipelines.ts → buildUserPostsPipeline`

```js
[
  { $match: { user: ObjectId(userId) } }, // 1. IXSCAN user_1_createdAt_-1
  { $sort: { createdAt: -1 } }, // 2. same index walk, no SORT stage
  {
    $facet: {
      metadata: [{ $count: 'totalRecords' }], // 3a. total for pagination, same round trip
      data: [
        { $skip: (page - 1) * limit }, // 3b. cut the page FIRST...
        { $limit: limit },
        {
          $lookup: {
            // ...then join only `limit` posts
            from: 'users',
            localField: 'user',
            foreignField: '_id', // users._id_ index
            pipeline: [{ $project: { _id: 0, id: '$_id', name: '$name', email: '$email' } }],
            as: 'author',
          },
        },
        { $unwind: { path: '$author', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 0,
            id: '$_id',
            title: '$title',
            content: '$content',
            createdAt: '$createdAt',
            updatedAt: '$updatedAt',
            author: { $ifNull: ['$author', null] },
          },
        },
      ],
    },
  },
];
```

**Stage order versus the naive pipeline.** The example in the brief runs `$lookup`,
`$unwind` and `$project` before `$sort`, `$skip` and `$limit`. That joins _every_ post of
the user and then throws most of them away. Here `$match` and `$sort` come first, so they
run in the query layer on the compound index. `$skip` and `$limit` come before the join,
so at most `limit` index lookups hit `users._id_`.

**Other properties.**

- The `$lookup` sub-pipeline projects only `name` and `email`, so role, interests and the
  password hash are never joined.
- Because of `preserveNullAndEmptyArrays`, a post whose author is missing still counts and
  shows `author: null`. `totalRecords` and the page contents therefore always agree.
- An invalid ObjectId is rejected with 400 before any posts query runs; the test asserts
  that the only command sent was the auth lookup. A valid but unknown id returns an empty
  page, because a 404 would need a second (User) query, which the brief forbids.
- Tests assert that the request sends the auth lookup plus exactly one
  `{ aggregate: 'posts' }`, and they check the exact stage list, including `$lookup`
  from `users`.

**Known cost.** `$facet` consumes its whole input. The count therefore makes MongoDB fetch
_all_ of this user's posts through the index (1 009 docs for the heaviest user in the
report), even though only 10 are joined and returned. A separate
`countDocuments({ user })` would be a `COUNT_SCAN` with 0 documents fetched. The brief
mandates a single `aggregate()` call, so this cost is accepted and documented. The
alternative is listed in [limitations](#15-design-decisions-and-limitations).

The **global feed** (`GET /api/posts`) uses the same `$lookup` stages after
`$sort { _id }`, `$skip` and `$limit`. Its total comes from `estimatedDocumentCount()`,
which reads collection metadata in O(1) instead of counting every post per request.

## 12. Pagination

`src/utils/pagination.ts`

- **`paginationQuerySchema(sortFields, defaults)`** builds a Zod schema per endpoint.
  - `page`: integer, 1–10 000, default 1.
  - `limit`: integer, 1–100, default 10.
  - `sortBy`: an **allow-list per endpoint**.
  - `sortOrder`: `asc` or `desc`.
  - Invalid values return 400. `sortBy` accepts only orders an index can serve, so a
    client can never trigger an unindexed in-memory sort.

  | Endpoint                               | `sortBy` values         | Served by                                        |
  | -------------------------------------- | ----------------------- | ------------------------------------------------ |
  | `/notes`, `/posts/user/:userId`        | `createdAt`             | `{ user, createdAt }` index                      |
  | `/notes` (admin, unfiltered), `/posts` | `createdAt`             | `_id_` (creation order)                          |
  | `/users`                               | `createdAt`, `email`    | `_id_` / `email_1`                               |
  | `/users/aggregation/interests`         | `interest`, `userCount` | `$sort` after `$group`, on the small grouped set |

- **`buildPaginationMeta(params, totalRecords)`** returns `currentPage`, `limit`,
  `totalRecords`, `totalPages`, `hasNextPage` and `hasPreviousPage`.
- **`paginationFacet()` and `unwrapFacet()`** produce the
  `{ metadata: [$count], data: [$skip, $limit, …] }` stage for single-call aggregations.
- **Totals.**
  - Scoped lists use `countDocuments` (a `COUNT_SCAN` on the index), run in parallel with
    the page query.
  - Unscoped lists use `estimatedDocumentCount()` (O(1)).
  - Aggregations use `$count` inside `$facet`.
- **Memory.** Only one page is ever loaded into memory (`skip` and `limit` run in the
  database). Queries use `lean()`.
- **Frontend.** The current page is kept in the URL (`?page=`), so reloading or going back
  restores it.

## 13. API examples (curl)

The token is an HttpOnly cookie, so curl uses a cookie jar (`-c` to save, `-b` to send).
State-changing requests that carry the cookie must also send the CSRF header (§7).

Against production, set `API=https://<your-backend-project>.vercel.app/api`. The production
cookie is `Secure`, which curl sends over https as usual.

```bash
API=http://localhost:4000/api
JSON='Content-Type: application/json'
XHR='X-Requested-With: XMLHttpRequest'

# Health
curl -s $API/health

# Register (sets the cookie). Adding "role":"admin" is rejected with 400.
curl -s -c user.txt -H "$JSON" -H "$XHR" -X POST $API/auth/register \
  -d '{"name":"Abbas","email":"abbas@example.com","password":"Password123!","interests":["chess","reading"]}'

# Login
curl -s -c user.txt -H "$JSON" -H "$XHR" -X POST $API/auth/login \
  -d '{"email":"abbas@example.com","password":"Password123!"}'
curl -s -c admin.txt -H "$JSON" -H "$XHR" -X POST $API/auth/login \
  -d '{"email":"admin@example.com","password":"ChangeMe123!"}'

# Current user
curl -s -b user.txt $API/auth/me

# Notes
curl -s -b user.txt -H "$JSON" -H "$XHR" -X POST $API/notes -d '{"title":"Groceries","content":"Milk"}'
curl -s -b user.txt "$API/notes?page=1&limit=10&sortBy=createdAt&sortOrder=desc"
curl -s -b user.txt $API/notes/<noteId>
curl -s -b user.txt -H "$JSON" -H "$XHR" -X PATCH $API/notes/<noteId> -d '{"title":"Groceries (updated)"}'
curl -s -b user.txt -H "$XHR" -X DELETE $API/notes/<noteId>

# Admin: every note, or one user's notes
curl -s -b admin.txt "$API/notes?page=1&limit=20"
curl -s -b admin.txt "$API/notes?userId=<userId>"

# Admin: user management
curl -s -b admin.txt -H "$JSON" -H "$XHR" -X POST $API/users \
  -d '{"name":"John","email":"john@example.com","password":"Password123!","role":"user","interests":["reading","football"]}'
curl -s -b admin.txt "$API/users?page=2&limit=20&sortBy=email&sortOrder=asc"
curl -s -b admin.txt $API/users/<userId>
curl -s -b admin.txt -H "$JSON" -H "$XHR" -X PATCH $API/users/<userId> -d '{"role":"admin"}'
curl -s -b admin.txt -H "$XHR" -X DELETE $API/users/<userId>

# Admin: interests aggregation (all, filtered, sorted by group size)
curl -s -b admin.txt "$API/users/aggregation/interests"
curl -s -b admin.txt "$API/users/aggregation/interests?interests=chess,reading"
curl -s -b admin.txt "$API/users/aggregation/interests?sortBy=userCount&sortOrder=desc&limit=5"

# Posts
curl -s -b user.txt -H "$JSON" -H "$XHR" -X POST $API/posts -d '{"title":"Hello","content":"First post"}'
curl -s -b user.txt "$API/posts?page=1&limit=15"
curl -s -b user.txt "$API/posts/user/<userId>?page=1&limit=10&sortOrder=desc"

# Normal user calling an admin endpoint -> 403
curl -s -b user.txt $API/users

# CSRF: a cookie-authenticated write without the header -> 403
curl -s -b user.txt -H "$JSON" -X POST $API/notes -d '{"title":"x"}'

# Non-browser clients can send the same JWT as a Bearer header
curl -s -H "Authorization: Bearer <jwt>" $API/auth/me

# Logout (clears the cookie)
curl -s -b user.txt -c user.txt -H "$XHR" -X POST $API/auth/logout
```

## 14. Testing

```bash
npm test             # 135 tests, ~7 s
npm run typecheck    # tsconfig.json (bundler, as Vercel compiles) + tsconfig.node.json (NodeNext)
npm run lint
npm run format:check
npm run build
```

The tests run against a **real `mongod`** (MongoDB 8.2 via mongodb-memory-server, which is
downloaded on first run). Each test file uses its own database, which is wiped between
tests. Driver command monitoring is on, so tests can count real database round trips.

| File                  | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | :---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.test.ts`        |  22   | Registration (hashing, normalization, HttpOnly cookie), duplicate email (case-insensitive), self-assigned admin role rejected, login success and generic failure, NoSQL injection, rate limiting, `/me`, expired, forged, `alg:none`, wrong-audience and garbage JWTs, token for a deleted account, logout, Helmet and CORS headers, 4xx (not 500) for malformed URL encoding, unsupported charset and oversized body, JSON 404                                                                                                                                     |
| `notes.test.ts`       |  26   | CRUD, ownership can't be injected, 404 on others' notes for read, update and delete, `?userId=` 403 for users, admin reads all and filters, admin writes are owner-scoped, pagination metadata, no page overlap, sort order, defaults, 8 invalid-pagination cases, query-string injection stays scoped to the caller                                                                                                                                                                                                                                                |
| `users.test.ts`       |  18   | 401/403 on every admin endpoint, no self-promotion, create (incl. admin), duplicates, list and pagination without hashes, sort by creation and email, get, update with password re-hash plus login, cascade delete, **stale tokens**: a demoted admin cannot re-promote itself, a deleted user cannot write, a promoted user must log in again; last-admin protection, including a successful self-delete when another admin exists                                                                                                                                 |
| `aggregation.test.ts` |  16   | Scenario 1: exact grouping (the brief's example), **commands on the wire = auth lookup + exactly one `aggregate`**, stage list, pagination, sort, index-backed filter, empty result, validation. Scenario 2: `$lookup` author details, **auth lookup + exactly one `aggregate`**, exact stage order, pagination and sort, empty result for an unknown id, 400 with no posts query for an invalid id. Global feed.                                                                                                                                                   |
| `deployment.test.ts`  |  29   | `/api/health`, Vercel entry delegates to the app and answers bad configuration with a JSON 500 (variable names, no values), CSRF (missing header, foreign origin, login CSRF, Bearer exemption, safe methods), credentialed CORS preflight and no grant for other origins, production env validation (required `FRONTEND_URL`, no wildcard/localhost/http, placeholder secret, `SameSite=None` needs `Secure`, no secret values in errors), production cookie attributes, connection cache (single flight, failures not cached), log redaction of Atlas credentials |
| `indexes.test.ts`     |  24   | Exact index inventory per collection, no field-level index declarations, `diffIndexes()` empty, `strictQuery: 'throw'` blocks typo'd filters, and `explain('executionStats')` for every query in the catalog: expected index, no `SORT`/`COLLSCAN` where forbidden, `$lookup` on `_id_`, docs-examined bounds                                                                                                                                                                                                                                                       |

To check that the guards actually catch regressions, three mutations were applied by hand
and then reverted:

- An extra `countDocuments()` in the interests service. Both single-`aggregate` tests
  failed.
- Removing the owner scope from note reads. The cross-user access test failed.
- Trusting the token's role without the database check. The stale-token tests failed.

## 15. Design decisions and limitations

- **One account lookup per authenticated request.** It is an `_id` point read projecting
  `role` only. It makes role changes and deletions effective immediately (§7). Two
  consequences:
  - A user whose role changes must log in again.
  - Every authenticated request costs one extra round trip, including the aggregation
    endpoints, whose own work remains a single `aggregate()`.
- **No refresh tokens.** When the access token expires, the user logs in again.
- **Skip-based pagination.** `skip` is O(offset). `page` is capped at 10 000. For deep
  scrolling, keyset (cursor) pagination on `{ createdAt, _id }` would be the next step.
- **Sort ties.** `{ user, createdAt }` has no `_id` tie-breaker, so documents with
  identical `createdAt` milliseconds rely on index order, which is stable in practice.
  Extending the index to `{ user: 1, createdAt: -1, _id: -1 }` would make the order
  strictly deterministic. It would also let the Scenario 2 count be computed without
  fetching documents. It was not done, because the brief specifies
  `{ user: 1, createdAt: -1 }` exactly.
- **Scenario 2 count cost.** `$facet` fetches all of a user's posts to count them (see
  §11). This is the price of the single-`aggregate()` requirement.
- **Interest groups are unbounded.** `$addToSet` collects every member of an interest into
  one document. With very large groups this approaches the 16 MB document limit, and the
  fix would be to paginate members within a group. `allowDiskUse` is enabled for the
  `$group` and `$sort`.
- **No transactions.** The cascade delete (user, then notes and posts) and the last-admin
  check are not atomic. A crash between steps can leave orphans; the posts `$lookup`
  tolerates them with `author: null`. Two last admins demoting each other at the same
  moment could both pass the check. Making these atomic requires a replica set and
  multi-document transactions.
- **Admins cannot edit other users' notes.** This is a deliberate least-privilege reading
  of the brief, which grants admins _view_ rights. Admins can still delete the whole user.
- **Posts are visible only to authenticated users**, because responses include author
  emails (as the brief requires) and those should not be scraped anonymously.
- **Rate limiting uses the in-memory store.** On Vercel each function instance keeps its
  own counters, so the effective limit is per instance. A shared store (for example
  Upstash Redis via `rate-limit-redis`) would make it global.
- **Cross-site cookie support.** The production cookie relies on `SameSite=None` plus
  `Partitioned` (CHIPS). Browsers without CHIPS that block third-party cookies won't keep
  the session: Safari before 26.2, and some privacy modes and extensions. In those
  browsers a login appears to succeed, but `/api/auth/me` then returns 401. §16 lists two
  fixes: a custom domain shared by both apps, or a same-origin rewrite on the frontend.

## 16. Deployment on Vercel

### How Vercel runs this API

- **Entry point.** Vercel's zero-config Express preset looks for a file that imports
  `express` at `app|index|server.{js,ts,…}` or `src/app|index|server.{js,ts,…}`. That file
  must default-export the app or call `app.listen`. Here it is **`src/app.ts`**, which
  `export default`s a thin Express app. That app loads the real one (`src/createApp.ts`)
  through a guarded dynamic import, so invalid configuration becomes a JSON 500 instead of a
  crashed function. `src/server.ts`, the local `app.listen` server, does not import
  `express`, so it is never selected.
- **Single function.** The whole Express app becomes one Vercel Function on Fluid compute.
  There is no `vercel.json`, no per-route functions, no rewrites and no `express.static`.
- **Build.** Vercel runs `npm run build` (`tsc`), so a type error fails the deployment.
  It then compiles `src/app.ts` with `tsconfig.json`. The Node version comes from
  `"engines": { "node": "24.x" }`.
- **Database.** The connection is opened lazily by `ensureDatabase`, cached per instance
  (single flight, failures retried), and registered with `attachDatabasePool` from
  `@vercel/functions` so idle connections are released before an instance suspends.
- **No local state.** Nothing is written to the filesystem, and rate-limit counters live
  in memory per instance.

This was verified locally with Vercel CLI 65.14.0. `vercel build` selected `src/app.js`,
runtime `nodejs24.x`, and produced a 12 MB function with no dev dependencies. The
compiled function then served the API in production mode against MongoDB:

- health check: 503 → 200 once indexes exist
- cookie attributes as in §7
- CORS preflight and CSRF rejections
- role checks and both aggregations
- per-client rate limiting behind `X-Forwarded-For`

### 1. MongoDB Atlas

1. Create a cluster. The free M0 tier is enough.
2. **Database Access → Add user.** Use password authentication and give it the built-in
   role `readWrite` on the database `secure_notes` only, not `atlasAdmin`.
3. **Network Access → Add IP address → `0.0.0.0/0`.** Vercel functions have no fixed
   outbound IPs unless you buy Static IPs or Secure Compute. Atlas still requires TLS and
   the user's password, so use a long random password.
4. **Connect → Drivers** gives the SRV string. Put the database name in the path and
   URL-encode special characters in the password:
   `mongodb+srv://<user>:<password>@<cluster>.mongodb.net/secure_notes?retryWrites=true&w=majority`
5. From your machine, create the indexes and the first admin in Atlas. `.env.atlas`
   matches `.gitignore`'s `.env.*` and is never committed:
   ```bash
   cp .env.example .env.atlas
   # edit .env.atlas: MONGODB_URI=<Atlas SRV string>, JWT_SECRET=<any strong value>,
   #                  ADMIN_EMAIL / ADMIN_PASSWORD for the first admin
   DOTENV_CONFIG_PATH=.env.atlas npm run db:indexes              # dry run
   DOTENV_CONFIG_PATH=.env.atlas npm run db:indexes -- --apply   # create indexes
   DOTENV_CONFIG_PATH=.env.atlas npm run db:seed-admin           # first admin
   DOTENV_CONFIG_PATH=.env.atlas npm run db:indexes              # should list 0 toCreate
   ```

### 2. Create the Vercel project

1. Push this repository to GitHub as `secure-notes-backend`.
2. In Vercel, choose **Add New → Project** and import the repository.
3. Settings:
   - **Framework Preset:** Express. It is detected automatically.
   - **Root Directory:** `./`, the repository root.
   - **Build Command, Output Directory, Install Command:** leave the defaults.
4. **Environment Variables** (Production; add them to Preview too if you use previews):

   | Name             | Value                                        |
   | ---------------- | -------------------------------------------- |
   | `NODE_ENV`       | `production`                                 |
   | `MONGODB_URI`    | Atlas SRV string from step 1                 |
   | `JWT_SECRET`     | a new random value (not the local one)       |
   | `JWT_EXPIRES_IN` | `1h`                                         |
   | `FRONTEND_URL`   | `https://<your-frontend-project>.vercel.app` |

   `FRONTEND_URL` is required in production, and the frontend URL is only final once the
   frontend is deployed. Use the URL you expect (`https://<project-name>.vercel.app`),
   then correct it and **redeploy** if it differs. Environment variable changes only
   apply to new deployments.

5. Click **Deploy**.

### 3. Verify

```bash
API=https://<your-backend-project>.vercel.app/api
curl -s $API/health
# {"success":true,"message":"Service healthy","data":{"status":"ok","database":"connected",...}}
```

`"database": "indexes_missing"` means step 1.5 was skipped. `"unreachable"` means the
URI, the user, or Atlas network access is wrong (§17).

### Preview deployments

- **Unlisted origins.** Preview URLs (`<project>-git-<branch>-<team>.vercel.app`) differ
  for every deployment. A frontend preview can only call the API if its exact origin is in
  `FRONTEND_URL`. Wildcards are rejected on purpose: anyone can create a `*.vercel.app`
  site.
- **Deployment Protection.** Vercel's default Deployment Protection puts previews behind
  a Vercel login, so cross-origin API calls to a preview backend fail.
- **Recommendation.** Test cross-app flows on the production URLs.

### Browsers that block third-party cookies

Production uses `SameSite=None; Secure; Partitioned` (§7). That works in current Chrome,
Edge, Firefox and Safari 26.2+. Older Safari versions and some privacy settings or
extensions drop the cookie: login succeeds, but the next request returns 401. Two ways to
make the cookie first-party:

1. **Custom domains under one parent domain**, for example `app.example.com` (frontend)
   and `api.example.com` (backend). They are then the same site. Set
   `FRONTEND_URL=https://app.example.com`, and you can use `COOKIE_SAME_SITE=lax`.
2. **Same-origin rewrite on the frontend.** In the frontend's `vercel.json`, add
   `{ "source": "/api/:path*", "destination": "https://<backend>.vercel.app/api/:path*" }`
   **before** the SPA fallback, and build the frontend with `VITE_API_BASE_URL=/api`. The
   browser then only ever talks to the frontend's domain. Keep `FRONTEND_URL` set to the
   frontend origin. This variant was not exercised in this repository's verification, so
   test login and logout on it before relying on it.

## 17. Troubleshooting

| Symptom                                                                                                | Cause and fix                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment fails with `NODE_TYPESCRIPT_ERROR`                                                          | Run `npm run typecheck` and `npm run build` locally. Keep `"moduleResolution": "bundler"` in `tsconfig.json`: Vercel's builder resolves imports without an ESM/CJS mode, and under NodeNext it picks CommonJS typings (e.g. `helmet()` "not callable").                                                   |
| `500 Server misconfigured: invalid environment variables` (older builds: `FUNCTION_INVOCATION_FAILED`) | `errors[].field` names each missing or invalid variable, and the runtime logs show the same. Common causes: `FRONTEND_URL` missing, `NODE_ENV` not `production`, `MONGODB_URI` pasted with quotes, `JWT_SECRET` under 32 characters. Fix it in Project Settings → Environment Variables and **redeploy**. |
| `/api/health` → `503`, `"database": "unreachable"`                                                     | Wrong URI or password (URL-encode special characters), Atlas Network Access missing `0.0.0.0/0`, wrong user privileges, or a paused cluster. Runtime logs show the driver error with credentials redacted.                                                                                                |
| `/api/health` → `503`, `"database": "indexes_missing"`                                                 | Run `DOTENV_CONFIG_PATH=.env.atlas npm run db:indexes -- --apply`, then call health again. No redeploy needed.                                                                                                                                                                                            |
| Browser console: CORS error, no `Access-Control-Allow-Origin`                                          | `FRONTEND_URL` doesn't exactly match the page origin: scheme and host, no path, and a preview URL is a different origin. Fix it and redeploy.                                                                                                                                                             |
| `403 Cross-site request blocked: origin not allowed`                                                   | Same as above: the request came from an origin missing from `FRONTEND_URL`.                                                                                                                                                                                                                               |
| `403 Missing X-Requested-With header`                                                                  | A cookie-authenticated write without the CSRF header. The frontend sends it. curl needs `-H 'X-Requested-With: XMLHttpRequest'`.                                                                                                                                                                          |
| Login returns 200, then `/api/auth/me` returns 401                                                     | The browser rejected the cross-site cookie (see "Browsers that block third-party cookies"). Check DevTools → Application → Cookies for `access_token` on the API domain.                                                                                                                                  |
| `401 Your role has changed, please log in again`                                                       | Expected after a role change: tokens are bound to the role they were issued for.                                                                                                                                                                                                                          |
| `429 Too many authentication attempts`                                                                 | The login/register rate limit (20 per 15 min per IP and instance). Wait, or adjust `AUTH_RATE_LIMIT_*`.                                                                                                                                                                                                   |
| Preview URL returns a Vercel login page                                                                | Deployment Protection is on for previews. Use the production URL, or configure protection in Project Settings.                                                                                                                                                                                            |
