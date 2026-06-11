# ---- Stage 1: test + build --------------------------------------------------
# npm run build runs the Vitest suite and the TypeScript type-check first
# (prebuild script); if either fails, the image build aborts and nothing
# gets served.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Stage 2: static site behind nginx --------------------------------------
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
