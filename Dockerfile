# ---- Base: dependencies ------------------------------------------------------
FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- Dev: Vite dev server with hot reload ------------------------------------
# Used by `docker compose --profile dev up` with the repo bind-mounted,
# so edits on the host hot-reload in the browser.
FROM base AS dev
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

# ---- Build: test + type-check + bundle ----------------------------------------
# npm run build runs the Vitest suite and tsc first (prebuild script);
# if either fails, the image build aborts and nothing gets served.
FROM base AS build
COPY . .
RUN npm run build

# ---- Prod: static site behind nginx -------------------------------------------
FROM nginx:1.27-alpine AS prod

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
