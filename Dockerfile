# ---- Stage 1: test ---------------------------------------------------------
# Runs the full test suite. If any test fails, the image build aborts and
# nothing gets served.
FROM node:22-alpine AS test
WORKDIR /app
COPY . .
RUN npm test

# ---- Stage 2: static site behind nginx -------------------------------------
# Copies from the test stage (not the build context) so the test stage is
# guaranteed to have run before anything ships.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=test /app/clone_dance.html /app/clone_dance.js \
                 /app/visualizer.html /app/visualizer.js \
                 /app/extractor.html /app/extractor.js /app/choreo_core.js \
                 /app/config_loader.js /app/config.json \
                 /app/pose_landmarker_lite.task \
                 /app/pose_landmarker_full.task \
                 /app/pose_landmarker_heavy.task \
                 /usr/share/nginx/html/
COPY --from=test /app/cdn /usr/share/nginx/html/cdn
COPY --from=test /app/visual_effects /usr/share/nginx/html/visual_effects
COPY --from=test /app/assets /usr/share/nginx/html/assets
COPY --from=test /app/choreographies /usr/share/nginx/html/choreographies

EXPOSE 80
